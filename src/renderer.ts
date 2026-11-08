/**
 * 碁盤の描画。画面表示と PNG 出力の両方で同じ関数を使う。
 */

import { BLACK, EMPTY, type Board, type StoneColor } from './board';
import { columnLabel, rowLabel, starPoints, type CoordStyle } from './coords';
import type { Layout } from './layout';
import type { Point, View } from './view';

export type ThemeName = 'wood' | 'print';
export const THEME_NAMES: readonly ThemeName[] = ['wood', 'print'];

interface Theme {
  readonly background: string;
  readonly line: string;
  readonly label: string;
  readonly star: string;
  /** 立体的な石（グラデーション・影）にするか */
  readonly shaded: boolean;
}

const THEMES: Record<ThemeName, Theme> = {
  wood: { background: '#dcb35c', line: '#2a1f0e', label: '#3a2a10', star: '#2a1f0e', shaded: true },
  print: { background: '#ffffff', line: '#000000', label: '#000000', star: '#000000', shaded: false },
};

const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", Meiryo, sans-serif';

export interface DrawParams {
  readonly board: Board;
  readonly view: View;
  readonly layout: Layout;
  readonly theme: ThemeName;
  readonly coordStyle: CoordStyle;
  /** △を付ける石のインデックス */
  readonly marks?: ReadonlySet<number> | null;
  /** 石に書く着手番号（キーは交点のインデックス） */
  readonly numbers?: ReadonlyMap<number, number> | null;
  /** 置く予定の石（半透明で表示） */
  readonly ghost?: (Point & { readonly color: StoneColor }) | null;
  /** 拡大範囲の選択中の矩形（対角の 2 交点） */
  readonly selection?: { readonly a: Point; readonly b: Point } | null;
  /** 1 CSS px あたりのデバイスピクセル数。ctx の変換行列はこの倍率に設定済みであること */
  readonly scale?: number;
}

