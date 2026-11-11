/**
 * 碁盤アプリの UI。ポインタ操作・元に戻す・拡大・PNG 出力・保存をつなぐ。
 */

import { BLACK, Board, CAPTURE_MODES, EMPTY, opposite, type PlaceResult, type StoneColor } from './board';
import { eraseCapturing, placeCapturing, settleCaptured } from './capture';
import { COORD_STYLES, pointName } from './coords';
import { downloadBlob, exportFileName, renderPng } from './export';
import { UndoHistory } from './history';
import {
  applyEntry,
  cleanName,
  defaultName,
  emptyEntry,
  entryFromState,
  loadLibrary,
  newId,
  saveLibrary,
  sortedEntries,
  type BoardEntry,
} from './library';
import { computeLayout, hitTest, hitTestClamped, hitsAlongSegment, type Layout } from './layout';
import { NUMBER_STYLES, movesOnBoard, stoneNumbers, withoutLastMoveAt, type Move } from './moves';
import { getStorage, loadState, saveState } from './persistence';
import { THEME_NAMES, draw, drawThumbnail } from './renderer';
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
  readonly marks: ReadonlySet<number>;
  readonly captured: ReadonlySet<number>;
}

/** 石を置く／消す操作（タップまたはドラッグ）の途中経過 */
interface Stroke {
  readonly pointerId: number;
  readonly before: Snapshot;
  /** 石を置く / 石を消す / △を付ける / △を外す */
  readonly action: 'place' | 'erase' | 'mark' | 'unmark';
  readonly color: StoneColor;
  /** ドラッグで続けて置ける／消せるか（同色連打と△の付け外しのとき） */
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

/** 一覧に出す更新時刻（今年なら月日と時刻、それより前なら年月日） */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === new Date().getFullYear()
    ? `${md} ${p(d.getHours())}:${p(d.getMinutes())}`
    : `${d.getFullYear()}/${md}`;
}

function samePoint(a: Point | null, b: Point | null): boolean {
  return a === null || b === null ? a === b : a.x === b.x && a.y === b.y;
}

