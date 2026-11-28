/**
 * 手順の移動と変化の整理。DOM に依存しない（docs/design-sgf-core.md §7・§8）。
 *
 * 「今の手順」（line）は、根から今のノード（cursor）を通ってその先まで続く一本道の path。
 * cursor はいつも line の先頭部分になる。先は、最後に選んだ変化（なければ最初の子）をたどる。
 * line は画面の状態で、保存しない（開き直すと本線をたどる）。
 *
 * 手順の移動は編集ではないので、元に戻すの履歴には積まない（ツリーは変わらない）。
 */

import type { StoneColor } from './board';
import { capturelessMoveOf } from './ext';
import { moveOf } from './game';
import { extendPath, findPath, moveChild, nodeAt, nodesOnPath, removeAt, type NodePath, type SgfNode } from './tree';

/** 今のノードと、今の手順 */
export interface Nav {
  readonly cursor: NodePath;
  readonly line: NodePath;
}

/** a が b の先頭部分（同じものを含む）なら true */
export function isPrefix(a: NodePath, b: NodePath): boolean {
  return a.length <= b.length && a.every((k, i) => k === b[i]);
}

function nodesOrThrow(root: SgfNode, path: NodePath): SgfNode[] {
  const nodes = nodesOnPath(root, path);
  if (!nodes) throw new RangeError(`invalid path: ${path.join(',')}`);
  return nodes;
}

/**
 * 編集の後の今の手順。前の手順の最後のノード（id）がまだあり、今のノードを通るならその手順を保つ。
 * なければ、今のノードから最初の子をたどる
 */
export function lineAfterEdit(root: SgfNode, cursor: NodePath, prev: { line: NodePath; endId: number } | null): number[] {
  if (prev) {
    // ふつうは同じ位置にある（子を足した・ノードを直しただけ）。位置が変わっていたら id で探す
    const at = nodeAt(root, prev.line)?.id === prev.endId ? prev.line : findPath(root, prev.endId);
    if (at && isPrefix(cursor, at)) return extendPath(root, at);
  }
  return extendPath(root, cursor);
}

/** line の最後のノードの id */
export function lineEndId(root: SgfNode, line: NodePath): number {
  const node = nodeAt(root, line);
  if (!node) throw new RangeError(`invalid path: ${line.join(',')}`);
  return node.id;
}

/** 前の手へ（根なら null） */
export function prev(nav: Nav): Nav | null {
  return nav.cursor.length === 0 ? null : { cursor: nav.cursor.slice(0, -1), line: nav.line };
}

/** 次の手へ（今の手順の最後なら null） */
export function next(nav: Nav): Nav | null {
  return nav.cursor.length >= nav.line.length ? null : { cursor: nav.line.slice(0, nav.cursor.length + 1), line: nav.line };
}

/** 今の手順の深さ depth のノードへ */
export function goToDepth(nav: Nav, depth: number): Nav {
  const d = Math.max(0, Math.min(depth, nav.line.length));
  return { cursor: nav.line.slice(0, d), line: nav.line };
}

/** 分かれ目。今の手順で、深さ depth のノードが count 個の兄弟の index 番目 */
export interface Fork {
  readonly depth: number;
  readonly index: number;
  readonly count: number;
}

/** 今の手順の上の分かれ目（根に近い順） */
export function forksOnLine(root: SgfNode, line: NodePath): Fork[] {
  const nodes = nodesOrThrow(root, line);
  const out: Fork[] = [];
  for (let d = 1; d < nodes.length; d++) {
    const count = nodes[d - 1].children.length;
    if (count > 1) out.push({ depth: d, index: line[d - 1], count });
  }
  return out;
}

/**
 * 今の分かれ目（変化の切り替えの対象）。今のノードに子が 2 つ以上あれば次の手の分かれ目、
 * なければ今のノードにいちばん近い、さかのぼった分かれ目。なければ null
 */
export function activeFork(root: SgfNode, nav: Nav): Fork | null {
  const { cursor, line } = nav;
  const forks = forksOnLine(root, line);
  for (let k = forks.length - 1; k >= 0; k--) {
    if (forks[k].depth <= cursor.length + 1) return forks[k];
  }
  return null;
}

/**
 * 分かれ目 fork で index 番目の変化を選ぶ。今のノードは分かれ目の手前（変化の親）にし、
 * 今の手順はその変化の先を最初の子でたどる。盤には次の手の候補として選んだ変化が出る
 */
export function selectVariation(root: SgfNode, nav: Nav, fork: Fork, index: number): Nav {
  const parent = nav.line.slice(0, fork.depth - 1);
  return { cursor: parent, line: extendPath(root, [...parent, index]) };
}