export function draw(ctx: CanvasRenderingContext2D, p: DrawParams): void {
  const { board, view, layout: L } = p;
  const theme = THEMES[p.theme];
  const scale = p.scale ?? 1;
  const size = board.size;
  const cell = L.cell;
  const inView = (x: number, y: number) => x >= view.x0 && x <= view.x1 && y >= view.y0 && y <= view.y1;

  // 線幅をデバイスピクセル単位で決め、位置をピクセル境界にそろえてくっきり描く
  const lineDev = Math.max(1, Math.round((cell * scale) / 30));
  const edgeDev = Math.max(2, lineDev * 2);
  const snapFor = (widthDev: number) => {
    const off = (widthDev % 2) / 2;
    return (v: number) => (Math.round(v * scale - off) + off) / scale;
  };
  const snap = snapFor(lineDev);
  const xs = Array.from({ length: L.cols }, (_, i) => snap(L.ox + i * cell));
  const ys = Array.from({ length: L.rows }, (_, j) => snap(L.oy + j * cell));
  const X = (bx: number) => xs[bx - view.x0];
  const Y = (by: number) => ys[by - view.y0];

  ctx.save();

  // 背景
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, ctx.canvas.width / scale + 1, ctx.canvas.height / scale + 1);

  // 線。表示範囲の外にも盤が続いている側は線を少し延ばして示す
  const ext = cell * 0.45;
  const top = view.y0 === 0 ? ys[0] : ys[0] - ext;
  const bottom = view.y1 === size - 1 ? ys[L.rows - 1] : ys[L.rows - 1] + ext;
  const left = view.x0 === 0 ? xs[0] : xs[0] - ext;
  const right = view.x1 === size - 1 ? xs[L.cols - 1] : xs[L.cols - 1] + ext;
  const isEdge = (v: number) => v === 0 || v === size - 1;

  ctx.strokeStyle = theme.line;
  ctx.lineCap = 'butt';
  ctx.lineWidth = lineDev / scale;
  ctx.beginPath();
  for (let bx = view.x0; bx <= view.x1; bx++) {
    if (isEdge(bx)) continue;
    ctx.moveTo(X(bx), top);
    ctx.lineTo(X(bx), bottom);
  }
  for (let by = view.y0; by <= view.y1; by++) {
    if (isEdge(by)) continue;
    ctx.moveTo(left, Y(by));
    ctx.lineTo(right, Y(by));
  }
  ctx.stroke();

  // 盤の外周線（太線）
  const edgeSnap = snapFor(edgeDev);
  ctx.lineWidth = edgeDev / scale;
  ctx.lineCap = 'square';
  ctx.beginPath();
  for (const bx of [0, size - 1]) {
    if (bx < view.x0 || bx > view.x1) continue;
    const x = edgeSnap(L.ox + (bx - view.x0) * cell);
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  for (const by of [0, size - 1]) {
    if (by < view.y0 || by > view.y1) continue;
    const y = edgeSnap(L.oy + (by - view.y0) * cell);
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }
  ctx.stroke();

  // 星
  ctx.fillStyle = theme.star;
  const starR = Math.max(1.6, cell * 0.095);
  for (const s of starPoints(size)) {
    if (!inView(s.x, s.y) || board.get(s.x, s.y) !== EMPTY) continue;
    ctx.beginPath();
    ctx.arc(X(s.x), Y(s.y), starR, 0, Math.PI * 2);
    ctx.fill();
  }

  // 石
  const r = cell * 0.48;
  for (let by = view.y0; by <= view.y1; by++) {
    for (let bx = view.x0; bx <= view.x1; bx++) {
      const c = board.get(bx, by);
      if (c !== EMPTY) drawStone(ctx, X(bx), Y(by), r, c, theme, scale, false);
    }
  }

  // △マークと着手番号（石と反対の色で描く）。両方ある石は大きめの △ の中に小さめの番号を書く
  const marks = p.marks ?? new Set<number>();
  const numbers = p.numbers ?? new Map<number, number>();
  for (const idx of new Set([...marks, ...numbers.keys()])) {
    const bx = idx % size;
    const by = (idx - bx) / size;
    if (!inView(bx, by) || board.grid[idx] === EMPTY) continue;
    const color = board.grid[idx] === BLACK ? '#ffffff' : '#000000';
    const n = numbers.get(idx);
    if (n === undefined) {
      drawTriangle(ctx, X(bx), Y(by), r, color);
    } else if (marks.has(idx)) {
      drawNumberInTriangle(ctx, X(bx), Y(by), r, String(n), color);
    } else {
      drawNumber(ctx, X(bx), Y(by), r, String(n), color);
    }
  }

  // 置く予定の石（マウスホバー時）
  if (p.ghost && inView(p.ghost.x, p.ghost.y)) {
    ctx.globalAlpha = 0.45;
    drawStone(ctx, X(p.ghost.x), Y(p.ghost.y), r, p.ghost.color, theme, scale, true);
    ctx.globalAlpha = 1;
  }

  // 座標ラベル（表示中の線の分だけ、四辺に）
  ctx.fillStyle = theme.label;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let bx = view.x0; bx <= view.x1; bx++) {
    const text = columnLabel(bx, p.coordStyle);
    fillFitted(ctx, text, X(bx), L.bandY / 2, L.font, cell * 0.95);
    fillFitted(ctx, text, X(bx), L.height - L.bandY / 2, L.font, cell * 0.95);
  }
  for (let by = view.y0; by <= view.y1; by++) {
    const text = rowLabel(by, size, p.coordStyle);
    for (const x of [L.bandX / 2, L.width - L.bandX / 2]) {
      if (p.coordStyle === 'japanese' && text.length > 1) {
        fillStacked(ctx, text, x, Y(by), L.font, L.bandX * 0.92, Math.min(L.font * STACKED_HEIGHT, cell * 0.9));
      } else {
        fillFitted(ctx, text, x, Y(by), L.font, L.bandX * 0.92);
      }
    }
  }

  // 拡大範囲の選択中矩形
  if (p.selection) {
    const { a, b } = p.selection;
    const pad = cell * 0.5;
    const x0 = X(Math.min(a.x, b.x)) - pad;
    const x1 = X(Math.max(a.x, b.x)) + pad;
    const y0 = Y(Math.min(a.y, b.y)) - pad;
    const y1 = Y(Math.max(a.y, b.y)) + pad;
    ctx.fillStyle = 'rgba(37, 99, 235, 0.16)';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.95)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setLineDash([]);
  }

  ctx.restore();
}

