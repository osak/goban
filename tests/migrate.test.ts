import { describe, expect, it } from 'vitest';
import { BLACK, Board, WHITE } from '../src/board';
import { docName, docNodes, labelsAt, nextColorOf, trianglesAt } from '../src/edit';
import { positionOf } from '../src/game';
import {
  deserializeLabels,
  deserializeMoves,
  deserializePoints,
  migrateV1Entry,
  parseV1Entry,
  parseV1Library,
  type V1Entry,
  type V1Move,
} from '../src/migrate';
import { writeSgf } from '../src/sgf/write';
import { fullView } from '../src/view';

const B = (x: number, y: number): V1Move => ({ x, y, color: BLACK });
const W = (x: number, y: number): V1Move => ({ x, y, color: WHITE });

/** v1 の盤面を作る。board を省くと moves を「取り除く」モードで打った盤面 */
function v1(size: number, moves: V1Move[], extra: Partial<V1Entry> = {}): V1Entry {
  const board = new Board(size);
  for (const m of moves) board.place(m.x, m.y, m.color, 'remove');
  return {
    id: 'a',
    name: '盤面 1',
    createdAt: 1,
    updatedAt: 2,
    board,
    moves,
    marks: new Set(),
    labels: new Map(),
    numberFrom: 0,
    nextColor: BLACK,
    view: fullView(size),
    ...extra,
  };
}

function migrate(e: V1Entry) {
  const { doc, view } = migrateV1Entry(e);
  const pos = positionOf(docNodes(doc));
  return { doc, view, pos, sgf: writeSgf(doc.root) };
}

describe('v1 の保存形式', () => {
  it('着手・交点・文字を読む', () => {
    expect(deserializeMoves(19, 'BaaWss')).toEqual([B(0, 0), W(18, 18)]);
    expect(deserializeMoves(9, 'Bja')).toBeNull();
    expect(deserializeMoves(19, 'Xaa')).toBeNull();
    expect(deserializePoints(19, 'aapd')).toEqual(new Set([0, 3 * 19 + 15]));
    expect(deserializePoints(19, 'a')).toBeNull();
    expect(deserializeLabels(9, { aa: 'A', zz: 'B', bb: 'CD' })).toEqual(new Map([[0, 'A']]));
    expect(deserializeLabels(9, 'x')).toEqual(new Map());
  });

  it('盤面の一覧を検証する', () => {
    const ok = { id: 'a', name: ' 定石 ', size: 9, stones: '0'.repeat(81), moves: 'Bzz', numberFrom: -1, nextColor: 9 };
    const lib = parseV1Library({ currentId: 'x', entries: [ok, { ...ok, id: 'b', size: 7 }, { ...ok }] });
    expect(lib?.currentId).toBe('a');
    expect(lib?.entries).toHaveLength(1);
    expect(lib?.entries[0]).toMatchObject({ name: '定石', moves: [], numberFrom: 0, nextColor: BLACK });
    expect(parseV1Entry({ ...ok, name: '' })?.name).toBe('無題');
  });
});

describe('v1 からの移行', () => {
  it('着手の記録を着手ノードにする', () => {
    const { sgf, pos, doc } = migrate(v1(9, [B(2, 2), W(6, 6), B(2, 6)]));
    expect(sgf).toBe('(;GM[1]FF[4]CA[UTF-8]AP[goban:1.0]SZ[9]GN[盤面 1]\n;B[cc]\n;W[gg]\n;B[cg])\n');
    expect(pos.moves).toHaveLength(3);
    expect(doc.cursor).toEqual([0, 0, 0]);
    expect(docName(doc)).toBe('盤面 1');
  });

  it('石のある点に打つ手の前に AE を挟み、最後の局面が違えば差分の配置を足す', () => {
    // (0,0) の黒を手で消して白を打ち、さらに (4,4) の白を手で消した
    const board = new Board(9);
    board.set(0, 0, WHITE);
    const e = v1(9, [B(0, 0), W(4, 4), W(0, 0)], { board });
    const { sgf, pos } = migrate(e);
    expect(sgf).toContain(';B[aa]\n;W[ee]\n;AE[aa]\n;W[aa]\n;AE[ee])');
    expect(pos.board.equals(board)).toBe(true);
    expect(pos.moves).toHaveLength(3);
  });

  it('「何もしない」で置いた石（取りが起きる手）も、最後の局面は保存されていた配置と同じ', () => {
    const board = new Board(5);
    for (const m of [B(1, 0), W(0, 0), B(0, 1)]) board.place(m.x, m.y, m.color, 'none');
    const { pos } = migrate(v1(5, [B(1, 0), W(0, 0), B(0, 1)], { board }));
    expect(pos.board.equals(board)).toBe(true);
  });

  it('番号の起点を GBNS にする', () => {
    const moves = [B(0, 0), W(1, 1), B(2, 2)];
    expect(migrate(v1(9, moves, { numberFrom: 2 })).pos.numberFrom).toBe(2);
    expect(migrate(v1(9, moves, { numberFrom: 2 })).sgf).toContain(';W[bb]GBNS[]\n;B[cc])');
    expect(migrate(v1(9, moves, { numberFrom: 3 })).pos.numberFrom).toBe(3);
    expect(migrate(v1(9, moves, { numberFrom: 9 })).pos.numberFrom).toBe(3);
    expect(migrate(v1(9, moves, { numberFrom: 0 })).sgf).not.toContain('GBNS');
  });

  it('△（石のあるところだけ）と文字を最後のノードに付ける', () => {
    const e = v1(9, [B(0, 0)], { marks: new Set([0, 40]), labels: new Map([[1, 'A']]) });
    const { doc } = migrate(e);
    expect(trianglesAt(doc)).toEqual(new Set([0]));
    expect(labelsAt(doc)).toEqual(new Map([[1, 'A']]));
  });

  it('手番: 打ち直した手番と違うときだけ、配置ノードなら PL、着手ノードなら一時的な入れ替え', () => {
    const asMove = migrate(v1(9, [B(0, 0)], { nextColor: BLACK }));
    expect(asMove.doc.turn).toBe(BLACK);
    expect(nextColorOf(asMove.doc, asMove.pos)).toBe(BLACK);
    expect(migrate(v1(9, [B(0, 0)], { nextColor: WHITE })).doc.turn).toBeNull();

    const empty = migrate(v1(9, [], { nextColor: WHITE }));
    expect(empty.sgf).toContain('PL[W]');
    expect(empty.pos.nextColor).toBe(WHITE);
    expect(migrate(v1(9, [], { nextColor: BLACK })).sgf).not.toContain('PL');
  });

  it('表示範囲はそのまま', () => {
    const view = { x0: 0, y0: 0, x1: 4, y1: 4 };
    expect(migrate(v1(9, [], { view })).view).toEqual(view);
  });
});
