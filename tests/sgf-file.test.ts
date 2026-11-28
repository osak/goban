import { describe, expect, it } from 'vitest';
import { docName, docNodes, newDoc } from '../src/edit';
import { positionOf } from '../src/game';
import { MAX_SGF_BYTES, exportSgf, importSgfBytes, importSgfText } from '../src/sgf-file';
import { getValue } from '../src/tree';
import { fullView } from '../src/view';

const fallback = (k: number) => `ファイル ${k + 1}`;

describe('SGF の書き出し', () => {
  it('ツリーをそのまま書き、拡大している範囲を根の VW にする', () => {
    const doc = newDoc(9, '詰碁');
    expect(exportSgf(doc, fullView(9), 9)).toBe('(;GM[1]FF[4]CA[UTF-8]AP[goban:1.0]SZ[9]GN[詰碁])\n');
    expect(exportSgf(doc, { x0: 0, y0: 0, x1: 4, y1: 3 }, 9)).toContain('VW[aa:ed]');
  });
});

describe('SGF の読み込み', () => {
  it('コレクションの各ツリーを盤面にし、今のノードは本線の最後', () => {
    const { boards, skipped } = importSgfText('(;GN[a]SZ[9];B[aa](;W[bb])(;W[cc]))(;SZ[13])', fallback);
    expect(skipped).toEqual([]);
    expect(boards).toHaveLength(2);
    expect(boards[0].doc.cursor).toEqual([0, 0]);
    expect(positionOf(docNodes(boards[0].doc)).moves).toHaveLength(2);
    expect(docName(boards[0].doc)).toBe('a');
    expect(docName(boards[1].doc)).toBe('ファイル 2');
  });

  it('名前がなければ対局者から作る', () => {
    expect(docName(importSgfText('(;PB[秀策]PW[幻庵])', fallback).boards[0].doc)).toBe('秀策 対 幻庵');
    expect(docName(importSgfText('(;PB[秀策])', fallback).boards[0].doc)).toBe('秀策 対 白');
  });

  it('根の VW を表示範囲にして、ツリーからは外す', () => {
    const [b] = importSgfText('(;SZ[9]VW[aa:dd])', fallback).boards;
    expect(b.view).toEqual({ x0: 0, y0: 0, x1: 3, y1: 3 });
    expect(getValue(b.doc.root, 'VW')).toBeUndefined();
    expect(importSgfText('(;SZ[9]VW[])', fallback).boards[0].view).toEqual(fullView(9));
  });

  it('囲碁以外と、扱えない盤の大きさは理由を付けて断る', () => {
    const { boards, skipped } = importSgfText('(;GM[2])(;SZ[19:13])(;SZ[30])(;SZ[9])', fallback);
    expect(boards).toHaveLength(1);
    expect(skipped).toEqual([
      '1 局目: 囲碁の棋譜ではありません（GM[2]）',
      '2 局目: この盤の大きさには対応していません（SZ[19:13]）',
      '3 局目: この盤の大きさには対応していません（SZ[30]）',
    ]);
  });

  it('構文の誤りは位置つきで知らせる', () => {
    const bytes = new TextEncoder().encode('(;B[aa]');
    expect(() => importSgfBytes(bytes, fallback)).toThrow(/SGF を読めませんでした: .*1 行 8 列/);
  });

  it('大きすぎるファイルは読まない', () => {
    expect(() => importSgfBytes(new Uint8Array(MAX_SGF_BYTES + 1), fallback)).toThrow(/大きすぎます/);
  });

  it('書き出した SGF を読み込むと、同じツリーと表示範囲になる', () => {
    const [orig] = importSgfText('(;GN[x]SZ[9];B[aa]C[a\\]b];AW[bb]GBMV[](;W[cc])(;B[dd]GBNS[]))', fallback).boards;
    const view = { x0: 1, y0: 1, x1: 5, y1: 5 };
    const [back] = importSgfText(exportSgf(orig.doc, view, 9), fallback).boards;
    expect(exportSgf(back.doc, back.view, 9)).toBe(exportSgf(orig.doc, view, 9));
    expect(back.view).toEqual(view);
  });
});
