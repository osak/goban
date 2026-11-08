/**
 * 碁盤アプリの UI。ポインタ操作・元に戻す・拡大・PNG 出力・保存をつなぐ。
 */

import { BLACK, Board, CAPTURE_MODES, EMPTY, opposite, type StoneColor } from './board';
import { COORD_STYLES, pointName } from './coords';
import { downloadBlob, exportFileName, renderPng } from './export';
import { UndoHistory } from './history';
import { computeLayout, hitTest, hitTestClamped, hitsAlongSegment, type Layout } from './layout';
import { NUMBER_STYLES, movesOnBoard, stoneNumbers, withoutLastMoveAt, type Move } from './moves';
import { getStorage, loadState, saveState } from './persistence';
import { THEME_NAMES, draw } from './renderer';
import { BOARD_SIZES, COLOR_MODES, currentColor, initialState, type AppState, type Tool } from './state';
import { fullView, isFullView, normalizeView, viewAround, viewFromPoints, type Point, type View } from './view';

/** ドラッグ中に交点に「触れた」とみなす距離（マス単位） */
const DRAG_RADIUS = 0.45;
/** 拡大モードでタップしたときに表示する路数 */
const TAP_ZOOM_SPAN = 9;
const HISTORY_LIMIT = 500;

/** 画面表示用のレイアウト。キャンバスの CSS 上の大きさ（整数 px）を持つ */
interface ScreenLayout extends Layout {
  readonly cssWidth: number;
  readonly cssHeight: number;
}

interface Snapshot {
  readonly size: number;
  readonly grid: Uint8Array;
  readonly nextColor: StoneColor;
  readonly moves: readonly Move[];
}

/** 石を置く／消す操作（タップまたはドラッグ）の途中経過 */
interface Stroke {
  readonly pointerId: number;
  readonly before: Snapshot;
  readonly action: 'place' | 'erase';
  readonly color: StoneColor;
  /** ドラッグで続けて置ける／消せるか（同色連打のときだけ） */
  readonly drag: boolean;
  /** 直前のポインタ位置（キャンバス上の px） */
  last: { x: number; y: number };
  /** この操作で処理済みの交点 */
  readonly visited: Set<number>;
}

