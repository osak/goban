/**
 * このアプリの拡張プロパティ（接頭辞 GB）。DOM に依存しない。
 *
 * SGF の構文には従うので、ほかのソフトでは知らないプロパティとして無視される（局面は変わらない）。
 * - GBMV[]: AB か AW を 1 点だけ持つ配置ノードに付ける。その石を「取りなしの着手」として 1 手に数える
 * - GBNS[]: このノードより後の手から番号を付ける（相対番号では次の手が 1）
 */

import { BLACK, WHITE, type StoneColor } from './board';
import { parsePointList, formatPoint } from './sgf/values';
import { createNode, NONE, setProp, type SgfNode } from './tree';

export const CAPTURELESS_MOVE = 'GBMV';
export const NUMBER_START = 'GBNS';

export interface CapturelessMove {
  readonly color: StoneColor;
  /** 交点のインデックス（y * size + x） */
  readonly point: number;
}

/**
 * ノードが「取りなしの着手」なら、その色と点。
 * GBMV があっても、AB と AW を合わせて 1 点でなければ（ほかのソフトで直されたなど）着手とみなさない。
 */
export function capturelessMoveOf(node: SgfNode, size: number): CapturelessMove | null {
  if (!node.props.has(CAPTURELESS_MOVE)) return null;
  const black = parsePointList(node.props.get('AB') ?? []);
  const white = parsePointList(node.props.get('AW') ?? []);
  if (black.length + white.length !== 1) return null;
  const p = black[0] ?? white[0];
  if (p.x >= size || p.y >= size) return null;
  return { color: black.length === 1 ? BLACK : WHITE, point: p.y * size + p.x };
}

/** 「取りなしの着手」のノードを作る */
export function capturelessMoveNode(color: StoneColor, x: number, y: number): SgfNode {
  return createNode([
    [color === BLACK ? 'AB' : 'AW', [formatPoint(x, y)]],
    [CAPTURELESS_MOVE, NONE],
  ]);
}

/** このノードより後の手から番号を付けるなら true */
export function hasNumberStart(node: SgfNode): boolean {
  return node.props.has(NUMBER_START);
}

/** 番号の起点の印を付けた（on が false なら外した）ノード */
export function withNumberStart(node: SgfNode, on: boolean): SgfNode {
  return setProp(node, NUMBER_START, on ? NONE : null);
}
