import { describe, expect, it } from 'vitest';
import { BLACK, Board, WHITE } from '../src/board';
import { docName, docNodes, newDoc, placeStone, type Doc } from '../src/edit';
import { PositionCache, positionOf } from '../src/game';
import {
  LIBRARY_KEY,
  cleanName,
  defaultName,
  emptyEntry,
  entryFromDoc,
  entryName,
  loadLibrary,
  parseLibrary,
  saveLibrary,
  sortedEntries,
  toStored,
  type BoardEntry,
} from '../src/library';
import { LIBRARY_V1_KEY } from '../src/migrate';
import { STATE_V1_KEY, type KeyValueStorage } from '../src/persistence';
import { fullView } from '../src/view';

class MemoryStorage implements KeyValueStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const options = { inheritMarks: true };

/** doc に石を順に置く */
function play(doc: Doc, points: Array<[number, number]>): Doc {
  const cache = new PositionCache();
  const pos = (n: Parameters<PositionCache['position']>[0]) => cache.position(n);
  let d = doc;
  const size = positionOf(docNodes(doc)).size;
  points.forEach(([x, y], k) => {
    const res = placeStone(d, pos, y * size + x, k % 2 ? WHITE : BLACK, 'remove', options);
    if (!res.ok) throw new Error(res.reason);
    d = res.doc;
  });
  return d;
}

function entry(doc: Doc, base: Partial<BoardEntry> & { id: string; createdAt: number }, now = 0): BoardEntry {
  return entryFromDoc(doc, fullView(positionOf(docNodes(doc)).size), positionOf(docNodes(doc)), base, now);
}

