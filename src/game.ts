/**
 * ゲームツリーから局面を導出する。DOM に依存しない。
 *
 * 根から今のノードまでの各ノードを順に実行する:
 * 1. AE → AB → AW を上書きで反映する（取りは起きない）
 * 2. B / W があれば打つ。相手の呼吸点のない連を取り、それでも自分の連に呼吸点がなければ自分の連を取り除く。
 *    石のある点への手は上書きする（読み込んだファイルの不正な手も、仕様どおり寛容に実行する）
 *
 * あわせて、経路上の着手の一覧・番号の起点（GBNS）・次の手番・取られた石を求める。
 */

import { BLACK, Board, EMPTY, MAX_BOARD_SIZE, MIN_BOARD_SIZE, WHITE, opposite, type StoneColor } from './board';
import { capturelessMoveOf, hasNumberStart } from './ext';
import { decodeSimpleText, encodeText, parseNumber, parsePoint, parsePointList, splitComposed } from './sgf/values';
import { createNode, getValue, type Props, type SgfNode } from './tree';

export const DEFAULT_BOARD_SIZE = 19;

/** 根の SZ から盤の大きさを読む。この盤で扱えない（長方形・範囲外・読めない）なら null */
export function boardSizeOf(root: SgfNode): number | null {
  const raw = getValue(root, 'SZ');
  if (raw === undefined) return DEFAULT_BOARD_SIZE;
  const pair = splitComposed(raw);
  const w = parseNumber(pair ? pair[0] : raw);
  const h = pair ? parseNumber(pair[1]) : w;
  if (w === null || w !== h || w < MIN_BOARD_SIZE || w > MAX_BOARD_SIZE) return null;
  return w;
}

/** 新しいゲームツリーの根 */
export function newGameRoot(size: number, name?: string): SgfNode {
  const props: Array<[string, string[]]> = [
    ['GM', ['1']],
    ['FF', ['4']],
    ['CA', ['UTF-8']],
    ['AP', ['goban:1.0']],
    ['SZ', [String(size)]],
  ];
  const n = name?.replace(/\s+/g, ' ').trim();
  if (n) props.push(['GN', [encodeText(n)]]);
  return createNode(props);
}

/** ノードの B / W。point が null ならパス */
export interface NodeMove {
  readonly color: StoneColor;
  /** 交点のインデックス（y * size + x）。null はパス */
  readonly point: number | null;
}

/** ノードの着手（B / W）。なければ null。盤の外の点や読めない点の手はパスとみなす */
export function moveOf(node: SgfNode, size: number): NodeMove | null {
  const b = getValue(node, 'B');
  const w = getValue(node, 'W');
  const raw = b ?? w;
  if (raw === undefined) return null;
  const color = b !== undefined ? BLACK : WHITE;
  const p = parsePoint(raw);
  // [] と、19 路以下での [tt] はパス（FF[3] との互換）
  if (!p || p.x >= size || p.y >= size) return { color, point: null };
  return { color, point: p.y * size + p.x };
}

export interface NodeSetup {
  readonly black: readonly number[];
  readonly white: readonly number[];
  readonly empty: readonly number[];
  /** PL（次の手番）。なければ null */
  readonly player: StoneColor | null;
}

function pointIndices(node: SgfNode, ident: string, size: number): number[] {
  return parsePointList(node.props.get(ident) ?? [])
    .filter((p) => p.x < size && p.y < size)
    .map((p) => p.y * size + p.x);
}

function colorOf(raw: string | undefined): StoneColor | null {
  const v = raw?.trim().toUpperCase();
  return v === 'B' ? BLACK : v === 'W' ? WHITE : null;
}

/** ノードの配置（AB / AW / AE / PL） */
export function setupOf(node: SgfNode, size: number): NodeSetup {
  return {
    black: pointIndices(node, 'AB', size),
    white: pointIndices(node, 'AW', size),
    empty: pointIndices(node, 'AE', size),
    player: colorOf(getValue(node, 'PL')),
  };
}

