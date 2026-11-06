/*
 * 碁盤アプリの UI 部分。状態管理・ポインタ操作・元に戻す・拡大・PNG 出力・保存。
 */
(function () {
  'use strict';

  const C = window.GobanCore;
  const R = window.GobanRenderer;
  const { BLACK, WHITE, EMPTY } = C;

  const STORAGE_KEY = 'goban.state.v1';
  const HISTORY_LIMIT = 500;
  const SIZES = [9, 13, 19];
  const COLOR_MODES = ['black', 'white', 'alternate'];
  const CAPTURE_MODES = [C.CAPTURE_REMOVE, C.CAPTURE_MARK, C.CAPTURE_NONE];
  const COORD_STYLES = ['western', 'japanese'];
  const THEMES = ['wood', 'print'];
  const DRAG_RADIUS = 0.45; // ドラッグ中に交点に「触れた」とみなす距離（マス単位）
  const TAP_ZOOM_SPAN = 9; // 拡大モードでタップしたときの表示路数

  const $ = (id) => document.getElementById(id);
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  const area = $('boardArea');

  const state = {
    board: new C.Board(19),
    colorMode: 'black',
    nextColor: BLACK, // 交互モードで次に置く色
    captureMode: C.CAPTURE_REMOVE,
    coordStyle: 'western',
    theme: 'wood',
    view: C.fullView(19),
    tool: 'stone', // 'stone' | 'zoom'
  };

  const undoStack = [];
  const redoStack = [];

  let layout = null;
  let scale = 1;
  let hover = null; // マウスが指している交点
  let stroke = null; // 石を置く／消す操作の途中経過
  let selection = null; // 拡大範囲の選択の途中経過
  let renderQueued = false;

  // ---------------------------------------------------------------------------
  // 描画
  // ---------------------------------------------------------------------------

  function currentColor() {
    if (state.colorMode === 'black') return BLACK;
    if (state.colorMode === 'white') return WHITE;
    return state.nextColor;
  }

  function render() {
    renderQueued = false;
    $('zoomHint').classList.toggle('selecting', !!selection);
    if (!layout) return;
    ctx.setTransform(canvas.width / layout.cssWidth, 0, 0, canvas.height / layout.cssHeight, 0, 0);
    let ghost = null;
    if (hover && !stroke && state.tool === 'stone' && state.board.get(hover.x, hover.y) === EMPTY) {
      ghost = { x: hover.x, y: hover.y, color: currentColor() };
    }
    R.draw(ctx, {
      board: state.board,
      view: state.view,
      layout,
      theme: state.theme,
      coordStyle: state.coordStyle,
      marks: state.captureMode === C.CAPTURE_MARK ? state.board.deadStones() : null,
      ghost,
      selection,
      scale,
    });
  }

  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  /** 表示領域の大きさに合わせてキャンバスの大きさを決め直す */
  function relayout() {
    const cs = getComputedStyle(area);
    const w = area.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = area.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (!(w > 0 && h > 0)) return;
    layout = C.computeLayout(state.view, w, h, state.coordStyle);
    layout.cssWidth = Math.max(1, Math.floor(layout.width));
    layout.cssHeight = Math.max(1, Math.floor(layout.height));
    scale = window.devicePixelRatio || 1;
    canvas.style.width = layout.cssWidth + 'px';
    canvas.style.height = layout.cssHeight + 'px';
    canvas.width = Math.round(layout.cssWidth * scale);
    canvas.height = Math.round(layout.cssHeight * scale);
    render(); // キャンバスの大きさを変えると内容が消えるのですぐ描き直す
  }

  // ---------------------------------------------------------------------------
  // 履歴（元に戻す／やり直す）
  // ---------------------------------------------------------------------------

  function snapshot() {
    return { size: state.board.size, grid: state.board.grid.slice(), nextColor: state.nextColor };
  }

  function sameGrid(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function pushUndo(snap) {
    undoStack.push(snap);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }

  function applySnapshot(snap) {
    if (snap.size !== state.board.size) {
      state.board = new C.Board(snap.size, snap.grid);
      state.view = C.fullView(snap.size);
      hover = null;
      relayout();
    } else {
      state.board.grid.set(snap.grid);
      requestRender();
    }
    state.nextColor = snap.nextColor;
    persist();
    updateUI();
  }

  function undo() {
    if (stroke || !undoStack.length) return;
    redoStack.push(snapshot());
    applySnapshot(undoStack.pop());
  }

  function redo() {
    if (stroke || !redoStack.length) return;
    undoStack.push(snapshot());
    applySnapshot(redoStack.pop());
  }

  // ---------------------------------------------------------------------------
  // ポインタ操作
  // ---------------------------------------------------------------------------

  function canvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * layout.cssWidth) / rect.width,
      y: ((e.clientY - rect.top) * layout.cssHeight) / rect.height,
    };
  }

  function capturePointer(e) {
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (_) {
      /* 取れなくても動作に支障はない */
    }
  }

  function onPointerDown(e) {
    if (!layout) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (stroke || selection) return; // 2 本目の指は無視する
    const pt = canvasPoint(e);

    if (state.tool === 'zoom') {
      e.preventDefault();
      const p = C.hitTestClamped(layout, state.view, pt.x, pt.y);
      selection = { id: e.pointerId, a: p, b: p };
      capturePointer(e);
      requestRender();
      return;
    }

    const p = C.hitTest(layout, state.view, pt.x, pt.y);
    if (!p) return;
    e.preventDefault();
    capturePointer(e);

    const board = state.board;
    stroke = {
      id: e.pointerId,
      before: snapshot(),
      action: board.get(p.x, p.y) === EMPTY ? 'place' : 'erase',
      color: currentColor(),
      drag: state.colorMode !== 'alternate', // 同色連打のときだけドラッグで続けて置ける
      last: pt,
      visited: new Set([board.index(p.x, p.y)]),
    };

    if (stroke.action === 'place') {
      const res = board.place(p.x, p.y, stroke.color, state.captureMode);
      if (res.ok) {
        if (state.colorMode === 'alternate') state.nextColor = C.opposite(stroke.color);
      } else if (res.reason === 'suicide') {
        toast('そこには置けません（呼吸点がありません）');
      }
    } else {
      const removed = board.remove(p.x, p.y);
      // 交互モードで石を取り除いたら、その色をもう一度置ける手番にする
      if (state.colorMode === 'alternate' && removed !== EMPTY) state.nextColor = removed;
    }
    hover = null;
    requestRender();
  }

  function onPointerMove(e) {
    if (!layout) return;

    if (selection && e.pointerId === selection.id) {
      const pt = canvasPoint(e);
      const p = C.hitTestClamped(layout, state.view, pt.x, pt.y);
      if (p.x !== selection.b.x || p.y !== selection.b.y) {
        selection.b = p;
        requestRender();
      }
      return;
    }

    if (stroke && e.pointerId === stroke.id) {
      if (!stroke.drag) return;
      const board = state.board;
      let events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
      if (!events || !events.length) events = [e];
      let changed = false;
      for (const ev of events) {
        const pt = canvasPoint(ev);
        const hits = C.hitsAlongSegment(layout, state.view, stroke.last.x, stroke.last.y, pt.x, pt.y, DRAG_RADIUS);
        for (const p of hits) {
          const i = board.index(p.x, p.y);
          if (stroke.visited.has(i)) continue;
          stroke.visited.add(i);
          if (stroke.action === 'place') {
            if (board.grid[i] === EMPTY && board.place(p.x, p.y, stroke.color, state.captureMode).ok) changed = true;
          } else if (board.remove(p.x, p.y) !== EMPTY) {
            changed = true;
          }
        }
        stroke.last = pt;
      }
      if (changed) requestRender();
      return;
    }

    if (e.pointerType === 'mouse' && state.tool === 'stone') {
      const pt = canvasPoint(e);
      const p = C.hitTest(layout, state.view, pt.x, pt.y);
      if (!samePoint(p, hover)) {
        hover = p;
        requestRender();
      }
    }
  }

  function onPointerUp(e) {
    if (selection && e.pointerId === selection.id) {
      const { a, b } = selection;
      selection = null;
      const size = state.board.size;
      const view =
        a.x === b.x && a.y === b.y ? C.viewAround(a, TAP_ZOOM_SPAN, size) : C.viewFromPoints(a, b, size);
      setTool('stone');
      setView(view);
      return;
    }
    if (stroke && e.pointerId === stroke.id) finishStroke();
  }

  function onPointerCancel(e) {
    if (selection && e.pointerId === selection.id) {
      selection = null;
      requestRender();
    }
    if (stroke && e.pointerId === stroke.id) finishStroke();
  }

  function finishStroke() {
    const s = stroke;
    stroke = null;
    if (!sameGrid(s.before.grid, state.board.grid)) pushUndo(s.before);
    else state.nextColor = s.before.nextColor;
    persist();
    updateUI();
    requestRender();
  }

  function samePoint(a, b) {
    if (!a || !b) return a === b;
    return a.x === b.x && a.y === b.y;
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('lostpointercapture', onPointerCancel);
  canvas.addEventListener('pointerleave', () => {
    if (hover) {
      hover = null;
      requestRender();
    }
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------------------------------------------------------------------------
  // 操作
  // ---------------------------------------------------------------------------

  function setTool(tool) {
    state.tool = tool;
    selection = null;
    hover = null;
    canvas.classList.toggle('zooming', tool === 'zoom');
    updateUI();
    requestRender();
  }

  function setView(view) {
    state.view = C.normalizeView(view, state.board.size);
    hover = null;
    relayout();
    persist();
    updateUI();
  }

  function setBoardSize(n) {
    if (stroke || n === state.board.size) return;
    if (
      !state.board.isEmpty() &&
      !window.confirm(n + '路盤に変更すると今の盤面は消えます。よろしいですか？\n（「元に戻す」で復元できます）')
    ) {
      return;
    }
    pushUndo(snapshot());
    state.board = new C.Board(n);
    state.view = C.fullView(n);
    state.nextColor = BLACK;
    hover = null;
    relayout();
    persist();
    updateUI();
  }

  function clearBoard() {
    if (stroke || state.board.isEmpty()) return;
    if (!window.confirm('盤面の石をすべて消しますか？\n（「元に戻す」で復元できます）')) return;
    pushUndo(snapshot());
    state.board.clear();
    state.nextColor = BLACK;
    requestRender();
    persist();
    updateUI();
  }

  // ---------------------------------------------------------------------------
  // PNG 出力
  // ---------------------------------------------------------------------------

  function exportPng() {
    const view = state.view;
    const span = Math.max(view.x1 - view.x0 + 1, view.y1 - view.y0 + 1);
    const cell = Math.round(Math.max(36, Math.min(96, 1100 / (span + 2))));
    const L = C.computeLayout(view, 0, 0, state.coordStyle, cell);
    const out = document.createElement('canvas');
    out.width = Math.ceil(L.width);
    out.height = Math.ceil(L.height);
    R.draw(out.getContext('2d'), {
      board: state.board,
      view,
      layout: L,
      theme: state.theme,
      coordStyle: state.coordStyle,
      marks: state.captureMode === C.CAPTURE_MARK ? state.board.deadStones() : null,
      scale: 1,
    });
    out.toBlob((blob) => {
      if (!blob) {
        toast('PNG の作成に失敗しました');
        return;
      }
      downloadBlob(blob, exportFileName());
      toast('PNG を保存しました');
    }, 'image/png');
  }

  function exportFileName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return (
      'goban-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.png'
    );
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // ---------------------------------------------------------------------------
  // 保存（ブラウザ内）
  // ---------------------------------------------------------------------------

  function persist() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          size: state.board.size,
          stones: state.board.serialize(),
          colorMode: state.colorMode,
          nextColor: state.nextColor,
          captureMode: state.captureMode,
          coordStyle: state.coordStyle,
          theme: state.theme,
          view: state.view,
        })
      );
    } catch (_) {
      /* プライベートモードなどで保存できなくても動作は続ける */
    }
  }

  function restorePersisted() {
    let data = null;
    try {
      data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (_) {
      return;
    }
    if (!data || typeof data !== 'object') return;
    if (SIZES.includes(data.size)) {
      const board = C.Board.deserialize(data.size, data.stones);
      if (board) {
        state.board = board;
        state.view = C.normalizeView(data.view, data.size);
      }
    }
    if (COLOR_MODES.includes(data.colorMode)) state.colorMode = data.colorMode;
    if (data.nextColor === BLACK || data.nextColor === WHITE) state.nextColor = data.nextColor;
    if (CAPTURE_MODES.includes(data.captureMode)) state.captureMode = data.captureMode;
    if (COORD_STYLES.includes(data.coordStyle)) state.coordStyle = data.coordStyle;
    if (THEMES.includes(data.theme)) state.theme = data.theme;
  }

  // ---------------------------------------------------------------------------
  // パネル
  // ---------------------------------------------------------------------------

  const segments = [];

  function bindSegment(id, getValue, onSelect) {
    const el = $(id);
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (btn) onSelect(btn.dataset.value);
    });
    segments.push({ el, getValue });
  }

  bindSegment('colorMode', () => state.colorMode, (v) => {
    state.colorMode = v;
    persist();
    updateUI();
    requestRender();
  });

  bindSegment('captureMode', () => state.captureMode, (v) => {
    state.captureMode = v;
    persist();
    updateUI();
    requestRender();
  });

  bindSegment('boardSize', () => state.board.size, (v) => setBoardSize(Number(v)));

  bindSegment('coordStyle', () => state.coordStyle, (v) => {
    state.coordStyle = v;
    persist();
    updateUI();
    relayout();
  });

  bindSegment('theme', () => state.theme, (v) => {
    state.theme = v;
    persist();
    updateUI();
    requestRender();
  });

  $('nextColor').addEventListener('click', () => {
    state.nextColor = C.opposite(state.nextColor);
    persist();
    updateUI();
    requestRender();
  });

  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('zoomBtn').addEventListener('click', () => setTool(state.tool === 'zoom' ? 'stone' : 'zoom'));
  $('resetZoom').addEventListener('click', () => setView(C.fullView(state.board.size)));
  $('exportPng').addEventListener('click', exportPng);
  $('clearBoard').addEventListener('click', clearBoard);

  $('settingsBtn').addEventListener('click', () => {
    const settings = $('settings');
    settings.hidden = !settings.hidden;
    $('settingsBtn').setAttribute('aria-expanded', String(!settings.hidden));
  });

  function updateUI() {
    for (const { el, getValue } of segments) {
      const v = String(getValue());
      for (const btn of el.querySelectorAll('button[data-value]')) {
        btn.setAttribute('aria-pressed', String(btn.dataset.value === v));
      }
    }
    const alternate = state.colorMode === 'alternate';
    $('nextColor').hidden = !alternate;
    $('nextColorIcon').className = 'stone-icon ' + (state.nextColor === BLACK ? 'black' : 'white');
    $('nextColorText').textContent = state.nextColor === BLACK ? '黒' : '白';
    $('undo').disabled = undoStack.length === 0;
    $('redo').disabled = redoStack.length === 0;
    $('resetZoom').disabled = C.isFullView(state.view, state.board.size);
    $('zoomBtn').setAttribute('aria-pressed', String(state.tool === 'zoom'));
    $('zoomHint').hidden = state.tool !== 'zoom';
  }

  let toastTimer = 0;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && !e.altKey && key === 'y') {
      e.preventDefault();
      redo();
    } else if (e.key === 'Escape' && state.tool === 'zoom') {
      setTool('stone');
    }
  });

  // ---------------------------------------------------------------------------
  // 起動
  // ---------------------------------------------------------------------------

  restorePersisted();
  updateUI();
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => relayout()).observe(area);
  }
  window.addEventListener('resize', relayout);
  relayout();
})();