/** 拡大範囲の選択の途中経過 */
interface Selection {
  readonly pointerId: number;
  readonly a: Point;
  b: Point;
}

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} が見つかりません`);
  return el;
}

function samePoint(a: Point | null, b: Point | null): boolean {
  return a === null || b === null ? a === b : a.x === b.x && a.y === b.y;
}

function sameGrid(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export class GobanApp {
  private state: AppState = initialState();
  private readonly history = new UndoHistory<Snapshot>(HISTORY_LIMIT);
  private readonly storage = getStorage();

  private layout: ScreenLayout | null = null;
  private scale = 1;
  /** マウスが指している交点（タッチでは使わない） */
  private hover: Point | null = null;
  private stroke: Stroke | null = null;
  private selection: Selection | null = null;
  private renderQueued = false;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly canvas = byId('board', HTMLCanvasElement);
  private readonly ctx: CanvasRenderingContext2D;
  private readonly area = byId('boardArea', HTMLElement);
  private readonly ui = {
    undo: byId('undo', HTMLButtonElement),
    redo: byId('redo', HTMLButtonElement),
    zoom: byId('zoomBtn', HTMLButtonElement),
    resetZoom: byId('resetZoom', HTMLButtonElement),
    exportPng: byId('exportPng', HTMLButtonElement),
    settingsToggle: byId('settingsBtn', HTMLButtonElement),
    settings: byId('settings', HTMLElement),
    clear: byId('clearBoard', HTMLButtonElement),
    nextColor: byId('nextColor', HTMLButtonElement),
    nextColorIcon: byId('nextColorIcon', HTMLElement),
    nextColorText: byId('nextColorText', HTMLElement),
    zoomHint: byId('zoomHint', HTMLElement),
    moveLog: byId('moveLog', HTMLElement),
    moveLogStatus: byId('moveLogStatus', HTMLElement),
    moveLogList: byId('moveLogList', HTMLOListElement),
    toast: byId('toast', HTMLElement),
  };
  /** 選択ボタン群の表示を状態に合わせる関数 */
  private readonly segmentUpdaters: Array<() => void> = [];
  /** 着手のログを最後に描き直したときの手数（増えたら末尾までスクロールする） */
  private loggedMoves = -1;

  constructor() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D が使えません');
    this.ctx = ctx;
  }

  start(): void {
    loadState(this.storage, this.state);
    this.bindPointer();
    this.bindPanel();
    this.bindKeyboard();
    this.updateUI();
    new ResizeObserver(() => this.relayout()).observe(this.area);
    window.addEventListener('resize', () => this.relayout());
    this.relayout();
  }

  // ---------------------------------------------------------------------------
  // 描画
  // ---------------------------------------------------------------------------

  private requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => this.render());
  }

  private render(): void {
    this.renderQueued = false;
    this.ui.zoomHint.classList.toggle('selecting', this.selection !== null);
    const L = this.layout;
    if (!L) return;
    const { board, view, theme, coordStyle, captureMode, tool } = this.state;
    const hover = this.hover;
    const ghost =
      hover && !this.stroke && tool === 'stone' && board.get(hover.x, hover.y) === EMPTY
        ? { ...hover, color: currentColor(this.state) }
        : null;
    this.ctx.setTransform(this.canvas.width / L.cssWidth, 0, 0, this.canvas.height / L.cssHeight, 0, 0);
    draw(this.ctx, {
      board,
      view,
      layout: L,
      theme,
      coordStyle,
      marks: captureMode === 'mark' ? board.deadStones() : null,
      numbers: this.numbers(),
      ghost,
      selection: this.selection,
      scale: this.scale,
    });
  }

  /** 石に書く着手番号（表示しないときは null） */
  private numbers(): Map<number, number> | null {
    const { board, moves, numbering, numberFrom, numberStyle } = this.state;
    return numbering ? stoneNumbers(board, moves, numberFrom, numberStyle) : null;
  }

  /** 表示領域の大きさに合わせてキャンバスの大きさを決め直す */
  private relayout(): void {
    const cs = getComputedStyle(this.area);
    const w = this.area.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = this.area.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (!(w > 0 && h > 0)) return;
    const layout = computeLayout(this.state.view, w, h, this.state.coordStyle);
    const cssWidth = Math.max(1, Math.floor(layout.width));
    const cssHeight = Math.max(1, Math.floor(layout.height));
    this.layout = { ...layout, cssWidth, cssHeight };
    this.scale = window.devicePixelRatio || 1;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.width = Math.round(cssWidth * this.scale);
    this.canvas.height = Math.round(cssHeight * this.scale);
    this.render(); // キャンバスの大きさを変えると内容が消えるのですぐ描き直す
  }

  // ---------------------------------------------------------------------------
  // 履歴
  // ---------------------------------------------------------------------------

  private snapshot(): Snapshot {
    const { board, nextColor, moves } = this.state;
    return { size: board.size, grid: board.grid.slice(), nextColor, moves: moves.slice() };
  }

  private applySnapshot(snap: Snapshot): void {
    if (snap.size !== this.state.board.size) {
      this.state.board = new Board(snap.size, snap.grid);
      this.state.view = fullView(snap.size);
      this.hover = null;
      this.relayout();
    } else {
      this.state.board.grid.set(snap.grid);
      this.requestRender();
    }
    this.state.nextColor = snap.nextColor;
    this.state.moves = snap.moves.slice();
    this.changed();
  }

  private undo(): void {
    if (this.stroke) return;
    const prev = this.history.undo(this.snapshot());
    if (prev) this.applySnapshot(prev);
  }

  private redo(): void {
    if (this.stroke) return;
    const next = this.history.redo(this.snapshot());
    if (next) this.applySnapshot(next);
  }

  /** 状態が変わったあとに保存とパネル表示の更新を行う */
  private changed(): void {
    saveState(this.storage, this.state);
    this.updateUI();
  }

  // ---------------------------------------------------------------------------
  // ポインタ操作
  // ---------------------------------------------------------------------------

  private bindPointer(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', (e) => this.onPointerMove(e));
    c.addEventListener('pointerup', (e) => this.onPointerUp(e));
    c.addEventListener('pointercancel', (e) => this.onPointerCancel(e));
    c.addEventListener('lostpointercapture', (e) => this.onPointerCancel(e));
    c.addEventListener('pointerleave', () => {
      if (this.hover) {
        this.hover = null;
        this.requestRender();
      }
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** ポインタ位置をキャンバス上の座標（CSS px）にする */
  private canvasPoint(e: PointerEvent, L: ScreenLayout): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * L.cssWidth) / rect.width,
      y: ((e.clientY - rect.top) * L.cssHeight) / rect.height,
    };
  }

  private capturePointer(e: PointerEvent): void {
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // 取れなくても動作に支障はない
    }
  }

  private onPointerDown(e: PointerEvent): void {
    const L = this.layout;
    if (!L) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.stroke || this.selection) return; // 2 本目の指は無視する
    const pt = this.canvasPoint(e, L);
    const { state } = this;

    if (state.tool === 'zoom') {
      e.preventDefault();
      const p = hitTestClamped(L, state.view, pt.x, pt.y);
      this.selection = { pointerId: e.pointerId, a: p, b: p };
      this.capturePointer(e);
      this.requestRender();
      return;
    }

    const p = hitTest(L, state.view, pt.x, pt.y);
    if (!p) return;
    e.preventDefault();
    this.capturePointer(e);

    const board = state.board;
    const stroke: Stroke = {
      pointerId: e.pointerId,
      before: this.snapshot(),
      action: board.get(p.x, p.y) === EMPTY ? 'place' : 'erase',
      color: currentColor(state),
      drag: state.colorMode !== 'alternate',
      last: pt,
      visited: new Set([board.index(p.x, p.y)]),
    };
    this.stroke = stroke;

    if (stroke.action === 'place') {
      const res = board.place(p.x, p.y, stroke.color, state.captureMode);
      if (res.ok) {
        state.moves.push({ x: p.x, y: p.y, color: stroke.color });
        if (state.colorMode === 'alternate') state.nextColor = opposite(stroke.color);
      } else if (res.reason === 'suicide') {
        this.toast('そこには置けません（呼吸点がありません）');
      }
    } else {
      const removed = this.eraseStone(p.x, p.y);
      // 交互モードで石を取り除いたら、その色をもう一度置ける手番にする
      if (state.colorMode === 'alternate' && removed !== EMPTY) state.nextColor = removed;
    }
    this.hover = null;
    this.requestRender();
  }

  private onPointerMove(e: PointerEvent): void {
    const L = this.layout;
    if (!L) return;
    const { state } = this;

    const sel = this.selection;
    if (sel && e.pointerId === sel.pointerId) {
      const pt = this.canvasPoint(e, L);
      const p = hitTestClamped(L, state.view, pt.x, pt.y);
      if (!samePoint(p, sel.b)) {
        sel.b = p;
        this.requestRender();
      }
      return;
    }

    const stroke = this.stroke;
    if (stroke && e.pointerId === stroke.pointerId) {
      if (!stroke.drag) return;
      const board = state.board;
      const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      let changed = false;
      for (const ev of coalesced.length ? coalesced : [e]) {
        const pt = this.canvasPoint(ev, L);
        for (const p of hitsAlongSegment(L, state.view, stroke.last.x, stroke.last.y, pt.x, pt.y, DRAG_RADIUS)) {
          const i = board.index(p.x, p.y);
          if (stroke.visited.has(i)) continue;
          stroke.visited.add(i);
          if (stroke.action === 'place') {
            if (board.grid[i] === EMPTY && board.place(p.x, p.y, stroke.color, state.captureMode).ok) {
              state.moves.push({ x: p.x, y: p.y, color: stroke.color });
              changed = true;
            }
          } else if (this.eraseStone(p.x, p.y) !== EMPTY) {
            changed = true;
          }
        }
        stroke.last = pt;
      }
      if (changed) this.requestRender();
      return;
    }

    if (e.pointerType === 'mouse' && state.tool === 'stone') {
      const pt = this.canvasPoint(e, L);
      const p = hitTest(L, state.view, pt.x, pt.y);
      if (!samePoint(p, this.hover)) {
        this.hover = p;
        this.requestRender();
      }
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const sel = this.selection;
    if (sel && e.pointerId === sel.pointerId) {
      this.selection = null;
      const size = this.state.board.size;
      const view = samePoint(sel.a, sel.b) ? viewAround(sel.a, TAP_ZOOM_SPAN, size) : viewFromPoints(sel.a, sel.b, size);
      this.setTool('stone');
      this.setView(view);
      return;
    }
    if (this.stroke && e.pointerId === this.stroke.pointerId) this.finishStroke();
  }

  private onPointerCancel(e: PointerEvent): void {
    if (this.selection && e.pointerId === this.selection.pointerId) {
      this.selection = null;
      this.requestRender();
    }
    if (this.stroke && e.pointerId === this.stroke.pointerId) this.finishStroke();
  }

  /**
   * 石を取り除き、取り除いた石の色を返す。
   * 最後に置いた石なら置き間違いの修正とみなして着手の記録からも消す。
   * それ以外の石は記録に残す（取られた石を手で取り除く場合など）。
   */
  private eraseStone(x: number, y: number): ReturnType<Board['remove']> {
    const removed = this.state.board.remove(x, y);
    if (removed !== EMPTY) {
      const moves = withoutLastMoveAt(this.state.moves, x, y, removed);
      if (moves) this.state.moves = moves;
    }
    return removed;
  }

  private finishStroke(): void {
    const stroke = this.stroke;
    if (!stroke) return;
    this.stroke = null;
    if (sameGrid(stroke.before.grid, this.state.board.grid) && stroke.before.moves.length === this.state.moves.length) {
      this.state.nextColor = stroke.before.nextColor;
    } else {
      this.history.record(stroke.before);
    }
    this.changed();
    this.requestRender();
  }

  // ---------------------------------------------------------------------------
  // 操作
  // ---------------------------------------------------------------------------

  private setTool(tool: Tool): void {
    this.state.tool = tool;
    this.selection = null;
    this.hover = null;
    this.canvas.classList.toggle('zooming', tool === 'zoom');
    this.updateUI();
    this.requestRender();
  }

  private setView(view: View): void {
    this.state.view = normalizeView(view, this.state.board.size);
    this.hover = null;
    this.relayout();
    this.changed();
  }

  private setBoardSize(size: number): void {
    if (this.stroke || size === this.state.board.size) return;
    const message = `${size}路盤に変更すると今の盤面は消えます。よろしいですか？\n（「元に戻す」で復元できます）`;
    if (!this.state.board.isEmpty() && !window.confirm(message)) return;
    this.history.record(this.snapshot());
    this.state.board = new Board(size);
    this.state.view = fullView(size);
    this.state.nextColor = BLACK;
    this.resetMoves();
    this.hover = null;
    this.relayout();
    this.changed();
  }

  private clearBoard(): void {
    const { board, moves } = this.state;
    if (this.stroke || (board.isEmpty() && moves.length === 0)) return;
    const message = board.isEmpty()
      ? '着手のログを消しますか？\n（「元に戻す」で復元できます）'
      : '盤面の石をすべて消しますか？\n（「元に戻す」で復元できます）';
    if (!window.confirm(message)) return;
    this.history.record(this.snapshot());
    board.clear();
    this.state.nextColor = BLACK;
    this.resetMoves();
    this.requestRender();
    this.changed();
  }

  /** 盤面を新しくしたときに着手の記録と番号の起点を消す */
  private resetMoves(): void {
    this.state.moves = [];
    this.state.numberFrom = 0;
  }

  private async exportPng(): Promise<void> {
    const { board, view, theme, coordStyle, captureMode } = this.state;
    const blob = await renderPng({
      board,
      view,
      theme,
      coordStyle,
      marks: captureMode === 'mark' ? board.deadStones() : null,
      numbers: this.numbers(),
    });
    if (!blob) {
      this.toast('PNG の作成に失敗しました');
      return;
    }
    downloadBlob(blob, exportFileName());
    this.toast('PNG を保存しました');
  }

  // ---------------------------------------------------------------------------
  // パネル
  // ---------------------------------------------------------------------------

  /** data-value を持つボタン群を、values のどれかを選ぶ選択肢として結び付ける */
  private bindSegment<T extends string | number>(
    id: string,
    values: readonly T[],
    get: () => T,
    set: (value: T) => void,
  ): void {
    const group = byId(id, HTMLElement);
    const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>('button[data-value]'));
    group.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest<HTMLButtonElement>('button[data-value]') : null;
      const value = values.find((v) => String(v) === btn?.dataset.value);
      if (value !== undefined) set(value);
    });
    this.segmentUpdaters.push(() => {
      const current = String(get());
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === current));
    });
  }

  private bindPanel(): void {
    const { state, ui } = this;
    const settingChanged = () => {
      this.changed();
      this.requestRender();
    };

    this.bindSegment('colorMode', COLOR_MODES, () => state.colorMode, (v) => {
      state.colorMode = v;
      settingChanged();
    });
    this.bindSegment('captureMode', CAPTURE_MODES, () => state.captureMode, (v) => {
      state.captureMode = v;
      settingChanged();
    });
    this.bindSegment('numbering', ['off', 'on'] as const, () => (state.numbering ? 'on' : 'off'), (v) => {
      state.numbering = v === 'on';
      settingChanged();
    });
    this.bindSegment('numberStyle', NUMBER_STYLES, () => state.numberStyle, (v) => {
      state.numberStyle = v;
      settingChanged();
    });
    ui.moveLogList.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest<HTMLButtonElement>('button[data-index]') : null;
      const index = Number(btn?.dataset.index);
      if (!Number.isInteger(index) || index < 0) return;
      state.numberFrom = index;
      settingChanged();
    });
    this.bindSegment('boardSize', BOARD_SIZES, () => state.board.size, (v) => this.setBoardSize(v));
    this.bindSegment('coordStyle', COORD_STYLES, () => state.coordStyle, (v) => {
      state.coordStyle = v;
      this.changed();
      this.relayout(); // ラベル帯の幅が変わる
    });
    this.bindSegment('theme', THEME_NAMES, () => state.theme, (v) => {
      state.theme = v;
      settingChanged();
    });

    ui.nextColor.addEventListener('click', () => {
      state.nextColor = opposite(state.nextColor);
      settingChanged();
    });
    ui.undo.addEventListener('click', () => this.undo());
    ui.redo.addEventListener('click', () => this.redo());
    ui.zoom.addEventListener('click', () => this.setTool(state.tool === 'zoom' ? 'stone' : 'zoom'));
    ui.resetZoom.addEventListener('click', () => this.setView(fullView(state.board.size)));
    ui.exportPng.addEventListener('click', () => void this.exportPng());
    ui.clear.addEventListener('click', () => this.clearBoard());
    ui.settingsToggle.addEventListener('click', () => {
      ui.settings.hidden = !ui.settings.hidden;
      ui.settingsToggle.setAttribute('aria-expanded', String(!ui.settings.hidden));
    });
  }

  private bindKeyboard(): void {
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && !e.altKey && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (mod && !e.altKey && key === 'y') {
        e.preventDefault();
        this.redo();
      } else if (e.key === 'Escape' && this.state.tool === 'zoom') {
        this.setTool('stone');
      }
    });
  }

  private updateUI(): void {
    const { state, ui } = this;
    for (const update of this.segmentUpdaters) update();
    const black = state.nextColor === BLACK;
    ui.nextColor.hidden = state.colorMode !== 'alternate';
    ui.nextColorIcon.className = `stone-icon ${black ? 'black' : 'white'}`;
    ui.nextColorText.textContent = black ? '黒' : '白';
    ui.undo.disabled = !this.history.canUndo;
    ui.redo.disabled = !this.history.canRedo;
    ui.resetZoom.disabled = isFullView(state.view, state.board.size);
    ui.zoom.setAttribute('aria-pressed', String(state.tool === 'zoom'));
    ui.zoomHint.hidden = state.tool !== 'zoom';
    ui.moveLog.hidden = !state.numbering;
    if (state.numbering) this.updateMoveLog();
  }

  /** 着手のログを描き直す */
  private updateMoveLog(): void {
    const { board, moves, numberFrom, numberStyle, coordStyle } = this.state;
    const { moveLogStatus: status, moveLogList: list } = this.ui;
    const onBoard = movesOnBoard(board, moves);
    const from = Math.min(numberFrom, moves.length);

    const items = moves.map((m, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.index = String(i);
      btn.setAttribute('aria-pressed', String(i === from));
      if (i < from) btn.classList.add('before');
      if (!onBoard.has(i)) {
        btn.classList.add('gone');
        btn.title = '盤上にありません';
      }
      const num = document.createElement('span');
      num.className = 'mv-n';
      num.textContent = String(i + 1);
      const icon = document.createElement('span');
      icon.className = `stone-icon ${m.color === BLACK ? 'black' : 'white'}`;
      const pt = document.createElement('span');
      pt.className = 'mv-pt';
      pt.textContent = pointName(m.x, m.y, board.size, coordStyle);
      btn.append(num, icon, pt);
      return btn;
    });
    // 末尾に「次の手から」（これから置く石から番号を付ける）
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'next';
    next.dataset.index = String(moves.length);
    next.setAttribute('aria-pressed', String(from === moves.length));
    next.textContent = '次の手から';
    items.push(next);
    list.replaceChildren(
      ...items.map((b) => {
        const li = document.createElement('li');
        li.append(b);
        return li;
      }),
    );

    const first = numberStyle === 'absolute' ? from + 1 : 1;
    const last = first + moves.length - from - 1;
    status.textContent =
      moves.length === 0
        ? 'まだ石が置かれていません'
        : from >= moves.length
          ? `${moves.length}手 ・ 次の手から番号`
          : `${moves.length}手 ・ ${from + 1}手目から番号（${first}〜${last}）`;

    if (moves.length > this.loggedMoves) list.scrollTop = list.scrollHeight;
    this.loggedMoves = moves.length;
  }

  private toast(message: string): void {
    const el = this.ui.toast;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }
}
