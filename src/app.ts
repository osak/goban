/**
 * 碁盤アプリの UI。ポインタ操作・元に戻す・拡大・PNG / SGF の保存と読み込み・盤面の一覧をつなぐ。
 *
 * 盤面の内容はゲームツリー（edit.ts の Doc）だけに持ち、表示する局面はそこから導出する（game.ts）。
 */

import { BLACK, Board, CAPTURE_MODES, EMPTY, type StoneColor } from './board';
import { COORD_STYLES, pointName } from './coords';
import {
  docName,
  docNodes,
  eraseStone,
  hasContent,
  labelsAt,
  newDoc,
  nextColorOf,
  placeStone,
  renameDoc,
  resetDoc,
  setLabel,
  setNumberStart,
  setTriangle,
  toggleTurn,
  trianglesAt,
  type Doc,
  type EditOptions,
} from './edit';
import { downloadBlob, exportFileName, renderPng } from './export';
import { PositionCache, type GamePosition } from './game';
import { UndoHistory } from './history';
import {
  cleanName,
  defaultName,
  emptyEntry,
  entryFromDoc,
  entryName,
  loadLibrary,
  newId,
  saveLibrary,
  sortedEntries,
  type BoardEntry,
} from './library';
import { pickLabelText } from './labels';
import { computeLayout, hitTest, hitTestClamped, hitsAlongSegment, type Layout } from './layout';
import { NUMBER_STYLES, movesOnBoard, stoneNumbers } from './moves';
import { getStorage, loadSettings, saveSettings } from './persistence';
import { THEME_NAMES, draw, drawThumbnail } from './renderer';
import { exportSgf, importSgfBytes } from './sgf-file';
import { BOARD_SIZES, COLOR_MODES, currentColor, initialState, type AppState, type Tool } from './state';
import { getProp, setProp } from './tree';
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

/** 石を置く／消す操作（タップまたはドラッグ）の途中経過 */
interface Stroke {
  readonly pointerId: number;
  readonly before: Doc;
  /** 石を置く / 石を消す / △を付ける / △を外す / 文字を書く・消す */
  readonly action: 'place' | 'erase' | 'mark' | 'unmark' | 'label';
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

function sameDoc(a: Doc, b: Doc): boolean {
  return a.root === b.root && a.turn === b.turn && a.cursor.length === b.cursor.length && a.cursor.every((k, i) => k === b.cursor[i]);
}

function sameValues(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => v === b[i]));
}

