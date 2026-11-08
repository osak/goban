import { describe, expect, it } from 'vitest';
import { BLACK, Board, WHITE } from '../src/board';
import {
  deserializeMoves,
  moveLabel,
  movesOnBoard,
  serializeMoves,
  stoneNumbers,
  withoutLastMoveAt,
  type Move,
} from '../src/moves';

/** moves を順に置いた盤面（captureMode は 'remove'） */
function play(size: number, moves: Move[]): Board {
  const b = new Board(size);
  for (const m of moves) expect(b.place(m.x, m.y, m.color, 'remove').ok).toBe(true);
  return b;
}

const B = (x: number, y: number): Move => ({ x, y, color: BLACK });
const W = (x: number, y: number): Move => ({ x, y, color: WHITE });

describe('着手番号', () => {
  it('起点より前の手には番号を付けない', () => {
    expect(moveLabel(2, 3, 'relative')).toBeNull();
    expect(moveLabel(3, 3, 'relative')).toBe(1);
    expect(moveLabel(5, 3, 'relative')).toBe(3);
    expect(moveLabel(5, 3, 'absolute')).toBe(6);
  });

  it('盤上の石に番号を付ける', () => {
    const moves = [B(2, 2), W(6, 6), B(2, 6), W(6, 2)];
    const b = play(9, moves);
    expect(stoneNumbers(b, moves, 0, 'relative')).toEqual(
      new Map([
        [b.index(2, 2), 1],
        [b.index(6, 6), 2],
        [b.index(2, 6), 3],
        [b.index(6, 2), 4],
      ]),
    );
    expect(stoneNumbers(b, moves, 2, 'relative')).toEqual(
      new Map([
        [b.index(2, 6), 1],
        [b.index(6, 2), 2],
      ]),
    );
    expect(stoneNumbers(b, moves, 2, 'absolute')).toEqual(
      new Map([
        [b.index(2, 6), 3],
        [b.index(6, 2), 4],
      ]),
    );
    // 起点が記録より先なら番号はない
    expect(stoneNumbers(b, moves, 4, 'relative').size).toBe(0);
  });

  it('同色の連打もそのまま番号を付ける', () => {
    const moves = [B(0, 0), B(1, 1), B(2, 2)];
    const b = play(9, moves);
    expect([...stoneNumbers(b, moves, 0, 'relative').values()]).toEqual([1, 2, 3]);
  });

  it('取られた石には番号を付けず、同じ交点に打ち直した手の番号を付ける', () => {
    // 隅の白 (0,0) を黒 (1,0)・(0,1) で取り、そこに白が打ち直す
    const moves2 = [W(0, 0), B(1, 0), W(4, 4), B(0, 1)];
    const b2 = play(5, moves2);
    expect(b2.get(0, 0)).toBe(0);
    expect(movesOnBoard(b2, moves2)).toEqual(new Set([1, 2, 3]));
    const moves3 = [...moves2, W(0, 0)];
    b2.place(0, 0, WHITE, 'none');
    const n = stoneNumbers(b2, moves3, 0, 'relative');
    expect(n.get(b2.index(0, 0))).toBe(5);
    expect([...n.values()].sort()).toEqual([2, 3, 4, 5]);
  });

  it('記録と色が合わない石には番号を付けない', () => {
    const b = new Board(9);
    b.set(3, 3, WHITE);
    expect(stoneNumbers(b, [B(3, 3)], 0, 'relative').size).toBe(0);
  });

  it('最後の手の石を消したときだけ記録から消す', () => {
    const moves = [B(0, 0), W(1, 1)];
    expect(withoutLastMoveAt(moves, 1, 1, WHITE)).toEqual([B(0, 0)]);
    expect(withoutLastMoveAt(moves, 0, 0, BLACK)).toBeNull();
    expect(withoutLastMoveAt(moves, 1, 1, BLACK)).toBeNull();
    expect(withoutLastMoveAt([], 1, 1, BLACK)).toBeNull();
  });
});

describe('着手の記録の保存形式', () => {
  it('文字列にして元に戻せる', () => {
    const moves = [B(0, 0), W(18, 18), B(3, 15), W(24, 0)];
    const text = serializeMoves(moves);
    expect(text).toBe('BaaWssBdpWya');
    expect(deserializeMoves(25, text)).toEqual(moves);
    expect(deserializeMoves(19, '')).toEqual([]);
  });

  it('不正なら null', () => {
    expect(deserializeMoves(19, 'Bt')).toBeNull(); // 長さ
    expect(deserializeMoves(19, 'Xaa')).toBeNull(); // 色
    expect(deserializeMoves(19, 'Bta')).toBeNull(); // 盤外
    expect(deserializeMoves(9, 'Bja')).toBeNull();
    expect(deserializeMoves(19, 42)).toBeNull();
  });
});
