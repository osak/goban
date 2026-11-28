import { describe, expect, it } from 'vitest';
import { BLACK, WHITE } from '../src/board';
import { exportCellSize, exportFileName } from '../src/export';
import { UndoHistory } from '../src/history';
import {
  SETTINGS_KEY,
  STATE_V1_KEY,
  applySettings,
  loadSettings,
  saveSettings,
  type KeyValueStorage,
} from '../src/persistence';
import { currentColor, initialSettings } from '../src/state';
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
    expect(currentColor('black', WHITE)).toBe(BLACK);
    expect(currentColor('white', BLACK)).toBe(WHITE);
    expect(currentColor('alternate', WHITE)).toBe(WHITE);
  });
});

describe('設定の保存と復元', () => {
  it('保存した内容をそのまま復元できる', () => {
    const storage = new MemoryStorage();
    const s = initialSettings();
    s.colorMode = 'alternate';
    s.captureMode = 'mark';
    s.coordStyle = 'japanese';
    s.theme = 'print';
    s.numbering = true;
    s.numberStyle = 'absolute';
    s.labelText = 'あ';
    s.inheritMarks = false;
    s.candidates = 'all';
    s.setupMode = true;
    s.showTree = true;
    s.showComment = true;
    saveSettings(storage, s);
    expect(storage.data.has(SETTINGS_KEY)).toBe(true);

    const t = initialSettings();
    loadSettings(storage, t);
    expect(t).toEqual(s);
  });

  it('不正な項目は無視して今の値を残す', () => {
    const s = initialSettings();
    applySettings(s, {
      colorMode: 'red',
      captureMode: 'remove',
      coordStyle: 1,
      theme: 'dark',
      numbering: 'yes',
      numberStyle: 'roman',
      labelText: 'AB',
      inheritMarks: 0,
      candidates: 'some',
      setupMode: 'on',
      showTree: 1,
      showComment: null,
    });
    expect(s).toEqual(initialSettings());
  });

  it('新しい形式がなければ以前の版の設定を引き継ぐ（盤面の項目は使わない）', () => {
    const storage = new MemoryStorage();
    storage.setItem(STATE_V1_KEY, JSON.stringify({ size: 9, stones: '0'.repeat(81), theme: 'print', numbering: true }));
    const s = initialSettings();
    loadSettings(storage, s);
    expect(s).toEqual({ ...initialSettings(), theme: 'print', numbering: true });
  });

  it('壊れた JSON や使えない storage でも例外を出さない', () => {
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_KEY, '{broken');
    const s = initialSettings();
    expect(() => loadSettings(storage, s)).not.toThrow();
    expect(() => loadSettings(null, s)).not.toThrow();
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => loadSettings(throwing, s)).not.toThrow();
    expect(() => saveSettings(throwing, s)).not.toThrow();
  });
});

describe('PNG 出力', () => {
  it('ファイル名', () => {
    expect(exportFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe('goban-20260102-030405.png');
    expect(exportFileName(new Date(2026, 0, 2, 3, 4, 5), ' 定石/小目 その1 ')).toBe('goban-定石_小目_その1-20260102-030405.png');
    expect(exportFileName(new Date(2026, 0, 2, 3, 4, 5), '...')).toBe('goban-20260102-030405.png');
    expect(exportFileName(new Date(2026, 0, 2, 3, 4, 5), '詰碁', 'sgf')).toBe('goban-詰碁-20260102-030405.sgf');
  });

  it('表示範囲が狭いほどマスを大きくする（上限・下限あり）', () => {
    const full = exportCellSize(fullView(19));
    const zoomed = exportCellSize({ x0: 0, y0: 0, x1: 6, y1: 6 });
    expect(zoomed).toBeGreaterThan(full);
    expect(exportCellSize({ x0: 0, y0: 0, x1: 2, y1: 2 })).toBe(96);
    expect(exportCellSize(fullView(25))).toBeGreaterThanOrEqual(36);
  });
});
