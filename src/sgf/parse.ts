/**
 * SGF の文字列 → ゲームツリー。DOM に依存しない。
 *
 * 外部から来るファイルを読むので、寛容に読みつつ上限を設ける。
 * - 最初の ( より前と、最後のゲームツリーの後ろにあるものは無視する。
 * - FF[3] の書き方（プロパティ名の小文字。LaBel は LB）も読む。
 * - 1 つのノードに同じプロパティが 2 回あれば、値をつなげる。
 * - 構文の誤りは、位置（行・列）つきの SgfParseError にする。
 * 長い手順でも呼び出しの深さが増えないよう、再帰を使わずに読む。
 */

import { createNode, type SgfNode } from '../tree';

export class SgfParseError extends Error {
  /** 文字列の先頭からの位置（0 始まり） */
  readonly offset: number;
  /** 行（1 始まり） */
  readonly line: number;
  /** 列（1 始まり） */
  readonly column: number;

  constructor(message: string, text: string, offset: number) {
    const before = text.slice(0, offset);
    const line = before.split(/\r\n|\r|\n/).length;
    const column = offset - Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r')); // 1 始まり
    super(`${message}（${line} 行 ${column} 列）`);
    this.name = 'SgfParseError';
    this.offset = offset;
    this.line = line;
    this.column = column;
  }
}

export interface ParseOptions {
  /** ノードの数の上限（ファイル全体で）。超えたら SgfParseError */
  readonly maxNodes?: number;
}

export const DEFAULT_MAX_NODES = 100_000;

/** 読んでいる途中のノード（読み終えたら SgfNode として返す） */
interface MutableNode {
  readonly id: number;
  readonly props: Map<string, string[]>;
  readonly children: MutableNode[];
}

interface Frame {
  /** このゲームツリーの最初のノードをつなぐ先（いちばん外側のゲームツリーなら null） */
  readonly parent: MutableNode | null;
  /** このゲームツリーの手順の最後のノード */
  last: MutableNode | null;
  /** 手順の後ろに、子のゲームツリーが始まったか */
  branched: boolean;
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\v' || c === '\f';
}

function isLetter(c: string): boolean {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

/** SGF の文字列を読み、コレクションのゲームツリーの根の列を返す */
export function parseSgf(text: string, options: ParseOptions = {}): SgfNode[] {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const fail = (message: string, at: number): never => {
    throw new SgfParseError(message, text, at);
  };

  const roots: MutableNode[] = [];
  const stack: Frame[] = [];
  let nodeCount = 0;
  let i = text.indexOf('(');
  if (i < 0) fail('SGF のゲームツリー（ ( で始まる部分）がありません', 0);

  const readProperties = (node: MutableNode) => {
    for (;;) {
      while (i < text.length && isSpace(text[i])) i++;
      if (i >= text.length || !isLetter(text[i])) return;
      const identStart = i;
      while (i < text.length && isLetter(text[i])) i++;
      // FF[3] では小文字は意味を持たない（LaBel は LB）
      const ident = text.slice(identStart, i).replace(/[a-z]/g, '');
      if (ident === '') fail('プロパティ名に大文字がありません', identStart);
      const values: string[] = [];
      for (;;) {
        while (i < text.length && isSpace(text[i])) i++;
        if (text[i] !== '[') break;
        const valueStart = i;
        i++;
        const start = i;
        while (i < text.length && text[i] !== ']') i += text[i] === '\\' ? 2 : 1;
        if (i >= text.length) fail('値が ] で閉じていません', valueStart);
        values.push(text.slice(start, i));
        i++;
      }
      if (values.length === 0) fail(`プロパティ ${ident} に値がありません`, i);
      const existing = node.props.get(ident);
      if (existing) existing.push(...values);
      else node.props.set(ident, values);
    }
  };

  while (i < text.length) {
    const c = text[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    const frame = stack.at(-1);
    if (!frame) {
      // ゲームツリーの外。次のゲームツリーがなければ、残りは無視する
      if (c !== '(') break;
      stack.push({ parent: null, last: null, branched: false });
      i++;
      continue;
    }
    if (c === '(') {
      if (!frame.last) fail('ゲームツリーがノード（ ; ）で始まっていません', i);
      frame.branched = true;
      stack.push({ parent: frame.last, last: null, branched: false });
      i++;
    } else if (c === ')') {
      if (!frame.last) fail('ノードのないゲームツリーです', i);
      stack.pop();
      i++;
    } else if (c === ';') {
      if (frame.branched) fail('変化の後ろにノードがあります', i);
      if (++nodeCount > maxNodes) fail(`ノードが多すぎます（上限 ${maxNodes}）`, i);
      const node = createNode() as SgfNode as MutableNode;
      if (frame.last) frame.last.children.push(node);
      else if (frame.parent) frame.parent.children.push(node);
      else roots.push(node);
      frame.last = node;
      i++;
      readProperties(node);
    } else {
      fail(`予期しない文字「${c}」があります`, i);
    }
  }
  if (stack.length > 0) fail('ゲームツリーが ) で閉じていません', text.length);
  return roots;
}

/**
 * SGF のファイルの中身を文字列にする。
 * 根の CA があればその文字コードで読む。なければ UTF-8 として読み、
 * UTF-8 として正しくなければ Shift_JIS、それもだめなら仕様の既定の ISO-8859-1 で読む。
 */
export function decodeSgf(bytes: Uint8Array): string {
  // CA の値は ASCII なので、1 バイトずつ文字にした文字列から探せる
  let latin1 = '';
  const head = bytes.subarray(0, 64 * 1024);
  for (let k = 0; k < head.length; k += 8192) {
    latin1 += String.fromCharCode(...head.subarray(k, k + 8192));
  }
  const ca = /(?:^|[^A-Za-z])CA\s*\[([^\]\\]*)\]/.exec(latin1)?.[1]?.trim();
  if (ca) {
    try {
      return new TextDecoder(ca).decode(bytes);
    } catch {
      // 知らない文字コード名。下の判定で読む
    }
  }
  for (const label of ['utf-8', 'shift_jis']) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(bytes);
    } catch {
      // 次の文字コードを試す
    }
  }
  return new TextDecoder('iso-8859-1').decode(bytes);
}
