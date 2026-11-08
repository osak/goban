/**
 * 着手の記録（ログ）と、盤上の石に付ける着手番号。DOM に依存しない。
 *
 * 記録は石を置いた順に並べただけのもので、碁のルール上の手番とは限らない
 * （同じ色を連打すれば同じ色が続けて記録される）。
 */

import { BLACK, WHITE, type Board, type StoneColor } from './board';

export interface Move {
  readonly x: number;
  readonly y: number;
  readonly color: StoneColor;
}

/** 番号の付け方: 起点の手を 1 とする / 手数（何手目か）をそのまま使う */
export type NumberStyle = 'relative' | 'absolute';
export const NUMBER_STYLES: readonly NumberStyle[] = ['relative', 'absolute'];

/**
 * いま盤上に残っている石を置いた手のインデックス。
 * 同じ交点に何度も打たれている場合は最後の手だけが対象で、
 * その石が取られたり消されたりしていれば含まれない。
 */
export function movesOnBoard(board: Board, moves: readonly Move[]): Set<number> {
  const latest = new Map<number, number>();
  moves.forEach((m, i) => {
    if (board.inBounds(m.x, m.y)) latest.set(board.index(m.x, m.y), i);
  });
  const out = new Set<number>();
  for (const [p, i] of latest) {
    if (board.grid[p] === moves[i].color) out.add(i);
  }
  return out;
}

/** 手 i に付ける番号（from より前の手は null） */
export function moveLabel(i: number, from: number, style: NumberStyle): number | null {
  if (i < from) return null;
  return style === 'absolute' ? i + 1 : i - from + 1;
}

/**
 * 盤上の石に付ける番号。キーは交点のインデックス、値は表示する番号。
 * from 番目（0 始まり）以降の手で、いま盤上に残っている石だけが対象。
 */
export function stoneNumbers(
  board: Board,
  moves: readonly Move[],
  from: number,
  style: NumberStyle,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const i of movesOnBoard(board, moves)) {
    const label = moveLabel(i, from, style);
    if (label !== null) out.set(board.index(moves[i].x, moves[i].y), label);
  }
  return out;
}

/** 最後の手が (x, y) に置いた color の石なら、それを取り消した記録を返す（違えば null） */
export function withoutLastMoveAt(moves: readonly Move[], x: number, y: number, color: StoneColor): Move[] | null {
  const last = moves.at(-1);
  if (!last || last.x !== x || last.y !== y || last.color !== color) return null;
  return moves.slice(0, -1);
}

const COORD_CHARS = 'abcdefghijklmnopqrstuvwxy'; // MAX_BOARD_SIZE (25) 路まで

/** 1 手を 3 文字（色 B/W + 列 + 行。列・行は a 始まり）で表して並べた文字列にする */
export function serializeMoves(moves: readonly Move[]): string {
  return moves.map((m) => (m.color === BLACK ? 'B' : 'W') + COORD_CHARS[m.x] + COORD_CHARS[m.y]).join('');
}

/** 交点のインデックス（y * size + x）の集合を、1 点 2 文字（列 + 行）で並べた文字列にする */
export function serializePoints(points: Iterable<number>, size: number): string {
  return [...points]
    .sort((a, b) => a - b)
    .map((i) => COORD_CHARS[i % size] + COORD_CHARS[Math.floor(i / size)])
    .join('');
}

/** serializePoints の逆。size 路盤に収まらないなど不正なら null */
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

/** serializeMoves の逆。size 路盤に収まらないなど不正なら null */
export function deserializeMoves(size: number, data: unknown): Move[] | null {
  if (typeof data !== 'string' || data.length % 3 !== 0) return null;
  const moves: Move[] = [];
  for (let k = 0; k < data.length; k += 3) {
    const c = data[k];
    const x = COORD_CHARS.indexOf(data[k + 1]);
    const y = COORD_CHARS.indexOf(data[k + 2]);
    if ((c !== 'B' && c !== 'W') || x < 0 || y < 0 || x >= size || y >= size) return null;
    moves.push({ x, y, color: c === 'B' ? BLACK : WHITE });
  }
  return moves;
}
