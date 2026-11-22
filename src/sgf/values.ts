/**
 * SGF のプロパティの値の読み書き。DOM に依存しない。
 *
 * ツリー（tree.ts）には値を SGF に書かれている形のまま持つので、ここで型ごとに解いたり作ったりする。
 * 仕様は FF[4]（https://www.red-bean.com/sgf/sgf4.html）。
 */

/** 点の座標に使う文字。a〜z が 0〜25、A〜Z が 26〜51 */
const COORDS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 点の値（2 文字）を読む。点として読めなければ null */
export function parsePoint(raw: string): Point | null {
  const v = raw.trim();
  if (v.length !== 2) return null;
  const x = COORDS.indexOf(v[0]);
  const y = COORDS.indexOf(v[1]);
  return x < 0 || y < 0 ? null : { x, y };
}

export function formatPoint(x: number, y: number): string {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= COORDS.length || y >= COORDS.length) {
    throw new RangeError(`point out of range: ${x},${y}`);
  }
  return COORDS[x] + COORDS[y];
}

/**
 * 点のリスト（list of point / elist of point）を読む。
 * 圧縮した形（ul:lr の長方形）は展開する。読めない値は飛ばし、重なった点は 1 つにする。
 */
export function parsePointList(values: readonly string[]): Point[] {
  const out: Point[] = [];
  const seen = new Set<string>();
  const add = (x: number, y: number) => {
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ x, y });
  };
  for (const raw of values) {
    const rect = splitComposed(raw);
    if (!rect) {
      const p = parsePoint(raw);
      if (p) add(p.x, p.y);
      continue;
    }
    const a = parsePoint(rect[0]);
    const b = parsePoint(rect[1]);
    if (!a || !b) continue;
    // 仕様では左上:右下の順だが、逆に書かれていても読む
    for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) {
      for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) add(x, y);
    }
  }
  return out;
}

/** 点の並びを点のリストの値にする（圧縮はしない） */
export function formatPointList(points: Iterable<Point>): string[] {
  return [...points].map((p) => formatPoint(p.x, p.y));
}

/** composed の値（a:b）を最初のエスケープされていない : で分ける。: がなければ null */
export function splitComposed(raw: string): [string, string] | null {
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\') i++;
    else if (c === ':') return [raw.slice(0, i), raw.slice(i + 1)];
  }
  return null;
}

/** 2 つの値（どちらも SGF に書く形）を composed の値にする */
export function composed(a: string, b: string): string {
  return `${a}:${b}`;
}

/** 改行（LF・CR・CRLF・LFCR）なら、その長さ */
function linebreakAt(s: string, i: number): number {
  const c = s[i];
  if (c !== '\n' && c !== '\r') return 0;
  const d = s[i + 1];
  return (d === '\n' || d === '\r') && d !== c ? 2 : 1;
}

/** 改行以外で、スペースに変える空白（全角スペースなどは変えない） */
const OTHER_WHITESPACE = /[\t\v\f]/;

function decode(raw: string, keepLinebreaks: boolean): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\') {
      if (i + 1 >= raw.length) break;
      const lb = linebreakAt(raw, i + 1);
      if (lb > 0) {
        // ソフト改行（\ の直後の改行）は取り除く
        i += lb;
        continue;
      }
      i++;
      out += OTHER_WHITESPACE.test(raw[i]) ? ' ' : raw[i];
      continue;
    }
    const lb = linebreakAt(raw, i);
    if (lb > 0) {
      out += keepLinebreaks ? '\n' : ' ';
      i += lb - 1;
      continue;
    }
    out += OTHER_WHITESPACE.test(c) ? ' ' : c;
  }
  return out;
}

/** Text 型の値を読む（エスケープを解く。改行は \n にそろえて残す） */
export function decodeText(raw: string): string {
  return decode(raw, true);
}

/** SimpleText 型の値を読む（エスケープを解く。改行はスペースにする） */
export function decodeSimpleText(raw: string): string {
  return decode(raw, false);
}

/**
 * 文字列を Text / SimpleText の値にする。] と \ と、composed の区切りと紛れないよう : もエスケープする。
 * SimpleText に入れるときは、呼び出す側で改行を除いておく。
 */
export function encodeText(text: string): string {
  return text.replace(/[\]\\:]/g, (c) => '\\' + c);
}

/** Number 型の値を読む。読めなければ null */
export function parseNumber(raw: string): number | null {
  const v = raw.trim();
  return /^[+-]?\d+$/.test(v) ? Number(v) : null;
}
