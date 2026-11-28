/**
 * ゲームツリー → SGF の文字列。DOM に依存しない。
 *
 * 値はツリーに持っている形（SGF に書く形）のまま書く。値が SGF の構文を壊さないか
 * （エスケープされていない ] や、末尾の \ がないか）は確かめ、壊すなら例外にする。
 * 長い手順でも呼び出しの深さが増えないよう、再帰を使わずに書く。
 */

import type { SgfNode } from '../tree';

/** 値をそのまま [ と ] で囲んで書けるなら true */
export function isWritableValue(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') {
      if (i + 1 >= raw.length) return false;
      i++;
    } else if (raw[i] === ']') {
      return false;
    }
  }
  return true;
}

function nodeText(node: SgfNode): string {
  let out = ';';
  for (const [ident, values] of node.props) {
    if (!/^[A-Z]+$/.test(ident)) throw new Error(`invalid property identifier: ${ident}`);
    if (values.length === 0) continue;
    out += ident;
    for (const v of values) {
      if (!isWritableValue(v)) throw new Error(`invalid value for ${ident}: ${v}`);
      out += `[${v}]`;
    }
  }
  return out;
}

/**
 * ゲームツリー（1 つ、またはコレクションとして複数）を SGF の文字列にする。
 * 手順の各ノードと、各変化を 1 行ずつに分けて書く。
 */
export function writeSgf(roots: SgfNode | readonly SgfNode[]): string {
  const list: readonly SgfNode[] = Array.isArray(roots) ? roots : [roots as SgfNode];
  const out: string[] = [];
  // 文字列はそのまま書き、ノードはそこから始まるゲームツリーとして書く
  const stack: Array<string | SgfNode> = [];
  // pop で 最初の根, \n, 次の根, \n, … の順に出るように積む
  for (let k = list.length - 1; k >= 0; k--) stack.push('\n', list[k]);
  for (let t = stack.pop(); t !== undefined; t = stack.pop()) {
    if (typeof t === 'string') {
      out.push(t);
      continue;
    }
    out.push('(');
    let n = t;
    out.push(nodeText(n));
    while (n.children.length === 1) {
      n = n.children[0];
      out.push('\n', nodeText(n));
    }
    stack.push(')');
    for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k], '\n');
  }
  return out.join('');
}