/** 今の分かれ目で、前（delta = -1）・次（+1）の変化に切り替える。端なら null */
export function switchVariation(root: SgfNode, nav: Nav, delta: number): Nav | null {
  const fork = activeFork(root, nav);
  if (!fork) return null;
  const index = fork.index + delta;
  if (index < 0 || index >= fork.count) return null;
  return selectVariation(root, nav, fork, index);
}

/** 変化の一覧の 1 行 */
export interface Variation {
  readonly index: number;
  /** 変化の最初の手（着手がなければ null。パスは point が null） */
  readonly first: { readonly color: StoneColor; readonly point: number | null } | null;
  /** 変化の手数（最初の子をたどった一本道の着手の数） */
  readonly moves: number;
  /** 変化の最初のノードが着手ノードか（盤に次の手の候補として出せるか） */
  readonly startsWithMove: boolean;
}

function playOf(node: SgfNode, size: number): { color: StoneColor; point: number | null } | null {
  return moveOf(node, size) ?? capturelessMoveOf(node, size);
}

/** parentPath のノードの子の一覧（変化の一覧・次の手の候補） */
export function variationsAt(root: SgfNode, parentPath: NodePath, size: number): Variation[] {
  const parent = nodeAt(root, parentPath);
  if (!parent) throw new RangeError(`invalid path: ${parentPath.join(',')}`);
  return parent.children.map((child, index) => {
    let first: Variation['first'] = null;
    let moves = 0;
    for (let n: SgfNode | undefined = child; n; n = n.children[0]) {
      const play = playOf(n, size);
      if (!play) continue;
      first ??= play;
      moves++;
    }
    return { index, first, moves, startsWithMove: playOf(child, size) !== null };
  });
}

/** 次の手の候補の文字（A, B, … Z, 27, 28, …） */
export function variationLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/** 本線（最初の子だけをたどる path）なら true */
export function isMainLine(path: NodePath): boolean {
  return path.every((k) => k === 0);
}

/**
 * path のノードまでを本線にする（経路の各分かれ目で、たどる子を最初の子に並べ替える）。
 * 今のノードと今の手順は、同じノードを指すように付け直す
 */
export function promote(root: SgfNode, nav: Nav, path: NodePath): { root: SgfNode; nav: Nav } {
  let next = root;
  for (let d = 0; d < path.length; d++) {
    // ここより根に近い分かれ目は並べ替え済みなので、親への path は 0 の列
    if (path[d] !== 0) next = moveChild(next, new Array<number>(d).fill(0), path[d], 0);
  }
  const remap = (q: NodePath): number[] => {
    const out = [...q];
    for (let d = 0; d < Math.min(q.length, path.length); d++) {
      const k = path[d];
      if (q[d] === k) {
        out[d] = 0;
        continue; // 同じ子をたどっているので、次の分かれ目も並べ替えの対象
      }
      if (q[d] < k) out[d] = q[d] + 1;
      break; // ほかの子に入ったら、その先は並べ替えていない
    }
    return out;
  };
  return { root: next, nav: { cursor: remap(nav.cursor), line: remap(nav.line) } };
}

/**
 * path のノードとその先を消す。今のノードが消える部分にあれば、消したノードの親に移る。
 * 根は消せない
 */
export function removeBranch(root: SgfNode, nav: Nav, path: NodePath): { root: SgfNode; nav: Nav } {
  if (path.length === 0) throw new RangeError('cannot remove the root');
  const next = removeAt(root, path);
  const parent = path.slice(0, -1);
  const k = path[path.length - 1];
  const remap = (q: NodePath): NodePath | null => {
    if (!isPrefix(parent, q) || q.length === parent.length) return q;
    const j = q[parent.length];
    if (j === k) return null;
    return j > k ? [...parent, j - 1, ...q.slice(parent.length + 1)] : q;
  };
  const cursor = remap(nav.cursor) ?? parent;
  const line = remap(nav.line);
  return { root: next, nav: { cursor, line: line && isPrefix(cursor, line) ? line : extendPath(next, cursor) } };
}

/** path のノードから先（そのノードを含む）の着手の数 */
export function movesInBranch(root: SgfNode, path: NodePath, size: number): number {
  const start = nodeAt(root, path);
  if (!start) throw new RangeError(`invalid path: ${path.join(',')}`);
  let count = 0;
  const stack = [start];
  for (let n = stack.pop(); n; n = stack.pop()) {
    if (playOf(n, size)) count++;
    stack.push(...n.children);
  }
  return count;
}

/** 今のノードの子のうち、point に打つ手の子の位置。同じ色を優先し、なければ違う色。なければ -1 */
export function childAt(node: SgfNode, size: number, point: number, color: StoneColor): number {
  let other = -1;
  for (let k = 0; k < node.children.length; k++) {
    const play = playOf(node.children[k], size);
    if (!play || play.point !== point) continue;
    if (play.color === color) return k;
    if (other < 0) other = k;
  }
  return other;
}
