/**
 * 保存した盤面の一覧（盤面ライブラリ）。DOM に依存しない。
 *
 * 盤面ごとに石の配置・着手の記録・△・文字・番号の起点・手番・表示範囲を持つ。
 * 置く石の色や座標の表記などの設定は盤面によらず共通で、persistence.ts 側で保存する。
 * 保存データは外部入力として扱い、読み込み時に項目ごとに検証する。
 */

import { BLACK, Board, WHITE, type StoneColor } from './board';
import { deserializeLabels, sameLabels, serializeLabels } from './labels';
import { deserializeMoves, deserializePoints, serializeMoves, serializePoints } from './moves';
import type { KeyValueStorage } from './persistence';
import { BOARD_SIZES, type AppState } from './state';
import { fullView, isView, normalizeView, type View } from './view';

export const LIBRARY_KEY = 'goban.boards.v1';

/** 保存する盤面 1 つ分 */
export interface BoardEntry {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  /** 盤面の内容（石・着手の記録）を最後に変えた時刻 */
  readonly updatedAt: number;
  readonly size: number;
  /** Board.serialize() の文字列 */
  readonly stones: string;
  /** serializeMoves() の文字列 */
  readonly moves: string;
  /** 手で△を付けた石。serializePoints() の文字列 */
  readonly marks: string;
  /** 「△マーク」モードで取られた石。serializePoints() の文字列（以前の版の保存データにはない） */
  readonly captured?: string;
  /** 交点に書いた文字。serializeLabels() の形式（以前の版の保存データにはない） */
  readonly labels?: Readonly<Record<string, string>>;
  readonly numberFrom: number;
  readonly nextColor: StoneColor;
  readonly view: View;
}

export interface Library {
  readonly currentId: string;
  readonly entries: readonly BoardEntry[];
}

export const MAX_NAME_LENGTH = 40;

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** 「盤面 N」のうち使われていない最小の N を使った名前 */
export function defaultName(entries: readonly BoardEntry[]): string {
  const used = new Set(entries.map((e) => e.name));
  for (let n = 1; ; n++) {
    const name = `盤面 ${n}`;
    if (!used.has(name)) return name;
  }
}

/** 名前を整える（前後の空白を除き、長すぎれば切る。空なら fallback） */
export function cleanName(name: string, fallback: string): string {
  const trimmed = Array.from(name.trim()).slice(0, MAX_NAME_LENGTH).join('');
  return trimmed || fallback;
}

/**
 * state の盤面の内容で entry を作る（base があれば ID・名前・作成時刻を引き継ぐ）。
 * 石や着手の記録が base から変わっていなければ更新時刻も引き継ぐ。
 */
export function entryFromState(
  state: Pick<AppState, 'board' | 'moves' | 'numberFrom' | 'nextColor' | 'view' | 'marks' | 'captured' | 'labels'>,
  base: Pick<BoardEntry, 'id' | 'name' | 'createdAt'> & Partial<BoardEntry>,
  now = Date.now(),
): BoardEntry {
  const size = state.board.size;
  const stones = state.board.serialize();
  const moves = serializeMoves(state.moves);
  const marks = serializePoints(state.marks, size);
  const labels = serializeLabels(state.labels, size);
  // 取られた石はモードの切り替えでも変わるので、更新時刻の判定には使わない（石を置いたり消したりしたときは stones が変わる）
  const same =
    base.size === size &&
    base.stones === stones &&
    base.moves === moves &&
    base.marks === marks &&
    sameLabels(deserializeLabels(size, base.labels ?? {}) ?? new Map(), state.labels);
  return {
    id: base.id,
    name: base.name,
    createdAt: base.createdAt,
    updatedAt: same && base.updatedAt !== undefined ? base.updatedAt : now,
    size,
    stones,
    moves,
    marks,
    captured: serializePoints(state.captured, size),
    labels,
    numberFrom: state.numberFrom,
    nextColor: state.nextColor,
    view: state.view,
  };
}

