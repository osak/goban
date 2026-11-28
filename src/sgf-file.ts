/**
 * SGF ファイルの読み込みと書き出し（盤面 = ゲームツリー 1 つ）。DOM に依存しない。
 *
 * - 書き出し: ツリーをそのまま書く。拡大している範囲は根の VW にする
 * - 読み込み: コレクションの各ツリーを盤面にする。根の VW は表示範囲にして、ツリーからは外す
 *   （表示範囲は画面の状態として持ち、二重に持たないため）。
 *   囲碁以外（GM が 1 以外）と、この盤で扱えない大きさ（長方形・2〜25 路の外）は理由を付けて断る
 */

import { docName, renameDoc, type Doc } from './edit';
import { boardSizeOf, positionOf } from './game';
import { SgfParseError, decodeSgf, parseSgf } from './sgf/parse';
import { composed, decodeSimpleText, formatPoint, parseNumber, parsePointList } from './sgf/values';
import { writeSgf } from './sgf/write';
import { extendPath, getValue, nodesOnPath, setProp, type SgfNode } from './tree';
import { fullView, isFullView, normalizeView, viewFromPoints, type View } from './view';

/** 読み込むファイルの大きさの上限（バイト） */
export const MAX_SGF_BYTES = 5 * 1024 * 1024;

/** 盤面を SGF の文字列にする */
export function exportSgf(doc: Doc, view: View, size: number): string {
  const root = isFullView(view, size)
    ? setProp(doc.root, 'VW', null)
    : setProp(doc.root, 'VW', [composed(formatPoint(view.x0, view.y0), formatPoint(view.x1, view.y1))]);
  return writeSgf(root);
}

export interface ImportedBoard {
  readonly doc: Doc;
  readonly view: View;
}

export interface ImportResult {
  readonly boards: readonly ImportedBoard[];
  /** 読み込まなかったツリーの理由 */
  readonly skipped: readonly string[];
}

/** 名前がなければ、対局者や手番のない図などから名前を作る */
function nameFor(root: SgfNode, fallback: string): string {
  const text = (ident: string) => {
    const raw = getValue(root, ident);
    return raw === undefined ? '' : decodeSimpleText(raw).trim();
  };
  const gn = text('GN');
  if (gn) return gn;
  const pb = text('PB');
  const pw = text('PW');
  if (pb || pw) return `${pb || '黒'} 対 ${pw || '白'}`;
  return fallback;
}

/** 根の VW を表示範囲にする。なければ盤全体 */
function viewOf(root: SgfNode, size: number): View {
  const points = parsePointList(root.props.get('VW') ?? []).filter((p) => p.x < size && p.y < size);
  if (points.length === 0) return fullView(size);
  let a = points[0];
  let b = points[0];
  for (const p of points) {
    a = { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y) };
    b = { x: Math.max(b.x, p.x), y: Math.max(b.y, p.y) };
  }
  return normalizeView(viewFromPoints(a, b, size), size);
}

/**
 * SGF の文字列を盤面にする。fallbackName(k) は、名前のない k 番目のツリーに付ける名前。
 * 構文の誤りは SgfParseError を投げる。
 */
export function importSgfText(text: string, fallbackName: (k: number) => string): ImportResult {
  const roots = parseSgf(text);
  const boards: ImportedBoard[] = [];
  const skipped: string[] = [];
  roots.forEach((original, k) => {
    const label = roots.length > 1 ? `${k + 1} 局目: ` : '';
    const gm = parseNumber(getValue(original, 'GM') ?? '1');
    if (gm !== 1) {
      skipped.push(`${label}囲碁の棋譜ではありません（GM[${getValue(original, 'GM')}]）`);
      return;
    }
    const size = boardSizeOf(original);
    if (size === null) {
      skipped.push(`${label}この盤の大きさには対応していません（SZ[${getValue(original, 'SZ')}]）`);
      return;
    }
    const view = viewOf(original, size);
    const root = setProp(original, 'VW', null);
    const cursor = extendPath(root, []);
    let doc: Doc = { root, cursor, turn: null };
    if (docName(doc) === '' || getValue(root, 'GN') === undefined) doc = renameDoc(doc, nameFor(root, fallbackName(k)));
    // 局面を求められることを確かめる（扱えない形なら、ここで例外になる）
    positionOf(nodesOnPath(doc.root, doc.cursor)!);
    boards.push({ doc, view });
  });
  return { boards, skipped };
}

/** SGF のファイルの中身を盤面にする。大きすぎるファイルや構文の誤りは Error（message を利用者に見せる） */
export function importSgfBytes(bytes: Uint8Array, fallbackName: (k: number) => string): ImportResult {
  if (bytes.length > MAX_SGF_BYTES) {
    throw new Error(`ファイルが大きすぎます（${Math.floor(MAX_SGF_BYTES / 1024 / 1024)}MB まで）`);
  }
  try {
    return importSgfText(decodeSgf(bytes), fallbackName);
  } catch (e) {
    if (e instanceof SgfParseError) throw new Error(`SGF を読めませんでした: ${e.message}`);
    throw e;
  }
}
