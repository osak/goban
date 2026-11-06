/**
 * キャンバス上のレイアウト（マスの大きさ・余白・ラベル帯）と当たり判定。
 */

import type { CoordStyle } from './coords';
import type { Point, View } from './view';

export interface Layout {
  /** 表示する列数・行数 */
  readonly cols: number;
  readonly rows: number;
  /** マスの大きさ（px） */
  readonly cell: number;
  /** ラベルの文字サイズ（px） */
  readonly font: number;
  /** 左右・上下のラベル帯の幅（px） */
  readonly bandX: number;
  readonly bandY: number;
  /** 表示範囲の左上の交点の位置（px） */
  readonly ox: number;
  readonly oy: number;
  /** 全体の大きさ（px） */
  readonly width: number;
  readonly height: number;
}

export const LAYOUT_PARAMS = {
  /** 外側の線からラベル帯までの距離（マス単位） */
  gap: 0.7,
  /** ラベル文字サイズ / マス */
  fontRatio: 0.42,
  /** ラベル文字の最小サイズ（px） */
  minFont: 9,
  /** 上下のラベル帯の高さ（em） */
  bandY: 1.5,
  /** 左右のラベル帯の幅（em）: "19" と "十九" */
  bandXWestern: 1.7,
  bandXJapanese: 2.4,
} as const;

/**
 * 表示範囲 view を availW × availH に収めるレイアウトを計算する。
 * fixedCell を指定するとマスの大きさを固定する（PNG 出力用）。
 */
export function computeLayout(
  view: View,
  availW: number,
  availH: number,
  coordStyle: CoordStyle,
  fixedCell?: number,
): Layout {
  const P = LAYOUT_PARAMS;
  const cols = view.x1 - view.x0 + 1;
  const rows = view.y1 - view.y0 + 1;
  const bandXem = coordStyle === 'japanese' ? P.bandXJapanese : P.bandXWestern;
  const bandYem = P.bandY;
  let cell: number;
  if (fixedCell) {
    cell = fixedCell;
  } else {
    const unitsX = cols - 1 + 2 * P.gap;
    const unitsY = rows - 1 + 2 * P.gap;
    cell = Math.min(
      availW / (unitsX + 2 * bandXem * P.fontRatio),
      availH / (unitsY + 2 * bandYem * P.fontRatio),
    );
    if (cell * P.fontRatio < P.minFont) {
      // 文字が小さくなりすぎる場合はラベル帯を最小文字サイズで固定して計算し直す
      cell = Math.min((availW - 2 * bandXem * P.minFont) / unitsX, (availH - 2 * bandYem * P.minFont) / unitsY);
    }
    cell = Math.max(cell, 4);
  }
  const font = Math.max(P.minFont, cell * P.fontRatio);
  const bandX = bandXem * font;
  const bandY = bandYem * font;
  const ox = bandX + P.gap * cell;
  const oy = bandY + P.gap * cell;
  return {
    cols,
    rows,
    cell,
    font,
    bandX,
    bandY,
    ox,
    oy,
    width: 2 * ox + (cols - 1) * cell,
    height: 2 * oy + (rows - 1) * cell,
  };
}

/**
 * キャンバス上の座標 (px, py) に最も近い表示中の交点。
 * radius（マス単位）を指定すると、交点からその距離以内のときだけ返す。
 */
export function hitTest(layout: Layout, view: View, px: number, py: number, radius?: number): Point | null {
  const fx = (px - layout.ox) / layout.cell;
  const fy = (py - layout.oy) / layout.cell;
  const ix = Math.round(fx);
  const iy = Math.round(fy);
  if (ix < 0 || iy < 0 || ix >= layout.cols || iy >= layout.rows) return null;
  if (radius !== undefined && Math.hypot(fx - ix, fy - iy) > radius) return null;
  return { x: view.x0 + ix, y: view.y0 + iy };
}

/** hitTest と同様だが、表示範囲外は最も近い端の交点に丸める */
export function hitTestClamped(layout: Layout, view: View, px: number, py: number): Point {
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
  const ix = clamp(Math.round((px - layout.ox) / layout.cell), layout.cols - 1);
  const iy = clamp(Math.round((py - layout.oy) / layout.cell), layout.rows - 1);
  return { x: view.x0 + ix, y: view.y0 + iy };
}

/**
 * (x0, y0) から (x1, y1) へ指を動かしたときに通過した交点を順に返す。
 * 始点付近の交点も含まれうるので、重複の除外は呼び出し側で行う。
 * 速いドラッグでも交点を取りこぼさないよう線分上を細かくサンプリングする。
 */
export function hitsAlongSegment(
  layout: Layout,
  view: View,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
): Point[] {
  const step = Math.max(1, layout.cell * 0.12);
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
  const out: Point[] = [];
  let last: Point | null = null;
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const p = hitTest(layout, view, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius);
    if (p && (!last || p.x !== last.x || p.y !== last.y)) {
      out.push(p);
      last = p;
    }
  }
  return out;
}
