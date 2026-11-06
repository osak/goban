/**
 * 座標ラベルと星の位置。
 */

import type { Point } from './view';

/** western: A–T（I を除く）/ 下から 1–19, japanese: 左から 1–19 / 上から 一–十九 */
export type CoordStyle = 'western' | 'japanese';
export const COORD_STYLES: readonly CoordStyle[] = ['western', 'japanese'];

const WESTERN_COLUMNS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';
const KANJI_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function kanjiNumber(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n >= 100) return String(n);
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  const tensPart = tens === 0 ? '' : (tens > 1 ? KANJI_DIGITS[tens] : '') + '十';
  return tensPart + KANJI_DIGITS[ones];
}

/** 列（横方向）のラベル。x は左端が 0 */
export function columnLabel(x: number, style: CoordStyle): string {
  if (style === 'japanese') return String(x + 1);
  return WESTERN_COLUMNS[x] ?? String(x + 1);
}

/** 行（縦方向）のラベル。y は上端が 0 */
export function rowLabel(y: number, size: number, style: CoordStyle): string {
  if (style === 'japanese') return kanjiNumber(y + 1);
  return String(size - y);
}

/** 交点の表記（例: "D4", "4の十六"） */
export function pointName(x: number, y: number, size: number, style: CoordStyle): string {
  const col = columnLabel(x, style);
  const row = rowLabel(y, size, style);
  return style === 'japanese' ? `${col}の${row}` : col + row;
}

/** 星の位置 */
export function starPoints(size: number): Point[] {
  const grid = (lines: number[]): Point[] => lines.flatMap((y) => lines.map((x) => ({ x, y })));
  const center = (size - 1) / 2;
  if (size === 19) return grid([3, 9, 15]);
  if (size >= 13) {
    // 13 路は四隅と天元の 5 つ。それより大きい盤は 9 つ（偶数路は 4 つ）
    const pts = grid([3, size - 4]);
    if (size % 2 === 1) {
      pts.push({ x: center, y: center });
      if (size > 13) pts.push(...[3, size - 4].flatMap((c) => [{ x: c, y: center }, { x: center, y: c }]));
    }
    return pts;
  }
  if (size >= 7) {
    const pts = grid([2, size - 3]);
    if (size % 2 === 1) pts.push({ x: center, y: center });
    return pts;
  }
  return size % 2 === 1 ? [{ x: center, y: center }] : [];
}
