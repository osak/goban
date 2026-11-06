/**
 * アプリの状態。
 */

import { BLACK, Board, WHITE, type CaptureMode, type StoneColor } from './board';
import type { CoordStyle } from './coords';
import type { ThemeName } from './renderer';
import { fullView, type View } from './view';

/** 置く石: 黒を連打 / 白を連打 / 黒白交互 */
export type ColorMode = 'black' | 'white' | 'alternate';
export const COLOR_MODES: readonly ColorMode[] = ['black', 'white', 'alternate'];

export const BOARD_SIZES: readonly number[] = [19, 13, 9];

/** 盤面タップの役割: 石を置く / 拡大範囲を選ぶ */
export type Tool = 'stone' | 'zoom';

export interface AppState {
  board: Board;
  colorMode: ColorMode;
  /** 交互モードで次に置く色 */
  nextColor: StoneColor;
  captureMode: CaptureMode;
  coordStyle: CoordStyle;
  theme: ThemeName;
  view: View;
  tool: Tool;
}

export function initialState(size = 19): AppState {
  return {
    board: new Board(size),
    colorMode: 'black',
    nextColor: BLACK,
    captureMode: 'remove',
    coordStyle: 'western',
    theme: 'wood',
    view: fullView(size),
    tool: 'stone',
  };
}

/** 今タップしたら置かれる石の色 */
export function currentColor(state: Pick<AppState, 'colorMode' | 'nextColor'>): StoneColor {
  switch (state.colorMode) {
    case 'black':
      return BLACK;
    case 'white':
      return WHITE;
    case 'alternate':
      return state.nextColor;
  }
}
