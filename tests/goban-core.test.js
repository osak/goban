'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/goban-core.js');

const { BLACK, WHITE, EMPTY } = C;

/** 文字列で盤面を作る。'X' = 黒, 'O' = 白, '.' = 空 */
function boardFrom(rows) {
  const size = rows.length;
  const b = new C.Board(size);
  rows.forEach((row, y) => {
    [...row.replace(/\s+/g, '')].forEach((ch, x) => {
      if (ch === 'X') b.set(x, y, BLACK);
      else if (ch === 'O') b.set(x, y, WHITE);
    });
  });
  return b;
}

function toRows(b) {
  const rows = [];
  for (let y = 0; y < b.size; y++) {
    let s = '';
    for (let x = 0; x < b.size; x++) s += '.XO'[b.get(x, y)];
    rows.push(s);
  }
  return rows;
}

test('石を置いて取り除ける', () => {
  const b = new C.Board(9);
  assert.equal(b.place(2, 3, BLACK, 'remove').ok, true);
  assert.equal(b.get(2, 3), BLACK);
  assert.equal(b.place(2, 3, WHITE, 'remove').reason, 'occupied');
  assert.equal(b.remove(2, 3), BLACK);
  assert.equal(b.get(2, 3), EMPTY);
  assert.equal(b.remove(2, 3), EMPTY);
});

test('取り除くモード: 呼吸点のなくなった相手の石を取る', () => {
  const b = boardFrom([
    '.....',
    '..X..',
    '.XO..',
    '..X..',
    '.....',
  ]);
  const res = b.place(3, 2, BLACK, 'remove');
  assert.equal(res.ok, true);
  assert.deepEqual(res.captured, [b.index(2, 2)]);
  assert.deepEqual(toRows(b), ['.....', '..X..', '.X.X.', '..X..', '.....']);
});

test('取り除くモード: 連をまとめて取る・隅や辺でも取る', () => {
  const b = boardFrom([
    'OOX..',
    'XX...',
    '.....',
    '.....',
    '.....',
  ]);
  // 白の 2 子は既に呼吸点なし → 置いた石の隣ではないので何も起きない
  assert.equal(b.place(4, 4, BLACK, 'remove').captured.length, 0);
  const b2 = boardFrom([
    'OO...',
    'XXX..',
    '.....',
    '.....',
    '.....',
  ]);
  const res = b2.place(2, 0, BLACK, 'remove');
  assert.equal(res.ok, true);
  assert.equal(res.captured.length, 2);
  assert.deepEqual(toRows(b2)[0], '..X..');
});

test('取り除くモード: 複数の連を同時に取る', () => {
  const b = boardFrom([
    '.XOX.',
    'XO.OX',
    '.XOX.',
    '..X..',
    '.....',
  ]);
  // (2,1) に黒: 上・左・右・下の白 4 子がそれぞれ取られる
  const res = b.place(2, 1, BLACK, 'remove');
  assert.equal(res.ok, true);
  assert.equal(res.captured.length, 4);
  assert.deepEqual(toRows(b).slice(0, 3), ['.X.X.', 'X.X.X', '.X.X.']);
});

test('取り除くモード: 自殺手は置けない', () => {
  const b = boardFrom([
    '.X...',
    'X....',
    '.....',
    '.....',
    '.....',
  ]);
  const res = b.place(0, 0, WHITE, 'remove');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'suicide');
  assert.equal(b.get(0, 0), EMPTY);
});

test('取り除くモード: 取りになる場合は呼吸点がなくても置ける', () => {
  const b = boardFrom([
    'O.O..',
    'XOX..',
    '.X...',
    '.....',
    '.....',
  ]);
  // 黒 (1,0) の周りは白ばかりだが、白 (0,0) と (1,1) を取れるので置ける
  const res = b.place(1, 0, BLACK, 'remove');
  assert.equal(res.ok, true);
  assert.deepEqual(res.captured.sort((a, c) => a - c), [b.index(0, 0), b.index(1, 1)]);
  assert.equal(b.get(1, 0), BLACK);
  assert.equal(b.get(2, 0), WHITE);
});

test('マーク／何もしないモード: 盤面は変えない', () => {
  for (const mode of ['mark', 'none']) {
    const b = boardFrom([
      '.....',
      '..X..',
      '.XO..',
      '..X..',
      '.....',
    ]);
    const res = b.place(3, 2, BLACK, mode);
    assert.equal(res.ok, true);
    assert.equal(res.captured.length, 0);
    assert.equal(b.get(2, 2), WHITE);
    // 自殺手の位置にも置ける
    const b2 = boardFrom(['.X...', 'X....', '.....', '.....', '.....']);
    assert.equal(b2.place(0, 0, WHITE, mode).ok, true);
  }
});

test('deadStones: 呼吸点ゼロの連（両色）を返す', () => {
  const b = boardFrom([
    'OX...',
    'XX...',
    '..XXX',
    '..OOX',
    '..XX.',
  ]);
  const dead = b.deadStones();
  assert.deepEqual([...dead], [b.index(0, 0)]);
  b.set(1, 3, BLACK);
  const dead2 = b.deadStones();
  assert.ok(dead2.has(b.index(2, 3)) && dead2.has(b.index(3, 3)));
  assert.equal(dead2.size, 3);
});

test('serialize / deserialize', () => {
  const b = boardFrom(['X.O', '...', 'O.X']);
  const s = b.serialize();
  assert.equal(s, '102000201');
  const b2 = C.Board.deserialize(3, s);
  assert.ok(b2.equals(b));
  assert.equal(C.Board.deserialize(3, '12'), null);
  assert.equal(C.Board.deserialize(3, '10200020x'), null);
});

