import { describe, expect, it } from 'vitest';
import { BLACK, Board, WHITE, type StoneColor } from '../src/board';
import { moveLabel, movesOnBoard, stoneNumbers } from '../src/moves';

interface M {
  readonly x: number;
  readonly y: number;
  readonly color: StoneColor;
}

/** moves を順に置いた盤面（captureMode は 'remove'） */
function play(size: number, moves: M[]): Board {
  const b = new Board(size);
  for (const m of moves) expect(b.place(m.x, m.y, m.color, 'remove').ok).toBe(true);
  return b;
}

/** 盤面の手を、経路上の手（交点のインデックスと手数）にする */
function log(size: number, moves: M[]) {
  return moves.map((m, i) => ({ point: m.y * size + m.x, color: m.color, number: i + 1 }));
}

const B = (x: number, y: number): M => ({ x, y, color: BLACK });
const W = (x: number, y: number): M => ({ x, y, color: WHITE });

describe('着手番号', () => {
  it('起点より前の手には番号を付けない', () => {
    const moves = log(9, [B(0, 0), B(1, 0), B(2, 0), B(3, 0), B(4, 0), B(5, 0)]);
    expect(moveLabel(moves, 2, 3, 'relative')).toBeNull();
    expect(moveLabel(moves, 3, 3, 'relative')).toBe(1);
    expect(moveLabel(moves, 5, 3, 'relative')).toBe(3);
    expect(moveLabel(moves, 5, 3, 'absolute')).toBe(6);
  });

  it('「手数」は手の手数（MN）に従う', () => {
    const moves = [{ number: 50 }, { number: 51 }];
    expect(moveLabel(moves, 1, 0, 'absolute')).toBe(51);
    expect(moveLabel(moves, 1, 0, 'relative')).toBe(2);
  });

  it('パスは盤上の石に数えない', () => {
    const b = new Board(9);
    b.set(0, 0, BLACK);
    const moves: Array<{ point: number | null; color: StoneColor; number: number }> = [
      { point: 0, color: BLACK, number: 1 },
      { point: null, color: WHITE, number: 2 },
    ];
    expect(movesOnBoard(b, moves)).toEqual(new Set([0]));
  });

  it('盤上の石に番号を付ける', () => {
    const moves = [B(2, 2), W(6, 6), B(2, 6), W(6, 2)];
    const b = play(9, moves);
    expect(stoneNumbers(b, log(9, moves), 0, 'relative')).toEqual(
      new Map([
        [b.index(2, 2), 1],
        [b.index(6, 6), 2],
        [b.index(2, 6), 3],
        [b.index(6, 2), 4],
      ]),
    );
    expect(stoneNumbers(b, log(9, moves), 2, 'relative')).toEqual(
      new Map([
        [b.index(2, 6), 1],
        [b.index(6, 2), 2],
      ]),
    );
    expect(stoneNumbers(b, log(9, moves), 2, 'absolute')).toEqual(
      new Map([
        [b.index(2, 6), 3],
        [b.index(6, 2), 4],
      ]),
    );
    // 起点が記録より先なら番号はない
    expect(stoneNumbers(b, log(9, moves), 4, 'relative').size).toBe(0);
  });

  it('同色の連打もそのまま番号を付ける', () => {
    const moves = [B(0, 0), B(1, 1), B(2, 2)];
    const b = play(9, moves);
    expect([...stoneNumbers(b, log(9, moves), 0, 'relative').values()]).toEqual([1, 2, 3]);
  });

  it('取られた石には番号を付けず、同じ交点に打ち直した手の番号を付ける', () => {
    // 隅の白 (0,0) を黒 (1,0)・(0,1) で取り、そこに白が打ち直す
    const moves2 = [W(0, 0), B(1, 0), W(4, 4), B(0, 1)];
    const b2 = play(5, moves2);
    expect(b2.get(0, 0)).toBe(0);
    expect(movesOnBoard(b2, log(5, moves2))).toEqual(new Set([1, 2, 3]));
    const moves3 = [...moves2, W(0, 0)];
    b2.place(0, 0, WHITE, 'none');
    const n = stoneNumbers(b2, log(5, moves3), 0, 'relative');
    expect(n.get(b2.index(0, 0))).toBe(5);
    expect([...n.values()].sort()).toEqual([2, 3, 4, 5]);
  });

  it('記録と色が合わない石には番号を付けない', () => {
    const b = new Board(9);
    b.set(3, 3, WHITE);
    expect(stoneNumbers(b, log(9, [B(3, 3)]), 0, 'relative').size).toBe(0);
  });
});