/** 盤面一覧用の小さな盤面（線と石だけ）。px × px の正方形に描く */
export function drawThumbnail(ctx: CanvasRenderingContext2D, board: Board, px: number, themeName: ThemeName): void {
  const theme = THEMES[themeName];
  const size = board.size;
  const pad = px / (size + 1);
  const cell = (px - 2 * pad) / (size - 1);
  ctx.save();
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, px, px);
  ctx.strokeStyle = theme.line;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = Math.max(0.5, px / 200);
  ctx.beginPath();
  for (let k = 0; k < size; k++) {
    const v = pad + k * cell;
    ctx.moveTo(pad, v);
    ctx.lineTo(px - pad, v);
    ctx.moveTo(v, pad);
    ctx.lineTo(v, px - pad);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  const r = cell * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = board.get(x, y);
      if (c === EMPTY) continue;
      ctx.beginPath();
      ctx.arc(pad + x * cell, pad + y * cell, r, 0, Math.PI * 2);
      ctx.fillStyle = c === BLACK ? '#111111' : '#ffffff';
      ctx.fill();
      if (c !== BLACK) {
        ctx.lineWidth = Math.max(0.4, r * 0.15);
        ctx.strokeStyle = '#555555';
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

function drawStone(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: StoneColor,
  theme: Theme,
  scale: number,
  isGhost: boolean,
): void {
  ctx.save();
  if (theme.shaded) {
    if (!isGhost) {
      // shadow* は変換行列の影響を受けないのでデバイスピクセルで指定する
      ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
      ctx.shadowBlur = r * 0.18 * scale;
      ctx.shadowOffsetX = r * 0.07 * scale;
      ctx.shadowOffsetY = r * 0.1 * scale;
    }
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.38, r * 0.05, x, y, r * 1.05);
    if (color === BLACK) {
      g.addColorStop(0, '#5c5c5c');
      g.addColorStop(0.45, '#1c1c1c');
      g.addColorStop(1, '#000000');
    } else {
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.55, '#f1f0ec');
      g.addColorStop(1, '#bcb8b0');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (color !== BLACK) {
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = Math.max(0.5, r * 0.04);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.stroke();
    }
  } else {
    const lw = Math.max(1, r * 0.07);
    ctx.beginPath();
    ctx.arc(x, y, r - lw / 2, 0, Math.PI * 2);
    ctx.fillStyle = color === BLACK ? '#000000' : '#ffffff';
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#000000';
    ctx.stroke();
  }
  ctx.restore();
}

function drawTriangle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  const s = r * 0.62; // 外接円の半径
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.2, r * 0.13);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const angle = -Math.PI / 2 + (k * 2 * Math.PI) / 3;
    const px = x + s * Math.cos(angle);
    const py = y + s * 0.1 + s * Math.sin(angle);
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawNumber(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, text: string, color: string): void {
  const fontPx = r * (text.length <= 1 ? 1.05 : text.length === 2 ? 0.95 : 0.78);
  ctx.save();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 文字の見た目の中心が石の中心に来るよう、わずかに下げる
  fillFitted(ctx, text, x, y + r * 0.05, fontPx, r * 1.62, '600 ');
  ctx.restore();
}

/** 番号と△マークの両方がある石: 石いっぱいの △ の中に小さめの番号を書く */
function drawNumberInTriangle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  text: string,
  color: string,
): void {
  const R = r * 0.86; // △ の外接円の半径
  const cy = y + r * 0.09; // △ の重心（石の中心より少し下にすると △ が石の中に収まる）
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, r * 0.075);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const angle = -Math.PI / 2 + (k * 2 * Math.PI) / 3;
    const px = x + R * Math.cos(angle);
    const py = cy + R * Math.sin(angle);
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.stroke();
  // 番号は △ の重心より少し下（△ の幅が広いところ）に、辺にかからない大きさで書く
  const fontPx = r * (text.length <= 1 ? 0.68 : text.length === 2 ? 0.56 : 0.5);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fillFitted(ctx, text, x, cy + r * 0.08, fontPx, R * (text.length <= 2 ? 0.8 : 0.66), '600 ');
  ctx.restore();
}

/** 縦に重ねて書く漢数字の全体の高さ（em） */
const STACKED_HEIGHT = 1.1;

/**
 * 文字を縦に重ね、縦方向に潰して高さ height に収めて書く（"十一" などの漢数字の座標用）。
 * 幅は 1 文字分（maxW を超えれば縮める）。
 */
function fillStacked(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontPx: number,
  maxW: number,
  height: number,
): void {
  const chars = Array.from(text);
  ctx.font = `${fontPx}px ${FONT_FAMILY}`;
  const w = Math.max(...chars.map((ch) => ctx.measureText(ch).width));
  const sx = w > maxW ? maxW / w : 1;
  const sy = height / (chars.length * fontPx);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(sx, sy);
  chars.forEach((ch, k) => ctx.fillText(ch, 0, (k - (chars.length - 1) / 2) * fontPx));
  ctx.restore();
}

/** 幅 maxW に収まるよう必要なら文字を小さくして描く */
function fillFitted(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontPx: number,
  maxW: number,
  weight = '',
): void {
  ctx.font = `${weight}${fontPx}px ${FONT_FAMILY}`;
  const w = ctx.measureText(text).width;
  if (w > maxW) ctx.font = `${weight}${Math.max(6, (fontPx * maxW) / w)}px ${FONT_FAMILY}`;
  ctx.fillText(text, x, y);
}
