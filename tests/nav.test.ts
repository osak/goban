import { describe, expect, it } from 'vitest';
import { BLACK, WHITE } from '../src/board';
import { lineMoves } from '../src/game';
import {
  activeFork,
  childAt,
  forksOnLine,
  goToDepth,
  isMainLine,
  lineAfterEdit,
  lineEndId,
  movesInBranch,
  next,
  prev,
  promote,
  removeBranch,
  selectVariation,
  switchVariation,
  variationLetter,
  variationsAt,
  type Nav,
} from '../src/nav';
import { parseSgf } from '../src/sgf/parse';
import { writeSgf } from '../src/sgf/write';
import { addChild, createNode, extendPath, nodeAt, nodesOnPath, type SgfNode } from '../src/tree';

/**
 * 根 ─ B[aa] ─┬ W[bb] ─ B[cc] ─ W[dd]   （本線）
 *             ├ W[ee] ─ B[ff]
 *             └ W[gg]
 */
function tree(): SgfNode {
  return parseSgf('(;SZ[9];B[aa](;W[bb];B[cc];W[dd])(;W[ee];B[ff])(;W[gg]))')[0];
}

const at = (x: number, y: number) => y * 9 + x;

describe('手順の移動', () => {
  it('前・次・深さを指定して移る。今の手順はそのまま', () => {
    const root = tree();
    let nav: Nav = { cursor: [], line: extendPath(root, []) };
    expect(nav.line).toEqual([0, 0, 0, 0]);
    expect(prev(nav)).toBeNull();
    nav = next(nav)!;
    nav = next(nav)!;
    expect(nav.cursor).toEqual([0, 0]);
    expect(prev(nav)).toEqual({ cursor: [0], line: [0, 0, 0, 0] });
    expect(goToDepth(nav, 99).cursor).toEqual([0, 0, 0, 0]);
    expect(next(goToDepth(nav, 4))).toBeNull();
    expect(goToDepth(nav, 0).cursor).toEqual([]);
  });

  it('今の手順の着手（打ち直さない）', () => {
    const root = parseSgf('(;SZ[9]AB[aa];B[bb];W[]MN[10];AB[cc]GBMV[])')[0];
    const moves = lineMoves(nodesOnPath(root, extendPath(root, []))!, 9);
    expect(moves.map((m) => [m.depth, m.color, m.point, m.number, m.captureless])).toEqual([
      [1, BLACK, at(1, 1), 1, false],
      [2, WHITE, null, 10, false],
      [3, BLACK, at(2, 2), 11, true],
    ]);
  });
});

describe('変化', () => {
  it('分かれ目: 今のノードに子が 2 つ以上あれば次の手、なければさかのぼって近いもの', () => {
    const root = tree();
    const line = [0, 1, 0];
    expect(forksOnLine(root, line)).toEqual([{ depth: 2, index: 1, count: 3 }]);
    expect(activeFork(root, { cursor: [], line })).toBeNull();
    expect(activeFork(root, { cursor: [0], line })).toEqual({ depth: 2, index: 1, count: 3 });
    expect(activeFork(root, { cursor: [0, 1, 0], line })?.depth).toBe(2);
    expect(activeFork(parseSgf('(;B[aa];W[bb])')[0], { cursor: [], line: [0] })).toBeNull();
  });

  it('変化を切り替えると、分かれ目の手前に移って、その変化をたどる手順にする', () => {
    const root = tree();
    let nav: Nav = { cursor: [0, 0, 0], line: [0, 0, 0, 0] };
    nav = switchVariation(root, nav, 1)!;
    expect(nav).toEqual({ cursor: [0], line: [0, 1, 0] });
    nav = switchVariation(root, nav, 1)!;
    expect(nav).toEqual({ cursor: [0], line: [0, 2] });
    expect(switchVariation(root, nav, 1)).toBeNull(); // 端
    nav = switchVariation(root, nav, -2 + 1)!;
    expect(nav.line).toEqual([0, 1, 0]);
    expect(selectVariation(root, nav, activeFork(root, nav)!, 0).line).toEqual([0, 0, 0, 0]);
  });

  it('変化の一覧と、次の手の候補の文字', () => {
    const root = tree();
    expect(variationsAt(root, [0], 9)).toEqual([
      { index: 0, first: { color: WHITE, point: at(1, 1) }, moves: 3, startsWithMove: true },
      { index: 1, first: { color: WHITE, point: at(4, 4) }, moves: 2, startsWithMove: true },
      { index: 2, first: { color: WHITE, point: at(6, 6) }, moves: 1, startsWithMove: true },
    ]);
    expect(variationsAt(parseSgf('(;(;AE[aa])(;W[]))')[0], [], 9).map((v) => [v.first, v.startsWithMove])).toEqual([
      [null, false],
      [{ color: WHITE, point: null }, true],
    ]);
    expect([0, 1, 25, 26].map(variationLetter)).toEqual(['A', 'B', 'Z', '27']);
  });

  it('候補の点に打つ子（同じ色を優先）', () => {
    const root = parseSgf('(;(;W[aa])(;B[aa])(;B[bb]))')[0];
    expect(childAt(root, 9, at(0, 0), BLACK)).toBe(1);
    expect(childAt(root, 9, at(0, 0), WHITE)).toBe(0);
    expect(childAt(root, 9, at(1, 1), WHITE)).toBe(2);
    expect(childAt(root, 9, at(2, 2), BLACK)).toBe(-1);
  });
});

