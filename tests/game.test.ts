import { describe, expect, it } from 'vitest';
import { BLACK, EMPTY, WHITE } from '../src/board';
import { capturelessMoveNode, capturelessMoveOf, hasNumberStart, withNumberStart } from '../src/ext';
import {
  PositionCache,
  boardSizeOf,
  labelsOf,
  moveOf,
  newGameRoot,
  positionOf,
  setupOf,
  trianglesOf,
  type GamePosition,
} from '../src/game';
import { parseSgf } from '../src/sgf/parse';
import { writeSgf } from '../src/sgf/write';
import {
  addChild,
  countNodes,
  createNode,
  extendPath,
  findPath,
  getValue,
  moveChild,
  nodeAt,
  nodesOnPath,
  removeAt,
  setProp,
  updateAt,
  type SgfNode,
} from '../src/tree';

function root(text: string): SgfNode {
  const [r] = parseSgf(text);
  return r;
}

/** 最初の子をたどった最後のノードの局面 */
function mainLineEnd(text: string): GamePosition {
  const r = root(text);
  return positionOf(nodesOnPath(r, extendPath(r, []))!);
}

/** 盤を 1 行 1 文字列にする（. 空 / X 黒 / O 白） */
function rows(p: GamePosition): string[] {
  const out: string[] = [];
  for (let y = 0; y < p.size; y++) {
    let line = '';
    for (let x = 0; x < p.size; x++) line += '.XO'[p.board.grid[y * p.size + x]];
    out.push(line);
  }
  return out;
}

describe('tree', () => {
  const base = () => root('(;SZ[9];B[aa](;W[bb];B[cc])(;W[dd]))');

  it('path のノードと、根からの列', () => {
    const r = base();
    expect(getValue(nodeAt(r, [0, 1])!, 'W')).toBe('dd');
    expect(nodeAt(r, [0, 2])).toBeNull();
    expect(nodesOnPath(r, [0, 0, 0])!.map((n) => getValue(n, 'B') ?? getValue(n, 'W') ?? '')).toEqual([
      '',
      'aa',
      'bb',
      'cc',
    ]);
  });

  it('編集は根までを作り直し、id を引き継ぎ、変えていない部分木とプロパティは共有する', () => {
    const r = base();
    const next = updateAt(r, [0, 0], (n) => setProp(n, 'C', ['x']));
    expect(next).not.toBe(r);
    expect(next.id).toBe(r.id);
    expect(next.props).toBe(r.props);
    expect(nodeAt(next, [0, 0])!.id).toBe(nodeAt(r, [0, 0])!.id);
    expect(nodeAt(next, [0, 1])).toBe(nodeAt(r, [0, 1]));
    expect(nodeAt(next, [0, 0, 0])).toBe(nodeAt(r, [0, 0, 0]));
    // 元のツリーは変わらない
    expect(nodeAt(r, [0, 0])!.props.has('C')).toBe(false);
  });

  it('子を最後に足し、その path を返す', () => {
    const { root: next, path } = addChild(base(), [0], createNode([['W', ['ee']]]));
    expect(path).toEqual([0, 2]);
    expect(getValue(nodeAt(next, path)!, 'W')).toBe('ee');
  });

  it('ノードを消す・子を並べ替える', () => {
    const r = base();
    expect(nodeAt(removeAt(r, [0, 0]), [0])!.children.map((c) => getValue(c, 'W'))).toEqual(['dd']);
    expect(() => removeAt(r, [])).toThrow(RangeError);
    expect(nodeAt(moveChild(r, [0], 1, 0), [0])!.children.map((c) => getValue(c, 'W'))).toEqual(['dd', 'bb']);
  });

  it('setProp は位置を保って書き換え、null で消す', () => {
    const n = createNode([
      ['A', ['1']],
      ['B', ['2']],
    ]);
    expect([...setProp(n, 'A', ['3']).props]).toEqual([
      ['A', ['3']],
      ['B', ['2']],
    ]);
    expect([...setProp(n, 'A', null).props.keys()]).toEqual(['B']);
    expect(setProp(n, 'Z', null)).toBe(n);
  });

  it('id から path を求め、最初の子をたどって伸ばす', () => {
    const r = base();
    expect(findPath(r, nodeAt(r, [0, 1])!.id)).toEqual([0, 1]);
    expect(findPath(r, -1)).toBeNull();
    expect(extendPath(r, [0])).toEqual([0, 0, 0]);
    expect(extendPath(r, [0, 1])).toEqual([0, 1]);
    expect(countNodes(r)).toBe(5);
  });
});