/** ノードの △（TR） */
export function trianglesOf(node: SgfNode, size: number): Set<number> {
  return new Set(pointIndices(node, 'TR', size));
}

/** ノードの文字（LB）。交点のインデックス → 文字 */
export function labelsOf(node: SgfNode, size: number): Map<number, string> {
  const out = new Map<number, string>();
  for (const raw of node.props.get('LB') ?? []) {
    const pair = splitComposed(raw);
    const p = pair && parsePoint(pair[0]);
    if (!pair || !p || p.x >= size || p.y >= size) continue;
    out.set(p.y * size + p.x, decodeSimpleText(pair[1]));
  }
  return out;
}

/** 経路上の 1 手 */
export interface GameMove {
  /** 着手のノードの id */
  readonly nodeId: number;
  /** 着手のノードの深さ（根が 0） */
  readonly depth: number;
  readonly color: StoneColor;
  /** 交点のインデックス。null はパス */
  readonly point: number | null;
  /** 手数（何手目か。MN があればそれに従う） */
  readonly number: number;
  /** 「取りなしの着手」（GBMV） */
  readonly captureless: boolean;
}

export interface GamePosition {
  readonly size: number;
  /** 今のノードの局面。書き換えないこと（キャッシュと共有している） */
  readonly board: Board;
  /** 経路上の着手（根に近い順） */
  readonly moves: readonly GameMove[];
  /** 番号を付け始める手の moves の中での位置（GBNS がなければ 0） */
  readonly numberFrom: number;
  /** 次の手番 */
  readonly nextColor: StoneColor;
  /**
   * 経路上の手で取られ、その後その点に石が置かれていない（AE でも消されていない）石。
   * 交点のインデックス → 取られた石の色。「△マーク」の表示に使う
   */
  readonly captured: ReadonlyMap<number, StoneColor>;
}

/** 1 つのノードを実行した後の状態 */
interface Step {
  /** このノードのプロパティ（キャッシュを使えるかの判定に使う） */
  readonly props: Props;
  readonly nodeId: number;
  readonly board: Board;
  readonly captured: ReadonlyMap<number, StoneColor>;
  readonly move: GameMove | null;
  readonly moveCount: number;
  readonly numberFrom: number;
  /** ここまでで決まった次の手番（まだ決まっていなければ null） */
  readonly toPlay: StoneColor | null;
  /** 最後の手の手数 */
  readonly lastNumber: number;
}

/**
 * 石を打つ（SGF の B / W の実行）。石のある点にも上書きで打ち、相手の呼吸点のない連を取り、
 * それでも自分の連に呼吸点がなければ自分の連を取り除く。取り除いた石（自分の連も含む）とその色を返す
 */
export function playMove(board: Board, point: number, color: StoneColor): Array<[number, StoneColor]> {
  const removed: Array<[number, StoneColor]> = [];
  const take = (stones: readonly number[]) => {
    for (const s of stones) {
      removed.push([s, board.grid[s] as StoneColor]);
      board.grid[s] = EMPTY;
    }
  };
  board.grid[point] = color;
  const enemy = opposite(color);
  for (const n of board.neighbors(point)) {
    if (board.grid[n] !== enemy) continue; // 取り除いたばかりの連もここで弾かれる
    const g = board.groupAt(n);
    if (g.liberties === 0) take(g.stones);
  }
  const own = board.groupAt(point);
  if (own.liberties === 0) take(own.stones); // 自殺手
  return removed;
}

/** ノードの手（着手ノードでなければ null）。lastNumber は直前の手の手数 */
function nodeMove(node: SgfNode, depth: number, size: number, lastNumber: number): GameMove | null {
  const m = moveOf(node, size);
  const cm = m ? null : capturelessMoveOf(node, size);
  const played = m ?? cm;
  if (!played) return null;
  const number = parseNumber(getValue(node, 'MN') ?? '') ?? lastNumber + 1;
  return { nodeId: node.id, depth, color: played.color, point: played.point, number, captureless: m === null };
}

/**
 * 手順の上の着手（局面は打ち直さない）。nodes は根からのノードの列。
 * 着手のログで、今のノードより先の手を出すのに使う
 */
