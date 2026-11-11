/**
 * 盤面と設定のブラウザ内保存（localStorage）。
 * 保存データは外部入力として扱い、項目ごとに検証してから反映する。
 */

import { BLACK, Board, CAPTURE_MODES, WHITE, type CaptureMode, type StoneColor } from './board';
import { COORD_STYLES, type CoordStyle } from './coords';
import { isLabelText } from './labels';
import { NUMBER_STYLES, deserializeMoves, serializeMoves, type NumberStyle } from './moves';
import { THEME_NAMES, type ThemeName } from './renderer';
import { BOARD_SIZES, COLOR_MODES, type AppState, type ColorMode } from './state';
import { isView, normalizeView, type View } from './view';

export const STORAGE_KEY = 'goban.state.v1';

export interface SavedState {
  readonly size: number;
  /** Board.serialize() の文字列 */
  readonly stones: string;
  readonly colorMode: ColorMode;
  readonly nextColor: StoneColor;
  readonly captureMode: CaptureMode;
  readonly coordStyle: CoordStyle;
  readonly theme: ThemeName;
  readonly view: View;
  /** serializeMoves() の文字列 */
  readonly moves: string;
  readonly numbering: boolean;
  readonly numberFrom: number;
  readonly numberStyle: NumberStyle;
  /** 「文字」で書く文字（以前の版の保存データにはない） */
  readonly labelText?: string;
}

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** localStorage（使えない環境では null） */
export function getStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function toSaved(state: AppState): SavedState {
  return {
    size: state.board.size,
    stones: state.board.serialize(),
    colorMode: state.colorMode,
    nextColor: state.nextColor,
    captureMode: state.captureMode,
    coordStyle: state.coordStyle,
    theme: state.theme,
    view: state.view,
    moves: serializeMoves(state.moves),
    numbering: state.numbering,
    numberFrom: state.numberFrom,
    numberStyle: state.numberStyle,
    labelText: state.labelText,
  };
}

function oneOf<T>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}

/** 保存データを検証して state に反映する。不正な項目は無視して今の値を残す */
export function applySaved(state: AppState, data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const d = data as Partial<Record<keyof SavedState, unknown>>;
  if (typeof d.size === 'number' && BOARD_SIZES.includes(d.size)) {
    const board = Board.deserialize(d.size, d.stones);
    if (board) {
      state.board = board;
      state.view = normalizeView(isView(d.view) ? d.view : null, board.size);
      // 着手の記録は盤面と組なので、盤面を読み込んだときだけ使う
      state.moves = deserializeMoves(board.size, d.moves) ?? [];
    }
  }
  if (oneOf(COLOR_MODES, d.colorMode)) state.colorMode = d.colorMode;
  if (d.nextColor === BLACK || d.nextColor === WHITE) state.nextColor = d.nextColor;
  if (oneOf(CAPTURE_MODES, d.captureMode)) state.captureMode = d.captureMode;
  if (oneOf(COORD_STYLES, d.coordStyle)) state.coordStyle = d.coordStyle;
  if (oneOf(THEME_NAMES, d.theme)) state.theme = d.theme;
  if (typeof d.numbering === 'boolean') state.numbering = d.numbering;
  if (typeof d.numberFrom === 'number' && Number.isInteger(d.numberFrom) && d.numberFrom >= 0) {
    state.numberFrom = d.numberFrom;
  }
  if (oneOf(NUMBER_STYLES, d.numberStyle)) state.numberStyle = d.numberStyle;
  if (d.labelText === '' || isLabelText(d.labelText)) state.labelText = d.labelText;
}

export function saveState(storage: KeyValueStorage | null, state: AppState): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(toSaved(state)));
  } catch {
    // 容量超過やプライベートモードで保存できなくても動作は続ける
  }
}

export function loadState(storage: KeyValueStorage | null, state: AppState): void {
  try {
    const json = storage?.getItem(STORAGE_KEY);
    if (json) applySaved(state, JSON.parse(json));
  } catch {
    // 壊れた保存データは無視する
  }
}
