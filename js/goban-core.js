/*
 * 碁盤アプリのコアロジック（DOM / Canvas に依存しない部分）
 *  - 盤面データと石の配置・除去
 *  - 囲まれた石（呼吸点ゼロの連）の判定
 *  - 座標ラベル
 *  - 表示範囲（拡大）とレイアウト計算・当たり判定
 *
 * ブラウザでは window.GobanCore、Node では module.exports として公開する。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.GobanCore = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EMPTY = 0;
  const BLACK = 1;
  const WHITE = 2;

  /** 取り判定モード */
  const CAPTURE_REMOVE = 'remove'; // 囲まれた石を取り除く
  const CAPTURE_MARK = 'mark'; // 囲まれた石に△を付ける
  const CAPTURE_NONE = 'none'; // 何もしない

  function opposite(color) {
    if (color === BLACK) return WHITE;
    if (color === WHITE) return BLACK;
    return EMPTY;
  }

  class Board {
    constructor(size, grid) {
      if (!Number.isInteger(size) || size < 2 || size > 25) {
        throw new RangeError('invalid board size: ' + size);
      }
      this.size = size;
      this.grid = new Uint8Array(size * size);
      if (grid) {
        if (grid.length !== size * size) throw new RangeError('grid length mismatch');
        this.grid.set(grid);
      }
    }

    index(x, y) {
      return y * this.size + x;
    }

    inBounds(x, y) {
      return x >= 0 && y >= 0 && x < this.size && y < this.size;
    }

    get(x, y) {
      return this.grid[this.index(x, y)];
    }

    set(x, y, color) {
      this.grid[this.index(x, y)] = color;
    }

    clone() {
      return new Board(this.size, this.grid);
    }

    isEmpty() {
      for (let i = 0; i < this.grid.length; i++) if (this.grid[i] !== EMPTY) return false;
      return true;
    }

    stoneCount() {
      let n = 0;
      for (let i = 0; i < this.grid.length; i++) if (this.grid[i] !== EMPTY) n++;
      return n;
    }

    equals(other) {
      if (!other || other.size !== this.size) return false;
      for (let i = 0; i < this.grid.length; i++) if (this.grid[i] !== other.grid[i]) return false;
      return true;
    }

    /** 盤上インデックス i の上下左右のインデックス */
    neighbors(i) {
      const s = this.size;
      const x = i % s;
      const out = [];
      if (x > 0) out.push(i - 1);
      if (x < s - 1) out.push(i + 1);
      if (i >= s) out.push(i - s);
      if (i < s * s - s) out.push(i + s);
      return out;
    }

    /** インデックス i の石を含む連と、その呼吸点の数を返す */
    groupAt(i) {
      const color = this.grid[i];
      if (color === EMPTY) return { color, stones: [], liberties: 0 };
      const seen = new Uint8Array(this.grid.length);
      const libSeen = new Uint8Array(this.grid.length);
      const stones = [];
      const stack = [i];
      let liberties = 0;
      seen[i] = 1;
      while (stack.length) {
        const cur = stack.pop();
        stones.push(cur);
        for (const n of this.neighbors(cur)) {
          const c = this.grid[n];
          if (c === EMPTY) {
            if (!libSeen[n]) {
              libSeen[n] = 1;
              liberties++;
            }
          } else if (c === color && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
      return { color, stones, liberties };
    }

    /** 呼吸点がゼロの連に属する石のインデックス集合（△マーク用） */
    deadStones() {
      const dead = new Set();
      const done = new Uint8Array(this.grid.length);
      for (let i = 0; i < this.grid.length; i++) {
        if (this.grid[i] === EMPTY || done[i]) continue;
        const g = this.groupAt(i);
        for (const s of g.stones) done[s] = 1;
        if (g.liberties === 0) for (const s of g.stones) dead.add(s);
      }
      return dead;
    }

    /**
     * 石を置く。
     * captureMode が 'remove' のときは、呼吸点がなくなった相手の連を取り除く。
     * その結果自分の連の呼吸点がゼロなら（自殺手）置かずに失敗とする。
     * 'mark' / 'none' のときは盤面に石を置くだけ。
     * @returns {{ok: boolean, captured: number[], reason?: string}}
     */
    place(x, y, color, captureMode) {
      if (!this.inBounds(x, y)) return { ok: false, captured: [], reason: 'out-of-bounds' };
      if (color !== BLACK && color !== WHITE) return { ok: false, captured: [], reason: 'bad-color' };
      const i = this.index(x, y);
      if (this.grid[i] !== EMPTY) return { ok: false, captured: [], reason: 'occupied' };
      this.grid[i] = color;
      const captured = [];
      if (captureMode === CAPTURE_REMOVE) {
        const enemy = opposite(color);
        for (const n of this.neighbors(i)) {
          if (this.grid[n] !== enemy) continue; // 既に取り除いた連もここで弾かれる
          const g = this.groupAt(n);
          if (g.liberties === 0) {
            for (const s of g.stones) {
              this.grid[s] = EMPTY;
              captured.push(s);
            }
          }
        }
        if (captured.length === 0 && this.groupAt(i).liberties === 0) {
          this.grid[i] = EMPTY;
          return { ok: false, captured: [], reason: 'suicide' };
        }
      }
      return { ok: true, captured };
    }

    /** 石を取り除き、取り除いた石の色を返す（なければ EMPTY） */
    remove(x, y) {
      if (!this.inBounds(x, y)) return EMPTY;
      const i = this.index(x, y);
      const c = this.grid[i];
      this.grid[i] = EMPTY;
      return c;
    }

    clear() {
      this.grid.fill(EMPTY);
    }

    serialize() {
      return Array.from(this.grid).join('');
    }

    static deserialize(size, str) {
      if (typeof str !== 'string' || str.length !== size * size || /[^012]/.test(str)) return null;
      const grid = new Uint8Array(size * size);
      for (let i = 0; i < str.length; i++) grid[i] = str.charCodeAt(i) - 48;
      return new Board(size, grid);
    }
  }

  // ---------------------------------------------------------------------------
  // 星
  // ---------------------------------------------------------------------------

  function starPoints(size) {
    let lines;
    if (size === 19) lines = [3, 9, 15];
    else if (size === 13) return [[3, 3], [9, 3], [6, 6], [3, 9], [9, 9]];
    else if (size === 9) return [[2, 2], [6, 2], [4, 4], [2, 6], [6, 6]];
    else if (size >= 13) {
      const c = (size - 1) / 2;
      lines = Number.isInteger(c) ? [3, c, size - 4] : [3, size - 4];
    } else if (size >= 7) {
      const pts = [[2, 2], [size - 3, 2], [2, size - 3], [size - 3, size - 3]];
      if (size % 2 === 1) pts.push([(size - 1) / 2, (size - 1) / 2]);
      return pts;
    } else {
      return size % 2 === 1 ? [[(size - 1) / 2, (size - 1) / 2]] : [];
    }
    const pts = [];
    for (const y of lines) for (const x of lines) pts.push([x, y]);
    return pts;
  }

  // ---------------------------------------------------------------------------
  // 座標ラベル
  // ---------------------------------------------------------------------------

  const WESTERN_COLUMNS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'; // I は使わない
  const KANJI_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  function kanjiNumber(n) {
    if (n <= 0 || n >= 100) return String(n);
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    let s = '';
    if (tens > 0) s += (tens > 1 ? KANJI_DIGITS[tens] : '') + '十';
    s += KANJI_DIGITS[ones];
    return s;
  }

  /**
   * 横方向（列）のラベル。x は 0 始まり（左端が 0）。
   * western: A, B, ... T（I を飛ばす） / japanese: 1, 2, ... 19
   */
  function columnLabel(x, size, style) {
    if (style === 'japanese') return String(x + 1);
    return WESTERN_COLUMNS[x] || String(x + 1);
  }

  /**
   * 縦方向（行）のラベル。y は 0 始まり（上端が 0）。
   * western: 下から 1..19 / japanese: 上から 一..十九
   */
  function rowLabel(y, size, style) {
    if (style === 'japanese') return kanjiNumber(y + 1);
    return String(size - y);
  }

  /** 交点の座標表記（例: "D4", "4の十六"） */
  function pointName(x, y, size, style) {
    if (style === 'japanese') return columnLabel(x, size, style) + 'の' + rowLabel(y, size, style);
    return columnLabel(x, size, style) + rowLabel(y, size, style);
  }

  // ---------------------------------------------------------------------------
  // 表示範囲（拡大）
  // ---------------------------------------------------------------------------

  const MIN_VIEW_SPAN = 3;

  function fullView(size) {
    return { x0: 0, y0: 0, x1: size - 1, y1: size - 1 };
  }

  function isFullView(view, size) {
    return view.x0 === 0 && view.y0 === 0 && view.x1 === size - 1 && view.y1 === size - 1;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  /** [a, b] の幅が min 以上になるよう、盤内で広げる */
  function expandSpan(a, b, min, size) {
    min = Math.min(min, size);
    while (b - a + 1 < min) {
      if (a > 0) a--;
      if (b - a + 1 < min && b < size - 1) b++;
    }
    return [a, b];
  }

  /** 任意の矩形を盤内に収め、最小幅を保証した表示範囲にする */
  function normalizeView(view, size, minSpan) {
    if (minSpan == null) minSpan = MIN_VIEW_SPAN;
    if (!view || [view.x0, view.y0, view.x1, view.y1].some((v) => !Number.isFinite(v))) {
      return fullView(size);
    }
    let x0 = clamp(Math.round(Math.min(view.x0, view.x1)), 0, size - 1);
    let x1 = clamp(Math.round(Math.max(view.x0, view.x1)), 0, size - 1);
    let y0 = clamp(Math.round(Math.min(view.y0, view.y1)), 0, size - 1);
    let y1 = clamp(Math.round(Math.max(view.y0, view.y1)), 0, size - 1);
    [x0, x1] = expandSpan(x0, x1, minSpan, size);
    [y0, y1] = expandSpan(y0, y1, minSpan, size);
    return { x0, y0, x1, y1 };
  }

  /** 2 つの交点を対角とする表示範囲 */
  function viewFromPoints(a, b, size) {
    return normalizeView({ x0: a.x, y0: a.y, x1: b.x, y1: b.y }, size);
  }

  /** 交点 p を中心とした span × span の表示範囲（盤端では内側にずらす） */
  function viewAround(p, span, size) {
    span = Math.min(span, size);
    const shift = (c) => {
      let a = c - Math.floor((span - 1) / 2);
      a = clamp(a, 0, size - span);
      return [a, a + span - 1];
    };
    const [x0, x1] = shift(p.x);
    const [y0, y1] = shift(p.y);
    return { x0, y0, x1, y1 };
  }

  // ---------------------------------------------------------------------------
  // レイアウト（キャンバス上の位置）と当たり判定
  // ---------------------------------------------------------------------------

  const LAYOUT = {
    gap: 0.7, // 外側の線からラベル帯までの距離（マス単位）
    fontRatio: 0.42, // ラベル文字サイズ / マス
    minFont: 9, // ラベル文字の最小サイズ（px）
    bandY: 1.5, // 上下のラベル帯の高さ（em）
    bandXWestern: 1.7, // 左右のラベル帯の幅（em）: "19"
    bandXJapanese: 2.4, // 左右のラベル帯の幅（em）: "十九"
  };

  /**
   * 表示範囲 view を availW × availH に収めるレイアウトを計算する。
   * fixedCell を指定するとマスの大きさを固定する（PNG 出力用）。
   */
  function computeLayout(view, availW, availH, coordStyle, fixedCell) {
    const cols = view.x1 - view.x0 + 1;
    const rows = view.y1 - view.y0 + 1;
    const L = LAYOUT;
    const bandXem = coordStyle === 'japanese' ? L.bandXJapanese : L.bandXWestern;
    const bandYem = L.bandY;
    let cell;
    if (fixedCell) {
      cell = fixedCell;
    } else {
      const unitsX = cols - 1 + 2 * L.gap;
      const unitsY = rows - 1 + 2 * L.gap;
      cell = Math.min(
        availW / (unitsX + 2 * bandXem * L.fontRatio),
        availH / (unitsY + 2 * bandYem * L.fontRatio)
      );
      if (cell * L.fontRatio < L.minFont) {
        // 文字が小さくなりすぎる場合はラベル帯を固定幅にして計算し直す
        cell = Math.min(
          (availW - 2 * bandXem * L.minFont) / unitsX,
          (availH - 2 * bandYem * L.minFont) / unitsY
        );
      }
      cell = Math.max(cell, 4);
    }
    const font = Math.max(L.minFont, cell * L.fontRatio);
    const bandX = bandXem * font;
    const bandY = bandYem * font;
    const ox = bandX + L.gap * cell;
    const oy = bandY + L.gap * cell;
    return {
      cols,
      rows,
      cell,
      font,
      bandX,
      bandY,
      ox,
      oy,
      width: 2 * ox + (cols - 1) * cell,
      height: 2 * oy + (rows - 1) * cell,
    };
  }

  /**
   * キャンバス上の座標 (px, py) に最も近い表示中の交点を返す。
   * radius（マス単位）を指定すると、交点からその距離以内のときだけ返す。
   */
  function hitTest(layout, view, px, py, radius) {
    const fx = (px - layout.ox) / layout.cell;
    const fy = (py - layout.oy) / layout.cell;
    const ix = Math.round(fx);
    const iy = Math.round(fy);
    if (ix < 0 || iy < 0 || ix >= layout.cols || iy >= layout.rows) return null;
    if (radius != null && Math.hypot(fx - ix, fy - iy) > radius) return null;
    return { x: view.x0 + ix, y: view.y0 + iy };
  }

  /** hitTest と同様だが、表示範囲外は最も近い端の交点に丸める */
  function hitTestClamped(layout, view, px, py) {
    const ix = clamp(Math.round((px - layout.ox) / layout.cell), 0, layout.cols - 1);
    const iy = clamp(Math.round((py - layout.oy) / layout.cell), 0, layout.rows - 1);
    return { x: view.x0 + ix, y: view.y0 + iy };
  }

  /**
   * (x0,y0) から (x1,y1) へ指を動かしたときに通過した交点を順に返す。
   * 始点付近の交点も含まれうるので、重複の除外は呼び出し側で行う。
   * 速いドラッグでも交点を取りこぼさないよう線分上を細かくサンプリングする。
   */
  function hitsAlongSegment(layout, view, x0, y0, x1, y1, radius) {
    const step = Math.max(1, layout.cell * 0.12);
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    const out = [];
    let lastKey = -1;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const p = hitTest(layout, view, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius);
      if (!p) continue;
      const key = p.y * 64 + p.x;
      if (key !== lastKey) {
        out.push(p);
        lastKey = key;
      }
    }
    return out;
  }

  return {
    EMPTY,
    BLACK,
    WHITE,
    CAPTURE_REMOVE,
    CAPTURE_MARK,
    CAPTURE_NONE,
    opposite,
    Board,
    starPoints,
    kanjiNumber,
    columnLabel,
    rowLabel,
    pointName,
    MIN_VIEW_SPAN,
    fullView,
    isFullView,
    normalizeView,
    viewFromPoints,
    viewAround,
    LAYOUT,
    computeLayout,
    hitTest,
    hitTestClamped,
    hitsAlongSegment,
  };
});
