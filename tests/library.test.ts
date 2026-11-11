import { describe, expect, it } from 'vitest';
import { BLACK, Board, WHITE } from '../src/board';
import {
  LIBRARY_KEY,
  applyEntry,
  cleanName,
  defaultName,
  emptyEntry,
  entryFromState,
  loadLibrary,
  parseLibrary,
  saveLibrary,
  sortedEntries,
  type BoardEntry,
} from '../src/library';
import type { KeyValueStorage } from '../src/persistence';
import { initialState } from '../src/state';
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

const base = { id: 'a', name: '盤面 1', createdAt: 100 };

describe('盤面の一覧', () => {
  it('盤面の内容を entry にして元に戻せる', () => {
    const s = initialState(13);
    s.board.place(3, 3, BLACK, 'remove');
    s.board.place(9, 9, WHITE, 'remove');
    s.moves = [
      { x: 3, y: 3, color: BLACK },
      { x: 9, y: 9, color: WHITE },
    ];
    s.numberFrom = 1;
    s.nextColor = WHITE;
    s.view = { x0: 0, y0: 0, x1: 6, y1: 6 };
    s.marks = new Set([s.board.index(9, 9)]);
    s.captured = new Set([s.board.index(3, 3)]);
    const e = entryFromState(s, base, 200);
    expect(e).toMatchObject({
      id: 'a',
      name: '盤面 1',
      createdAt: 100,
      updatedAt: 200,
      size: 13,
      moves: 'BddWjj',
      marks: 'jj',
      captured: 'dd',
    });

    const t = initialState();
    applyEntry(t, e);
    expect(t.board.equals(s.board)).toBe(true);
    expect(t.moves).toEqual(s.moves);
    expect(t.numberFrom).toBe(1);
    expect(t.nextColor).toBe(WHITE);
    expect(t.view).toEqual(s.view);
    expect(t.marks).toEqual(s.marks);
    expect(t.captured).toEqual(s.captured);
  });

  it('石も着手の記録も変わらなければ更新時刻を変えない', () => {
    const s = initialState(9);
    const e = entryFromState(s, base, 200);
    s.view = { x0: 0, y0: 0, x1: 4, y1: 4 }; // 表示範囲だけ変える
    expect(entryFromState(s, e, 300).updatedAt).toBe(200);
    s.marks.add(0); // △を付けるのは盤面の編集
    expect(entryFromState(s, e, 300).updatedAt).toBe(300);
    s.marks.clear();
    s.captured.add(0); // 取られた石はモードの切り替えでも変わるので編集とみなさない
    expect(entryFromState(s, e, 300).updatedAt).toBe(200);
    s.board.place(0, 0, BLACK, 'remove');
    expect(entryFromState(s, e, 300).updatedAt).toBe(300);
  });

  it('既定の名前は使われていない最小の番号', () => {
    expect(defaultName([])).toBe('盤面 1');
    const e = (name: string) => emptyEntry(name, 9);
    expect(defaultName([e('盤面 1'), e('盤面 3')])).toBe('盤面 2');
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
});

describe('盤面の一覧の保存', () => {
  it('保存して読み込める', () => {
    const storage = new MemoryStorage();
    const a = emptyEntry('盤面 1', 19);
    const b = { ...emptyEntry('盤面 2', 9), stones: '1'.padEnd(81, '0'), moves: 'Baa' };
    expect(saveLibrary(storage, { currentId: b.id, entries: [a, b] })).toBe(true);
    expect(loadLibrary(storage)).toEqual({ currentId: b.id, entries: [a, b] });
  });

  it('不正な盤面は捨て、選んでいた盤面がなければ先頭を選ぶ', () => {
    const ok = emptyEntry('盤面 1', 9);
    const lib = parseLibrary({
      currentId: 'missing',
      entries: [
        null,
        { ...ok, id: 'bad-size', size: 7, stones: '0'.repeat(49) },
        { ...ok, id: 'bad-stones', stones: '3'.repeat(81) },
        { ...ok, id: '' },
        ok,
        { ...ok, name: '重複' }, // 同じ ID
        {
          ...ok,
          id: 'fixed',
          name: '  ',
          moves: 'Bzz',
          marks: 'zz',
          captured: 'zz',
          numberFrom: -3,
          nextColor: 5,
          view: { x0: 0, y0: 0, x1: 99, y1: 99 },
          updatedAt: 'x',
        },
      ],
    });
    expect(lib?.currentId).toBe(ok.id);
    expect(lib?.entries.map((e) => e.id)).toEqual([ok.id, 'fixed']);
    expect(lib?.entries[1]).toMatchObject({
      name: '無題',
      moves: '',
      marks: '',
      captured: '',
      numberFrom: 0,
      nextColor: BLACK,
      view: fullView(9),
      updatedAt: ok.createdAt,
    });
  });

  it('以前の版の保存データ（取られた石がない）も読み込める', () => {
    const { captured: _, ...old } = emptyEntry('盤面 1', 9);
    const lib = parseLibrary({ currentId: old.id, entries: [old] });
    expect(lib?.entries[0].captured).toBe('');
    const t = initialState();
    applyEntry(t, { ...old });
    expect(t.captured.size).toBe(0);
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

  it('空の盤面', () => {
    const e = emptyEntry('x', 13, 50);
    expect(Board.deserialize(e.size, e.stones)?.isEmpty()).toBe(true);
    expect(e).toMatchObject({ createdAt: 50, updatedAt: 50, moves: '', numberFrom: 0, view: fullView(13) });
  });
});
