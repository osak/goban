import { describe, expect, it } from 'vitest';
import { columnLabel, kanjiNumber, pointName, rowLabel, starPoints } from '../src/coords';
import { LAYOUT_PARAMS, computeLayout, hitTest, hitTestClamped, hitsAlongSegment } from '../src/layout';
import { fullView, isFullView, isView, normalizeView, viewAround, viewFromPoints } from '../src/view';

describe('座標ラベル', () => {
  it('western: A–T（I を除く）と下から 1–19', () => {
    expect(columnLabel(0, 'western')).toBe('A');
    expect(columnLabel(7, 'western')).toBe('H');
    expect(columnLabel(8, 'western')).toBe('J');
    expect(columnLabel(18, 'western')).toBe('T');
    expect(rowLabel(0, 19, 'western')).toBe('19');
    expect(rowLabel(18, 19, 'western')).toBe('1');
    expect(rowLabel(0, 9, 'western')).toBe('9');
    expect(pointName(3, 15, 19, 'western')).toBe('D4');
  });

  it('japanese: 左から 1–19 と上から 一–十九', () => {
    expect(columnLabel(0, 'japanese')).toBe('1');
    expect(columnLabel(18, 'japanese')).toBe('19');
    expect(rowLabel(0, 19, 'japanese')).toBe('一');
    expect(rowLabel(9, 19, 'japanese')).toBe('十');
    expect(rowLabel(10, 19, 'japanese')).toBe('十一');
    expect(rowLabel(18, 19, 'japanese')).toBe('十九');
    expect(pointName(15, 3, 19, 'japanese')).toBe('16の四');
  });

  it('漢数字', () => {
    expect([1, 9, 10, 11, 19, 20, 25].map(kanjiNumber)).toEqual(['一', '九', '十', '十一', '十九', '二十', '二十五']);
  });

  it('星', () => {
    expect(starPoints(19)).toHaveLength(9);
    const sorted = (pts: { x: number; y: number }[]) => pts.map((p) => `${p.x},${p.y}`).sort();
    expect(sorted(starPoints(13))).toEqual(['3,3', '3,9', '6,6', '9,3', '9,9']);
    expect(sorted(starPoints(9))).toEqual(['2,2', '2,6', '4,4', '6,2', '6,6']);
  });
});

describe('表示範囲', () => {
  it('正規化・最小幅・盤端での調整', () => {
    expect(normalizeView({ x0: 5, y0: 9, x1: 2, y1: 3 }, 19)).toEqual({ x0: 2, y0: 3, x1: 5, y1: 9 });
    expect(normalizeView({ x0: 4, y0: 4, x1: 4, y1: 5 }, 19)).toEqual({ x0: 3, y0: 3, x1: 5, y1: 5 });
    expect(normalizeView({ x0: 0, y0: 18, x1: 0, y1: 18 }, 19)).toEqual({ x0: 0, y0: 16, x1: 2, y1: 18 });
    expect(normalizeView({ x0: -3, y0: 0, x1: 40, y1: 7 }, 19)).toEqual({ x0: 0, y0: 0, x1: 18, y1: 7 });
    expect(normalizeView(null, 9)).toEqual(fullView(9));
    expect(normalizeView({ x0: NaN, y0: 0, x1: 1, y1: 1 }, 9)).toEqual(fullView(9));
  });

  it('2 点から・1 点の周り', () => {
    expect(viewFromPoints({ x: 12, y: 1 }, { x: 6, y: 7 }, 19)).toEqual({ x0: 6, y0: 1, x1: 12, y1: 7 });
    expect(viewAround({ x: 0, y: 0 }, 9, 19)).toEqual({ x0: 0, y0: 0, x1: 8, y1: 8 });
    expect(viewAround({ x: 9, y: 18 }, 9, 19)).toEqual({ x0: 5, y0: 10, x1: 13, y1: 18 });
    expect(viewAround({ x: 4, y: 4 }, 9, 9)).toEqual(fullView(9));
  });

  it('isView / isFullView', () => {
    expect(isView({ x0: 0, y0: 0, x1: 1, y1: 1 })).toBe(true);
    expect(isView({ x0: 0, y0: 0, x1: '1', y1: 1 })).toBe(false);
    expect(isView(null)).toBe(false);
    expect(isFullView(fullView(13), 13)).toBe(true);
    expect(isFullView({ x0: 0, y0: 0, x1: 12, y1: 11 }, 13)).toBe(false);
  });
});

describe('レイアウトと当たり判定', () => {
  it('表示領域に収まり、交点を返す', () => {
    const view = fullView(19);
    const L = computeLayout(view, 360, 500, 'western');
    expect(L.width).toBeLessThanOrEqual(360 + 1e-6);
    expect(L.height).toBeLessThanOrEqual(500 + 1e-6);
    expect(L.font).toBeGreaterThanOrEqual(LAYOUT_PARAMS.minFont);
    expect(hitTest(L, view, L.ox + 3 * L.cell, L.oy + 15 * L.cell)).toEqual({ x: 3, y: 15 });
    expect(hitTest(L, view, L.ox + 3.4 * L.cell, L.oy + 14.6 * L.cell)).toEqual({ x: 3, y: 15 });
    expect(hitTest(L, view, 1, 1)).toBeNull(); // ラベル部分
    expect(hitTest(L, view, L.ox + 3.4 * L.cell, L.oy + 14.6 * L.cell, 0.3)).toBeNull();
  });

  it('拡大中は表示範囲の交点を返す', () => {
    const view = { x0: 10, y0: 0, x1: 18, y1: 6 };
    const L = computeLayout(view, 360, 500, 'japanese');
    expect([L.cols, L.rows]).toEqual([9, 7]);
    expect(L.width).toBeLessThanOrEqual(360 + 1e-6);
    expect(L.height).toBeLessThanOrEqual(500 + 1e-6);
    expect(hitTest(L, view, L.ox, L.oy)).toEqual({ x: 10, y: 0 });
    expect(hitTestClamped(L, view, -50, 9999)).toEqual({ x: 10, y: 6 });
  });

  it('マスの大きさを固定できる', () => {
    expect(computeLayout(fullView(19), 0, 0, 'western', 40).cell).toBe(40);
  });

  it('ドラッグの線分上の交点を順に拾う', () => {
    const view = fullView(9);
    const L = computeLayout(view, 400, 400, 'western');
    const y = L.oy + 2 * L.cell;
    const xy = (pts: { x: number; y: number }[]) => pts.map((p) => [p.x, p.y]);
    expect(xy(hitsAlongSegment(L, view, L.ox, y, L.ox + 5 * L.cell, y, 0.45))).toEqual([
      [0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2],
    ]);
    // 斜めに動かしたとき、間の交点は拾わない（階段状にならない）
    expect(xy(hitsAlongSegment(L, view, L.ox, L.oy, L.ox + 3 * L.cell, L.oy + 3 * L.cell, 0.45))).toEqual([
      [0, 0], [1, 1], [2, 2], [3, 3],
    ]);
  });
});
