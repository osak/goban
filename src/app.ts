/**
 * 碁盤アプリの UI。ポインタ操作・元に戻す・拡大・PNG / SGF の保存と読み込み・盤面の一覧をつなぐ。
 *
 * 盤面の内容はゲームツリー（edit.ts の Doc）だけに持ち、表示する局面はそこから導出する（game.ts）。
 * 手順の移動（nav.ts）はツリーを変えないので、元に戻すの履歴に積まない。
 * コメントの入力は、打ち始めてから欄を離れる（ほかの操作をする）までを 1 回の編集として積む。
 */

import { BLACK, Board, CAPTURE_MODES, EMPTY, type StoneColor } from './board';
import { COORD_STYLES, pointName } from './coords';
import {
  commentAt,
  docName,
  docNodes,
  eraseStone,
  cursorNode,
  hasContent,
  isNumberStartHere,
  labelsAt,
  newDoc,
  nextColorOf,
  placeStone,
  renameDoc,
  resetDoc,
  setLabel,
  setComment,
  setNumberStartHere,
  setSetupPoint,
  setTriangle,
  toggleTurn,
  trianglesAt,
  type Doc,
  type EditOptions,
} from './edit';
import { downloadBlob, exportFileName, renderPng } from './export';
import { PositionCache, lineMoves, type GameMove, type GamePosition } from './game';
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
import {
  activeFork,
  childAt,
  forksOnLine,
  goToDepth,
  isMainLine,
  lineAfterEdit,
  lineEndId,
  movesInBranch,
  next as nextNode,
  prev as prevNode,
  promote,
  removeBranch,
  selectVariation,
  switchVariation,
  variationLetter,
  variationsAt,
  type Fork,
  type Nav,
} from './nav';
import { getStorage, loadSettings, saveSettings } from './persistence';
import { THEME_NAMES, draw, drawThumbnail, type Candidate } from './renderer';
import { exportSgf, importSgfBytes } from './sgf-file';
import { BOARD_SIZES, CANDIDATE_MODES, COLOR_MODES, currentColor, initialState, type AppState, type Tool } from './state';
import { extendPath, getProp, nodesOnPath, setProp, type NodePath, type SgfNode } from './tree';
import { indicesOnPath, layoutTree, pathOfIndex, type TreeLayout } from './tree-layout';
import { TreeView } from './tree-view';
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
  /** 石を置く / 石を消す / △を付ける / △を外す / 文字を書く・消す / 配置で石を置く / 配置で石を消す */
  readonly action: 'place' | 'erase' | 'mark' | 'unmark' | 'label' | 'setup' | 'unsetup';
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

function samePath(a: NodePath, b: NodePath): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

