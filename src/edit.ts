/**
 * UI の操作（タップ・ドラッグ）を、ゲームツリーの編集に変える。DOM に依存しない。
 *
 * 規則（docs/design-sgf-core.md §5・§6）:
 * - 石を置くと、今のノードに子の着手ノードを足してそこへ移る。同じ手の子がすでにあれば、その子へ移るだけにする
 * - 着手ノードには配置のプロパティ（AB / AW / AE / PL）を足さない。必要なら子の配置ノードを作る
 * - 配置ノードをその場で書き換えるのは、子がないときだけにする
 * - 子のノードを作るとき、親の文字（LB）と、盤上に残る石の △（TR）を子にコピーする（設定で切れる）
 */

import { BLACK, Board, EMPTY, opposite, type CaptureMode, type StoneColor } from './board';
import { CAPTURELESS_MOVE, capturelessMoveNode, capturelessMoveOf, hasNumberStart, withNumberStart } from './ext';
import {
  boardSizeOf,
  labelsOf,
  moveOf,
  newGameRoot,
  setupOf,
  trianglesOf,
  type GamePosition,
} from './game';
import { composed, decodeSimpleText, encodeText, formatPoint } from './sgf/values';
import {
  addChild,
  createNode,
  getValue,
  nodeAt,
  nodesOnPath,
  removeAt,
  setProp,
  spliceOut,
  updateAt,
  type NodePath,
  type SgfNode,
} from './tree';

/** 1 つの盤面の、編集の対象になる状態 */
export interface Doc {
  readonly root: SgfNode;
  /** 今のノードへの path */
  readonly cursor: NodePath;
  /** 着手ノードでの手番の一時的な入れ替え（ノードを移ったら消える）。なければ null */
  readonly turn: StoneColor | null;
}

/** 局面を求める関数（game.ts の PositionCache.position） */
export type PositionOf = (nodes: readonly SgfNode[]) => GamePosition;

export interface EditOptions {
  /** 子のノードを作るとき、親の △ と文字をコピーするか */
  readonly inheritMarks: boolean;
}

export function newDoc(size: number, name?: string): Doc {
  return { root: newGameRoot(size, name), cursor: [], turn: null };
}

export function docNodes(doc: Doc): SgfNode[] {
  const nodes = nodesOnPath(doc.root, doc.cursor);
  if (!nodes) throw new RangeError(`invalid cursor: ${doc.cursor.join(',')}`);
  return nodes;
}

export function cursorNode(doc: Doc): SgfNode {
  return docNodes(doc)[doc.cursor.length];
}

export function docSize(doc: Doc): number {
  const size = boardSizeOf(doc.root);
  if (size === null) throw new RangeError('unsupported board size');
  return size;
}

/** 次の手番（一時的な入れ替えがあればそれ） */
export function nextColorOf(doc: Doc, pos: GamePosition): StoneColor {
  return doc.turn ?? pos.nextColor;
}

/** 着手ノード（B / W か、取りなしの着手）なら true */
export function isMoveNode(node: SgfNode, size: number): boolean {
  return moveOf(node, size) !== null || capturelessMoveOf(node, size) !== null;
}

function pointValue(i: number, size: number): string {
  return formatPoint(i % size, Math.floor(i / size));
}

function pointValues(points: Iterable<number>, size: number): string[] {
  return [...points].sort((a, b) => a - b).map((i) => pointValue(i, size));
}

function labelValues(labels: ReadonlyMap<number, string>, size: number): string[] {
  return [...labels]
    .sort(([a], [b]) => a - b)
    .map(([i, text]) => composed(pointValue(i, size), encodeText(text)));
}

/**
 * 今のノードに子を足してそこへ移る。親の △ と文字を引き継ぐときは、子の局面で盤上に残る石の △ だけを写す。
 */
function addChildNode(doc: Doc, child: SgfNode, positionOf: PositionOf, options: EditOptions): Doc {
  const size = docSize(doc);
  const parent = cursorNode(doc);
  let node = child;
  if (options.inheritMarks) {
    const labels = parent.props.get('LB');
    if (labels) node = setProp(node, 'LB', labels);
  }
  const added = addChild(doc.root, doc.cursor, node);
  let next: Doc = { root: added.root, cursor: added.path, turn: null };
  const triangles = options.inheritMarks ? trianglesOf(parent, size) : new Set<number>();
  if (triangles.size > 0) {
    const board = positionOf(docNodes(next)).board;
    const kept = [...triangles].filter((i) => board.grid[i] !== EMPTY);
    if (kept.length > 0) {
      next = { ...next, root: updateAt(next.root, next.cursor, (n) => setProp(n, 'TR', pointValues(kept, size))) };
    }
  }
  return next;
}

/** 今のノードを f で書き換える */
function updateCursor(doc: Doc, f: (node: SgfNode) => SgfNode): Doc {
  return { ...doc, root: updateAt(doc.root, doc.cursor, f) };
}

/**
 * 経路上の最後の着手ノードの深さ。そこから今のノードまでが、子が 1 つずつの配置ノードの一本道のときだけ返す
 * （今のノード自身が着手ノードなら null。今のノードに子があっても null）
 */