export function lineMoves(nodes: readonly SgfNode[], size: number): GameMove[] {
  const out: GameMove[] = [];
  let last = 0;
  nodes.forEach((node, depth) => {
    const move = nodeMove(node, depth, size, last);
    if (move) {
      out.push(move);
      last = move.number;
    }
  });
  return out;
}

function runNode(prev: Step | null, node: SgfNode, depth: number, size: number): Step {
  const board = prev ? prev.board.clone() : new Board(size);
  let captured = prev?.captured ?? new Map<number, StoneColor>();
  let copied = false;
  const editCaptured = (): Map<number, StoneColor> => {
    if (!copied) {
      captured = new Map(captured);
      copied = true;
    }
    return captured as Map<number, StoneColor>;
  };
  /** その点に石を置いた・消したので、取られた石の記録から外す */
  const touch = (i: number) => {
    if (captured.has(i)) editCaptured().delete(i);
  };

  const setup = setupOf(node, size);
  for (const i of setup.empty) {
    board.grid[i] = EMPTY;
    touch(i);
  }
  for (const i of setup.black) {
    board.grid[i] = BLACK;
    touch(i);
  }
  for (const i of setup.white) {
    board.grid[i] = WHITE;
    touch(i);
  }

  const lastNumber = prev?.lastNumber ?? 0;
  const move = nodeMove(node, depth, size, lastNumber);
  if (move && !move.captureless && move.point !== null) {
    touch(move.point);
    const removed = playMove(board, move.point, move.color);
    for (const [s, c] of removed) editCaptured().set(s, c);
  }

  const moveCount = (prev?.moveCount ?? 0) + (move ? 1 : 0);
  let toPlay = prev?.toPlay ?? null;
  if (move) toPlay = opposite(move.color);
  else if (setup.player !== null) toPlay = setup.player;

  return {
    props: node.props,
    nodeId: node.id,
    board,
    captured,
    move,
    moveCount,
    numberFrom: hasNumberStart(node) ? moveCount : (prev?.numberFrom ?? 0),
    toPlay,
    lastNumber: move ? move.number : lastNumber,
  };
}

/**
 * 経路の局面を求める。前に求めた経路と途中まで同じなら、その先だけを打ち直す。
 *
 * 同じかどうかはノードのプロパティ（の入れ物）が同じものかで判定する。ツリーは不変で、
 * パスコピーで作り直した祖先のノードもプロパティの入れ物は前と共有するので、
 * 子を足しただけなら、足した 1 手だけを打てばよい。
 */
export class PositionCache {
  private steps: Step[] = [];
  private size = 0;

  /** nodes は根から今のノードまでのノードの列（tree.ts の nodesOnPath） */
  position(nodes: readonly SgfNode[]): GamePosition {
    if (nodes.length === 0) throw new RangeError('empty path');
    const size = boardSizeOf(nodes[0]);
    if (size === null) throw new RangeError(`unsupported board size: ${getValue(nodes[0], 'SZ')}`);
    if (size !== this.size) {
      this.size = size;
      this.steps = [];
    }

    let same = 0;
    while (
      same < nodes.length &&
      same < this.steps.length &&
      this.steps[same].props === nodes[same].props &&
      this.steps[same].nodeId === nodes[same].id
    ) {
      same++;
    }
    this.steps.length = same;
    for (let d = same; d < nodes.length; d++) {
      this.steps.push(runNode(this.steps[d - 1] ?? null, nodes[d], d, size));
    }

    const moves: GameMove[] = [];
    for (const s of this.steps) if (s.move) moves.push(s.move);
    const last = this.steps[this.steps.length - 1];
    return {
      size,
      board: last.board,
      moves,
      numberFrom: last.numberFrom,
      nextColor: last.toPlay ?? BLACK,
      captured: last.captured,
    };
  }
}

/** 経路の局面を、キャッシュを使わずに求める */
export function positionOf(nodes: readonly SgfNode[]): GamePosition {
  return new PositionCache().position(nodes);
}
