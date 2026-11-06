/**
 * 盤面の PNG 出力。
 */

import { computeLayout } from './layout';
import { draw, type DrawParams } from './renderer';
import type { View } from './view';

export type ExportParams = Pick<DrawParams, 'board' | 'view' | 'theme' | 'coordStyle' | 'marks'>;

/** 出力画像のマスの大きさ。表示範囲が狭いほど大きくし、長辺がおよそ 1000px 前後になるようにする */
export function exportCellSize(view: View): number {
  const span = Math.max(view.x1 - view.x0 + 1, view.y1 - view.y0 + 1);
  return Math.round(Math.max(36, Math.min(96, 1100 / (span + 2))));
}

/** 表示範囲を座標ラベル付きで描いた PNG を作る */
export function renderPng(params: ExportParams): Promise<Blob | null> {
  const layout = computeLayout(params.view, 0, 0, params.coordStyle, exportCellSize(params.view));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(layout.width);
  canvas.height = Math.ceil(layout.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  draw(ctx, { ...params, layout, scale: 1 });
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export function exportFileName(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
  const time = `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `goban-${day}-${time}.png`;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
