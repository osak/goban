/**
 * 以前の版（v1）の保存データを、ゲームツリーの形（v2）に移す。DOM に依存しない。
 *
 * v1 は盤面ごとに、石の配置・着手の記録（石を置いた順）・△・文字・番号の起点・手番を持っていた。
 * 変換の手順は docs/design-sgf-core.md §9.2:
 * 1. 根に SZ と GN（名前）を置く
 * 2. 着手の記録を順に打ち直して着手ノードにする。石のある点に打つ手があれば、その前に AE の配置ノードを挟む
 * 3. 打ち直した局面が保存されていた石の配置と違えば、最後に差分の配置ノード（AB / AW / AE）を足す
 * 4. 番号の起点 numberFrom = k は、k 手目の直前のノード（k = 0 なら付けない）に GBNS
 * 5. △ と文字は最後のノードの TR と LB にする
 * 6. 手番は、打ち直した手番と違うときだけ、最後のノードが配置ノードなら PL、着手ノードなら一時的な入れ替えにする
 * 7. 今のノードは最後のノード
 * 「△マーク」モードの取られた石の記録は移さない（経路から導出するため）。
 */

import { BLACK, Board, EMPTY, WHITE, type StoneColor } from './board';
import type { Doc } from './edit';
import { NUMBER_START } from './ext';
import { newGameRoot, playMove, positionOf } from './game';
import { isLabelText } from './labels';
import { composed, encodeText, formatPoint } from './sgf/values';
import { BOARD_SIZES } from './state';
import { NONE, createNode, withChildren, type SgfNode } from './tree';
import { isView, normalizeView, type View } from './view';

export const LIBRARY_V1_KEY = 'goban.boards.v1';

const COORD_CHARS = 'abcdefghijklmnopqrstuvwxy'; // MAX_BOARD_SIZE (25) 路まで

export interface V1Move {
  readonly x: number;
  readonly y: number;
  readonly color: StoneColor;
}

/** v1 の盤面 1 つ分（検証済み） */
export interface V1Entry {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly board: Board;
  readonly moves: readonly V1Move[];
  readonly marks: ReadonlySet<number>;
  readonly labels: ReadonlyMap<number, string>;
  readonly numberFrom: number;
  readonly nextColor: StoneColor;
  readonly view: View;
}

/** v1 の着手の記録（1 手 3 文字: 色 B/W + 列 + 行）を読む。不正なら null */
export function deserializeMoves(size: number, data: unknown): V1Move[] | null {
  if (typeof data !== 'string' || data.length % 3 !== 0) return null;
  const moves: V1Move[] = [];
  for (let k = 0; k < data.length; k += 3) {
    const c = data[k];
    const x = COORD_CHARS.indexOf(data[k + 1]);
    const y = COORD_CHARS.indexOf(data[k + 2]);
    if ((c !== 'B' && c !== 'W') || x < 0 || y < 0 || x >= size || y >= size) return null;
    moves.push({ x, y, color: c === 'B' ? BLACK : WHITE });
  }
  return moves;
}

/** v1 の交点の集合（1 点 2 文字: 列 + 行）を読む。不正なら null */
export function deserializePoints(size: number, data: unknown): Set<number> | null {
  if (typeof data !== 'string' || data.length % 2 !== 0) return null;
  const out = new Set<number>();
  for (let k = 0; k < data.length; k += 2) {
    const x = COORD_CHARS.indexOf(data[k]);
    const y = COORD_CHARS.indexOf(data[k + 1]);
    if (x < 0 || y < 0 || x >= size || y >= size) return null;
    out.add(y * size + x);
  }
  return out;
}

/** v1 の文字（キーは点の 2 文字、値は書く文字）を読む。盤外の交点や書けない文字の項目は除く */
export function deserializeLabels(size: number, data: unknown): Map<number, string> {
  const out = new Map<number, string>();
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return out;
  for (const [key, text] of Object.entries(data)) {
    const points = deserializePoints(size, key);
    if (!points || points.size !== 1 || !isLabelText(text)) continue;
    out.set([...points][0], text);
  }
  return out;
}

const MAX_NAME_LENGTH = 40;

function cleanV1Name(name: string): string {
  return Array.from(name.trim()).slice(0, MAX_NAME_LENGTH).join('') || '無題';
}

/** v1 の盤面 1 件を検証する。不正なら null */
export function parseV1Entry(data: unknown): V1Entry | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.id !== 'string' || d.id === '' || typeof d.name !== 'string') return null;
  if (typeof d.size !== 'number' || !BOARD_SIZES.includes(d.size)) return null;
  const board = Board.deserialize(d.size, d.stones);
  if (!board) return null;
  const time = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const createdAt = time(d.createdAt, 0);
  return {
    id: d.id,
    name: cleanV1Name(d.name),
    createdAt,
    updatedAt: time(d.updatedAt, createdAt),
    board,
    moves: deserializeMoves(d.size, d.moves) ?? [],
    marks: deserializePoints(d.size, d.marks) ?? new Set(),
    labels: deserializeLabels(d.size, d.labels),
    numberFrom: typeof d.numberFrom === 'number' && Number.isInteger(d.numberFrom) && d.numberFrom >= 0 ? d.numberFrom : 0,
    nextColor: d.nextColor === WHITE ? WHITE : BLACK,
    view: normalizeView(isView(d.view) ? d.view : null, d.size),
  };
}

