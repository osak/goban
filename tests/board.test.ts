import { describe, expect, it } from 'vitest';
import { BLACK, Board, EMPTY, WHITE, type PlaceResult } from '../src/board';

/** 文字列で盤面を作る。'X' = 黒, 'O' = 白, '.' = 空 */
function boardFrom(rows: string[]): Board {
  const b = new Board(rows.length);
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === 'X') b.set(x, y, BLACK);
      else if (ch === 'O') b.set(x, y, WHITE);
    });
  });
  return b;
}

function toRows(b: Board): string[] {
  return Array.from({ length: b.size }, (_, y) =>
    Array.from({ length: b.size }, (_, x) => '.XO'[b.get(x, y)]).join(''),
  );
}

function captured(res: PlaceResult): readonly number[] {
  if (!res.ok) throw new Error(`place failed: ${res.reason}`);
  return res.captured;
}

describe('Board', () => {
  it('石を置いて取り除ける', () => {
    const b = new Board(9);
    expect(b.place(2, 3, BLACK, 'remove').ok).toBe(true);
    expect(b.get(2, 3)).toBe(BLACK);
    expect(b.place(2, 3, WHITE, 'remove')).toEqual({ ok: false, reason: 'occupied' });
    expect(b.remove(2, 3)).toBe(BLACK);
    expect(b.get(2, 3)).toBe(EMPTY);
    expect(b.remove(2, 3)).toBe(EMPTY);
    expect(b.place(9, 0, BLACK, 'remove')).toEqual({ ok: false, reason: 'out-of-bounds' });
  });

  it('不正な大きさは作れない', () => {
    expect(() => new Board(1)).toThrow(RangeError);
    expect(() => new Board(26)).toThrow(RangeError);
    expect(() => new Board(9, [1, 2])).toThrow(RangeError);
  });

  describe("取り除くモード ('remove')", () => {
    it('呼吸点のなくなった相手の石を取る', () => {
      const b = boardFrom(['.....', '..X..', '.XO..', '..X..', '.....']);
      expect(captured(b.place(3, 2, BLACK, 'remove'))).toEqual([b.index(2, 2)]);
      expect(toRows(b)).toEqual(['.....', '..X..', '.X.X.', '..X..', '.....']);
    });

    it('置いた石に接していない連はそのまま', () => {
      const b = boardFrom(['OOX..', 'XX...', '.....', '.....', '.....']);
      expect(captured(b.place(4, 4, BLACK, 'remove'))).toEqual([]);
      expect(b.get(0, 0)).toBe(WHITE);
    });

    it('辺の連をまとめて取る', () => {
      const b = boardFrom(['OO...', 'XXX..', '.....', '.....', '.....']);
      expect(captured(b.place(2, 0, BLACK, 'remove'))).toHaveLength(2);
      expect(toRows(b)[0]).toBe('..X..');
    });

    it('複数の連を同時に取る', () => {
      const b = boardFrom(['.XOX.', 'XO.OX', '.XOX.', '..X..', '.....']);
      expect(captured(b.place(2, 1, BLACK, 'remove'))).toHaveLength(4);
      expect(toRows(b).slice(0, 3)).toEqual(['.X.X.', 'X.X.X', '.X.X.']);
    });

    it('自殺手は置けない', () => {
      const b = boardFrom(['.X...', 'X....', '.....', '.....', '.....']);
      expect(b.place(0, 0, WHITE, 'remove')).toEqual({ ok: false, reason: 'suicide' });
      expect(b.get(0, 0)).toBe(EMPTY);
    });

    it('相手を取れるなら周りが相手の石でも置ける', () => {
      const b = boardFrom(['O.O..', 'XOX..', '.X...', '.....', '.....']);
      const res = captured(b.place(1, 0, BLACK, 'remove'));
      expect([...res].sort((a, c) => a - c)).toEqual([b.index(0, 0), b.index(1, 1)]);
      expect(b.get(1, 0)).toBe(BLACK);
      expect(b.get(2, 0)).toBe(WHITE);
    });
  });

  it.each(['mark', 'none'] as const)("'%s' モードでは盤面の他の石を変えない", (mode) => {
    const b = boardFrom(['.....', '..X..', '.XO..', '..X..', '.....']);
    expect(captured(b.place(3, 2, BLACK, mode))).toEqual([]);
    expect(b.get(2, 2)).toBe(WHITE);
    // 自殺手の位置にも置ける
    const b2 = boardFrom(['.X...', 'X....', '.....', '.....', '.....']);
    expect(b2.place(0, 0, WHITE, mode).ok).toBe(true);
  });

  it('deadStones: 呼吸点ゼロの連（黒白とも）', () => {
    const b = boardFrom(['OX...', 'XX...', '..XXX', '..OOX', '..XX.']);
    expect([...b.deadStones()]).toEqual([b.index(0, 0)]);
    b.set(1, 3, BLACK);
    const dead = b.deadStones();
    expect(dead.size).toBe(3);
    expect(dead.has(b.index(2, 3)) && dead.has(b.index(3, 3))).toBe(true);
  });

  it('serialize / deserialize', () => {
    const b = boardFrom(['X.O', '...', 'O.X']);
    expect(b.serialize()).toBe('102000201');
    expect(Board.deserialize(3, '102000201')?.equals(b)).toBe(true);
    expect(Board.deserialize(3, '12')).toBeNull();
    expect(Board.deserialize(3, '10200020x')).toBeNull();
    expect(Board.deserialize(3, 102000201)).toBeNull();
    expect(Board.deserialize(30, '0'.repeat(900))).toBeNull();
  });

  it('clone は独立したコピーを作る', () => {
    const b = boardFrom(['X..', '...', '...']);
    const c = b.clone();
    c.set(1, 1, WHITE);
    expect(b.get(1, 1)).toBe(EMPTY);
    expect(b.equals(c)).toBe(false);
  });
});