function sameGrid(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export class GobanApp {
  private state: AppState = initialState();
  private readonly storage = getStorage();
  /** 保存した盤面の一覧。currentId の盤面が今 state に読み込まれている */
  private entries: BoardEntry[] = [];
  private currentId = '';
  /** 盤面ごとの元に戻す／やり直すの履歴（このページを開いている間だけ） */
  private readonly histories = new Map<string, UndoHistory<Snapshot>>();
  /** 盤面一覧のサムネイル（盤面の内容が変わったら作り直す） */
  private readonly thumbnails = new Map<string, { key: string; canvas: HTMLCanvasElement }>();
  /** 保存に失敗したことを知らせたか */
  private saveFailureShown = false;

  private layout: ScreenLayout | null = null;
  private scale = 1;
  /** マウスが指している交点（タッチでは使わない） */
  private hover: Point | null = null;
  private stroke: Stroke | null = null;
  /** 拡大範囲を選び終えたら戻すタップの役割 */
  private toolBeforeZoom: Tool = 'stone';
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
    boardsToggle: byId('boardsBtn', HTMLButtonElement),
    boards: byId('boards', HTMLElement),
    boardName: byId('boardName', HTMLInputElement),
    newBoard: byId('newBoard', HTMLButtonElement),
    duplicateBoard: byId('duplicateBoard', HTMLButtonElement),
    deleteBoard: byId('deleteBoard', HTMLButtonElement),
    boardList: byId('boardList', HTMLUListElement),
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
    this.loadEntries();
    this.syncCaptured();
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
    const { board, view, theme, coordStyle, tool } = this.state;
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
      marks: this.marks(),
      numbers: this.numbers(),
      ghost,
      selection: this.selection,
      scale: this.scale,
    });
  }

  /** △を付ける石: 手で付けたもの（石があるところだけ）と、「△マーク」モードの取られた石 */
  private marks(): Set<number> {
    const { board, captureMode } = this.state;
    const out = captureMode === 'mark' ? new Set(this.state.captured) : new Set<number>();
    for (const i of this.state.marks) if (board.grid[i] !== EMPTY) out.add(i);
    return out;
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
    const { board, nextColor, moves, marks, captured } = this.state;
    return {
      size: board.size,
      grid: board.grid.slice(),
      nextColor,
      moves: moves.slice(),
      marks: new Set(marks),
      captured: new Set(captured),
    };
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
    this.state.marks = new Set(snap.marks);
    this.state.captured = new Set(snap.captured);
    this.syncCaptured(); // 記録したあとにモードを切り替えていることがある
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
    this.syncCurrentEntry();
    this.saveEntries();
    this.updateUI();
  }

  /** 今の盤面の履歴 */
  private get history(): UndoHistory<Snapshot> {
    let h = this.histories.get(this.currentId);
    if (!h) {
      h = new UndoHistory<Snapshot>(HISTORY_LIMIT);
      this.histories.set(this.currentId, h);
    }
    return h;
  }

  // ---------------------------------------------------------------------------
  // 保存した盤面
  // ---------------------------------------------------------------------------

  private get currentEntry(): BoardEntry | undefined {
    return this.entries.find((e) => e.id === this.currentId);
  }

  /** 保存した盤面の一覧を読み込み、選んでいた盤面を state に反映する */
  private loadEntries(): void {
    const library = loadLibrary(this.storage);
    if (library) {
      this.entries = [...library.entries];
      this.currentId = library.currentId;
      const entry = this.currentEntry;
      if (entry) applyEntry(this.state, entry);
    } else {
      // 盤面の一覧がまだない（初回、または以前の版で保存した盤面）: 今の盤面を 1 つ目として登録する
      const now = Date.now();
      const entry = entryFromState(this.state, { id: newId(), name: defaultName([]), createdAt: now }, now);
      this.entries = [entry];
      this.currentId = entry.id;
      this.saveEntries();
    }
  }

  /** state の盤面の内容を一覧の今の盤面に書き戻す */
  private syncCurrentEntry(): void {
    const i = this.entries.findIndex((e) => e.id === this.currentId);
    if (i >= 0) this.entries[i] = entryFromState(this.state, this.entries[i]);
  }

  private saveEntries(): void {
    const ok = saveLibrary(this.storage, { currentId: this.currentId, entries: this.entries });
    if (!ok && this.storage && !this.saveFailureShown) {
      this.saveFailureShown = true;
      this.toast('盤面を保存できませんでした（ブラウザの保存容量を確認してください）');
    }
  }

  /** 一覧の盤面 id に切り替える */
  private switchBoard(id: string): void {
    if (this.stroke || id === this.currentId) return;
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    this.syncCurrentEntry();
    this.currentId = id;
    applyEntry(this.state, entry);
    this.syncCaptured();
    this.hover = null;
    this.selection = null;
    this.relayout();
    this.changed();
  }

  /** 盤面を一覧に加えて切り替える */
  private addBoard(entry: BoardEntry): void {
    this.syncCurrentEntry();
    this.entries.push(entry);
    this.switchBoard(entry.id);
    this.ui.boardList.scrollTop = 0;
  }

  private newBoard(): void {
    if (this.stroke) return;
    this.addBoard(emptyEntry(defaultName(this.entries), this.state.board.size));
  }

  private duplicateBoard(): void {
    if (this.stroke) return;
    this.syncCurrentEntry();
    const src = this.currentEntry;
    if (!src) return;
    const now = Date.now();
    const name = cleanName(`${src.name} のコピー`, defaultName(this.entries));
    this.addBoard({ ...src, id: newId(), name, createdAt: now, updatedAt: now });
  }

  private deleteBoard(): void {
    const entry = this.currentEntry;
    if (this.stroke || !entry) return;
    if (!window.confirm(`「${entry.name}」を削除しますか？\n（削除すると元に戻せません）`)) return;
    this.entries = this.entries.filter((e) => e.id !== entry.id);
    this.histories.delete(entry.id);
    this.thumbnails.delete(entry.id);
    const next = sortedEntries(this.entries)[0] ?? emptyEntry(defaultName([]), entry.size);
    if (this.entries.length === 0) this.entries.push(next);
    this.currentId = ''; // 削除した盤面には書き戻さない
    this.switchBoard(next.id);
  }

  private renameBoard(name: string, final: boolean): void {
    const i = this.entries.findIndex((e) => e.id === this.currentId);
    if (i < 0) return;
    const fallback = this.entries[i].name;
    const cleaned = final ? cleanName(name, fallback) : Array.from(name).slice(0, 40).join('') || fallback;
    if (cleaned === this.entries[i].name) return;
    this.entries[i] = { ...this.entries[i], name: cleaned };
    this.saveEntries();
    this.updateBoardList();
    this.updateTitle();
  }

  private updateTitle(): void {
    const name = this.currentEntry?.name;
    document.title = name ? `${name} - 碁盤` : '碁盤';
  }

  /** 盤面一覧を描き直す */
  private updateBoardList(): void {
    const { boardList: list, boardName } = this.ui;
    const current = this.currentEntry;
    if (current && document.activeElement !== boardName) boardName.value = current.name;
    this.ui.deleteBoard.disabled = !current;
    if (this.ui.boards.hidden) return;

    const items = sortedEntries(this.entries).map((e) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.id = e.id;
      if (e.id === this.currentId) btn.setAttribute('aria-current', 'true');
      const info = document.createElement('span');
      info.className = 'board-info';
      const name = document.createElement('span');
      name.className = 'board-name';
      name.textContent = e.name;
      const meta = document.createElement('span');
      meta.className = 'board-meta';
      const moves = e.moves.length / 3;
      const stones = e.stones.replace(/0/g, '').length;
      meta.textContent = [`${e.size}路`, moves > 0 ? `${moves}手` : `${stones}子`, formatTime(e.updatedAt)].join(' ・ ');
      info.append(name, meta);
      btn.append(this.thumbnail(e), info);
      const li = document.createElement('li');
      li.append(btn);
      return li;
    });
    list.replaceChildren(...items);
  }

  private thumbnail(e: BoardEntry): HTMLCanvasElement {
    const key = `${this.state.theme}:${e.size}:${e.stones}`;
    const cached = this.thumbnails.get(e.id);
    if (cached && cached.key === key) return cached.canvas;
    const canvas = cached?.canvas ?? document.createElement('canvas');
    canvas.className = 'board-thumb';
    const css = 48;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(css * scale);
    canvas.height = Math.round(css * scale);
    const ctx = canvas.getContext('2d');
    const board = Board.deserialize(e.size, e.stones);
    if (ctx && board) {
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      drawThumbnail(ctx, board, css, this.state.theme);
    }
    this.thumbnails.set(e.id, { key, canvas });
    return canvas;
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
    const i = board.index(p.x, p.y);
    const marking = state.tool === 'mark';
    if (marking && board.grid[i] === EMPTY) return; // △は石にだけ付ける
    const stroke: Stroke = {
      pointerId: e.pointerId,
      before: this.snapshot(),
      action: marking
        ? state.marks.has(i)
          ? 'unmark'
          : 'mark'
        : board.grid[i] === EMPTY
          ? 'place'
          : 'erase',
      color: currentColor(state),
      drag: marking || state.colorMode !== 'alternate',
      last: pt,
      visited: new Set([i]),
    };
    this.stroke = stroke;

    if (stroke.action === 'mark') {
      state.marks.add(i);
    } else if (stroke.action === 'unmark') {
      state.marks.delete(i);
    } else if (stroke.action === 'place') {
      const res = this.placeStone(p.x, p.y, stroke.color);
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
          if (stroke.action === 'mark' || stroke.action === 'unmark') {
            if (board.grid[i] === EMPTY) continue;
            if (stroke.action === 'mark') state.marks.add(i);
            else state.marks.delete(i);
            changed = true;
          } else if (stroke.action === 'place') {
            if (board.grid[i] === EMPTY && this.placeStone(p.x, p.y, stroke.color).ok) {
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
      this.setTool(this.toolBeforeZoom);
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

  /** 囲まれた石の扱いに合わせて石を置く */
  private placeStone(x: number, y: number, color: StoneColor): PlaceResult {
    const { board, captured, captureMode } = this.state;
    return captureMode === 'mark'
      ? placeCapturing(board, captured, x, y, color)
      : board.place(x, y, color, captureMode);
  }

  /**
   * 石を取り除き、取り除いた石の色を返す。
   * 最後に置いた石なら置き間違いの修正とみなして着手の記録からも消す。
   * それ以外の石は記録に残す（取られた石を手で取り除く場合など）。
   * 「△マーク」モードで取られていない石を取り除いたら、それに囲まれていた取られた石は元に戻す。
   */
  private eraseStone(x: number, y: number): ReturnType<Board['remove']> {
    const { board, captured } = this.state;
    const i = board.index(x, y);
    const wasCaptured = captured.has(i);
    const removed = board.remove(x, y);
    if (removed !== EMPTY) {
      const moves = withoutLastMoveAt(this.state.moves, x, y, removed);
      if (moves) this.state.moves = moves;
      if (this.state.captureMode === 'mark') eraseCapturing(board, captured, i, removed, wasCaptured);
    }
    return removed;
  }

  /**
   * 取られた石を今のモードに合わせる。
   * 「△マーク」モードでは盤面と食い違わないように整え（打った順が分からない石は呼吸点のない連をすべて取られた石にする）、
   * ほかのモードでは空にする。
   */
  private syncCaptured(): void {
    const { board, captured } = this.state;
    if (this.state.captureMode === 'mark') settleCaptured(board, captured);
    else captured.clear();
  }

  private finishStroke(): void {
    const stroke = this.stroke;
    if (!stroke) return;
    this.stroke = null;
    this.pruneMarks();
    const { board, moves, marks } = this.state;
    const sameMarks = marks.size === stroke.before.marks.size && [...marks].every((i) => stroke.before.marks.has(i));
    if (sameGrid(stroke.before.grid, board.grid) && stroke.before.moves.length === moves.length && sameMarks) {
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

  /** 石がなくなった交点の△を外す（取られた石の跡に後から置いた石に△が残らないように） */
  private pruneMarks(): void {
    const { board, marks } = this.state;
    for (const i of marks) if (board.grid[i] === EMPTY) marks.delete(i);
  }

  private setTool(tool: Tool): void {
    if (tool === 'zoom' && this.state.tool !== 'zoom') this.toolBeforeZoom = this.state.tool;
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
    this.state.marks = new Set();
    this.state.captured = new Set();
  }

  private async exportPng(): Promise<void> {
    const { board, view, theme, coordStyle } = this.state;
    const blob = await renderPng({
      board,
      view,
      theme,
      coordStyle,
      marks: this.marks(),
      numbers: this.numbers(),
    });
    if (!blob) {
      this.toast('PNG の作成に失敗しました');
      return;
    }
    downloadBlob(blob, exportFileName(new Date(), this.currentEntry?.name));
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

    // 「置く石」は黒・白・交互に加えて△（石に△を付け外しする）を選べる
    this.bindSegment(
      'colorMode',
      [...COLOR_MODES, 'mark'] as const,
      () => (state.tool === 'mark' ? 'mark' : state.colorMode),
      (v) => {
        if (v === 'mark') {
          this.setTool('mark');
        } else {
          state.colorMode = v;
          this.setTool('stone');
        }
        settingChanged();
      },
    );
    this.bindSegment('captureMode', CAPTURE_MODES, () => state.captureMode, (v) => {
      if (this.stroke || v === state.captureMode) return;
      state.captureMode = v;
      // 「△マーク」に切り替えた時点では打った順が分からないので、呼吸点のない連をすべて取られた石にする
      state.captured.clear();
      this.syncCaptured();
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
    ui.zoom.addEventListener('click', () => this.setTool(state.tool === 'zoom' ? this.toolBeforeZoom : 'zoom'));
    ui.resetZoom.addEventListener('click', () => this.setView(fullView(state.board.size)));
    ui.exportPng.addEventListener('click', () => void this.exportPng());
    ui.clear.addEventListener('click', () => this.clearBoard());
    ui.boardsToggle.addEventListener('click', () => {
      ui.boards.hidden = !ui.boards.hidden;
      ui.boardsToggle.setAttribute('aria-expanded', String(!ui.boards.hidden));
      this.updateBoardList();
    });
    ui.newBoard.addEventListener('click', () => this.newBoard());
    ui.duplicateBoard.addEventListener('click', () => this.duplicateBoard());
    ui.deleteBoard.addEventListener('click', () => this.deleteBoard());
    ui.boardName.addEventListener('input', () => this.renameBoard(ui.boardName.value, false));
    ui.boardName.addEventListener('change', () => {
      this.renameBoard(ui.boardName.value, true);
      ui.boardName.value = this.currentEntry?.name ?? '';
    });
    ui.boardName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ui.boardName.blur();
    });
    ui.boardList.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest<HTMLButtonElement>('button[data-id]') : null;
      if (btn?.dataset.id) this.switchBoard(btn.dataset.id);
    });
    ui.settingsToggle.addEventListener('click', () => {
      ui.settings.hidden = !ui.settings.hidden;
      ui.settingsToggle.setAttribute('aria-expanded', String(!ui.settings.hidden));
    });
  }

  private bindKeyboard(): void {
    document.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return; // 名前の入力中は文字の取り消しに使う
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
        this.setTool(this.toolBeforeZoom);
      }
    });
  }

  private updateUI(): void {
    const { state, ui } = this;
    for (const update of this.segmentUpdaters) update();
    const black = state.nextColor === BLACK;
    ui.nextColor.hidden = state.colorMode !== 'alternate' || state.tool === 'mark';
    ui.nextColorIcon.className = `stone-icon ${black ? 'black' : 'white'}`;
    ui.nextColorText.textContent = black ? '黒' : '白';
    ui.undo.disabled = !this.history.canUndo;
    ui.redo.disabled = !this.history.canRedo;
    ui.resetZoom.disabled = isFullView(state.view, state.board.size);
    ui.zoom.setAttribute('aria-pressed', String(state.tool === 'zoom'));
    ui.zoomHint.hidden = state.tool !== 'zoom';
    ui.moveLog.hidden = !state.numbering;
    if (state.numbering) this.updateMoveLog();
    this.updateBoardList();
    this.updateTitle();
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
