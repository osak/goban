import { describe, expect, it } from 'vitest';
import { BLACK, Board, WHITE } from '../src/board';
import type { Move } from '../src/moves';
import { escapeSgfText, replaysTo, toSgf, type SgfParams } from '../src/sgf';
import { fullView } from '../src/view';

function params(board: Board, moves: Move[], extra: Partial<SgfParams> = {}): SgfParams {
  return {
    board,
    moves,
    marks: new Set(),
    captured: new Set(),
    labels: new Map(),
    view: fullView(board.size),
    ...extra,
  };
}

/** moves を「取り除く」モードで打った盤面 */
function played(size: number, moves: Move[]): Board {
  const b = new Board(size);
  for (const m of moves) expect(b.place(m.x, m.y, m.color, 'remove').ok).toBe(true);
  return b;
}

describe('escapeSgfText', () => {
  it('] と \\ と : をエスケープする', () => {
    expect(escapeSgfText('a]b\\c:d')).toBe('a\\]b\\\\c\\:d');
    expect(escapeSgfText('黒番')).toBe('黒番');
  });
});

describe('replaysTo', () => {
  it('取りを含めて打ち直せるか', () => {
    // 白 (1,0) を黒 3 子で囲んで取る（隅ではなく上辺）
    const moves: Move[] = [
      { x: 1, y: 0, color: WHITE },
      { x: 0, y: 0, color: BLACK },
      { x: 2, y: 0, color: BLACK },
      { x: 1, y: 1, color: BLACK },
    ];
    const b = played(9, moves);
    expect(b.get(1, 0)).toBe(0);
    expect(replaysTo(b, moves)).toBe(true);
    b.remove(0, 0); // 手で石を消した
    expect(replaysTo(b, moves)).toBe(false);
  });

  it('石のある交点に打つ手があれば false', () => {
    const b = new Board(9);
    b.set(0, 0, WHITE);
    const moves: Move[] = [
      { x: 0, y: 0, color: BLACK },
      { x: 0, y: 0, color: WHITE },
    ];
    expect(replaysTo(b, moves)).toBe(false);
  });
});

describe('toSgf', () => {
  it('空の盤', () => {
    expect(toSgf(params(new Board(19), []))).toBe('(;GM[1]FF[4]CA[UTF-8]AP[goban:1.0]SZ[19]\n)\n');
  });

  it('打ち直せるログは手順として出力し、△と文字を最後の手に付ける', () => {
    const moves: Move[] = [
      { x: 3, y: 3, color: BLACK },
      { x: 15, y: 15, color: WHITE },
      { x: 2, y: 15, color: BLACK },
    ];
    const board = played(19, moves);
    const sgf = toSgf(
      params(board, moves, {
        name: '定石 [1]',
        marks: new Set([board.index(3, 3)]),
        labels: new Map([
          [board.index(4, 4), 'A'],
          [board.index(0, 0), ':'],
        ]),
        nextColor: WHITE,
      }),
    );
    expect(sgf).toBe(
      '(;GM[1]FF[4]CA[UTF-8]AP[goban:1.0]SZ[19]GN[定石 [1\\]]\n;B[dd]\n;W[pp]\n;B[cp]TR[dd]LB[aa:\\:][ee:A]\n)\n',
    );
  });

  it('打ち直せないときは今の盤面を配置として出力する', () => {
    const board = new Board(9);
    board.set(0, 0, BLACK);
    board.set(1, 0, BLACK);
    board.set(8, 8, WHITE);
    const moves: Move[] = [{ x: 4, y: 4, color: BLACK }]; // 盤上にない手
    const sgf = toSgf(params(board, moves, { nextColor: BLACK, marks: new Set([board.index(8, 8)]) }));
    expect(sgf).toBe('(;GM[1]FF[4]CA[UTF-8]AP[goban:1.0]SZ[9]AB[aa][ba]AW[ii]PL[B]TR[ii]\n)\n');
  });

  it('「△マーク」モードで取られた石は打ち直すと取られる', () => {
    const moves: Move[] = [
      { x: 0, y: 0, color: WHITE },
      { x: 1, y: 0, color: BLACK },
      { x: 0, y: 1, color: BLACK },
    ];
    const board = new Board(9);
    for (const m of moves) board.set(m.x, m.y, m.color); // 取られた石も盤上に残る
    const captured = new Set([0]);
    const sgf = toSgf(params(board, moves, { captured, marks: captured }));
    expect(sgf).toBe('(;GM[1]FF[4]CA[UTF-8]AP[goban:1.0]SZ[9]\n;W[aa]\n;B[ba]\n;B[ab]\n)\n');
  });

  it('拡大しているときは VW を付ける', () => {
    const sgf = toSgf(params(new Board(19), [], { view: { x0: 0, y0: 10, x1: 8, y1: 18 } }));
    expect(sgf).toContain('VW[ak:is]');
  });
});
