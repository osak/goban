/**
 * SGF（Smart Game Format, FF[4]）での出力。DOM に依存しない。
 *
 * 着手のログを空の盤から「取り除く」モードの規則で打ち直して今の盤面
 * （「△マーク」モードで取られた石は空点とみなす）と同じになるなら、手順（棋譜）として出力する。
 * そうでなければ（石を手で消した・「何もしない」モードで置いたなど）、今の盤面を
 * 配置（AB / AW）として出力する。△は TR、交点の文字は LB として最後の局面に付ける。
 */

import { BLACK, Board, EMPTY, type StoneColor } from './board';
import { withoutCaptured } from './capture';
import type { Move } from './moves';
import { isFullView, type View } from './view';

export interface SgfParams {
  readonly board: Board;
  readonly moves: readonly Move[];
  /** 表示している △（手で付けたものと、「△マーク」モードで取られた石） */
  readonly marks: ReadonlySet<number>;
  /** 「△マーク」モードで取られた石（取られていない場合は空） */
  readonly captured: ReadonlySet<number>;
  readonly labels: ReadonlyMap<number, string>;
  readonly view: View;
  /** 盤面の名前（GN に入れる） */
  readonly name?: string;
  /** 配置として出力するときの手番（PL に入れる）。null なら入れない */
  readonly nextColor?: StoneColor | null;
}

const COORD_CHARS = 'abcdefghijklmnopqrstuvwxy'; // MAX_BOARD_SIZE (25) 路まで

function point(x: number, y: number): string {
  return COORD_CHARS[x] + COORD_CHARS[y];
}

function pointAt(i: number, size: number): string {
  return point(i % size, Math.floor(i / size));
}

/** SGF のテキスト値に入れられるようにする（] と \ をエスケープ。composed の区切りと紛れないよう : も） */
export function escapeSgfText(text: string): string {
  return text.replace(/[\]\\:]/g, (c) => '\\' + c);
}

function prop(id: string, values: readonly string[]): string {
  return values.length === 0 ? '' : id + values.map((v) => `[${v}]`).join('');
}

/** 交点の集合を、交点の順に並べた SGF の点のリストにする */
function points(set: Iterable<number>, size: number): string[] {
  return [...set].sort((a, b) => a - b).map((i) => pointAt(i, size));
}

/**
 * 着手のログを空の盤から打ち直した結果が target と同じなら true。
 * 石のある交点に打つ手や自殺手があれば false。
 */
export function replaysTo(target: Board, moves: readonly Move[]): boolean {
  const b = new Board(target.size);
  for (const m of moves) {
    if (!b.place(m.x, m.y, m.color, 'remove').ok) return false;
  }
  return b.equals(target);
}

/** 最後の局面に付ける △ と文字 */
function markup(params: SgfParams, onBoard: (i: number) => boolean): string {
  const size = params.board.size;
  const marks = [...params.marks].filter(onBoard);
  const labels = [...params.labels]
    .sort(([a], [b]) => a - b)
    .map(([i, text]) => `${pointAt(i, size)}:${escapeSgfText(text)}`);
  return prop('TR', points(marks, size)) + prop('LB', labels);
}

/** SGF の文字列を作る */
export function toSgf(params: SgfParams): string {
  const { board, moves, captured, view } = params;
  const size = board.size;

  const root: string[] = ['GM[1]', 'FF[4]', 'CA[UTF-8]', 'AP[goban:1.0]', `SZ[${size}]`];
  const name = params.name?.trim();
  if (name) root.push(`GN[${escapeSgfText(name)}]`);
  if (!isFullView(view, size)) {
    root.push(`VW[${point(view.x0, view.y0)}:${point(view.x1, view.y1)}]`);
  }

  const settled = withoutCaptured(board, captured);
  const asRecord = moves.length > 0 && replaysTo(settled, moves);

  if (asRecord) {
    // 手順として出力する。△ は打ち直した盤上に残っている石にだけ付ける
    const nodes = moves.map((m) => `;${m.color === BLACK ? 'B' : 'W'}[${point(m.x, m.y)}]`);
    nodes[nodes.length - 1] += markup(params, (i) => settled.grid[i] !== EMPTY);
    return `(;${root.join('')}\n${nodes.join('\n')}\n)\n`;
  }

  const black: number[] = [];
  const white: number[] = [];
  board.grid.forEach((c, i) => {
    if (c === BLACK) black.push(i);
    else if (c !== EMPTY) white.push(i);
  });
  root.push(prop('AB', points(black, size)), prop('AW', points(white, size)));
  if (params.nextColor != null) {
    root.push(`PL[${params.nextColor === BLACK ? 'B' : 'W'}]`);
  }
  root.push(markup(params, (i) => board.grid[i] !== EMPTY));
  return `(;${root.filter(Boolean).join('')}\n)\n`;
}
