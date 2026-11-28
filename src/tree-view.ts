/**
 * ツリー全体の表示（canvas）。配置は tree-layout.ts で求め、ここでは見えている範囲だけを描く。
 *
 * スクロールする入れ物の中に、ツリー全体の大きさの空の要素（スクロールの範囲）と、入れ物と同じ大きさの canvas を置く。
 * canvas はスクロールに合わせて動かし、見えている部分を描き直す（大きな棋譜でも canvas の大きさの上限に掛からない）。
 */

import { KIND_BLACK, KIND_SETUP, indexAt, type TreeLayout } from './tree-layout';

/** 升目の間隔・ノードの半径・余白（CSS px） */
const STEP = 24;
const RADIUS = 8;
const PAD = 14;

export interface TreeViewState {
  readonly layout: TreeLayout;
  /** 今のノードの番号 */
  readonly current: number;
  /** 今の手順のノードの番号 */
  readonly line: ReadonlySet<number>;
}

export class TreeView {
  private readonly canvas = document.createElement('canvas');
  private readonly spacer = document.createElement('div');
  private readonly ctx: CanvasRenderingContext2D;
  private state: TreeViewState | null = null;
  private queued = false;
  private shownCurrent = -1;

  /** onSelect はノードをタップしたときに、そのノードの番号で呼ぶ */
  constructor(
    private readonly box: HTMLElement,
    private readonly onSelect: (index: number) => void,
  ) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D が使えません');
    this.ctx = ctx;
    this.canvas.className = 'tree-canvas';
    this.spacer.className = 'tree-spacer';
    box.replaceChildren(this.spacer, this.canvas);
    box.addEventListener('scroll', () => this.request());
    new ResizeObserver(() => this.request()).observe(box);
    box.addEventListener('click', (e) => this.onClick(e));
  }

  /** 表示する内容を変える。今のノードが変わったら見える位置までスクロールする */
  update(state: TreeViewState): void {
    this.state = state;
    const { cols, rows } = state.layout;
    this.spacer.style.width = `${PAD * 2 + Math.max(0, cols - 1) * STEP}px`;
    this.spacer.style.height = `${PAD * 2 + Math.max(0, rows - 1) * STEP}px`;
    if (state.current !== this.shownCurrent && this.box.clientWidth > 0) {
      this.shownCurrent = state.current;
      this.scrollTo(state.current);
    }
    this.request();
  }

  /** 表示し直したとき（隠していた入れ物を出したとき）に、今のノードが見えるようにする */
  reveal(): void {
    this.shownCurrent = -1;
    if (this.state) this.update(this.state);
  }

  private scrollTo(index: number): void {
    const L = this.state?.layout;
    if (!L) return;
    const x = PAD + L.col[index] * STEP;
    const y = PAD + L.row[index] * STEP;
    const { box } = this;
    const margin = STEP * 1.5;
    if (x - margin < box.scrollLeft || x + margin > box.scrollLeft + box.clientWidth) {
      box.scrollLeft = Math.max(0, x - box.clientWidth / 2);
    }
    if (y - margin < box.scrollTop || y + margin > box.scrollTop + box.clientHeight) {
      box.scrollTop = Math.max(0, y - box.clientHeight / 2);
    }
  }

  private request(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.draw();
    });
  }

  private onClick(e: MouseEvent): void {
    const L = this.state?.layout;
    if (!L) return;
    const rect = this.box.getBoundingClientRect();
    const x = e.clientX - rect.left - this.box.clientLeft + this.box.scrollLeft;
    const y = e.clientY - rect.top - this.box.clientTop + this.box.scrollTop;
    const col = Math.round((x - PAD) / STEP);
    const row = Math.round((y - PAD) / STEP);
    const i = indexAt(L, col, row);
    if (i < 0) return;
    const dx = x - (PAD + col * STEP);
    const dy = y - (PAD + row * STEP);
    // タップしやすいように、升目の半分より内側なら当たりにする
    if (dx * dx + dy * dy <= (STEP / 2) ** 2) this.onSelect(i);
  }

  private draw(): void {
    const { box, canvas, ctx, state } = this;
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (!state || w === 0 || h === 0) return;
    const scale = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * scale) || canvas.height !== Math.round(h * scale)) {
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const sx = box.scrollLeft;
    const sy = box.scrollTop;
    canvas.style.transform = `translate(${sx}px, ${sy}px)`;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(-sx, -sy);

    const css = getComputedStyle(box);
    const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const text = color('--text', '#24211c');
    const muted = color('--muted', '#6f675a');
    const border = color('--border', '#d9d1c2');
    const accent = color('--accent', '#2f5fd0');
    const panel = color('--panel', '#fbfaf7');

    const L = state.layout;
    const px = (col: number) => PAD + col * STEP;
    const py = (row: number) => PAD + row * STEP;
    const c0 = Math.max(0, Math.floor((sx - PAD) / STEP) - 1);
    const c1 = Math.min(L.cols - 1, Math.ceil((sx + w - PAD) / STEP) + 1);
    const r0 = Math.floor((sy - PAD) / STEP) - 1;
    const r1 = Math.ceil((sy + h - PAD) / STEP) + 1;

    // 線: 親の列を下り、子へ斜めに入る。今の手順の線は濃く、ほかは薄く
    const visible: number[] = [];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let c = c0; c <= c1; c++) {
      for (const i of L.byColumn[c]) {
        const row = L.row[i];
        if (row >= r0 && row <= r1) visible.push(i);
        const p = L.parent[i];
        if (p < 0) continue;
        const pr = L.row[p];
        if (row < r0 || pr > r1) continue;
        const onLine = state.line.has(i);
        ctx.strokeStyle = onLine ? text : border;
        ctx.lineWidth = onLine ? 2 : 1.5;
        ctx.beginPath();
        ctx.moveTo(px(c - 1), py(pr));
        if (row > pr) ctx.lineTo(px(c - 1), py(row - 1));
        ctx.lineTo(px(c), py(row));
        ctx.stroke();
      }
    }

    // ノード
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const i of visible) {
      const x = px(L.col[i]);
      const y = py(L.row[i]);
      const kind = L.kind[i];
      ctx.globalAlpha = state.line.has(i) ? 1 : 0.5;
      ctx.beginPath();
      if (kind === KIND_SETUP) {
        const s = RADIUS * 0.8;
        ctx.rect(x - s, y - s, s * 2, s * 2);
        ctx.fillStyle = panel;
        ctx.strokeStyle = muted;
      } else {
        ctx.arc(x, y, RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = kind === KIND_BLACK ? '#151515' : '#fafafa';
        ctx.strokeStyle = kind === KIND_BLACK ? '#151515' : '#6b6b6b';
      }
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
      const n = L.number[i];
      if (kind !== KIND_SETUP && n > 0 && n < 1000) {
        ctx.fillStyle = kind === KIND_BLACK ? '#ffffff' : '#151515';
        ctx.font = `600 ${n < 100 ? 9 : 7.5}px system-ui, sans-serif`;
        ctx.fillText(String(n), x, y + 0.5);
      }
      if (L.comment[i]) {
        ctx.beginPath();
        ctx.arc(x + RADIUS * 0.8, y - RADIUS * 0.8, 3, 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // 今のノード
    const cur = state.current;
    if (cur >= 0 && cur < L.count) {
      ctx.beginPath();
      ctx.arc(px(L.col[cur]), py(L.row[cur]), RADIUS + 3, 0, Math.PI * 2);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }
}
