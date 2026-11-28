import { describe, expect, it } from 'vitest';
import { parseSgf } from '../src/sgf/parse';
import { KIND_BLACK, KIND_SETUP, KIND_WHITE, indexAt, indicesOnPath, layoutTree, pathOfIndex } from '../src/tree-layout';
import { createNode, nodeAt, type SgfNode } from '../src/tree';

/** 配置を「列,行」の列にする（前順） */
function cells(root: SgfNode): string[] {
  const L = layoutTree(root, 9);
  return Array.from({ length: L.count }, (_, i) => `${L.col[i]},${L.row[i]}`);
}

describe('ツリーの配置', () => {
  it('最初の子は親と同じ行、ほかの子は空いている下の行', () => {
    // 根 ─ B ─┬ W ─ B ─┬ W
    //         │        └ W
    //         ├ W ─ B
    //         └ W
    const root = parseSgf('(;SZ[9];B[aa](;W[bb];B[cc](;W[dd])(;W[ee]))(;W[ff];B[gg])(;W[hh]))')[0];
    expect(cells(root)).toEqual(['0,0', '1,0', '2,0', '3,0', '4,0', '4,1', '2,1', '3,1', '2,2']);
    const L = layoutTree(root, 9);
    expect([L.cols, L.rows]).toEqual([5, 3]);
    expect(L.byColumn[2]).toEqual([2, 6, 8]);
  });

  it('前の変化が下の行を使っていれば、その下に置く（線が重ならない）', () => {
    // 2 手目の変化が 3 列目の 1 行目を使うので、根の 2 つ目の子の先は 2 行目に下がる
    const root = parseSgf('(;SZ[9](;B[aa](;W[bb];B[cc])(;W[dd]))(;B[ee];W[ff]))')[0];
    expect(cells(root)).toEqual(['0,0', '1,0', '2,0', '3,0', '2,1', '1,1', '2,2']);
  });

  it('種類・手数・コメント', () => {
    const root = parseSgf('(;SZ[9]AB[aa];B[bb]C[x];AW[cc];W[]MN[10];AB[dd]GBMV[])')[0];
    const L = layoutTree(root, 9);
    expect(Array.from(L.kind)).toEqual([KIND_SETUP, KIND_BLACK, KIND_SETUP, KIND_WHITE, KIND_BLACK]);
    expect(Array.from(L.number)).toEqual([0, 1, 0, 10, 11]);
    expect(Array.from(L.comment)).toEqual([0, 1, 0, 0, 0]);
  });

  it('番号と path・升目の行き来', () => {
    const root = parseSgf('(;SZ[9];B[aa](;W[bb];B[cc])(;W[dd]))')[0];
    const L = layoutTree(root, 9);
    const i = indexAt(L, 2, 1);
    expect(pathOfIndex(L, i)).toEqual([0, 1]);
    expect(L.indexOf.get(nodeAt(root, [0, 1])!.id)).toBe(i);
    expect(indexAt(L, 2, 5)).toBe(-1);
    expect(indexAt(L, 9, 0)).toBe(-1);
    expect(pathOfIndex(L, 0)).toEqual([]);
    expect(indicesOnPath(L, root, [0, 1])).toEqual([0, 1, i]);
  });

  it('深いツリーでも再帰で溢れない', () => {
    let node = createNode([['SZ', ['9']]]);
    const chain: SgfNode[] = [];
    for (let k = 0; k < 20000; k++) chain.push(createNode([[k % 2 ? 'W' : 'B', ['']]]));
    for (let k = chain.length - 1; k > 0; k--) chain[k - 1] = { ...chain[k - 1], children: [chain[k]] };
    node = { ...node, children: [chain[0]] };
    const L = layoutTree(node, 9);
    expect(L.count).toBe(20001);
    expect([L.cols, L.rows]).toEqual([20001, 1]);
  });
});
