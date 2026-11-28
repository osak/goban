/**
 * 保存した盤面の一覧（盤面ライブラリ）。DOM に依存しない。
 *
 * 盤面ごとに、ゲームツリーを SGF の文字列（拡張プロパティ込み）で持ち、
 * 今のノード・表示範囲・手番の一時的な入れ替えを画面の状態として添える。
 * 盤面の名前は根の GN に入れる。一覧のサムネイル用の盤面と手数は、一覧を出すたびに打ち直さないためのキャッシュ。
 * 置く石の色や座標の表記などの設定は盤面によらず共通で、persistence.ts 側で保存する。
 * 保存データは外部入力として扱い、読み込み時に検証する。
 *
 * 新しい形式（goban.boards.v2）がなければ、以前の版（goban.boards.v1 か goban.state.v1）から移す。
 * 以前の版のデータは消さずに残す（前の版に戻しても盤面が残るように）。
 */

import { BLACK, Board, WHITE, type StoneColor } from './board';
import { docName, docNodes, isValidCursor, newDoc, renameDoc, type Doc } from './edit';
import { boardSizeOf, positionOf, type GamePosition } from './game';
import { LIBRARY_V1_KEY, migrateV1Entry, parseV1Library, parseV1State } from './migrate';
import { STATE_V1_KEY, type KeyValueStorage } from './persistence';
import { parseSgf } from './sgf/parse';
import { writeSgf } from './sgf/write';
import { extendPath } from './tree';
import { fullView, isView, normalizeView, type View } from './view';

export const LIBRARY_KEY = 'goban.boards.v2';

/** 保存する盤面 1 つ分 */
export interface StoredEntry {
  readonly id: string;
  readonly createdAt: number;
  /** 盤面の内容（ゲームツリー）を最後に変えた時刻 */
  readonly updatedAt: number;
  /** このツリー 1 つの SGF */
  readonly sgf: string;
  /** 根から今のノードまでの子の番号 */
  readonly cursor: readonly number[];
  readonly view: View;
  /** 着手ノードでの手番の一時的な入れ替え */
  readonly turn?: 'B' | 'W';
  /** サムネイル用の盤面（Board.serialize()）。キャッシュ */
  readonly thumb?: string;
  /** 今のノードまでの手数。キャッシュ */
  readonly moves?: number;
}

/** 読み込んだ盤面 1 つ分 */
export interface BoardEntry {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly doc: Doc;
  readonly view: View;
  /** doc.root を書き出した SGF（保存と、内容が変わったかの判定に使う） */
  readonly sgf: string;
  readonly size: number;
  readonly thumb: string;
  readonly moves: number;
}

export interface Library {
  readonly currentId: string;
  readonly entries: readonly BoardEntry[];
}

export const MAX_NAME_LENGTH = 40;
/** 1 つの盤面の SGF のノードの数の上限 */
const MAX_ENTRY_NODES = 100_000;

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** 「盤面 N」のうち使われていない最小の N を使った名前 */
export function defaultName(names: Iterable<string>): string {
  const used = new Set(names);
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

export function entryName(e: BoardEntry): string {
  return docName(e.doc);
}

/**
 * doc の内容で entry を作る（base があれば ID・作成時刻を引き継ぐ）。
 * ツリーが base から変わっていなければ更新時刻も引き継ぐ。pos は doc の今のノードの局面。
 */
export function entryFromDoc(
  doc: Doc,
  view: View,
  pos: GamePosition,
  base: Pick<BoardEntry, 'id' | 'createdAt'> & Partial<BoardEntry>,
  now = Date.now(),
): BoardEntry {
  const sgf = doc.root === base.doc?.root && base.sgf !== undefined ? base.sgf : writeSgf(doc.root);
  return {
    id: base.id,
    createdAt: base.createdAt,
    updatedAt: sgf === base.sgf && base.updatedAt !== undefined ? base.updatedAt : now,
    doc,
    view,
    sgf,
    size: pos.size,
    thumb: pos.board.serialize(),
    moves: pos.moves.length,
  };
}

/** 空の盤面の entry */
export function emptyEntry(name: string, size: number, now = Date.now()): BoardEntry {
  const doc = newDoc(size, name);
  return entryFromDoc(doc, fullView(size), positionOf(docNodes(doc)), { id: newId(), createdAt: now }, now);
}

export function toStored(e: BoardEntry): StoredEntry {
  return {
    id: e.id,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    sgf: e.sgf,
    cursor: e.doc.cursor,
    view: e.view,
    ...(e.doc.turn !== null ? { turn: e.doc.turn === BLACK ? 'B' : 'W' } : {}),
    thumb: e.thumb,
    moves: e.moves,
  };
}

function isCursor(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((k) => Number.isInteger(k) && k >= 0);
}

/** 保存データの 1 件を検証する。不正なら null */
export function parseStoredEntry(data: unknown): BoardEntry | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Partial<Record<keyof StoredEntry, unknown>>;
  if (typeof d.id !== 'string' || d.id === '' || typeof d.sgf !== 'string') return null;
  let root;
  try {
    [root] = parseSgf(d.sgf, { maxNodes: MAX_ENTRY_NODES });
  } catch {
    return null;
  }
  if (!root) return null;
  const size = boardSizeOf(root);
  if (size === null) return null;
  const cursor = isCursor(d.cursor) && isValidCursor(root, d.cursor) ? d.cursor : extendPath(root, []);
  const turn: StoneColor | null = d.turn === 'B' ? BLACK : d.turn === 'W' ? WHITE : null;
  let doc: Doc = { root, cursor, turn };
  if (docName(doc) === '') doc = renameDoc(doc, '無題');
  const time = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const createdAt = time(d.createdAt, 0);
  const view = normalizeView(isView(d.view) ? d.view : null, size);
  const thumb = Board.deserialize(size, d.thumb) ? (d.thumb as string) : null;
  const moves = typeof d.moves === 'number' && Number.isInteger(d.moves) && d.moves >= 0 ? d.moves : null;
  const base = { id: d.id, createdAt, updatedAt: time(d.updatedAt, createdAt) };
  if (thumb !== null && moves !== null && doc.root === root) {
    return { ...base, doc, view, sgf: d.sgf, size, thumb, moves };
  }
  // キャッシュがなければ打ち直して作る
  try {
    const pos = positionOf(docNodes(doc));
    return { ...base, doc, view, sgf: writeSgf(doc.root), size, thumb: pos.board.serialize(), moves: pos.moves.length };
  } catch {
    return null;
  }
}

