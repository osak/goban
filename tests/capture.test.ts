import { describe, expect, it } from 'vitest';
import { BLACK, Board, WHITE } from '../src/board';
import { eraseCapturing, placeCapturing, settleCaptured } from '../src/capture';

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

/** 盤面に取られた石を重ねた文字列。取られた石は 'x' / 'o' */
function toRows(b: Board, captured: ReadonlySet<number>): string[] {
  return Array.from({ length: b.size }, (_, y) =>
    Array.from({ length: b.size }, (_, x) => {
      const i = b.index(x, y);
      return (captured.has(i) ? '.xo' : '.XO')[b.grid[i]];
    }).join(''),
  );
}

/** 盤面の石を取り除いて eraseCapturing を呼ぶ（アプリの消す操作と同じ） */
function erase(b: Board, captured: Set<number>, x: number, y: number): void {
  const i = b.index(x, y);
  const wasCaptured = captured.has(i);
  const color = b.remove(x, y);
  if (color !== 0) eraseCapturing(b, captured, i, color, wasCaptured);
}

// コウの形。黒が (2, 1) に打つと白 (1, 1) を取る
const KO = ['.XO..', 'XO.O.', '.XO..', '.....', '.....'];

describe('取られた石（△マーク）', () => {
  it('取った石は盤上に残して captured に入れる。取った側の石は取られない', () => {
    const b = boardFrom(KO);
    const captured = new Set<number>();
    const res = placeCapturing(b, captured, 2, 1, BLACK);
    expect(res).toEqual({ ok: true, captured: [b.index(1, 1)] });
    // 盤面だけで判定すると黒 (2, 1) も呼吸点がないが、取られたのは白だけ
    expect(b.deadStones().size).toBe(2);
    expect(toRows(b, captured)).toEqual(['.XO..', 'XoXO.', '.XO..', '.....', '.....']);
  });

  it('取られた石は、その後の判定で空点とみなす', () => {
    const b = boardFrom(KO);
    const captured = new Set<number>();
    placeCapturing(b, captured, 2, 1, BLACK);
    // 白が黒 (2, 1) の隣を埋めても、取られた白の跡が呼吸点なので黒は取られない
    expect(placeCapturing(b, captured, 2, 3, WHITE).ok).toBe(true);
    expect(captured).toEqual(new Set([b.index(1, 1)]));
    // 取られた石の上には置けない
    expect(placeCapturing(b, captured, 1, 1, WHITE)).toEqual({ ok: false, reason: 'occupied' });
  });

  it('取られた石を消してから打てば取り返せる', () => {
    const b = boardFrom(KO);
    const captured = new Set<number>();
    placeCapturing(b, captured, 2, 1, BLACK);
    erase(b, captured, 1, 1); // 取られた石を消すだけなら、ほかは変わらない
    expect(captured.size).toBe(0);
    expect(placeCapturing(b, captured, 1, 1, WHITE)).toEqual({ ok: true, captured: [b.index(2, 1)] });
    expect(toRows(b, captured)).toEqual(['.XO..', 'XOxO.', '.XO..', '.....', '.....']);
  });

  it('自殺手は置けない', () => {
    const b = boardFrom(['.X...', 'X....', '.....', '.....', '.....']);
    const captured = new Set<number>();
    expect(placeCapturing(b, captured, 0, 0, WHITE)).toEqual({ ok: false, reason: 'suicide' });
    expect(b.get(0, 0)).toBe(0);
    expect(captured.size).toBe(0);
  });

  it('取られた石だけで呼吸点がふさがっているなら自殺手ではない', () => {
    const b = boardFrom(['XO...', 'O....', '.....', '.....', '.....']);
    const captured = new Set([b.index(0, 0)]);
    // (1, 1) の白は (0, 0) の黒が取られているので、つながった白に呼吸点がある
    expect(placeCapturing(b, captured, 1, 1, WHITE).ok).toBe(true);
  });

  it('囲んでいる石を消すと、取られた石は元に戻る', () => {
    const b = boardFrom(['.....', '..X..', '.XO..', '.....', '.....']);
    const captured = new Set<number>();
    placeCapturing(b, captured, 2, 3, BLACK);
    placeCapturing(b, captured, 3, 2, BLACK);
    expect(captured).toEqual(new Set([b.index(2, 2)]));
    erase(b, captured, 3, 2);
    expect(captured.size).toBe(0);
  });

  it('つながった取られた石はまとめて元に戻る', () => {
    const b2 = boardFrom(['.OOX.', 'XXX..', '.....', '.....', '.....']);
    const captured = new Set<number>();
    placeCapturing(b2, captured, 0, 0, BLACK);
    expect(captured).toEqual(new Set([b2.index(1, 0), b2.index(2, 0)]));
    erase(b2, captured, 3, 0);
    expect(captured.size).toBe(0);
  });

  it('元に戻った石に囲まれて呼吸点がなくなった石は取られた石になる', () => {
    const b = boardFrom(KO);
    const captured = new Set<number>();
    placeCapturing(b, captured, 2, 1, BLACK);
    erase(b, captured, 0, 1); // 白 (1, 1) を囲む黒を消す
    // 白が戻り、黒 (2, 1) の呼吸点がなくなる
    expect(toRows(b, captured)).toEqual(['.XO..', '.OxO.', '.XO..', '.....', '.....']);
  });

  it('取られた石を消しても、それに隣り合う前に取られた石は戻らない', () => {
    // 白 (1, 1) を取った黒 (2, 1) が、あとで白に取られた
    const b = boardFrom(['.XO..', 'XOXO.', '.XO..', '.....', '.....']);
    const captured = new Set([b.index(1, 1), b.index(2, 1)]);
    erase(b, captured, 2, 1);
    expect(captured).toEqual(new Set([b.index(1, 1)]));
  });

  it('取った石を消すと、取られた石は元に戻る（置き間違いの修正）', () => {
    const b = boardFrom(KO);
    const captured = new Set<number>();
    placeCapturing(b, captured, 2, 1, BLACK);
    erase(b, captured, 2, 1);
    expect(captured.size).toBe(0);
    expect(toRows(b, captured)).toEqual(KO);
  });

  it('打った順が分からない盤面では呼吸点のない連をすべて取られた石にする', () => {
    const b = boardFrom(['.XO..', 'XOXO.', '.XO..', '.....', '.....']);
    const captured = new Set<number>();
    settleCaptured(b, captured);
    expect(captured).toEqual(new Set([b.index(1, 1), b.index(2, 1)]));
  });

  it('settleCaptured は石のない交点を除き、今ある取られた石は残す', () => {
    const b = boardFrom(['.XO..', 'XOXO.', '.XO..', '.....', '.....']);
    const captured = new Set([b.index(1, 1), b.index(4, 4)]);
    settleCaptured(b, captured);
    expect(captured).toEqual(new Set([b.index(1, 1)]));
  });
});
