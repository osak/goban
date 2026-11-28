/**
 * ツリー全体の表示の配置。DOM に依存しない（docs/design-sgf-core.md §7.5・§7.6）。
 *
 * ノードを（列 = 深さ、行）の升目に置く。最初の子はできるだけ親と同じ行に置き、ほかの子は下の行に置く。
 * 行は、根に近い順・最初の子から先にたどる順（前順）で、その列の空いている行のうち親の行より下の最初のものにする。
 * こうすると、親から子への線（親の列を下り、子へ斜めに入る）がほかのノードや線と重ならない。
 *
 * 大きな棋譜（10 万ノード）でも扱えるよう、再帰を使わず、型付き配列に持つ。
 */

import { BLACK } from './board';
import { nodeMove } from './game';
import type { NodePath, SgfNode } from './tree';

/** ノードの種類: 配置ノード（根を含む） / 黒の手 / 白の手 */
export const KIND_SETUP = 0;
export const KIND_BLACK = 1;
export const KIND_WHITE = 2;

export interface TreeLayout {
  /** ノードの数。ノードは前順の番号（0 が根）で表す */
  readonly count: number;
  readonly col: Int32Array;
  readonly row: Int32Array;
  /** 親の番号（根は -1） */
  readonly parent: Int32Array;
  /** 親の子の中での位置（根は 0） */
  readonly childIndex: Int32Array;
  readonly kind: Uint8Array;
  /** 手の手数（MN があればそれ。配置ノードは 0） */
  readonly number: Int32Array;
  /** コメント（C）があれば 1 */
  readonly comment: Uint8Array;
  /** 列の数と行の数 */
  readonly cols: number;
  readonly rows: number;
  /** 列ごとのノードの番号（行の小さい順） */
  readonly byColumn: readonly (readonly number[])[];
  /** ノードの id → 番号 */
  readonly indexOf: ReadonlyMap<number, number>;
}

export function layoutTree(root: SgfNode, size: number): TreeLayout {
  const nodes: SgfNode[] = [];
  const parents: number[] = [];
  const childIndexes: number[] = [];
  const lastNumbers: number[] = [];
  const colList: number[] = [];
  const rowList: number[] = [];
  const kindList: number[] = [];
  const numberList: number[] = [];
  const nextFree: number[] = [];

  // 前順にたどる。スタックには（ノード, 親の番号, 子の位置）を積む
  const stack: Array<[SgfNode, number, number]> = [[root, -1, 0]];
  while (stack.length > 0) {
    const [node, parent, k] = stack.pop()!;
    const index = nodes.length;
    const col = parent < 0 ? 0 : colList[parent] + 1;
    const row = Math.max(parent < 0 ? 0 : rowList[parent], nextFree[col] ?? 0);
    nextFree[col] = row + 1;
    const move = parent < 0 ? null : nodeMove(node, col, size, lastNumbers[parent]);
    nodes.push(node);
    parents.push(parent);
    childIndexes.push(k);
    colList.push(col);
    rowList.push(row);
    kindList.push(move === null ? KIND_SETUP : move.color === BLACK ? KIND_BLACK : KIND_WHITE);
    numberList.push(move?.number ?? 0);
    lastNumbers.push(move ? move.number : parent < 0 ? 0 : lastNumbers[parent]);
    for (let c = node.children.length - 1; c >= 0; c--) stack.push([node.children[c], index, c]);
  }

  const count = nodes.length;
  const byColumn: number[][] = Array.from({ length: nextFree.length }, () => []);
  // 前順で、同じ列のノードは行の小さい順に並ぶ
  for (let i = 0; i < count; i++) byColumn[colList[i]].push(i);
  const indexOf = new Map<number, number>();
  const comment = new Uint8Array(count);
  nodes.forEach((n, i) => {
    indexOf.set(n.id, i);
    if (n.props.has('C')) comment[i] = 1;
  });
  return {
    count,
    col: Int32Array.from(colList),
    row: Int32Array.from(rowList),
    parent: Int32Array.from(parents),
    childIndex: Int32Array.from(childIndexes),
    kind: Uint8Array.from(kindList),
    number: Int32Array.from(numberList),
    comment,
    cols: nextFree.length,
    rows: nextFree.reduce((a, b) => Math.max(a, b), 0),
    byColumn,
    indexOf,
  };
}

/** 番号 index のノードへの path */
export function pathOfIndex(layout: TreeLayout, index: number): number[] {
  const out: number[] = [];
  for (let i = index; layout.parent[i] >= 0; i = layout.parent[i]) out.push(layout.childIndex[i]);
  return out.reverse();
}

/** 列 col・行 row にあるノードの番号（なければ -1） */
export function indexAt(layout: TreeLayout, col: number, row: number): number {
  const list = layout.byColumn[col];
  if (!list) return -1;
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = layout.row[list[mid]];
    if (r === row) return list[mid];
    if (r < row) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** path の各ノードの番号（根を含む）。path がツリーにない部分は含めない */
export function indicesOnPath(layout: TreeLayout, root: SgfNode, path: NodePath): number[] {
  const out: number[] = [];
  let node: SgfNode | undefined = root;
  for (let d = 0; node; d++) {
    const i = layout.indexOf.get(node.id);
    if (i === undefined) break;
    out.push(i);
    if (d >= path.length) break;
    node = node.children[path[d]];
  }
  return out;
}
