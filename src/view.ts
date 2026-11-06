/**
 * 表示範囲（盤の一部の拡大）。座標はすべて 0 始まりの交点番号（左上が 0, 0）。
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 表示する交点の範囲。x0..x1, y0..y1 を両端含みで表示する */
export interface View {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** 拡大したときに表示する最小の路数 */
export const MIN_VIEW_SPAN = 3;

export function fullView(size: number): View {
  return { x0: 0, y0: 0, x1: size - 1, y1: size - 1 };
}

export function isFullView(view: View, size: number): boolean {
  return view.x0 === 0 && view.y0 === 0 && view.x1 === size - 1 && view.y1 === size - 1;
}

export function isView(value: unknown): value is View {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return [v.x0, v.y0, v.x1, v.y1].every((n) => typeof n === 'number' && Number.isFinite(n));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** [a, b] の幅が min 以上になるよう盤内で広げる */
function expandSpan(a: number, b: number, min: number, size: number): [number, number] {
  const target = Math.min(min, size);
  while (b - a + 1 < target) {
    if (a > 0) a--;
    if (b - a + 1 < target && b < size - 1) b++;
  }
  return [a, b];
}

/** 任意の矩形を盤内に収め、最小幅を保証した表示範囲にする（不正なら盤全体） */
export function normalizeView(view: View | null | undefined, size: number, minSpan = MIN_VIEW_SPAN): View {
  if (!view || !isView(view)) return fullView(size);
  let x0 = clamp(Math.round(Math.min(view.x0, view.x1)), 0, size - 1);
  let x1 = clamp(Math.round(Math.max(view.x0, view.x1)), 0, size - 1);
  let y0 = clamp(Math.round(Math.min(view.y0, view.y1)), 0, size - 1);
  let y1 = clamp(Math.round(Math.max(view.y0, view.y1)), 0, size - 1);
  [x0, x1] = expandSpan(x0, x1, minSpan, size);
  [y0, y1] = expandSpan(y0, y1, minSpan, size);
  return { x0, y0, x1, y1 };
}

/** 2 つの交点を対角とする表示範囲 */
export function viewFromPoints(a: Point, b: Point, size: number): View {
  return normalizeView({ x0: a.x, y0: a.y, x1: b.x, y1: b.y }, size);
}

/** 交点 p を中心とした span × span の表示範囲（盤端では内側にずらす） */
export function viewAround(p: Point, span: number, size: number): View {
  const n = Math.min(span, size);
  const range = (c: number): [number, number] => {
    const a = clamp(c - Math.floor((n - 1) / 2), 0, size - n);
    return [a, a + n - 1];
  };
  const [x0, x1] = range(p.x);
  const [y0, y1] = range(p.y);
  return { x0, y0, x1, y1 };
}
