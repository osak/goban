/**
 * 交点に書く 1 文字のテキスト（石の上にも空点にも置ける）。DOM に依存しない。
 *
 * 「1 文字」は見た目の 1 文字（書記素クラスタ）とする。絵文字や結合文字も 1 文字として扱う。
 */

/** 1 文字とみなすテキストの長さの上限（UTF-16 のコード単位。結合の多い絵文字でも収まる程度） */
const MAX_LABEL_UNITS = 32;

/** text を見た目の文字（書記素クラスタ）に分ける */
export function graphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(seg.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/** 交点に書けるテキストか（空白や制御文字ではない 1 文字） */
export function isLabelText(text: unknown): text is string {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_LABEL_UNITS) return false;
  if (/^\s+$/u.test(text) || /\p{Cc}/u.test(text)) return false;
  return graphemes(text).length === 1;
}

/**
 * 入力欄の文字列から交点に書く 1 文字を取り出す（最後に入力した文字を使う）。
 * 書ける文字がなければ ''。
 */
export function pickLabelText(input: string): string {
  const chars = graphemes(input.trim());
  for (let k = chars.length - 1; k >= 0; k--) if (isLabelText(chars[k])) return chars[k];
  return '';
}
