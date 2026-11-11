import { describe, expect, it } from 'vitest';
import { BLACK, WHITE } from '../src/board';
import { exportCellSize, exportFileName } from '../src/export';
import { UndoHistory } from '../src/history';
import { STORAGE_KEY, applySaved, loadState, saveState, type KeyValueStorage } from '../src/persistence';
import { currentColor, initialState } from '../src/state';
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

describe('UndoHistory', () => {
  it('元に戻す・やり直す', () => {
    const h = new UndoHistory<number>();
    expect(h.canUndo).toBe(false);
    expect(h.undo(0)).toBeUndefined();
    expect(h.canRedo).toBe(false);
    h.record(0); // 0 → 1
    h.record(1); // 1 → 2
    expect(h.undo(2)).toBe(1);
    expect(h.undo(1)).toBe(0);
    expect(h.undo(0)).toBeUndefined();
    expect(h.redo(0)).toBe(1);
    expect(h.redo(1)).toBe(2);
    expect(h.redo(2)).toBeUndefined();
  });

  it('新しい操作でやり直し履歴は消える', () => {
    const h = new UndoHistory<string>();
    h.record('a');
    h.undo('b');
    expect(h.canRedo).toBe(true);
    h.record('a');
    expect(h.canRedo).toBe(false);
  });

  it('上限を超えると古いものから捨てる', () => {
    const h = new UndoHistory<number>(2);
    h.record(1);
    h.record(2);
    h.record(3);
    expect(h.undo(4)).toBe(3);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBeUndefined();
  });
});

describe('状態', () => {
  it('置く石の色', () => {
    expect(currentColor({ colorMode: 'black', nextColor: WHITE })).toBe(BLACK);
    expect(currentColor({ colorMode: 'white', nextColor: BLACK })).toBe(WHITE);
    expect(currentColor({ colorMode: 'alternate', nextColor: WHITE })).toBe(WHITE);
  });
});

describe('保存と復元', () => {
  it('保存した内容をそのまま復元できる', () => {
    const storage = new MemoryStorage();
    const s = initialState(13);
    s.board.place(3, 3, BLACK, 'remove');
    s.board.place(9, 9, WHITE, 'remove');
    s.colorMode = 'alternate';
    s.nextColor = WHITE;
    s.captureMode = 'mark';
    s.coordStyle = 'japanese';
    s.theme = 'print';
    s.view = { x0: 0, y0: 0, x1: 6, y1: 6 };
    s.moves = [
      { x: 3, y: 3, color: BLACK },
      { x: 9, y: 9, color: WHITE },
    ];
    s.numbering = true;
    s.numberFrom = 1;
    s.numberStyle = 'absolute';
    s.labelText = 'あ';
    saveState(storage, s);

    const t = initialState();
    loadState(storage, t);
    expect(t.board.equals(s.board)).toBe(true);
    expect({ ...t, board: null, tool: null }).toEqual({ ...s, board: null, tool: null });
  });

  it('不正な項目は無視して今の値を残す', () => {
    const s = initialState();
    applySaved(s, {
      size: 7, // 対応していない大きさ
      stones: '0'.repeat(49),
      colorMode: 'red',
      nextColor: 3,
      captureMode: 'remove',
      coordStyle: 1,
      theme: 'dark',
      view: { x0: 2 },
      moves: 'Baa',
      numbering: 'yes',
      numberFrom: -1,
      numberStyle: 'roman',
      labelText: 'AB',
    });
    expect(s.board.size).toBe(19);
    expect(s.colorMode).toBe('black');
    expect(s.nextColor).toBe(BLACK);
    expect(s.coordStyle).toBe('western');
    expect(s.theme).toBe('wood');
    expect(s.view).toEqual(fullView(19));
    expect(s.moves).toEqual([]); // 盤面を読み込まないときは記録も使わない
    expect(s.numbering).toBe(false);
    expect(s.numberFrom).toBe(0);
    expect(s.numberStyle).toBe('relative');
    expect(s.labelText).toBe('A');
  });

  it('着手の記録が壊れていたら空にする', () => {
    const s = initialState();
    s.moves = [{ x: 0, y: 0, color: BLACK }];
    applySaved(s, { size: 9, stones: '0'.repeat(81), moves: 'Bzz' });
    expect(s.board.size).toBe(9);
    expect(s.moves).toEqual([]);
  });

  it('盤面が正しければ表示範囲は盤内に直して使う', () => {
    const s = initialState();
    applySaved(s, { size: 9, stones: '0'.repeat(81), view: { x0: 5, y0: 5, x1: 30, y1: 6 } });
    expect(s.board.size).toBe(9);
    expect(s.view).toEqual({ x0: 5, y0: 4, x1: 8, y1: 6 });
  });

  it('壊れた JSON や使えない storage でも例外を出さない', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, '{broken');
    const s = initialState();
    expect(() => loadState(storage, s)).not.toThrow();
    expect(() => loadState(null, s)).not.toThrow();
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => loadState(throwing, s)).not.toThrow();
    expect(() => saveState(throwing, s)).not.toThrow();
  });
});

describe('PNG 出力', () => {
  it('ファイル名', () => {
    expect(exportFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe('goban-20260102-030405.png');
    expect(exportFileName(new Date(2026, 0, 2, 3, 4, 5), ' 定石/小目 その1 ')).toBe('goban-定石_小目_その1-20260102-030405.png');
    expect(exportFileName(new Date(2026, 0, 2, 3, 4, 5), '...')).toBe('goban-20260102-030405.png');
  });

  it('表示範囲が狭いほどマスを大きくする（上限・下限あり）', () => {
    const full = exportCellSize(fullView(19));
    const zoomed = exportCellSize({ x0: 0, y0: 0, x1: 6, y1: 6 });
    expect(zoomed).toBeGreaterThan(full);
    expect(exportCellSize({ x0: 0, y0: 0, x1: 2, y1: 2 })).toBe(96);
    expect(exportCellSize(fullView(25))).toBeGreaterThanOrEqual(36);
  });
});
