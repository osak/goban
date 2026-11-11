/**
 * 「△マーク」モードの取られた石。DOM に依存しない。
 *
 * 取られた石は盤上に残して △ を付け、その後の取りの判定では空点とみなす。
 * どちらが取られたかは打った順で決まり、盤面だけからは決まらない
 * （コウの形では「白が取られた」と「黒が取られた」のどちらでも辻褄が合う）。
 * そのため取られた石は盤面とは別に、交点のインデックスの集合として持つ。
 *
 * 打った順が分からない盤面（「何もしない」モードで置いた石など）は
 * settleCaptured() で呼吸点のない連をすべて（黒白とも）取られた石とする。
 */

import { EMPTY, opposite, type Board, type PlaceResult, type StoneColor } from './board';

/** 取られた石を空点にした盤面（取りの判定に使う） */
export function withoutCaptured(board: Board, captured: ReadonlySet<number>): Board {
  const b = board.clone();
  for (const i of captured) b.grid[i] = EMPTY;
  return b;
}

/**
 * 「△マーク」モードで石を置く。
 * 取られた石を空点とみなして「取り除く」モードと同じように取りを判定し、
 * 取った石を盤上に残したまま captured に加える。
 * 自殺手と、石がある交点（取られた石を含む）には置けない。
 */
export function placeCapturing(
  board: Board,
  captured: Set<number>,
  x: number,
  y: number,
  color: StoneColor,
): PlaceResult {
  if (!board.inBounds(x, y)) return { ok: false, reason: 'out-of-bounds' };
  const i = board.index(x, y);
  if (board.grid[i] !== EMPTY) return { ok: false, reason: 'occupied' };
  const res = withoutCaptured(board, captured).place(x, y, color, 'remove');
  if (!res.ok) return res;
  board.grid[i] = color;
  for (const s of res.captured) captured.add(s);
  return res;
}

/**
 * 交点 i にあった石を取り除いたあとに captured を整える。
 * 取り除いたのが取られていない石（color の石）なら、それに囲まれていた相手の取られた石
 * （隣の取られた石と、それにつながる取られた同じ色の石）を取られていないことにする。
 * 取られた石を取り除いただけなら、ほかの石は変わらない。
 * その後 settleCaptured() で、呼吸点がなくなった連を取られた石にする。
 */
export function eraseCapturing(
  board: Board,
  captured: Set<number>,
  i: number,
  color: StoneColor,
  wasCaptured: boolean,
): void {
  captured.delete(i);
  if (!wasCaptured) {
    const enemy = opposite(color);
    const stack = board.neighbors(i).filter((n) => board.grid[n] === enemy && captured.has(n));
    for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
      if (!captured.delete(cur)) continue;
      for (const n of board.neighbors(cur)) {
        if (board.grid[n] === enemy && captured.has(n)) stack.push(n);
      }
    }
  }
  settleCaptured(board, captured);
}

/**
 * captured を盤面と矛盾しないように整える。
 * 石のない交点を除き、取られた石を空点とみなして呼吸点のない連（黒白とも）を加える。
 */
export function settleCaptured(board: Board, captured: Set<number>): void {
  for (const i of captured) if (board.grid[i] === EMPTY) captured.delete(i);
  for (const i of withoutCaptured(board, captured).deadStones()) captured.add(i);
}