/** v1 の盤面の一覧を検証する。currentId と、正しい盤面の列 */
export function parseV1Library(data: unknown): { currentId: string; entries: V1Entry[] } | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as { currentId?: unknown; entries?: unknown };
  if (!Array.isArray(d.entries)) return null;
  const seen = new Set<string>();
  const entries: V1Entry[] = [];
  for (const raw of d.entries) {
    const e = parseV1Entry(raw);
    if (e && !seen.has(e.id)) {
      seen.add(e.id);
      entries.push(e);
    }
  }
  if (entries.length === 0) return null;
  const currentId = entries.some((e) => e.id === d.currentId) ? (d.currentId as string) : entries[0].id;
  return { currentId, entries };
}

/**
 * 盤面の一覧がなかったころの v1 の保存データ（goban.state.v1 の盤面の項目）を、盤面 1 つとして読む。
 * 盤面がなければ null
 */
export function parseV1State(data: unknown, id: string, name: string, now: number): V1Entry | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  return parseV1Entry({
    id,
    name,
    createdAt: now,
    updatedAt: now,
    size: d.size,
    stones: d.stones,
    moves: d.moves,
    marks: '',
    labels: {},
    numberFrom: d.numberFrom,
    nextColor: d.nextColor,
    view: d.view,
  });
}

function pointValue(i: number, size: number): string {
  return formatPoint(i % size, Math.floor(i / size));
}

function pointValues(points: Iterable<number>, size: number): string[] {
  return [...points].sort((a, b) => a - b).map((i) => pointValue(i, size));
}

/** v1 の盤面を、ゲームツリーにする */
export function migrateV1Entry(e: V1Entry): { doc: Doc; view: View } {
  const size = e.board.size;
  // 根から順に、各ノードのプロパティを並べる（最後に親子につなぐ）
  const chain: Array<Array<[string, readonly string[]]>> = [];
  /** k 手目の着手ノードの chain の中での位置 */
  const moveAt: number[] = [];
  const board = new Board(size);
  for (const m of e.moves) {
    const i = board.index(m.x, m.y);
    if (board.grid[i] !== EMPTY) {
      chain.push([['AE', [pointValue(i, size)]]]);
      board.grid[i] = EMPTY;
    }
    moveAt.push(chain.length + 1); // chain[0] は根なので 1 ずらす
    chain.push([[m.color === BLACK ? 'B' : 'W', [formatPoint(m.x, m.y)]]]);
    playMove(board, i, m.color);
  }

  // 打ち直した局面と保存されていた配置の差分
  const ab: number[] = [];
  const aw: number[] = [];
  const ae: number[] = [];
  e.board.grid.forEach((c, i) => {
    if (c === board.grid[i]) return;
    if (c === BLACK) ab.push(i);
    else if (c === WHITE) aw.push(i);
    else ae.push(i);
  });
  if (ab.length + aw.length + ae.length > 0) {
    const diff: Array<[string, readonly string[]]> = [];
    if (ae.length) diff.push(['AE', pointValues(ae, size)]);
    if (ab.length) diff.push(['AB', pointValues(ab, size)]);
    if (aw.length) diff.push(['AW', pointValues(aw, size)]);
    chain.push(diff);
  }

  const rootProps = [...newGameRoot(size, e.name).props];
  const all: Array<Array<[string, readonly string[]]>> = [rootProps, ...chain];
  const last = all[all.length - 1];

  // 番号の起点
  const k = e.numberFrom;
  if (k > 0) {
    const at = k >= e.moves.length ? all.length - 1 : moveAt[k] - 1;
    all[at].push([NUMBER_START, NONE]);
  }

  // △（石のあるところだけ）と文字
  const marks = [...e.marks].filter((i) => e.board.grid[i] !== EMPTY);
  if (marks.length) last.push(['TR', pointValues(marks, size)]);
  if (e.labels.size) {
    const lb = [...e.labels]
      .sort(([a], [b]) => a - b)
      .map(([i, text]) => composed(pointValue(i, size), encodeText(text)));
    last.push(['LB', lb]);
  }

  // 手番: 打ち直した手番と違うときだけ残す
  let doc = build(all);
  if (positionOf(docPath(doc)).nextColor !== e.nextColor) {
    if (moveAt.at(-1) === all.length - 1) {
      doc = { ...doc, turn: e.nextColor };
    } else {
      last.push(['PL', [e.nextColor === BLACK ? 'B' : 'W']]);
      doc = build(all);
    }
  }
  return { doc, view: e.view };
}

/** プロパティの列を、一本道のツリーにつなぐ。今のノードは最後のノード */
function build(all: ReadonlyArray<ReadonlyArray<readonly [string, readonly string[]]>>): Doc {
  let node: SgfNode | null = null;
  for (let d = all.length - 1; d >= 0; d--) {
    const n = createNode(all[d]);
    node = node ? withChildren(n, [node]) : n;
  }
  return { root: node!, cursor: new Array<number>(all.length - 1).fill(0), turn: null };
}

function docPath(doc: Doc): SgfNode[] {
  const nodes = [doc.root];
  for (let d = 0; d < doc.cursor.length; d++) nodes.push(nodes[d].children[0]);
  return nodes;
}
