/**
 * 設定のブラウザ内保存（localStorage）。盤面は library.ts で保存する。
 * 保存データは外部入力として扱い、項目ごとに検証してから反映する。
 */

import { CAPTURE_MODES } from './board';
import { COORD_STYLES } from './coords';
import { isLabelText } from './labels';
import { NUMBER_STYLES } from './moves';
import { THEME_NAMES } from './renderer';
import { CANDIDATE_MODES, COLOR_MODES, type Settings } from './state';

export const SETTINGS_KEY = 'goban.settings.v2';
/** 以前の版の保存データ（設定と今の盤面）。設定を引き継ぐときに読む。消さずに残す */
export const STATE_V1_KEY = 'goban.state.v1';

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** localStorage（使えない環境では null） */
export function getStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function oneOf<T>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}

/** 保存データを検証して settings に反映する。不正な項目は無視して今の値を残す */
export function applySettings(settings: Settings, data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const d = data as Partial<Record<keyof Settings, unknown>>;
  if (oneOf(COLOR_MODES, d.colorMode)) settings.colorMode = d.colorMode;
  if (oneOf(CAPTURE_MODES, d.captureMode)) settings.captureMode = d.captureMode;
  if (oneOf(COORD_STYLES, d.coordStyle)) settings.coordStyle = d.coordStyle;
  if (oneOf(THEME_NAMES, d.theme)) settings.theme = d.theme;
  if (typeof d.numbering === 'boolean') settings.numbering = d.numbering;
  if (oneOf(NUMBER_STYLES, d.numberStyle)) settings.numberStyle = d.numberStyle;
  if (d.labelText === '' || isLabelText(d.labelText)) settings.labelText = d.labelText;
  if (typeof d.inheritMarks === 'boolean') settings.inheritMarks = d.inheritMarks;
  if (oneOf(CANDIDATE_MODES, d.candidates)) settings.candidates = d.candidates;
  if (typeof d.setupMode === 'boolean') settings.setupMode = d.setupMode;
  if (typeof d.showTree === 'boolean') settings.showTree = d.showTree;
  if (typeof d.showComment === 'boolean') settings.showComment = d.showComment;
}

export function toSavedSettings(s: Settings): Settings {
  return {
    colorMode: s.colorMode,
    captureMode: s.captureMode,
    coordStyle: s.coordStyle,
    theme: s.theme,
    numbering: s.numbering,
    numberStyle: s.numberStyle,
    labelText: s.labelText,
    inheritMarks: s.inheritMarks,
    candidates: s.candidates,
    setupMode: s.setupMode,
    showTree: s.showTree,
    showComment: s.showComment,
  };
}

export function saveSettings(storage: KeyValueStorage | null, settings: Settings): void {
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(toSavedSettings(settings)));
  } catch {
    // 容量超過やプライベートモードで保存できなくても動作は続ける
  }
}

/** 設定を読み込む。新しい形式がなければ以前の版の保存データから引き継ぐ */
export function loadSettings(storage: KeyValueStorage | null, settings: Settings): void {
  try {
    const json = storage?.getItem(SETTINGS_KEY) ?? storage?.getItem(STATE_V1_KEY);
    if (json) applySettings(settings, JSON.parse(json));
  } catch {
    // 壊れた保存データは無視する
  }
}