function lastMoveBehindSetup(nodes: readonly SgfNode[], size: number): number | null {
  const cursor = nodes.length - 1;
  if (nodes[cursor].children.length > 0) return null;
  for (let d = cursor; d > 0; d--) {
    if (d < cursor && nodes[d].children.length !== 1) return null;
    if (isMoveNode(nodes[d], size)) return d === cursor ? null : d;
  }
  return null;
}

export type PlaceOutcome =
  | { readonly ok: true; readonly doc: Doc }
  | { readonly ok: false; readonly reason: 'occupied' | 'suicide' };

/** 着手ノードの手が (point, color) と同じなら true */
function samePlay(node: SgfNode, size: number, point: number, color: StoneColor): boolean {
  const m = moveOf(node, size) ?? capturelessMoveOf(node, size);
  return m !== null && m.point === point && m.color === color;
}

/**
 * 石を置く。
 * - 'remove' / 'mark': 普通の着手（B / W）。取りは打ち直しで起きる。自殺手は置かない。
 *   「△マーク」の△（取られた石）の点は空点なので、そのまま打てる
 * - 'none': 取りも自殺も起きないなら普通の着手。起きるなら「取りなしの着手」（AB / AW + GBMV）
 */
export function placeStone(
  doc: Doc,
  positionOf: PositionOf,
  point: number,
  color: StoneColor,
  captureMode: CaptureMode,
  options: EditOptions,
): PlaceOutcome {
  const size = docSize(doc);
  const pos = positionOf(docNodes(doc));
  if (pos.board.grid[point] !== EMPTY) return { ok: false, reason: 'occupied' };

  const current = cursorNode(doc);
  const existing = current.children.findIndex((c) => samePlay(c, size, point, color));
  if (existing >= 0) return { ok: true, doc: { root: doc.root, cursor: [...doc.cursor, existing], turn: null } };

  const x = point % size;
  const y = Math.floor(point / size);
  const trial = pos.board.clone();
  const res = trial.place(x, y, color, 'remove');
  let child: SgfNode;
  if (res.ok && res.captured.length === 0) {
    child = createNode([[color === BLACK ? 'B' : 'W', [formatPoint(x, y)]]]);
  } else if (captureMode === 'none') {
    child = capturelessMoveNode(color, x, y);
  } else if (res.ok) {
    child = createNode([[color === BLACK ? 'B' : 'W', [formatPoint(x, y)]]]);
  } else {
    return { ok: false, reason: 'suicide' };
  }
  return { ok: true, doc: addChildNode(doc, child, positionOf, options) };
}

/**
 * 石を取り除く。石がなければ null。
 * - 今のノードの手で置いた石なら、置き間違いの修正とみなして今のノードを消し、親へ移る。
 *   今のノードに子があるときは消さずに親へ移るだけにする（その先の手順は残る）
 * - それ以外の石は、子の配置ノード（AE）を足して移る。今のノードが子のない配置ノードなら、そのノードを直す
 * - alternate（交互）なら、取り除いた石の色を次の手番（PL）にする
 */
export function eraseStone(
  doc: Doc,
  positionOf: PositionOf,
  point: number,
  alternate: boolean,
  options: EditOptions,
): Doc | null {
  const size = docSize(doc);
  const nodes = docNodes(doc);
  const pos = positionOf(nodes);
  const removed = pos.board.grid[point];
  if (removed === EMPTY) return null;
  const color = removed as StoneColor;
  const current = nodes[nodes.length - 1];

  if (doc.cursor.length > 0 && samePlay(current, size, point, color)) {
    const parentPath = doc.cursor.slice(0, -1);
    const root = current.children.length === 0 ? removeAt(doc.root, doc.cursor) : doc.root;
    return { root, cursor: parentPath, turn: null };
  }

  // 最後に置いた石: 今のノードの手ではないが、その後が配置ノードの一本道だけなら、その手のノードを抜く
  const last = lastMoveBehindSetup(nodes, size);
  if (last !== null && samePlay(nodes[last], size, point, color)) {
    let root = spliceOut(doc.root, doc.cursor.slice(0, last));
    // 番号の起点の印は、抜いたノードの親に移す（番号の付き方を変えない）
    if (hasNumberStart(nodes[last])) root = updateAt(root, doc.cursor.slice(0, last - 1), (n) => withNumberStart(n, true));
    return { root, cursor: [...doc.cursor.slice(0, last), ...doc.cursor.slice(last + 1)], turn: null };
  }

  if (!isMoveNode(current, size) && current.children.length === 0) {
    // 子のない配置ノードを直す。AB / AW から外し、それでも石が残る（親の局面に石がある）なら AE に入れる
    const parentBoard = doc.cursor.length > 0 ? positionOf(nodes.slice(0, -1)).board : new Board(size);
    return updateCursor(doc, (n) => {
      let next = n;
      for (const ident of ['AB', 'AW'] as const) {
        const s = setupOf(next, size);
        const list = ident === 'AB' ? s.black : s.white;
        if (list.includes(point)) next = setProp(next, ident, pointValues(list.filter((i) => i !== point), size));
      }
      if (parentBoard.grid[point] !== EMPTY) {
        const empty = setupOf(next, size).empty;
        if (!empty.includes(point)) next = setProp(next, 'AE', pointValues([...empty, point], size));
      }
      const tr = trianglesOf(next, size);
      if (tr.delete(point)) next = setProp(next, 'TR', pointValues(tr, size));
      if (alternate) next = setProp(next, 'PL', [color === BLACK ? 'B' : 'W']);
      // 取りなしの着手の印が残っていると、1 点だけになったときに着手とみなされてしまう
      if (next.props.has(CAPTURELESS_MOVE)) next = setProp(next, CAPTURELESS_MOVE, null);
      return next;
    });
  }

  const props: Array<[string, string[]]> = [['AE', [pointValue(point, size)]]];
  if (alternate) props.push(['PL', [color === BLACK ? 'B' : 'W']]);
  return addChildNode(doc, createNode(props), positionOf, options);
}