describe('ノードの読み取り', () => {
  it('盤の大きさ', () => {
    expect(boardSizeOf(root('(;)'))).toBe(19);
    expect(boardSizeOf(root('(;SZ[9])'))).toBe(9);
    expect(boardSizeOf(root('(;SZ[13:13])'))).toBe(13);
    expect(boardSizeOf(root('(;SZ[19:13])'))).toBeNull();
    expect(boardSizeOf(root('(;SZ[26])'))).toBeNull();
    expect(boardSizeOf(root('(;SZ[1])'))).toBeNull();
    expect(boardSizeOf(root('(;SZ[x])'))).toBeNull();
  });

  it('着手（パスは [] と 19 路以下の [tt]）', () => {
    expect(moveOf(root('(;B[cb])'), 9)).toEqual({ color: BLACK, point: 9 + 2 });
    expect(moveOf(root('(;W[])'), 19)).toEqual({ color: WHITE, point: null });
    expect(moveOf(root('(;W[tt])'), 19)).toEqual({ color: WHITE, point: null });
    expect(moveOf(root('(;W[tt])'), 21)).toEqual({ color: WHITE, point: 19 * 21 + 19 });
    expect(moveOf(root('(;C[x])'), 19)).toBeNull();
  });

  it('配置・△・文字', () => {
    const n = root('(;AB[aa:ba]AW[cc]AE[dd]PL[w]TR[aa][zz]LB[cc:A][bb:x\\:y\\]])');
    expect(setupOf(n, 9)).toEqual({ black: [0, 1], white: [20], empty: [30], player: WHITE });
    expect(trianglesOf(n, 9)).toEqual(new Set([0]));
    expect(labelsOf(n, 9)).toEqual(
      new Map([
        [20, 'A'],
        [10, 'x:y]'],
      ]),
    );
  });

  it('新しいゲームの根', () => {
    const r = newGameRoot(13, '名前[1]');
    expect(writeSgf(r)).toBe('(;GM[1]FF[4]CA[UTF-8]AP[goban:1.0]SZ[13]GN[名前[1\\]])\n');
    expect(newGameRoot(9, '  ').props.has('GN')).toBe(false);
  });
});

describe('拡張プロパティ', () => {
  it('取りなしの着手', () => {
    const n = capturelessMoveNode(WHITE, 2, 1);
    expect(writeSgf(n)).toBe('(;AW[cb]GBMV[])\n');
    expect(capturelessMoveOf(n, 9)).toEqual({ color: WHITE, point: 11 });
    // 2 点以上あれば着手とみなさない
    expect(capturelessMoveOf(root('(;AB[aa][bb]GBMV[])'), 9)).toBeNull();
    expect(capturelessMoveOf(root('(;AB[aa])'), 9)).toBeNull();
  });

  it('番号の起点', () => {
    const n = withNumberStart(createNode(), true);
    expect(hasNumberStart(n)).toBe(true);
    expect(writeSgf(n)).toBe('(;GBNS[])\n');
    expect(hasNumberStart(withNumberStart(n, false))).toBe(false);
  });
});