describe('盤面の一覧', () => {
  it('盤面の内容を entry にする（SGF・サムネイル・手数）', () => {
    const doc = play(newDoc(9, '定石'), [
      [2, 2],
      [6, 6],
    ]);
    const e = entry(doc, { id: 'a', createdAt: 100 }, 200);
    expect(e).toMatchObject({ id: 'a', createdAt: 100, updatedAt: 200, size: 9, moves: 2 });
    expect(e.sgf).toContain(';B[cc]');
    expect(e.sgf).toContain('GN[定石]');
    expect(Board.deserialize(9, e.thumb)?.get(6, 6)).toBe(WHITE);
    expect(entryName(e)).toBe('定石');
  });

  it('ツリーが変わらなければ更新時刻を変えない', () => {
    const doc = newDoc(9, 'x');
    const e = entry(doc, { id: 'a', createdAt: 100 }, 200);
    // 表示範囲や今のノードだけを変えても編集ではない
    expect(entryFromDoc(doc, { x0: 0, y0: 0, x1: 4, y1: 4 }, positionOf(docNodes(doc)), e, 300).updatedAt).toBe(200);
    expect(entry(play(doc, [[0, 0]]), e, 300).updatedAt).toBe(300);
  });

  it('既定の名前は使われていない最小の番号', () => {
    expect(defaultName([])).toBe('盤面 1');
    expect(defaultName(['盤面 1', '盤面 3'])).toBe('盤面 2');
  });

  it('名前を整える', () => {
    expect(cleanName('  定石  ', 'x')).toBe('定石');
    expect(cleanName('   ', 'x')).toBe('x');
    expect(Array.from(cleanName('碁'.repeat(50), 'x'))).toHaveLength(40);
  });

  it('最後に編集した盤面が先頭', () => {
    const e = (id: string, createdAt: number, updatedAt: number): BoardEntry => ({
      ...emptyEntry(id, 9),
      id,
      createdAt,
      updatedAt,
    });
    expect(sortedEntries([e('a', 1, 5), e('b', 2, 9), e('c', 3, 5)]).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('空の盤面', () => {
    const e = emptyEntry('x', 13, 50);
    expect(Board.deserialize(e.size, e.thumb)?.isEmpty()).toBe(true);
    expect(e).toMatchObject({ createdAt: 50, updatedAt: 50, moves: 0, view: fullView(13) });
    expect(entryName(e)).toBe('x');
  });
});

describe('盤面の一覧の保存', () => {
  it('保存して読み込める（今のノード・表示範囲・手番の入れ替えも）', () => {
    const storage = new MemoryStorage();
    const a = emptyEntry('盤面 1', 19);
    const played = play(newDoc(9, '盤面 2'), [
      [0, 0],
      [1, 1],
    ]);
    const doc: Doc = { ...played, cursor: [0], turn: BLACK };
    const b = entryFromDoc(doc, { x0: 0, y0: 0, x1: 4, y1: 4 }, positionOf(docNodes(doc)), { id: 'b', createdAt: 1 }, 2);
    expect(saveLibrary(storage, { currentId: b.id, entries: [a, b] })).toBe(true);
    const lib = loadLibrary(storage)!;
    expect(lib.currentId).toBe('b');
    expect(lib.entries.map(toStored)).toEqual([toStored(a), toStored(b)]);
    expect(lib.entries[1].doc.cursor).toEqual([0]);
    expect(lib.entries[1].doc.turn).toBe(BLACK);
  });

  it('不正な盤面は捨て、選んでいた盤面がなければ先頭を選ぶ', () => {
    const ok = toStored(emptyEntry('盤面 1', 9));
    const lib = parseLibrary({
      currentId: 'missing',
      entries: [
        null,
        { ...ok, id: 'bad-sgf', sgf: '(;B[aa]' },
        { ...ok, id: 'bad-size', sgf: '(;SZ[19:13])' },
        { ...ok, id: '' },
        ok,
        { ...ok, sgf: '(;GN[重複])' }, // 同じ ID
        {
          ...ok,
          id: 'fixed',
          sgf: '(;SZ[9];B[aa])',
          cursor: [3, 1],
          view: { x0: 0, y0: 0, x1: 99, y1: 99 },
          turn: 'X',
          thumb: 'bad',
          moves: -1,
          updatedAt: 'x',
        },
      ],
    });
    expect(lib?.currentId).toBe(ok.id);
    expect(lib?.entries.map((e) => e.id)).toEqual([ok.id, 'fixed']);
    const fixed = lib!.entries[1];
    expect(fixed).toMatchObject({ view: fullView(9), moves: 1, updatedAt: ok.createdAt });
    expect(fixed.doc.cursor).toEqual([0]); // 不正なら本線の最後
    expect(fixed.doc.turn).toBeNull();
    expect(docName(fixed.doc)).toBe('無題');
    expect(Board.deserialize(9, fixed.thumb)?.get(0, 0)).toBe(BLACK);
  });

  it('壊れたデータや空の一覧は null', () => {
    const storage = new MemoryStorage();
    expect(loadLibrary(storage)).toBeNull();
    storage.setItem(LIBRARY_KEY, '{broken');
    expect(loadLibrary(storage)).toBeNull();
    expect(parseLibrary({ entries: [] })).toBeNull();
    expect(parseLibrary({ entries: 'x' })).toBeNull();
    expect(loadLibrary(null)).toBeNull();
  });

  it('保存できなければ false', () => {
    const throwing: KeyValueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(saveLibrary(throwing, { currentId: 'a', entries: [] })).toBe(false);
    expect(saveLibrary(null, { currentId: 'a', entries: [] })).toBe(false);
  });
});

describe('以前の版からの移行', () => {
  const v1Entry = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    createdAt: 10,
    updatedAt: 20,
    size: 9,
    stones: '0'.repeat(81),
    moves: '',
    marks: '',
    numberFrom: 0,
    nextColor: BLACK,
    view: fullView(9),
    ...extra,
  });

  it('v2 がなければ v1 の一覧を移して保存する（v1 は残す）', () => {
    const storage = new MemoryStorage();
    const stones = '1'.padEnd(81, '0');
    const v1 = JSON.stringify({
      currentId: 'b',
      entries: [v1Entry('a', '盤面 1'), v1Entry('b', '定石', { stones, moves: 'Baa' })],
    });
    storage.setItem(LIBRARY_V1_KEY, v1);
    const lib = loadLibrary(storage)!;
    expect(lib.currentId).toBe('b');
    expect(lib.entries.map(entryName)).toEqual(['盤面 1', '定石']);
    expect(lib.entries[1]).toMatchObject({ id: 'b', createdAt: 10, updatedAt: 20, moves: 1, thumb: stones });
    expect(storage.data.get(LIBRARY_V1_KEY)).toBe(v1);
    expect(storage.data.has(LIBRARY_KEY)).toBe(true);
    // 2 回目は v2 から読む
    expect(loadLibrary(storage)!.entries.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('盤面の一覧がなかったころの版は、今の盤面を 1 つ目の盤面にする', () => {
    const storage = new MemoryStorage();
    storage.setItem(STATE_V1_KEY, JSON.stringify({ size: 13, stones: '2'.padEnd(169, '0'), moves: '', theme: 'print' }));
    const lib = loadLibrary(storage)!;
    expect(lib.entries).toHaveLength(1);
    expect(entryName(lib.entries[0])).toBe('盤面 1');
    expect(lib.entries[0].size).toBe(13);
    expect(Board.deserialize(13, lib.entries[0].thumb)?.get(0, 0)).toBe(WHITE);
  });
});