/** entry の盤面の内容を state に反映する */
export function applyEntry(
  state: Pick<AppState, 'board' | 'moves' | 'numberFrom' | 'nextColor' | 'view' | 'marks' | 'captured' | 'labels'>,
  entry: BoardEntry,
): void {
  const board = Board.deserialize(entry.size, entry.stones) ?? new Board(19);
  state.board = board;
  state.moves = deserializeMoves(board.size, entry.moves) ?? [];
  state.marks = deserializePoints(board.size, entry.marks) ?? new Set();
  // 盤面と食い違っていても、読み込んだあとに今のモードに合わせて整える（GobanApp.syncCaptured）
  state.captured = deserializePoints(board.size, entry.captured) ?? new Set();
  state.labels = deserializeLabels(board.size, entry.labels ?? {}) ?? new Map();
  state.numberFrom = entry.numberFrom;
  state.nextColor = entry.nextColor;
  state.view = normalizeView(entry.view, board.size);
}

/** 空の盤面の entry */
export function emptyEntry(name: string, size: number, now = Date.now()): BoardEntry {
  return {
    id: newId(),
    name,
    createdAt: now,
    updatedAt: now,
    size,
    stones: new Board(size).serialize(),
    moves: '',
    marks: '',
    captured: '',
    labels: {},
    numberFrom: 0,
    nextColor: BLACK,
    view: fullView(size),
  };
}

/** 保存データの 1 件を検証する。不正なら null */
export function parseEntry(data: unknown): BoardEntry | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Partial<Record<keyof BoardEntry, unknown>>;
  if (typeof d.id !== 'string' || d.id === '' || typeof d.name !== 'string') return null;
  if (typeof d.size !== 'number' || !BOARD_SIZES.includes(d.size)) return null;
  const board = Board.deserialize(d.size, d.stones);
  if (!board) return null;
  const time = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const createdAt = time(d.createdAt, 0);
  const points = (v: unknown) => {
    const p = deserializePoints(board.size, v);
    return p ? serializePoints(p, board.size) : '';
  };
  return {
    id: d.id,
    name: cleanName(d.name, '無題'),
    createdAt,
    updatedAt: time(d.updatedAt, createdAt),
    size: d.size,
    stones: board.serialize(),
    moves: deserializeMoves(d.size, d.moves) ? (d.moves as string) : '',
    marks: points(d.marks),
    captured: points(d.captured),
    labels: serializeLabels(deserializeLabels(board.size, d.labels) ?? new Map(), board.size),
    numberFrom: typeof d.numberFrom === 'number' && Number.isInteger(d.numberFrom) && d.numberFrom >= 0 ? d.numberFrom : 0,
    nextColor: d.nextColor === WHITE ? WHITE : BLACK,
    view: normalizeView(isView(d.view) ? d.view : null, d.size),
  };
}

/** 保存データを検証する。正しい盤面が 1 つもなければ null */
export function parseLibrary(data: unknown): Library | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as { currentId?: unknown; entries?: unknown };
  if (!Array.isArray(d.entries)) return null;
  const seen = new Set<string>();
  const entries: BoardEntry[] = [];
  for (const raw of d.entries) {
    const e = parseEntry(raw);
    if (e && !seen.has(e.id)) {
      seen.add(e.id);
      entries.push(e);
    }
  }
  if (entries.length === 0) return null;
  const currentId = entries.some((e) => e.id === d.currentId) ? (d.currentId as string) : entries[0].id;
  return { currentId, entries };
}

export function loadLibrary(storage: KeyValueStorage | null): Library | null {
  try {
    const json = storage?.getItem(LIBRARY_KEY);
    return json ? parseLibrary(JSON.parse(json)) : null;
  } catch {
    return null; // 壊れた保存データは無視する
  }
}

/** 保存する。容量超過などで保存できなければ false */
export function saveLibrary(storage: KeyValueStorage | null, library: Library): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LIBRARY_KEY, JSON.stringify(library));
    return true;
  } catch {
    return false;
  }
}

/** 一覧の表示順（最後に編集した盤面が先頭） */
export function sortedEntries(entries: readonly BoardEntry[]): BoardEntry[] {
  return [...entries].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}