describe('局面の導出', () => {
  it('相手の石を取る', () => {
    const p = mainLineEnd('(;SZ[5];B[ba];W[aa];B[ab])');
    expect(rows(p)[0]).toBe('.X...');
    expect(rows(p)[1]).toBe('X....');
    expect(p.captured).toEqual(new Map([[0, WHITE]]));
    expect(p.moves.map((m) => m.number)).toEqual([1, 2, 3]);
    expect(p.nextColor).toBe(WHITE);
  });

  it('自殺手は自分の連を取り除く（取られた石として記録する）', () => {
    const p = mainLineEnd('(;SZ[5];B[ba];B[ab];W[aa])');
    expect(p.board.grid[0]).toBe(EMPTY);
    expect(p.captured).toEqual(new Map([[0, WHITE]]));
    expect(p.nextColor).toBe(BLACK);
  });

  it('石のある点への手は上書きする', () => {
    const p = mainLineEnd('(;SZ[5];B[cc];W[cc])');
    expect(p.board.grid[12]).toBe(WHITE);
  });

  it('取られた点にまた石が置かれたら、取られた石の記録から外す', () => {
    const p = mainLineEnd('(;SZ[5];B[ba];W[aa];B[ab];W[ee];B[aa])');
    expect(p.captured.size).toBe(0);
    const q = mainLineEnd('(;SZ[5];B[ba];W[aa];B[ab];AB[aa])');
    expect(q.captured.size).toBe(0);
  });

  it('配置は AE → AB → AW の順に上書きし、取りを起こさない', () => {
    const p = mainLineEnd('(;SZ[3]AB[aa:cc];AW[ba]AE[aa][ba];AB[ba]AW[ba])');
    expect(rows(p)).toEqual(['.OX', 'XXX', 'XXX']);
    expect(p.captured.size).toBe(0);
    expect(p.moves).toEqual([]);
  });

  it('パスも 1 手に数える', () => {
    const p = mainLineEnd('(;SZ[9];B[aa];W[];B[bb])');
    expect(p.moves.map((m) => [m.color, m.point, m.number])).toEqual([
      [BLACK, 0, 1],
      [WHITE, null, 2],
      [BLACK, 10, 3],
    ]);
  });

  it('MN は手数を変える', () => {
    const p = mainLineEnd('(;SZ[9];B[aa]MN[50];W[bb])');
    expect(p.moves.map((m) => m.number)).toEqual([50, 51]);
  });

  it('取りなしの着手は、取りを起こさずに 1 手に数える', () => {
    const p = mainLineEnd('(;SZ[5];B[ba];B[ab];AW[aa]GBMV[])');
    expect(p.board.grid[0]).toBe(WHITE);
    expect(p.moves.map((m) => [m.color, m.point, m.captureless])).toEqual([
      [BLACK, 1, false],
      [BLACK, 5, false],
      [WHITE, 0, true],
    ]);
    expect(p.nextColor).toBe(BLACK);
  });

  it('番号の起点は経路上でいちばん深い GBNS', () => {
    const r = root('(;SZ[9];B[aa]GBNS[];W[bb](;B[cc]GBNS[];W[dd])(;B[ee]))');
    expect(positionOf(nodesOnPath(r, [0, 0, 0, 0])!).numberFrom).toBe(3);
    expect(positionOf(nodesOnPath(r, [0, 0, 1])!).numberFrom).toBe(1);
    expect(positionOf(nodesOnPath(r, [])!).numberFrom).toBe(0);
  });

  it('次の手番: 着手か PL のうち今のノードにいちばん近いもの、なければ黒', () => {
    expect(mainLineEnd('(;SZ[9])').nextColor).toBe(BLACK);
    expect(mainLineEnd('(;SZ[9]AB[aa]PL[W])').nextColor).toBe(WHITE);
    expect(mainLineEnd('(;SZ[9]PL[W];AB[bb])').nextColor).toBe(WHITE);
    expect(mainLineEnd('(;SZ[9]PL[W];B[aa])').nextColor).toBe(WHITE);
    expect(mainLineEnd('(;SZ[9];B[aa];PL[B])').nextColor).toBe(BLACK);
  });

  it('扱えない盤の大きさは例外', () => {
    expect(() => positionOf([root('(;SZ[19:13])')])).toThrow(RangeError);
  });

  it('着手の一覧はノードの id と深さを持つ', () => {
    const r = root('(;SZ[9];C[x];B[aa])');
    const p = positionOf(nodesOnPath(r, [0, 0])!);
    expect(p.moves[0]).toMatchObject({ nodeId: nodeAt(r, [0, 0])!.id, depth: 2 });
  });
});

describe('PositionCache', () => {
  const text = '(;SZ[9];B[ee];W[ce](;B[gg];W[gc])(;B[cg];W[ec]))';

  it('キャッシュを使っても使わなくても同じ局面になる', () => {
    let r = root(text);
    const cache = new PositionCache();
    const check = (path: number[]) => {
      const nodes = nodesOnPath(r, path)!;
      const a = cache.position(nodes);
      const b = positionOf(nodes);
      expect(a.board.serialize()).toBe(b.board.serialize());
      expect(a.moves).toEqual(b.moves);
      expect(a.nextColor).toBe(b.nextColor);
      expect(a.numberFrom).toBe(b.numberFrom);
      expect(a.captured).toEqual(b.captured);
    };
    check([0, 0, 0, 0]);
    check([0, 0, 1, 0]); // 変化へ
    check([0]); // 戻る
    check([0, 0, 0]);
    // 子を足す
    const added = addChild(r, [0, 0, 0], createNode([['W', ['hh']]]));
    r = added.root;
    check(added.path);
    // 途中のノードを書き換える
    r = updateAt(r, [0], (n) => setProp(n, 'B', ['ff']));
    check(added.path);
    // 番号の起点を付ける
    r = updateAt(r, [0, 0], (n) => withNumberStart(n, true));
    check(added.path);
  });

  it('子を足しただけなら、それより前の局面を打ち直さない', () => {
    const r = root(text);
    const cache = new PositionCache();
    const before = cache.position(nodesOnPath(r, [0, 0])!);
    const boardAtDepth2 = before.board;
    const added = addChild(r, [0, 0], createNode([['B', ['aa']]]));
    const after = cache.position(nodesOnPath(added.root, added.path)!);
    expect(after.board).not.toBe(boardAtDepth2);
    // 前の局面の盤は書き換えていない
    expect(boardAtDepth2.grid[0]).toBe(EMPTY);
    expect(after.board.grid[0]).toBe(BLACK);
    // 戻ると、前に求めた盤をそのまま返す
    expect(cache.position(nodesOnPath(added.root, [0, 0])!).board).toBe(boardAtDepth2);
  });

  it('19 路で 300 手を打ち直せる', () => {
    let s = '(;SZ[19]';
    for (let k = 0; k < 300; k++) {
      const x = (k * 7) % 19;
      const y = (k * 11) % 19;
      s += `;${k % 2 ? 'W' : 'B'}[${'abcdefghijklmnopqrs'[x]}${'abcdefghijklmnopqrs'[y]}]`;
    }
    const p = mainLineEnd(s + ')');
    expect(p.moves).toHaveLength(300);
  });
});