function sameDoc(a: Doc, b: Doc): boolean {
  return a.root === b.root && a.turn === b.turn && samePath(a.cursor, b.cursor);
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
  /** 今の手順（根から今のノードを通ってその先まで。nav.ts）。保存しない */
  private line: NodePath = [];
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
    setupMode: byId('setupMode', HTMLButtonElement),
    zoomHint: byId('zoomHint', HTMLElement),
    moveLog: byId('moveLog', HTMLElement),
    moveLogStatus: byId('moveLogStatus', HTMLElement),
    moveLogList: byId('moveLogList', HTMLOListElement),
    numberHere: byId('numberHere', HTMLButtonElement),
    navFirst: byId('navFirst', HTMLButtonElement),
    navPrev: byId('navPrev', HTMLButtonElement),
    navNext: byId('navNext', HTMLButtonElement),
    navLast: byId('navLast', HTMLButtonElement),
    navPos: byId('navPos', HTMLElement),
    variationsBtn: byId('variationsBtn', HTMLButtonElement),
    deleteFrom: byId('deleteFrom', HTMLButtonElement),
    treeBtn: byId('treeBtn', HTMLButtonElement),
    commentBtn: byId('commentBtn', HTMLButtonElement),
    tree: byId('tree', HTMLElement),
    treeBox: byId('treeBox', HTMLElement),
    comment: byId('comment', HTMLElement),
    commentText: byId('commentText', HTMLTextAreaElement),
    variations: byId('variations', HTMLElement),
    variationsTitle: byId('variationsTitle', HTMLElement),
    variationList: byId('variationList', HTMLOListElement),
    promoteVariation: byId('promoteVariation', HTMLButtonElement),
    deleteVariation: byId('deleteVariation', HTMLButtonElement),
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
  /** 着手のログを最後に描き直したときの今のノード（変わったら今の手が見えるようにスクロールする） */
  private loggedCursor = '';
  /** 変化の一覧を開いているか */
  private variationsOpen = false;
  /** ツリー全体の表示 */
  private readonly treeView: TreeView;
  /** ツリーの配置（根が変わったら求め直す） */
  private treeLayout: { root: SgfNode; layout: TreeLayout } | null = null;
  /** コメントを打ち始めたときの doc（まだ履歴に積んでいない入力があるとき） */
  private commentBefore: Doc | null = null;
  /** コメントの欄に出しているノードの id */
  private commentNodeId = -1;

  constructor() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D が使えません');
    this.ctx = ctx;
    this.treeView = new TreeView(this.ui.treeBox, (index) => this.goToTreeNode(index));
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
      candidates: this.candidates(),
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

  /** 盤に出す次の手の候補（今のノードの子の手）。設定で出さないときや、候補がないときは空 */
  private candidates(): Candidate[] {
    const mode = this.state.candidates;
    const children = cursorNode(this.doc).children;
    if (mode === 'off' || children.length === 0 || (mode === 'branch' && children.length < 2)) return [];
    const selected = this.line[this.doc.cursor.length];
    const out: Candidate[] = [];
    for (const v of variationsAt(this.doc.root, this.doc.cursor, this.pos.size)) {
      // 子の最初のノードが手のときだけ（配置ノードやパスは盤に出せない）
      const first = v.first;
      if (!v.startsWithMove || !first || first.point === null) continue;
      out.push({
        point: first.point,
        color: first.color,
        text: children.length > 1 ? variationLetter(v.index) : '',
        selected: children.length > 1 && v.index === selected,
      });
    }
    return out;
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

  /**
   * 盤面の内容を doc にする（局面を求め直す）。line は今の手順。省くと、前の手順が今のノードを通るなら保ち、
   * 通らなければ今のノードから最初の子をたどる
   */
  private setDoc(doc: Doc, line?: NodePath): void {
    const prevSize = this.pos.size;
    const prevLine = { line: this.line, endId: lineEndId(this.doc.root, this.line) };
    this.doc = doc;
    this.line = line ?? lineAfterEdit(doc.root, doc.cursor, prevLine);
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

  /** まだ履歴に積んでいないコメントの入力を、1 回の編集として積む */
  private flushComment(): void {
    const before = this.commentBefore;
    this.commentBefore = null;
    if (before && before.root !== this.doc.root) this.history.record(before);
  }

  private undo(): void {
    if (this.stroke) return;
    this.flushComment();
    const prev = this.history.undo(this.doc);
    if (prev) this.restore(prev);
  }

  private redo(): void {
    if (this.stroke) return;
    this.flushComment();
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
    this.line = extendPath(entry.doc.root, entry.doc.cursor);
    this.view = entry.view;
    this.variationsOpen = false;
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
    this.flushComment();
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
    this.flushComment();

    const board = this.pos.board;
    const i = board.index(p.x, p.y);
    const marking = state.tool === 'mark';
    const labeling = state.tool === 'label';
    const setup = state.tool === 'stone' && state.setupMode;
    if (marking && board.grid[i] === EMPTY) return; // △は石にだけ付ける
    const empty = board.grid[i] === EMPTY; // 「△マーク」の△（取られた石）の点は空点なので、そのまま打てる
    const stroke: Stroke = {
      pointerId: e.pointerId,
      before: this.doc,
      action: labeling
        ? 'label'
        : marking
          ? trianglesAt(this.doc).has(i)
            ? 'unmark'
            : 'mark'
          : setup
            ? empty
              ? 'setup'
              : 'unsetup'
            : empty
              ? 'place'
              : 'erase',
      color: this.placeColor(),
      // 配置は手番を変えないので、交互でもドラッグで続けて置ける
      drag: marking || setup || (!labeling && state.colorMode !== 'alternate'),
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
    } else if (stroke.action === 'setup' || stroke.action === 'unsetup') {
      this.setupAt(i, stroke.action === 'setup' ? stroke.color : EMPTY);
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
          } else if (stroke.action === 'setup') {
            if (board.grid[i] === EMPTY) this.setupAt(i, stroke.color);
          } else if (stroke.action === 'unsetup') {
            if (board.grid[i] !== EMPTY) this.setupAt(i, EMPTY);
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

  /**
   * 交点 i に石を置く（囲まれた石の扱いに合わせる）。置けなければその理由。
   * 同じ手の子があればその子へ進む。盤に候補を出している点なら、色が違ってもその子へ進む
   */
  private placeAt(i: number, color: StoneColor): 'ok' | 'occupied' | 'suicide' {
    const k = childAt(cursorNode(this.doc), this.pos.size, i, color);
    if (k >= 0 && this.candidates().some((c) => c.point === i)) {
      this.setDoc({ root: this.doc.root, cursor: [...this.doc.cursor, k], turn: null });
      return 'ok';
    }
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

  /** 「配置」モードで交点 i を value（EMPTY なら空点）にする */
  private setupAt(i: number, value: StoneColor | typeof EMPTY): void {
    const doc = setSetupPoint(this.doc, this.positionOf, i, value, this.editOptions);
    if (doc) this.setDoc(doc);
  }

  private finishStroke(): void {
    const stroke = this.stroke;
    if (!stroke) return;
    this.stroke = null;
    // ツリーが変わったときだけ編集として積む（子の手へ進む・親へ戻るだけなら手順の移動）
    if (stroke.before.root !== this.doc.root) this.history.record(stroke.before);
    this.changed();
    this.requestRender();
  }

  // ---------------------------------------------------------------------------
  // 操作
  // ---------------------------------------------------------------------------

  /** 記録を変える操作（ツリーが変わったら元に戻せる）。doc が変わらなければ何もしない */
  private edit(doc: Doc, line?: NodePath): void {
    this.flushComment();
    if (sameDoc(doc, this.doc) && (line === undefined || samePath(line, this.line))) return;
    if (doc.root !== this.doc.root) this.history.record(this.doc);
    this.setDoc(doc, line);
    this.changed();
  }

  /** 手順を移動する（ツリーは変えない。履歴にも積まない）。nav が null なら何もしない */
  private navigate(nav: Nav | null): void {
    if (this.stroke || !nav) return;
    this.flushComment();
    const moved = !samePath(nav.cursor, this.doc.cursor);
    if (!moved && samePath(nav.line, this.line)) return;
    // 手番の一時的な入れ替えは、ノードを移ったら消す
    this.setDoc({ root: this.doc.root, cursor: nav.cursor, turn: moved ? null : this.doc.turn }, nav.line);
    this.hover = null;
    this.changed();
  }

  private get nav(): Nav {
    return { cursor: this.doc.cursor, line: this.line };
  }

  /** ツリーの表示でタップしたノードへ移る。今の手順がそのノードを通るなら手順は保つ */
  private goToTreeNode(index: number): void {
    const layout = this.treeLayout?.layout;
    if (!layout || this.stroke) return;
    const cursor = pathOfIndex(layout, index);
    const line = lineAfterEdit(this.doc.root, cursor, { line: this.line, endId: lineEndId(this.doc.root, this.line) });
    this.navigate({ cursor, line });
  }

  /** ツリーの配置（根が変わったときだけ求め直す） */
  private currentTreeLayout(): TreeLayout {
    const cached = this.treeLayout;
    if (cached && cached.root === this.doc.root) return cached.layout;
    const layout = layoutTree(this.doc.root, this.pos.size);
    this.treeLayout = { root: this.doc.root, layout };
    return layout;
  }

  /** コメントの入力を今のノードに反映する（履歴には、欄を離れるかほかの操作をしたときに積む） */
  private inputComment(text: string): void {
    if (this.stroke) return;
    const doc = setComment(this.doc, text);
    if (doc === this.doc) return;
    this.commentBefore ??= this.doc;
    this.setDoc(doc);
    this.changed();
  }

  /** 今の分かれ目で、変化を index 番目にする */
  private chooseVariation(fork: Fork, index: number): void {
    this.navigate(selectVariation(this.doc.root, this.nav, fork, index));
  }

  /** 選んでいる変化（今の分かれ目）までの手順を本線にする */
  private promoteVariation(): void {
    const fork = activeFork(this.doc.root, this.nav);
    if (this.stroke || !fork) return;
    const res = promote(this.doc.root, this.nav, this.line.slice(0, fork.depth));
    this.edit({ root: res.root, cursor: res.nav.cursor, turn: this.doc.turn }, res.nav.line);
  }

  /** path のノードから先を削除する（確認する。元に戻せる） */
  private deleteBranch(path: NodePath, what: string): void {
    if (this.stroke || path.length === 0) return;
    const n = movesInBranch(this.doc.root, path, this.pos.size);
    const count = n > 0 ? `（${n} 手）` : '';
    if (!window.confirm(`${what}${count}を削除しますか？\n（「取り消し」で元に戻せます）`)) return;
    const res = removeBranch(this.doc.root, this.nav, path);
    this.edit({ root: res.root, cursor: res.nav.cursor, turn: null }, res.nav.line);
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
    const message = `${size}路盤に変更すると今の盤面は消えます。よろしいですか？\n（「取り消し」で元に戻せます）`;
    if (hasContent(this.doc, this.pos) && !window.confirm(message)) return;
    this.edit(resetDoc(this.doc, size));
  }

  private clearBoard(): void {
    const { board, moves } = this.pos;
    if (this.stroke || !hasContent(this.doc, this.pos)) return;
    const message = !board.isEmpty()
      ? '盤面の石と文字をすべて消しますか？\n（「取り消し」で元に戻せます）'
      : moves.length === 0 && this.doc.root.children.length === 0
        ? '盤面の文字をすべて消しますか？\n（「取り消し」で元に戻せます）'
        : '着手のログと盤面の文字を消しますか？\n（「取り消し」で元に戻せます）';
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
    // ログの手をタップするとその手へ移る。分かれ目の印をタップすると、分かれ目の手前へ移って変化の一覧を開く
    ui.moveLogList.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest<HTMLButtonElement>('button') : null;
      if (!btn || this.stroke) return;
      const fork = Number(btn.dataset.fork);
      const depth = Number(btn.dataset.depth);
      if (Number.isInteger(fork) && fork > 0) {
        this.variationsOpen = true;
        this.navigate(goToDepth(this.nav, fork - 1));
        this.updateUI();
      } else if (Number.isInteger(depth) && depth >= 0) {
        this.navigate(goToDepth(this.nav, depth));
      }
    });
    ui.numberHere.addEventListener('click', () => {
      if (this.stroke) return;
      this.edit(setNumberStartHere(this.doc, this.line, !isNumberStartHere(this.doc)));
    });
    ui.navFirst.addEventListener('click', () => this.navigate(goToDepth(this.nav, 0)));
    ui.navPrev.addEventListener('click', () => this.navigate(prevNode(this.nav)));
    ui.navNext.addEventListener('click', () => this.navigate(nextNode(this.nav)));
    ui.navLast.addEventListener('click', () => this.navigate(goToDepth(this.nav, this.line.length)));
    ui.variationsBtn.addEventListener('click', () => {
      this.variationsOpen = !this.variationsOpen;
      this.updateUI();
    });
    ui.variationList.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest<HTMLButtonElement>('button[data-index]') : null;
      const index = Number(btn?.dataset.index);
      const fork = activeFork(this.doc.root, this.nav);
      if (fork && Number.isInteger(index)) this.chooseVariation(fork, index);
    });
    ui.promoteVariation.addEventListener('click', () => this.promoteVariation());
    ui.deleteVariation.addEventListener('click', () => {
      const fork = activeFork(this.doc.root, this.nav);
      if (fork) this.deleteBranch(this.line.slice(0, fork.depth), 'この変化');
    });
    ui.deleteFrom.addEventListener('click', () => this.deleteBranch(this.doc.cursor, '今の手から先'));
    this.bindSegment('candidates', CANDIDATE_MODES, () => state.candidates, (v) => {
      state.candidates = v;
      settingChanged();
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

    // 「配置」: 石を今のノードの配置として置く・消す
    ui.setupMode.addEventListener('click', () => {
      state.setupMode = !state.setupMode;
      if (state.tool !== 'stone') this.setTool('stone');
      settingChanged();
    });
    ui.treeBtn.addEventListener('click', () => {
      state.showTree = !state.showTree;
      this.changed();
      if (state.showTree) this.treeView.reveal();
    });
    ui.commentBtn.addEventListener('click', () => {
      state.showComment = !state.showComment;
      this.changed();
      if (state.showComment) ui.commentText.focus();
    });
    ui.commentText.addEventListener('input', () => this.inputComment(ui.commentText.value));
    ui.commentText.addEventListener('blur', () => {
      this.flushComment();
      this.updateUI();
    });

    // 今のノードが配置ノードなら PL に書き（元に戻せる）、着手ノードなら一時的に入れ替える
    ui.nextColor.addEventListener('click', () => {
      if (!this.stroke) this.edit(toggleTurn(this.doc, this.pos));
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
      // 名前・コメントの入力中は、文字の取り消しやカーソルの移動に使う
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
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
      } else if (!mod && !e.altKey && !e.shiftKey) {
        // 手順の移動: ← → で前後、↑ ↓ で変化の切り替え、Home / End で最初と最後
        const moves: Record<string, () => Nav | null> = {
          ArrowLeft: () => prevNode(this.nav),
          ArrowRight: () => nextNode(this.nav),
          ArrowUp: () => switchVariation(this.doc.root, this.nav, -1),
          ArrowDown: () => switchVariation(this.doc.root, this.nav, 1),
          Home: () => goToDepth(this.nav, 0),
          End: () => goToDepth(this.nav, this.line.length),
        };
        const move = moves[e.key];
        if (!move) return;
        e.preventDefault();
        this.navigate(move());
      }
    });
  }

  private updateUI(): void {
    const { state, ui } = this;
    for (const update of this.segmentUpdaters) update();
    const black = this.nextColor() === BLACK;
    ui.nextColor.hidden = state.colorMode !== 'alternate' || state.tool === 'mark' || state.tool === 'label';
    ui.labelText.hidden = state.tool !== 'label';
    ui.setupMode.hidden = state.tool !== 'stone';
    ui.setupMode.setAttribute('aria-pressed', String(state.setupMode));
    if (document.activeElement !== ui.labelText) ui.labelText.value = state.labelText;
    ui.nextColorIcon.className = `stone-icon ${black ? 'black' : 'white'}`;
    ui.nextColorText.textContent = black ? '黒' : '白';
    ui.undo.disabled = !this.history.canUndo;
    ui.redo.disabled = !this.history.canRedo;
    ui.resetZoom.disabled = isFullView(this.view, this.pos.size);
    ui.zoom.setAttribute('aria-pressed', String(state.tool === 'zoom'));
    ui.zoomHint.hidden = state.tool !== 'zoom';
    const lineMoveList = lineMoves(nodesOnPath(this.doc.root, this.line) ?? [], this.pos.size);
    this.updateNav(lineMoveList);
    this.updateTree();
    this.updateComment();
    ui.moveLog.hidden = !state.numbering;
    if (state.numbering) this.updateMoveLog(lineMoveList);
    this.updateBoardList();
    this.updateTitle();
  }

  /** ツリー全体の表示を今の状態に合わせる */
  private updateTree(): void {
    const { ui, state } = this;
    ui.treeBtn.setAttribute('aria-expanded', String(state.showTree));
    ui.tree.hidden = !state.showTree;
    if (!state.showTree) return;
    const layout = this.currentTreeLayout();
    const line = indicesOnPath(layout, this.doc.root, this.line);
    this.treeView.update({ layout, current: line[this.doc.cursor.length] ?? 0, line: new Set(line) });
  }

  /** コメントの欄を今のノードに合わせる（入力中は、今のノードが変わったときだけ書き換える） */
  private updateComment(): void {
    const { ui, state } = this;
    const node = cursorNode(this.doc);
    const has = node.props.has('C');
    ui.commentBtn.setAttribute('aria-expanded', String(state.showComment));
    ui.commentBtn.classList.toggle('has-comment', has);
    ui.commentBtn.title = has ? 'この局面のコメント（あり）' : 'この局面のコメント';
    ui.comment.hidden = !state.showComment;
    if (node.id !== this.commentNodeId || document.activeElement !== ui.commentText) {
      this.commentNodeId = node.id;
      const text = commentAt(this.doc);
      if (ui.commentText.value !== text) ui.commentText.value = text;
    }
    ui.commentText.placeholder = this.doc.cursor.length === 0 ? '最初の局面のコメント（問題の説明など）' : 'この局面のコメント';
  }

  /** 手順の移動のボタンと、変化の一覧を今の状態に合わせる。lineMoveList は今の手順の着手 */
  private updateNav(lineMoveList: readonly GameMove[]): void {
    const { ui } = this;
    const { cursor } = this.doc;
    const atRoot = cursor.length === 0;
    const atEnd = cursor.length >= this.line.length;
    ui.navFirst.disabled = atRoot;
    ui.navPrev.disabled = atRoot;
    ui.navNext.disabled = atEnd;
    ui.navLast.disabled = atEnd;
    ui.deleteFrom.disabled = atRoot;
    ui.navPos.textContent = `${this.pos.moves.length} / ${lineMoveList.length}`;

    const fork = activeFork(this.doc.root, this.nav);
    ui.variationsBtn.disabled = !fork;
    ui.variationsBtn.textContent = fork ? `変化 ${fork.index + 1}/${fork.count}` : '変化';
    if (!fork) this.variationsOpen = false;
    ui.variationsBtn.setAttribute('aria-expanded', String(this.variationsOpen));
    ui.variations.hidden = !this.variationsOpen;
    if (!fork || !this.variationsOpen) return;

    // 分かれ目の手の手数（分かれ目より前の手の次）
    const before = lineMoveList.filter((m) => m.depth < fork.depth).at(-1);
    ui.variationsTitle.textContent = `${(before?.number ?? 0) + 1}手目の変化（${fork.count} 通り）`;
    const parent = this.line.slice(0, fork.depth - 1);
    const { size } = this.pos;
    const { coordStyle } = this.state;
    const items = variationsAt(this.doc.root, parent, size).map((v) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.index = String(v.index);
      if (v.index === fork.index) btn.setAttribute('aria-current', 'true');
      const letter = document.createElement('span');
      letter.className = 'var-letter';
      letter.textContent = variationLetter(v.index);
      btn.append(letter);
      if (v.first) {
        const icon = document.createElement('span');
        icon.className = `stone-icon ${v.first.color === BLACK ? 'black' : 'white'}`;
        const pt = document.createElement('span');
        pt.textContent =
          v.first.point === null ? 'パス' : pointName(v.first.point % size, Math.floor(v.first.point / size), size, coordStyle);
        btn.append(icon, pt);
        if (!v.startsWithMove) pt.textContent += '（配置の後）';
      } else {
        const pt = document.createElement('span');
        pt.textContent = '配置だけ';
        btn.append(pt);
      }
      const len = document.createElement('span');
      len.className = 'var-len';
      len.textContent = `${v.moves}手`;
      btn.append(len);
      const li = document.createElement('li');
      li.append(btn);
      return li;
    });
    ui.variationList.replaceChildren(...items);
    ui.promoteVariation.disabled = isMainLine(this.line.slice(0, fork.depth));
  }

  /** 着手のログ（今の手順の手。今の手より先は薄く出す）を描き直す */
  private updateMoveLog(lineMoveList: readonly GameMove[]): void {
    const { coordStyle, numberStyle } = this.state;
    const { moves, numberFrom, size } = this.pos;
    const { moveLogStatus: status, moveLogList: list, numberHere } = this.ui;
    const onBoard = movesOnBoard(this.displayBoard(), moves);
    const commented = new Set(
      (nodesOnPath(this.doc.root, this.line) ?? []).filter((n) => n.props.has('C')).map((n) => n.id),
    );
    const here = moves.length; // 今の局面までの手の数（今の手順の先頭からこの数だけ）
    const from = Math.min(numberFrom, here);

    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'start';
    start.dataset.depth = '0';
    start.textContent = '開始';
    start.title = '最初の局面へ';
    if (here === 0) start.setAttribute('aria-current', 'step');
    const items: HTMLElement[][] = [[start]];

    lineMoveList.forEach((m, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.depth = String(m.depth);
      if (i === here - 1) btn.setAttribute('aria-current', 'step');
      if (i >= here) btn.classList.add('after');
      else if (i < from) btn.classList.add('before');
      if (i === from && from < here) btn.classList.add('from');
      if (commented.has(m.nodeId)) btn.classList.add('has-comment');
      if (i < here && m.point !== null && !onBoard.has(i)) {
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
      items.push([btn]);
    });

    // 分かれ目の印は、変化の最初の手（なければ末尾）に付ける
    for (const fork of forksOnLine(this.doc.root, this.line)) {
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'mv-fork';
      badge.dataset.fork = String(fork.depth);
      badge.textContent = `${fork.index + 1}/${fork.count}`;
      badge.title = `変化 ${fork.index + 1}/${fork.count}（タップで一覧）`;
      const i = lineMoveList.findIndex((m) => m.depth >= fork.depth);
      if (i >= 0) items[i + 1].unshift(badge);
      else items.push([badge]);
    }
    list.replaceChildren(
      ...items.map((els) => {
        const li = document.createElement('li');
        li.append(...els);
        return li;
      }),
    );

    numberHere.disabled = this.doc.cursor.length === 0;
    numberHere.setAttribute('aria-pressed', String(isNumberStartHere(this.doc)));
    const first = numberStyle === 'absolute' ? moves[from]?.number : 1;
    const last = numberStyle === 'absolute' ? moves.at(-1)?.number : here - from;
    status.textContent =
      lineMoveList.length === 0
        ? 'まだ石が置かれていません'
        : from >= here
          ? `次の手から番号`
          : `${moves[from].number}手目から番号（${first}〜${last}）`;

    // 今のノードが変わったら、今の手が見えるようにスクロールする
    const key = this.doc.cursor.join(',');
    if (key !== this.loggedCursor) {
      this.loggedCursor = key;
      const cur = list.querySelector<HTMLElement>('[aria-current="step"]');
      if (cur) {
        const top = cur.offsetTop - 6;
        const bottom = cur.offsetTop + cur.offsetHeight + 6;
        if (top < list.scrollTop) list.scrollTop = top;
        else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
      }
    }
  }

  private toast(message: string): void {
    const el = this.ui.toast;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }
}
