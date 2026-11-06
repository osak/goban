/**
 * 盤面データと石の配置・除去、囲まれた石（呼吸点ゼロの連）の判定。
 * DOM に依存しない。
 */

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

export type StoneColor = typeof BLACK | typeof WHITE;
export type PointState = typeof EMPTY | StoneColor;

/** 囲まれた石の扱い: 取り除く / △でマークする / 何もしない */
export type CaptureMode = 'remove' | 'mark' | 'none';
export const CAPTURE_MODES: readonly CaptureMode[] = ['remove', 'mark', 'none'];

export const MIN_BOARD_SIZE = 2;
export const MAX_BOARD_SIZE = 25;

export function opposite(color: StoneColor): StoneColor {
  return color === BLACK ? WHITE : BLACK;
}

export type PlaceResult =
  | { readonly ok: true; readonly captured: readonly number[] }
  | { readonly ok: false; readonly reason: 'out-of-bounds' | 'occupied' | 'suicide' };

export interface Group {
  readonly color: PointState;
  /** 連に属する石のインデックス */
  readonly stones: readonly number[];
  /** 呼吸点の数 */
  readonly liberties: number;
}

export class Board {
  readonly size: number;
  /** 交点の状態。インデックスは y * size + x（左上が 0） */
  readonly grid: Uint8Array;

  constructor(size: number, grid?: ArrayLike<number>) {
    if (!Number.isInteger(size) || size < MIN_BOARD_SIZE || size > MAX_BOARD_SIZE) {
      throw new RangeError(`invalid board size: ${size}`);
    }
    this.size = size;
    this.grid = new Uint8Array(size * size);
    if (grid) {
      if (grid.length !== size * size) throw new RangeError('grid length mismatch');
      this.grid.set(grid);
    }
  }

  index(x: number, y: number): number {
    return y * this.size + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.size && y < this.size;
  }

  get(x: number, y: number): PointState {
    return this.grid[this.index(x, y)] as PointState;
  }

  set(x: number, y: number, state: PointState): void {
    this.grid[this.index(x, y)] = state;
  }

  clone(): Board {
    return new Board(this.size, this.grid);
  }

  isEmpty(): boolean {
    return this.grid.every((c) => c === EMPTY);
  }

  equals(other: Board): boolean {
    return other.size === this.size && this.grid.every((c, i) => c === other.grid[i]);
  }

  /** インデックス i の上下左右のインデックス */
  neighbors(i: number): number[] {
    const s = this.size;
    const x = i % s;
    const out: number[] = [];
    if (x > 0) out.push(i - 1);
    if (x < s - 1) out.push(i + 1);
    if (i >= s) out.push(i - s);
    if (i < s * s - s) out.push(i + s);
    return out;
  }

  /** インデックス i の石を含む連と、その呼吸点の数 */
  groupAt(i: number): Group {
    const color = this.grid[i] as PointState;
    if (color === EMPTY) return { color, stones: [], liberties: 0 };
    const seen = new Uint8Array(this.grid.length);
    const libertySeen = new Uint8Array(this.grid.length);
    const stones: number[] = [];
    const stack = [i];
    let liberties = 0;
    seen[i] = 1;
    for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
      stones.push(cur);
      for (const n of this.neighbors(cur)) {
        const c = this.grid[n];
        if (c === EMPTY) {
          if (!libertySeen[n]) {
            libertySeen[n] = 1;
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

  /** 呼吸点がゼロの連に属する石のインデックス（△マーク用。黒白とも） */
  deadStones(): Set<number> {
    const dead = new Set<number>();
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
   * captureMode が 'remove' のときは呼吸点がなくなった相手の連を取り除き、
   * それでも自分の連の呼吸点がゼロなら（自殺手）置かずに失敗する。
   * 'mark' / 'none' のときは置くだけで盤面の他の石は変えない。
   */
  place(x: number, y: number, color: StoneColor, captureMode: CaptureMode): PlaceResult {
    if (!this.inBounds(x, y)) return { ok: false, reason: 'out-of-bounds' };
    const i = this.index(x, y);
    if (this.grid[i] !== EMPTY) return { ok: false, reason: 'occupied' };
    this.grid[i] = color;
    const captured: number[] = [];
    if (captureMode === 'remove') {
      const enemy = opposite(color);
      for (const n of this.neighbors(i)) {
        if (this.grid[n] !== enemy) continue; // 取り除いたばかりの連もここで弾かれる
        const g = this.groupAt(n);
        if (g.liberties > 0) continue;
        for (const s of g.stones) {
          this.grid[s] = EMPTY;
          captured.push(s);
        }
      }
      if (captured.length === 0 && this.groupAt(i).liberties === 0) {
        this.grid[i] = EMPTY;
        return { ok: false, reason: 'suicide' };
      }
    }
    return { ok: true, captured };
  }

  /** 石を取り除き、取り除いた石の色を返す（なければ EMPTY） */
  remove(x: number, y: number): PointState {
    if (!this.inBounds(x, y)) return EMPTY;
    const i = this.index(x, y);
    const c = this.grid[i] as PointState;
    this.grid[i] = EMPTY;
    return c;
  }

  clear(): void {
    this.grid.fill(EMPTY);
  }

  /** '0' / '1' / '2' を並べた文字列にする */
  serialize(): string {
    return Array.from(this.grid).join('');
  }

  static deserialize(size: number, data: unknown): Board | null {
    if (!Number.isInteger(size) || size < MIN_BOARD_SIZE || size > MAX_BOARD_SIZE) return null;
    if (typeof data !== 'string' || data.length !== size * size || /[^012]/.test(data)) return null;
    return new Board(size, Array.from(data, (ch) => ch.charCodeAt(0) - 48));
  }
}
