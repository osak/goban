/**
 * 着手のログと、盤上の石に付ける着手番号。DOM に依存しない。
 *
 * 着手は今の経路上の手（game.ts の GameMove）。碁のルール上の手番とは限らない
 * （同じ色を連打すれば同じ色が続く）。
 */

import type { Board } from './board';
import type { GameMove } from './game';

/** 番号の付け方: 起点の手を 1 とする / 手数（何手目か）をそのまま使う */
export type NumberStyle = 'relative' | 'absolute';
export const NUMBER_STYLES: readonly NumberStyle[] = ['relative', 'absolute'];

/** 番号を付ける対象の手（石を置く手。パスは除く） */
type PlacedMove = Pick<GameMove, 'point' | 'color'>;

/**
 * いま盤上に残っている石を置いた手のインデックス。
 * 同じ交点に何度も打たれている場合は最後の手だけが対象で、
 * その石が取られたり消されたりしていれば含まれない。パスは含まない。
 */
export function movesOnBoard(board: Board, moves: readonly PlacedMove[]): Set<number> {
  const latest = new Map<number, number>();
  moves.forEach((m, i) => {
    if (m.point !== null) latest.set(m.point, i);
  });
  const out = new Set<number>();
  for (const [p, i] of latest) {
    if (board.grid[p] === moves[i].color) out.add(i);
  }
  return out;
}

/** 手 i に付ける番号（from より前の手は null）。手数は MN があればそれに従う */
export function moveLabel(
  moves: readonly Pick<GameMove, 'number'>[],
  i: number,
  from: number,
  style: NumberStyle,
): number | null {
  if (i < from) return null;
  return style === 'absolute' ? moves[i].number : i - from + 1;
}

/**
 * 盤上の石に付ける番号。キーは交点のインデックス、値は表示する番号。
 * from 番目（0 始まり）以降の手で、いま盤上に残っている石だけが対象。
 */
export function stoneNumbers(
  board: Board,
  moves: readonly (PlacedMove & Pick<GameMove, 'number'>)[],
  from: number,
  style: NumberStyle,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const i of movesOnBoard(board, moves)) {
    const label = moveLabel(moves, i, from, style);
    if (label !== null) out.set(moves[i].point!, label);
  }
  return out;
}
