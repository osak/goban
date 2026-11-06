/*
 * 碁盤の描画。画面表示と PNG 出力の両方で同じ関数を使う。
 */
(function (root) {
  'use strict';

  const C = root.GobanCore;
  const { BLACK, WHITE, EMPTY } = C;

  const FONT_FAMILY =
    '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", Meiryo, sans-serif';

  const THEMES = {
    wood: {
      background: '#dcb35c',
      line: '#2a1f0e',
      label: '#3a2a10',
      star: '#2a1f0e',
      shaded: true,
    },
    print: {
      background: '#ffffff',
      line: '#000000',
      label: '#000000',
      star: '#000000',
      shaded: false,
    },
  };

  /**
   * @param {CanvasRenderingContext2D} ctx  変換行列は scale 倍に設定済みであること
   * @param {object} p
   * @param {C.Board} p.board
   * @param {{x0,y0,x1,y1}} p.view
   * @param {object} p.layout   C.computeLayout の結果
   * @param {string} p.theme    'wood' | 'print'
   * @param {string} p.coordStyle 'western' | 'japanese'
   * @param {Set<number>} [p.marks]  △を付ける石のインデックス
   * @param {{x,y,color}} [p.ghost]  置く予定の石（半透明表示）
   * @param {{a:{x,y}, b:{x,y}}} [p.selection]  拡大範囲の選択中矩形
   * @param {number} [p.scale]  1 CSS px あたりのデバイスピクセル数（線をくっきり描くため）
   */
  function draw(ctx, p) {
    const { board, view, layout: L } = p;
    const theme = THEMES[p.theme] || THEMES.wood;
    const scale = p.scale || 1;
    const size = board.size;
    const cell = L.cell;

    // 線幅をデバイスピクセル単位で決め、位置をピクセル境界にそろえる
    const lineDev = Math.max(1, Math.round((cell * scale) / 30));
    const edgeDev = Math.max(2, Math.round(lineDev * 2));
    const snapFor = (wDev) => {
      const off = (wDev % 2) / 2;
      return (v) => (Math.round(v * scale - off) + off) / scale;
    };
    const snap = snapFor(lineDev);
    const xs = [];
    const ys = [];
    for (let i = 0; i < L.cols; i++) xs.push(snap(L.ox + i * cell));
    for (let j = 0; j < L.rows; j++) ys.push(snap(L.oy + j * cell));
    const X = (bx) => xs[bx - view.x0];
    const Y = (by) => ys[by - view.y0];

    // 背景
    ctx.save();
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, ctx.canvas.width / scale + 1, ctx.canvas.height / scale + 1);

    // 線。表示範囲の外にも盤が続いている側は線を少し延ばして示す
    const ext = cell * 0.45;
    const top = view.y0 === 0 ? ys[0] : ys[0] - ext;
    const bottom = view.y1 === size - 1 ? ys[L.rows - 1] : ys[L.rows - 1] + ext;
    const left = view.x0 === 0 ? xs[0] : xs[0] - ext;
    const right = view.x1 === size - 1 ? xs[L.cols - 1] : xs[L.cols - 1] + ext;

    ctx.strokeStyle = theme.line;
    ctx.lineCap = 'butt';
    ctx.lineWidth = lineDev / scale;
    ctx.beginPath();
    for (let bx = view.x0; bx <= view.x1; bx++) {
      if (bx === 0 || bx === size - 1) continue;
      ctx.moveTo(X(bx), top);
      ctx.lineTo(X(bx), bottom);
    }
    for (let by = view.y0; by <= view.y1; by++) {
      if (by === 0 || by === size - 1) continue;
      ctx.moveTo(left, Y(by));
      ctx.lineTo(right, Y(by));
    }
    ctx.stroke();

    // 盤の外周線（太線）
    const edgeSnap = snapFor(edgeDev);
    ctx.lineWidth = edgeDev / scale;
    ctx.lineCap = 'square';
    ctx.beginPath();
    for (const bx of [0, size - 1]) {
      if (bx < view.x0 || bx > view.x1) continue;
      const x = edgeSnap(L.ox + (bx - view.x0) * cell);
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    for (const by of [0, size - 1]) {
      if (by < view.y0 || by > view.y1) continue;
      const y = edgeSnap(L.oy + (by - view.y0) * cell);
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();

    // 星
    ctx.fillStyle = theme.star;
    const starR = Math.max(1.6, cell * 0.095);
    for (const [sx, sy] of C.starPoints(size)) {
      if (sx < view.x0 || sx > view.x1 || sy < view.y0 || sy > view.y1) continue;
      if (board.get(sx, sy) !== EMPTY) continue;
      ctx.beginPath();
      ctx.arc(X(sx), Y(sy), starR, 0, Math.PI * 2);
      ctx.fill();
    }

    // 石
    const r = cell * 0.48;
    for (let by = view.y0; by <= view.y1; by++) {
      for (let bx = view.x0; bx <= view.x1; bx++) {
        const c = board.get(bx, by);
        if (c === EMPTY) continue;
        drawStone(ctx, X(bx), Y(by), r, c, theme, scale);
      }
    }

    // △マーク
    if (p.marks && p.marks.size) {
      for (const idx of p.marks) {
        const bx = idx % size;
        const by = (idx - bx) / size;
        if (bx < view.x0 || bx > view.x1 || by < view.y0 || by > view.y1) continue;
        const c = board.grid[idx];
        drawTriangle(ctx, X(bx), Y(by), r, c === BLACK ? '#ffffff' : '#000000');
      }
    }

    // 置く予定の石（マウスホバー時）
    if (p.ghost) {
      const g = p.ghost;
      if (g.x >= view.x0 && g.x <= view.x1 && g.y >= view.y0 && g.y <= view.y1) {
        ctx.globalAlpha = 0.45;
        drawStone(ctx, X(g.x), Y(g.y), r, g.color, theme, scale, true);
        ctx.globalAlpha = 1;
      }
    }

    // 座標ラベル（表示中の線の分だけ、四辺に）
    ctx.fillStyle = theme.label;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fontPx = L.font;
    const topY = L.bandY / 2;
    const bottomY = L.height - L.bandY / 2;
    for (let bx = view.x0; bx <= view.x1; bx++) {
      const text = C.columnLabel(bx, size, p.coordStyle);
      fillFitted(ctx, text, X(bx), topY, fontPx, cell * 0.95);
      fillFitted(ctx, text, X(bx), bottomY, fontPx, cell * 0.95);
    }
    const leftX = L.bandX / 2;
    const rightX = L.width - L.bandX / 2;
    for (let by = view.y0; by <= view.y1; by++) {
      const text = C.rowLabel(by, size, p.coordStyle);
      fillFitted(ctx, text, leftX, Y(by), fontPx, L.bandX * 0.92);
      fillFitted(ctx, text, rightX, Y(by), fontPx, L.bandX * 0.92);
    }

    // 拡大範囲の選択中矩形
    if (p.selection) {
      const s = p.selection;
      const pad = cell * 0.5;
      const x0 = X(Math.min(s.a.x, s.b.x)) - pad;
      const x1 = X(Math.max(s.a.x, s.b.x)) + pad;
      const y0 = Y(Math.min(s.a.y, s.b.y)) - pad;
      const y1 = Y(Math.max(s.a.y, s.b.y)) + pad;
      ctx.fillStyle = 'rgba(37, 99, 235, 0.16)';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.95)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  function drawStone(ctx, x, y, r, color, theme, scale, isGhost) {
    ctx.save();
    if (theme.shaded) {
      if (!isGhost) {
        // shadow* は変換行列の影響を受けないのでデバイスピクセルで指定する
        ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
        ctx.shadowBlur = r * 0.18 * scale;
        ctx.shadowOffsetX = r * 0.07 * scale;
        ctx.shadowOffsetY = r * 0.1 * scale;
      }
      const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.38, r * 0.05, x, y, r * 1.05);
      if (color === BLACK) {
        g.addColorStop(0, '#5c5c5c');
        g.addColorStop(0.45, '#1c1c1c');
        g.addColorStop(1, '#000000');
      } else {
        g.addColorStop(0, '#ffffff');
        g.addColorStop(0.55, '#f1f0ec');
        g.addColorStop(1, '#bcb8b0');
      }
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (color === WHITE) {
        ctx.shadowColor = 'transparent';
        ctx.lineWidth = Math.max(0.5, r * 0.04);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.stroke();
      }
    } else {
      const lw = Math.max(1, r * 0.07);
      ctx.beginPath();
      ctx.arc(x, y, r - lw / 2, 0, Math.PI * 2);
      ctx.fillStyle = color === BLACK ? '#000000' : '#ffffff';
      ctx.fill();
      ctx.lineWidth = lw;
      ctx.strokeStyle = '#000000';
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawTriangle(ctx, x, y, r, color) {
    const s = r * 0.62; // 外接円の半径
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.2, r * 0.13);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const a = -Math.PI / 2 + (k * 2 * Math.PI) / 3;
      const px = x + s * Math.cos(a);
      const py = y + s * 0.1 + s * Math.sin(a);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  /** 幅 maxW に収まるよう必要なら文字を小さくして描く */
  function fillFitted(ctx, text, x, y, fontPx, maxW) {
    ctx.font = fontPx + 'px ' + FONT_FAMILY;
    const w = ctx.measureText(text).width;
    if (w > maxW && w > 0) {
      ctx.font = Math.max(6, (fontPx * maxW) / w) + 'px ' + FONT_FAMILY;
    }
    ctx.fillText(text, x, y);
  }

  root.GobanRenderer = { draw, THEMES };
})(typeof self !== 'undefined' ? self : this);