export class GobanApp {
  private state: AppState = initialState();
  private readonly storage = getStorage();
  /** 今の盤面のゲームツリーと今のノード */
  private doc: Doc = newDoc(19);
  /** 今の盤面の表示範囲 */
  private view: View = fullView(19);
  private readonly positions = new PositionCache();
  /** doc の今のノードの局面 */
  private pos: GamePosition = this.positions.position(docNodes(this.doc));
  /** 保存した盤面の一覧。currentId の盤面が今 doc に読み込まれている */
  private entries: BoardEntry[] = [];
  private currentId = '';
  /** 盤面ごとの元に戻す／やり直すの履歴（このページを開いている間だけ） */
  private readonly histories = new Map<string, UndoHistory<Doc>>();
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
    exportSgf: byId('exportSgf', HTMLButtonElement),
    openSgf: byId('openSgf', HTMLButtonElement),
    sgfFile: byId('sgfFile', HTMLInputElement),
    settingsToggle: byId('settingsBtn', HTMLButtonElement),
    settings: byId('settings', HTMLElement),
    clear: byId('clearBoard', HTMLButtonElement),
    nextColor: byId('nextColor', HTMLButtonElement),
    nextColorIcon: byId('nextColorIcon', HTMLElement),
    nextColorText: byId('nextColorText', HTMLElement),
    labelText: byId('labelText', HTMLInputElement),
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
    loadSettings(this.storage, this.state);
    this.loadEntries();
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
    const { theme, coordStyle, tool } = this.state;
    const { view } = this;
    const board = this.displayBoard();
    const hover = this.hover;
    const ghost =
      hover && !this.stroke && tool === 'stone' && board.get(hover.x, hover.y) === EMPTY
        ? { ...hover, color: this.placeColor() }
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
      labels: labelsAt(this.doc),
      ghost,
      selection: this.selection,
      scale: this.scale,
    });
  }

  /**
   * 表示する盤面。「△マーク」モードでは、経路上の手で取られた石（その後その点に石が置かれていないもの）も
   * 盤上に残して表示する（△を付ける）
   */
  private displayBoard(): Board {
    const { board, captured } = this.pos;
    if (this.state.captureMode !== 'mark' || captured.size === 0) return board;
    const out = board.clone();
    for (const [i, color] of captured) out.grid[i] = color;
    return out;
  }

  /** △を付ける石: 今のノードの△（石があるところだけ）と、「△マーク」モードの取られた石 */
  private marks(): Set<number> {
    const board = this.displayBoard();
    const out = this.state.captureMode === 'mark' ? new Set(this.pos.captured.keys()) : new Set<number>();
    for (const i of trianglesAt(this.doc)) if (board.grid[i] !== EMPTY) out.add(i);
    return out;
  }

  /** 石に書く着手番号（表示しないときは null） */
  private numbers(): Map<number, number> | null {
    const { numbering, numberStyle } = this.state;
    return numbering ? stoneNumbers(this.displayBoard(), this.pos.moves, this.pos.numberFrom, numberStyle) : null;
  }

  /** 次の手番（交互モードで置く色） */
  private nextColor(): StoneColor {
    return nextColorOf(this.doc, this.pos);
  }

  /** 今タップしたら置かれる石の色 */
  private placeColor(): StoneColor {
    return currentColor(this.state.colorMode, this.nextColor());
  }

  private get editOptions(): EditOptions {
    return { inheritMarks: this.state.inheritMarks };
  }

  private readonly positionOf = (nodes: Parameters<PositionCache['position']>[0]) => this.positions.position(nodes);

  /** 盤面の内容を doc にする（局面を求め直す） */
  private setDoc(doc: Doc): void {
    const prevSize = this.pos.size;
    this.doc = doc;
    this.pos = this.positions.position(docNodes(doc));
    if (this.pos.size !== prevSize) {
      this.view = fullView(this.pos.size);
      this.hover = null;
      this.relayout();
    } else {
      this.requestRender();
    }
  }

  /** 表示領域の大きさに合わせてキャンバスの大きさを決め直す */
  private relayout(): void {
    const cs = getComputedStyle(this.area);
    const w = this.area.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = this.area.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (!(w > 0 && h > 0)) return;
    const layout = computeLayout(this.view, w, h, this.state.coordStyle);
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

  /** 元に戻す／やり直すで doc にする。盤面の名前は履歴に含めず、今の名前を保つ */
  private restore(doc: Doc): void {
    const name = getProp(this.doc.root, 'GN');
    const restored = sameValues(getProp(doc.root, 'GN'), name)
      ? doc
      : { ...doc, root: setProp(doc.root, 'GN', name ?? null) };
    this.setDoc(restored);
    this.changed();
  }

  private undo(): void {
    if (this.stroke) return;
    const prev = this.history.undo(this.doc);
    if (prev) this.restore(prev);
  }

  private redo(): void {
    if (this.stroke) return;
    const next = this.history.redo(this.doc);
    if (next) this.restore(next);
  }

  /** 状態が変わったあとに保存とパネル表示の更新を行う */
  private changed(): void {
    saveSettings(this.storage, this.state);
    this.syncCurrentEntry();
    this.saveEntries();
    this.updateUI();
  }

  /** 今の盤面の履歴 */
  private get history(): UndoHistory<Doc> {
    let h = this.histories.get(this.currentId);
    if (!h) {
      h = new UndoHistory<Doc>(HISTORY_LIMIT);
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

  /** 保存した盤面の一覧を読み込み（以前の版の保存データは移し）、選んでいた盤面を開く */
  private loadEntries(): void {
    const library = loadLibrary(this.storage);
    if (library) {
      this.entries = [...library.entries];
      this.currentId = library.currentId;
    } else {
      // 盤面がまだない（初回）: 空の盤面を 1 つ目として登録する
      const entry = emptyEntry(defaultName([]), 19);
      this.entries = [entry];
      this.currentId = entry.id;
      this.saveEntries();
    }
    const entry = this.currentEntry ?? this.entries[0];
    this.currentId = entry.id;
    this.openEntry(entry);
  }

  /** entry の盤面を doc にする */
  private openEntry(entry: BoardEntry): void {
    this.doc = entry.doc;
    this.view = entry.view;
    this.pos = this.positions.position(docNodes(this.doc));
  }

  /** doc の内容を一覧の今の盤面に書き戻す */
  private syncCurrentEntry(): void {
    const i = this.entries.findIndex((e) => e.id === this.currentId);
    if (i >= 0) this.entries[i] = entryFromDoc(this.doc, this.view, this.pos, this.entries[i]);
  }

  private entryNames(): string[] {
    return this.entries.map(entryName);
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
    this.openEntry(entry);
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
    this.addBoard(emptyEntry(defaultName(this.entryNames()), this.pos.size));
  }

  private duplicateBoard(): void {
    if (this.stroke) return;
    this.syncCurrentEntry();
    const src = this.currentEntry;
    if (!src) return;
    const now = Date.now();
    const name = cleanName(`${entryName(src)} のコピー`, defaultName(this.entryNames()));
    const doc = renameDoc(src.doc, name);
    this.addBoard(entryFromDoc(doc, src.view, this.pos, { id: newId(), createdAt: now }, now));
  }

  private deleteBoard(): void {
    const entry = this.currentEntry;
    if (this.stroke || !entry) return;
    if (!window.confirm(`「${entryName(entry)}」を削除しますか？\n（削除すると元に戻せません）`)) return;
    this.entries = this.entries.filter((e) => e.id !== entry.id);
    this.histories.delete(entry.id);
    this.thumbnails.delete(entry.id);
    const next = sortedEntries(this.entries)[0] ?? emptyEntry(defaultName([]), entry.size);
    if (this.entries.length === 0) this.entries.push(next);
    this.currentId = ''; // 削除した盤面には書き戻さない
    this.switchBoard(next.id);
  }

  /** 盤面の名前（根の GN）を変える。名前は元に戻すの履歴に含めない */
  private renameBoard(name: string, final: boolean): void {
    const fallback = docName(this.doc);
    const cleaned = final ? cleanName(name, fallback) : Array.from(name).slice(0, 40).join('').trim() || fallback;
    if (cleaned === fallback) return;
    this.doc = renameDoc(this.doc, cleaned);
    this.pos = this.positions.position(docNodes(this.doc));
    this.syncCurrentEntry();
    this.saveEntries();
    this.updateBoardList();
    this.updateTitle();
  }

  private updateTitle(): void {
    const name = docName(this.doc);
    document.title = name ? `${name} - 碁盤` : '碁盤';
  }

  /** 盤面一覧を描き直す */
  private updateBoardList(): void {
    const { boardList: list, boardName } = this.ui;
    const current = this.currentEntry;
    if (current && document.activeElement !== boardName) boardName.value = docName(this.doc);
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
      name.textContent = entryName(e);
      const meta = document.createElement('span');
      meta.className = 'board-meta';
      const moves = e.moves;
      const stones = e.thumb.replace(/0/g, '').length;
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
    const key = `${this.state.theme}:${e.size}:${e.thumb}`;
    const cached = this.thumbnails.get(e.id);
    if (cached && cached.key === key) return cached.canvas;
    const canvas = cached?.canvas ?? document.createElement('canvas');
    canvas.className = 'board-thumb';
    const css = 48;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(css * scale);
    canvas.height = Math.round(css * scale);
    const ctx = canvas.getContext('2d');
    const board = Board.deserialize(e.size, e.thumb);
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
    const { state, view } = this;

    if (state.tool === 'zoom') {
      e.preventDefault();
      const p = hitTestClamped(L, view, pt.x, pt.y);
      this.selection = { pointerId: e.pointerId, a: p, b: p };
      this.capturePointer(e);
      this.requestRender();
      return;
    }

    const p = hitTest(L, view, pt.x, pt.y);
    if (!p) return;
    e.preventDefault();
    this.capturePointer(e);

    const board = this.pos.board;
    const i = board.index(p.x, p.y);
    const marking = state.tool === 'mark';
    const labeling = state.tool === 'label';
    if (marking && board.grid[i] === EMPTY) return; // △は石にだけ付ける
    const stroke: Stroke = {
      pointerId: e.pointerId,
      before: this.doc,
      action: labeling
        ? 'label'
        : marking
          ? trianglesAt(this.doc).has(i)
            ? 'unmark'
            : 'mark'
          : board.grid[i] === EMPTY // 「△マーク」の△（取られた石）の点は空点なので、そのまま打てる
            ? 'place'
            : 'erase',
      color: this.placeColor(),
      drag: marking || (!labeling && state.colorMode !== 'alternate'),
      last: pt,
      visited: new Set([i]),
    };
    this.stroke = stroke;

    if (stroke.action === 'label') {
      // 同じ文字があればタップで消し、違う文字（またはなし）なら書く。書く文字が空ならタップで消す
      const text = state.labelText === '' || labelsAt(this.doc).get(i) === state.labelText ? null : state.labelText;
      this.setDoc(setLabel(this.doc, i, text));
    } else if (stroke.action === 'mark' || stroke.action === 'unmark') {
      this.setDoc(setTriangle(this.doc, i, stroke.action === 'mark'));
    } else if (stroke.action === 'place') {
      if (this.placeAt(i, stroke.color) === 'suicide') this.toast('そこには置けません（呼吸点がありません）');
    } else {
      this.eraseAt(i);
    }
    this.hover = null;
    this.requestRender();
  }

  private onPointerMove(e: PointerEvent): void {
    const L = this.layout;
    if (!L) return;
    const { state, view } = this;

    const sel = this.selection;
    if (sel && e.pointerId === sel.pointerId) {
      const pt = this.canvasPoint(e, L);
      const p = hitTestClamped(L, view, pt.x, pt.y);
      if (!samePoint(p, sel.b)) {
        sel.b = p;
        this.requestRender();
      }
      return;
    }

    const stroke = this.stroke;
    if (stroke && e.pointerId === stroke.pointerId) {
      if (!stroke.drag) return;
      const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      for (const ev of coalesced.length ? coalesced : [e]) {
        const pt = this.canvasPoint(ev, L);
        for (const p of hitsAlongSegment(L, view, stroke.last.x, stroke.last.y, pt.x, pt.y, DRAG_RADIUS)) {
          const board = this.pos.board;
          const i = board.index(p.x, p.y);
          if (stroke.visited.has(i)) continue;
          stroke.visited.add(i);
          if (stroke.action === 'mark' || stroke.action === 'unmark') {
            if (board.grid[i] !== EMPTY) this.setDoc(setTriangle(this.doc, i, stroke.action === 'mark'));
          } else if (stroke.action === 'place') {
            if (board.grid[i] === EMPTY) this.placeAt(i, stroke.color);
          } else {
            this.eraseAt(i);
          }
        }
        stroke.last = pt;
      }
      return;
    }

    if (e.pointerType === 'mouse' && state.tool === 'stone') {
      const pt = this.canvasPoint(e, L);
      const p = hitTest(L, view, pt.x, pt.y);
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
      const size = this.pos.size;
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

  /** 交点 i に石を置く（囲まれた石の扱いに合わせる）。置けなければその理由 */
  private placeAt(i: number, color: StoneColor): 'ok' | 'occupied' | 'suicide' {
    const res = placeStone(this.doc, this.positionOf, i, color, this.state.captureMode, this.editOptions);
    if (!res.ok) return res.reason;
    this.setDoc(res.doc);
    return 'ok';
  }

  /**
   * 交点 i の石を取り除く。今のノードの手で置いた石なら置き間違いの修正とみなしてそのノードを消し、
   * それ以外の石は配置（AE）で消す。交互モードでは、取り除いた石の色をもう一度置ける手番にする
   */
  private eraseAt(i: number): boolean {
    const doc = eraseStone(this.doc, this.positionOf, i, this.state.colorMode === 'alternate', this.editOptions);
    if (!doc) return false;
    this.setDoc(doc);
    return true;
  }

  private finishStroke(): void {
    const stroke = this.stroke;
    if (!stroke) return;
    this.stroke = null;
    if (!sameDoc(stroke.before, this.doc)) this.history.record(stroke.before);
    this.changed();
    this.requestRender();
  }

  // ---------------------------------------------------------------------------
  // 操作
  // ---------------------------------------------------------------------------

  /** 記録を変える操作（元に戻せる）。doc が変わらなければ何もしない */
  private edit(doc: Doc): void {
    if (sameDoc(doc, this.doc)) return;
    this.history.record(this.doc);
    this.setDoc(doc);
    this.changed();
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
    this.view = normalizeView(view, this.pos.size);
    this.hover = null;
    this.relayout();
    this.changed();
  }

  private setBoardSize(size: number): void {
    if (this.stroke || size === this.pos.size) return;
    const message = `${size}路盤に変更すると今の盤面は消えます。よろしいですか？\n（「元に戻す」で復元できます）`;
    if (hasContent(this.doc, this.pos) && !window.confirm(message)) return;
    this.edit(resetDoc(this.doc, size));
  }

  private clearBoard(): void {
    const { board, moves } = this.pos;
    if (this.stroke || !hasContent(this.doc, this.pos)) return;
    const message = !board.isEmpty()
      ? '盤面の石と文字をすべて消しますか？\n（「元に戻す」で復元できます）'
      : moves.length === 0 && this.doc.root.children.length === 0
        ? '盤面の文字をすべて消しますか？\n（「元に戻す」で復元できます）'
        : '着手のログと盤面の文字を消しますか？\n（「元に戻す」で復元できます）';
    if (!window.confirm(message)) return;
    this.edit(resetDoc(this.doc, this.pos.size));
  }

  private async exportPng(): Promise<void> {
    const { theme, coordStyle } = this.state;
    const blob = await renderPng({
      board: this.displayBoard(),
      view: this.view,
      theme,
      coordStyle,
      marks: this.marks(),
      numbers: this.numbers(),
      labels: labelsAt(this.doc),
    });
    if (!blob) {
      this.toast('PNG の作成に失敗しました');
      return;
    }
    downloadBlob(blob, exportFileName(new Date(), docName(this.doc)));
    this.toast('PNG を保存しました');
  }

  private exportSgf(): void {
    const sgf = exportSgf(this.doc, this.view, this.pos.size);
    const name = docName(this.doc);
    downloadBlob(new Blob([sgf], { type: 'application/x-go-sgf' }), exportFileName(new Date(), name, 'sgf'));
    this.toast('SGF を保存しました');
  }

  /** SGF のファイルを読み込み、各ゲームツリーを新しい盤面として一覧に加える */
  private async importSgf(file: File): Promise<void> {
    if (this.stroke) return;
    const stem = file.name.replace(/\.sgf$/i, '').trim();
    let result;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const names = this.entryNames();
      result = importSgfBytes(bytes, (k) => {
        const base = stem || defaultName(names);
        return cleanName(k === 0 ? base : `${base} (${k + 1})`, defaultName(names));
      });
    } catch (e) {
      this.toast(e instanceof Error ? e.message : 'SGF を読めませんでした');
      return;
    }
    const { boards, skipped } = result;
    if (boards.length === 0) {
      this.toast(skipped[0] ?? '盤面がありませんでした');
      return;
    }
    this.syncCurrentEntry();
    const now = Date.now();
    const added = boards.map((b) =>
      entryFromDoc(b.doc, b.view, this.positions.position(docNodes(b.doc)), { id: newId(), createdAt: now }, now),
    );
    this.entries.push(...added);
    this.switchBoard(added[0].id);
    this.ui.boardList.scrollTop = 0;
    const note = skipped.length > 0 ? `（${skipped.length} 局は読み込めませんでした: ${skipped[0]}）` : '';
    this.toast(boards.length === 1 ? `「${docName(boards[0].doc)}」を開きました${note}` : `${boards.length} 個の盤面を開きました${note}`);
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

    // 「置くもの」は黒・白・交互に加えて△（石に△を付け外しする）と文字（交点に 1 文字を書く）を選べる
    this.bindSegment(
      'colorMode',
      [...COLOR_MODES, 'mark', 'label'] as const,
      () => (state.tool === 'mark' || state.tool === 'label' ? state.tool : state.colorMode),
      (v) => {
        if (v === 'mark' || v === 'label') {
          this.setTool(v);
        } else {
          state.colorMode = v;
          this.setTool('stone');
        }
        settingChanged();
      },
    );
    this.bindSegment('captureMode', CAPTURE_MODES, () => state.captureMode, (v) => {
      // 記録は変わらない。「△マーク」では、経路上の手で取られた石を△で表示する
      if (this.stroke || v === state.captureMode) return;
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
      if (this.stroke || !Number.isInteger(index) || index < 0) return;
      this.edit(setNumberStart(this.doc, this.pos, index));
    });
    this.bindSegment('inheritMarks', ['on', 'off'] as const, () => (state.inheritMarks ? 'on' : 'off'), (v) => {
      state.inheritMarks = v === 'on';
      settingChanged();
    });
    this.bindSegment('boardSize', BOARD_SIZES, () => this.pos.size, (v) => this.setBoardSize(v));
    this.bindSegment('coordStyle', COORD_STYLES, () => state.coordStyle, (v) => {
      state.coordStyle = v;
      this.changed();
      this.relayout(); // ラベル帯の幅が変わる
    });
    this.bindSegment('theme', THEME_NAMES, () => state.theme, (v) => {
      state.theme = v;
      settingChanged();
    });

    // 書く文字は 1 文字だけ。入力したら最後に入力した文字に置き換える（変換中は待つ）
    const applyLabelText = () => {
      state.labelText = pickLabelText(ui.labelText.value);
      ui.labelText.value = state.labelText;
      saveSettings(this.storage, state);
    };
    ui.labelText.addEventListener('input', (e) => {
      if (!(e instanceof InputEvent && e.isComposing)) applyLabelText();
    });
    ui.labelText.addEventListener('compositionend', applyLabelText);
    ui.labelText.addEventListener('focus', () => ui.labelText.select());
    ui.labelText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) ui.labelText.blur();
    });

    // 今のノードが配置ノードなら PL に書き（元に戻せる）、着手ノードなら一時的に入れ替える
    ui.nextColor.addEventListener('click', () => {
      if (this.stroke) return;
      const doc = toggleTurn(this.doc, this.pos);
      if (doc.root !== this.doc.root) {
        this.edit(doc);
      } else {
        this.setDoc(doc);
        this.changed();
      }
    });
    ui.undo.addEventListener('click', () => this.undo());
    ui.redo.addEventListener('click', () => this.redo());
    ui.zoom.addEventListener('click', () => this.setTool(state.tool === 'zoom' ? this.toolBeforeZoom : 'zoom'));
    ui.resetZoom.addEventListener('click', () => this.setView(fullView(this.pos.size)));
    ui.exportPng.addEventListener('click', () => void this.exportPng());
    ui.exportSgf.addEventListener('click', () => this.exportSgf());
    ui.openSgf.addEventListener('click', () => ui.sgfFile.click());
    ui.sgfFile.addEventListener('change', () => {
      const file = ui.sgfFile.files?.[0];
      ui.sgfFile.value = ''; // 同じファイルをもう一度選べるように
      if (file) void this.importSgf(file);
    });
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
      ui.boardName.value = docName(this.doc);
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
    const black = this.nextColor() === BLACK;
    ui.nextColor.hidden = state.colorMode !== 'alternate' || state.tool === 'mark' || state.tool === 'label';
    ui.labelText.hidden = state.tool !== 'label';
    if (document.activeElement !== ui.labelText) ui.labelText.value = state.labelText;
    ui.nextColorIcon.className = `stone-icon ${black ? 'black' : 'white'}`;
    ui.nextColorText.textContent = black ? '黒' : '白';
    ui.undo.disabled = !this.history.canUndo;
    ui.redo.disabled = !this.history.canRedo;
    ui.resetZoom.disabled = isFullView(this.view, this.pos.size);
    ui.zoom.setAttribute('aria-pressed', String(state.tool === 'zoom'));
    ui.zoomHint.hidden = state.tool !== 'zoom';
    ui.moveLog.hidden = !state.numbering;
    if (state.numbering) this.updateMoveLog();
    this.updateBoardList();
    this.updateTitle();
  }

  /** 着手のログ（根から今のノードまでの手）を描き直す */
  private updateMoveLog(): void {
    const { coordStyle, numberStyle } = this.state;
    const { moves, numberFrom, size } = this.pos;
    const { moveLogStatus: status, moveLogList: list } = this.ui;
    const onBoard = movesOnBoard(this.displayBoard(), moves);
    const from = Math.min(numberFrom, moves.length);

    const items = moves.map((m, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.index = String(i);
      btn.setAttribute('aria-pressed', String(i === from));
      if (i < from) btn.classList.add('before');
      if (m.point !== null && !onBoard.has(i)) {
        btn.classList.add('gone');
        btn.title = '盤上にありません';
      }
      const num = document.createElement('span');
      num.className = 'mv-n';
      num.textContent = String(m.number);
      const icon = document.createElement('span');
      icon.className = `stone-icon ${m.color === BLACK ? 'black' : 'white'}`;
      const pt = document.createElement('span');
      pt.className = 'mv-pt';
      pt.textContent = m.point === null ? 'パス' : pointName(m.point % size, Math.floor(m.point / size), size, coordStyle);
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

    const first = numberStyle === 'absolute' ? moves[from]?.number : 1;
    const last = numberStyle === 'absolute' ? moves.at(-1)?.number : moves.length - from;
    status.textContent =
      moves.length === 0
        ? 'まだ石が置かれていません'
        : from >= moves.length
          ? `${moves.length}手 ・ 次の手から番号`
          : `${moves.length}手 ・ ${moves[from].number}手目から番号（${first}〜${last}）`;

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