describe('変化の整理', () => {
  it('本線にする: 経路の各分かれ目で最初の子に並べ替え、今のノードと手順は同じノードを指す', () => {
    const root = parseSgf('(;SZ[9](;B[aa])(;B[bb](;W[cc])(;W[dd];B[ee])))')[0];
    const target = nodeAt(root, [1, 1, 0])!;
    const nav: Nav = { cursor: [1, 1, 0], line: [1, 1, 0] };
    const res = promote(root, nav, [1, 1]);
    expect(writeSgf(res.root)).toBe('(;SZ[9]\n(;B[bb]\n(;W[dd]\n;B[ee])\n(;W[cc]))\n(;B[aa]))\n');
    expect(res.nav).toEqual({ cursor: [0, 0, 0], line: [0, 0, 0] });
    expect(nodeAt(res.root, res.nav.cursor)!.id).toBe(target.id);
    // 並べ替えた分かれ目のほかの子に入っている手順も付け直す
    const other = promote(root, { cursor: [1, 0], line: [1, 0] }, [1, 1]).nav;
    expect(other.cursor).toEqual([0, 1]);
    expect(isMainLine([0, 0])).toBe(true);
    expect(isMainLine([0, 1])).toBe(false);
  });

  it('削除: 消える部分に今のノードがあれば親に移る。後ろの兄弟の位置は詰める', () => {
    const root = tree();
    const inside = removeBranch(root, { cursor: [0, 1, 0], line: [0, 1, 0] }, [0, 1]);
    expect(inside.root.children[0].children).toHaveLength(2);
    expect(inside.nav).toEqual({ cursor: [0], line: [0, 0, 0, 0] });

    const after = removeBranch(root, { cursor: [0, 2], line: [0, 2] }, [0, 1]);
    expect(after.nav).toEqual({ cursor: [0, 1], line: [0, 1] });

    const before = removeBranch(root, { cursor: [0], line: [0, 0, 0, 0] }, [0, 0, 0]);
    expect(before.nav).toEqual({ cursor: [0], line: [0, 0] });
    expect(() => removeBranch(root, { cursor: [], line: [] }, [])).toThrow();
  });

  it('この手から先の着手の数', () => {
    const root = tree();
    expect(movesInBranch(root, [0], 9)).toBe(7);
    expect(movesInBranch(root, [0, 1], 9)).toBe(2);
  });
});

describe('編集の後の今の手順', () => {
  it('前の手順の最後のノードが残り、今のノードを通るならその手順を保つ', () => {
    const root = tree();
    const line = [0, 1, 0];
    const endId = lineEndId(root, line);
    expect(lineAfterEdit(root, [0], { line, endId })).toEqual(line);
    // 位置が変わっても id で探す
    const moved = promote(root, { cursor: [0], line }, [0, 1]).root;
    expect(lineAfterEdit(moved, [0], { line, endId })).toEqual([0, 0, 0]);
    // 今のノードを通らない・なくなったなら、今のノードから最初の子をたどる
    expect(lineAfterEdit(root, [0, 2], { line, endId })).toEqual([0, 2]);
    expect(lineAfterEdit(root, [0], null)).toEqual([0, 0, 0, 0]);
    // 手順の最後に子を足したら、その先も伸ばす
    const grown = addChild(root, line, createNode([['W', ['hh']]])).root;
    expect(lineAfterEdit(grown, [0], { line, endId })).toEqual([0, 1, 0, 0]);
  });
});