/** 保存データを検証する。正しい盤面が 1 つもなければ null */
export function parseLibrary(data: unknown): Library | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as { currentId?: unknown; entries?: unknown };
  if (!Array.isArray(d.entries)) return null;
  const seen = new Set<string>();
  const entries: BoardEntry[] = [];
  for (const raw of d.entries) {
    const e = parseStoredEntry(raw);
    if (e && !seen.has(e.id)) {
      seen.add(e.id);
      entries.push(e);
    }
  }
  if (entries.length === 0) return null;
  const currentId = entries.some((e) => e.id === d.currentId) ? (d.currentId as string) : entries[0].id;
  return { currentId, entries };
}

function readJson(storage: KeyValueStorage, key: string): unknown {
  try {
    const json = storage.getItem(key);
    return json ? JSON.parse(json) : null;
  } catch {
    return null; // 壊れた保存データは無視する
  }
}

/** 以前の版の保存データから一覧を作る。なければ null */
export function migrateLibrary(storage: KeyValueStorage, now = Date.now()): Library | null {
  const v1 = parseV1Library(readJson(storage, LIBRARY_V1_KEY));
  const v1Entries = v1?.entries ?? [];
  // 盤面の一覧がなかったころの版は、今の盤面だけを goban.state.v1 に持っていた
  if (v1Entries.length === 0) {
    const single = parseV1State(readJson(storage, STATE_V1_KEY), newId(), defaultName([]), now);
    if (single) v1Entries.push(single);
  }
  if (v1Entries.length === 0) return null;
  const entries = v1Entries.map((e) => {
    const { doc, view } = migrateV1Entry(e);
    const migrated = entryFromDoc(doc, view, positionOf(docNodes(doc)), { id: e.id, createdAt: e.createdAt }, now);
    return { ...migrated, updatedAt: e.updatedAt };
  });
  return { currentId: v1?.currentId ?? entries[0].id, entries };
}

/** 一覧を読み込む。新しい形式がなければ以前の版から移す（移したら保存する） */
export function loadLibrary(storage: KeyValueStorage | null): Library | null {
  if (!storage) return null;
  const library = parseLibrary(readJson(storage, LIBRARY_KEY));
  if (library) return library;
  const migrated = migrateLibrary(storage);
  if (migrated) saveLibrary(storage, migrated);
  return migrated;
}

/** 保存する。容量超過などで保存できなければ false */
export function saveLibrary(storage: KeyValueStorage | null, library: Library): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LIBRARY_KEY, JSON.stringify({ currentId: library.currentId, entries: library.entries.map(toStored) }));
    return true;
  } catch {
    return false;
  }
}

/** 一覧の表示順（最後に編集した盤面が先頭） */
export function sortedEntries(entries: readonly BoardEntry[]): BoardEntry[] {
  return [...entries].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}