/** 今のノードの △ を付ける（on が false なら外す） */
export function setTriangle(doc: Doc, point: number, on: boolean): Doc {
  const size = docSize(doc);
  const tr = trianglesOf(cursorNode(doc), size);
  if (tr.has(point) === on) return doc;
  if (on) tr.add(point);
  else tr.delete(point);
  return updateCursor(doc, (n) => setProp(n, 'TR', pointValues(tr, size)));
}

/** 今のノードの文字を書く（text が null なら消す） */
export function setLabel(doc: Doc, point: number, text: string | null): Doc {
  const size = docSize(doc);
  const labels = labelsOf(cursorNode(doc), size);
  if ((labels.get(point) ?? null) === text) return doc;
  if (text === null) labels.delete(point);
  else labels.set(point, text);
  return updateCursor(doc, (n) => setProp(n, 'LB', labelValues(labels, size)));
}

/** 今のノードの文字（読み取り用） */
export function labelsAt(doc: Doc): Map<number, string> {
  return labelsOf(cursorNode(doc), docSize(doc));
}

/** 今のノードの △（読み取り用） */
export function trianglesAt(doc: Doc): Set<number> {
  return trianglesOf(cursorNode(doc), docSize(doc));
}

/**
 * 今のノードより後の手から番号を付ける（on が false なら、最初の手から付ける）。
 * line は今のノードを通る今の手順で、その上のほかの GBNS は外す（手順の先へ進んでも番号の付き方が変わらない）
 */
export function setNumberStartHere(doc: Doc, line: NodePath, on: boolean): Doc {
  const nodes = nodesOnPath(doc.root, line);
  if (!nodes || doc.cursor.some((k, i) => k !== line[i])) throw new RangeError('line must pass through the cursor');
  let root = doc.root;
  for (let d = 0; d < nodes.length; d++) {
    const want = on && d === doc.cursor.length && d > 0;
    if (hasNumberStart(nodes[d]) !== want) root = updateAt(root, line.slice(0, d), (n) => withNumberStart(n, want));
  }
  return root === doc.root ? doc : { ...doc, root };
}

/** 今のノードが番号の起点（この後の手から番号を付ける）なら true */
export function isNumberStartHere(doc: Doc): boolean {
  return doc.cursor.length > 0 && hasNumberStart(cursorNode(doc));
}

/**
 * 次の手番を入れ替える。今のノードが配置ノードなら PL に書き（記録が変わる）、
 * 着手ノードなら一時的な入れ替えにする（記録は変わらない）。
 */
export function toggleTurn(doc: Doc, pos: GamePosition): Doc {
  const next = opposite(nextColorOf(doc, pos));
  const node = cursorNode(doc);
  if (isMoveNode(node, docSize(doc))) {
    return { ...doc, turn: next === pos.nextColor ? null : next };
  }
  return { ...updateCursor(doc, (n) => setProp(n, 'PL', [next === BLACK ? 'B' : 'W'])), turn: null };
}

/** 盤面の名前（根の GN） */
export function docName(doc: Doc): string {
  const raw = getValue(doc.root, 'GN');
  return raw === undefined ? '' : decodeSimpleText(raw);
}

/** 盤面の名前を変える（空なら GN を消す） */
export function renameDoc(doc: Doc, name: string): Doc {
  const n = name.replace(/\s+/g, ' ').trim();
  const root = setProp(doc.root, 'GN', n ? [encodeText(n)] : null);
  return root === doc.root ? doc : { ...doc, root };
}

/** 同じ名前で、size 路の空の盤面にする（盤のクリア・盤サイズの変更） */
export function resetDoc(doc: Doc, size: number): Doc {
  return newDoc(size, docName(doc));
}

/** doc の木で cursor が有効か */
export function isValidCursor(root: SgfNode, cursor: NodePath): boolean {
  return nodeAt(root, cursor) !== null;
}

/** 今の局面に石・着手・文字・△ のどれかがあるか（クリアの確認に使う） */
export function hasContent(doc: Doc, pos: GamePosition): boolean {
  return !pos.board.isEmpty() || pos.moves.length > 0 || labelsAt(doc).size > 0 || doc.root.children.length > 0;
}

