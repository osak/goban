/**
 * アプリの設定（盤面によらず共通）。盤面の内容はゲームツリー（edit.ts の Doc）に持つ。
 */

import { BLACK, WHITE, type CaptureMode, type StoneColor } from './board';
import type { CoordStyle } from './coords';
import type { NumberStyle } from './moves';
import type { ThemeName } from './renderer';

/** 置く石: 黒を連打 / 白を連打 / 黒白交互 */
export type ColorMode = 'black' | 'white' | 'alternate';
export const COLOR_MODES: readonly ColorMode[] = ['black', 'white', 'alternate'];

/** 新しく作る盤面の大きさの選択肢（読み込んだ棋譜はこれ以外の大きさもありうる） */
export const BOARD_SIZES: readonly number[] = [19, 13, 9];

/** 次の手の候補を盤に出すか: 出さない / 変化（子が 2 つ以上）のときだけ / 次の手があればいつも */
export type CandidateMode = 'off' | 'branch' | 'all';
export const CANDIDATE_MODES: readonly CandidateMode[] = ['off', 'branch', 'all'];

/** 盤面タップの役割: 石を置く / 石に△を付け外しする / 交点に文字を書く・消す / 拡大範囲を選ぶ */
export type Tool = 'stone' | 'mark' | 'label' | 'zoom';

export interface Settings {
  colorMode: ColorMode;
  captureMode: CaptureMode;
  coordStyle: CoordStyle;
  theme: ThemeName;
  /** 石に着手番号を表示するか */
  numbering: boolean;
  numberStyle: NumberStyle;
  /** 「文字」で交点に書く文字（'' ならタップで文字を消す） */
  labelText: string;
  /** 次の手を置くとき、今の △ と文字を引き継ぐか */
  inheritMarks: boolean;
  /** 次の手の候補の表示 */
  candidates: CandidateMode;
  /** 「配置」モード: 石を手ではなく今のノードの配置（AB / AW / AE）として置く・消す */
  setupMode: boolean;
  /** ツリー全体の表示を開いているか */
  showTree: boolean;
  /** コメントの欄を開いているか */
  showComment: boolean;
}

export interface AppState extends Settings {
  tool: Tool;
}

export function initialSettings(): Settings {
  return {
    colorMode: 'black',
    captureMode: 'remove',
    coordStyle: 'western',
    theme: 'wood',
    numbering: false,
    numberStyle: 'relative',
    labelText: 'A',
    inheritMarks: true,
    candidates: 'branch',
    setupMode: false,
    showTree: false,
    showComment: false,
  };
}

export function initialState(): AppState {
  return { ...initialSettings(), tool: 'stone' };
}

/** 今タップしたら置かれる石の色。nextColor は交互モードでの次の手番 */
export function currentColor(colorMode: ColorMode, nextColor: StoneColor): StoneColor {
  switch (colorMode) {
    case 'black':
      return BLACK;
    case 'white':
      return WHITE;
    case 'alternate':
      return nextColor;
  }
}