test('座標ラベル', () => {
  assert.equal(C.columnLabel(0, 19, 'western'), 'A');
  assert.equal(C.columnLabel(7, 19, 'western'), 'H');
  assert.equal(C.columnLabel(8, 19, 'western'), 'J'); // I は飛ばす
  assert.equal(C.columnLabel(18, 19, 'western'), 'T');
  assert.equal(C.rowLabel(0, 19, 'western'), '19');
  assert.equal(C.rowLabel(18, 19, 'western'), '1');
  assert.equal(C.rowLabel(0, 9, 'western'), '9');
  assert.equal(C.columnLabel(0, 19, 'japanese'), '1');
  assert.equal(C.columnLabel(18, 19, 'japanese'), '19');
  assert.equal(C.rowLabel(0, 19, 'japanese'), '一');
  assert.equal(C.rowLabel(9, 19, 'japanese'), '十');
  assert.equal(C.rowLabel(10, 19, 'japanese'), '十一');
  assert.equal(C.rowLabel(18, 19, 'japanese'), '十九');
  assert.equal(C.pointName(15, 3, 19, 'japanese'), '16の四');
  assert.equal(C.pointName(3, 15, 19, 'western'), 'D4');
});

test('星の位置', () => {
  assert.equal(C.starPoints(19).length, 9);
  assert.deepEqual(C.starPoints(13).sort(), [[3, 3], [3, 9], [6, 6], [9, 3], [9, 9]].sort());
  assert.ok(C.starPoints(9).some(([x, y]) => x === 4 && y === 4));
});

test('表示範囲: 正規化・最小幅・盤端での調整', () => {
  assert.deepEqual(C.normalizeView({ x0: 5, y0: 9, x1: 2, y1: 3 }, 19), { x0: 2, y0: 3, x1: 5, y1: 9 });
  assert.deepEqual(C.normalizeView({ x0: 4, y0: 4, x1: 4, y1: 5 }, 19), { x0: 3, y0: 3, x1: 5, y1: 5 });
  assert.deepEqual(C.normalizeView({ x0: 0, y0: 18, x1: 0, y1: 18 }, 19), { x0: 0, y0: 16, x1: 2, y1: 18 });
  assert.deepEqual(C.normalizeView({ x0: -3, y0: 0, x1: 40, y1: 7 }, 19), { x0: 0, y0: 0, x1: 18, y1: 7 });
  assert.deepEqual(C.normalizeView(null, 9), C.fullView(9));
  assert.deepEqual(C.viewAround({ x: 0, y: 0 }, 9, 19), { x0: 0, y0: 0, x1: 8, y1: 8 });
  assert.deepEqual(C.viewAround({ x: 9, y: 18 }, 9, 19), { x0: 5, y0: 10, x1: 13, y1: 18 });
  assert.deepEqual(C.viewAround({ x: 4, y: 4 }, 9, 9), C.fullView(9));
  assert.ok(C.isFullView(C.fullView(13), 13));
});

test('レイアウト: 表示領域に収まり、当たり判定が交点を返す', () => {
  const view = C.fullView(19);
  const L = C.computeLayout(view, 360, 500, 'western');
  assert.ok(L.width <= 360 + 1e-6, 'width ' + L.width);
  assert.ok(L.height <= 500 + 1e-6);
  assert.ok(L.font >= C.LAYOUT.minFont);
  // 交点ちょうど
  assert.deepEqual(C.hitTest(L, view, L.ox + 3 * L.cell, L.oy + 15 * L.cell), { x: 3, y: 15 });
  // 少しずれても最寄りの交点
  assert.deepEqual(C.hitTest(L, view, L.ox + 3.4 * L.cell, L.oy + 14.6 * L.cell), { x: 3, y: 15 });
  // 盤の外（ラベル部分）
  assert.equal(C.hitTest(L, view, 1, 1), null);
  // radius 指定
  assert.equal(C.hitTest(L, view, L.ox + 3.4 * L.cell, L.oy + 14.6 * L.cell, 0.3), null);

  const zoom = { x0: 10, y0: 0, x1: 18, y1: 6 };
  const Z = C.computeLayout(zoom, 360, 500, 'japanese');
  assert.equal(Z.cols, 9);
  assert.equal(Z.rows, 7);
  assert.ok(Z.width <= 360 + 1e-6 && Z.height <= 500 + 1e-6);
  assert.deepEqual(C.hitTest(Z, zoom, Z.ox, Z.oy), { x: 10, y: 0 });
  assert.deepEqual(C.hitTestClamped(Z, zoom, -50, 9999), { x: 10, y: 6 });

  const fixed = C.computeLayout(view, 0, 0, 'western', 40);
  assert.equal(fixed.cell, 40);
});

test('ドラッグ: 線分上の交点を順に拾う', () => {
  const view = C.fullView(9);
  const L = C.computeLayout(view, 400, 400, 'western');
  const y = L.oy + 2 * L.cell;
  const hits = C.hitsAlongSegment(L, view, L.ox, y, L.ox + 5 * L.cell, y, 0.45);
  assert.deepEqual(
    hits.map((p) => [p.x, p.y]),
    [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2]]
  );
  // 斜めに動かしたとき、間の交点は拾わない（階段状にならない）
  const diag = C.hitsAlongSegment(L, view, L.ox, L.oy, L.ox + 3 * L.cell, L.oy + 3 * L.cell, 0.45);
  assert.deepEqual(
    diag.map((p) => [p.x, p.y]),
    [[0, 0], [1, 1], [2, 2], [3, 3]]
  );
});
