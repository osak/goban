/**
 * 元に戻す／やり直すの履歴。T は盤面のスナップショットなど任意の値。
 */
export class UndoHistory<T> {
  private readonly undoStack: T[] = [];
  private readonly redoStack: T[] = [];
  private readonly limit: number;

  constructor(limit = 500) {
    this.limit = limit;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** 新しい操作の直前の状態を記録する。やり直しの履歴は消える */
  record(before: T): void {
    this.undoStack.push(before);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** current をやり直し側に積み、1 つ前の状態を返す（なければ undefined で何もしない） */
  undo(current: T): T | undefined {
    const prev = this.undoStack.pop();
    if (prev !== undefined) this.redoStack.push(current);
    return prev;
  }

  /** current を元に戻す側に積み、1 つ先の状態を返す（なければ undefined で何もしない） */
  redo(current: T): T | undefined {
    const next = this.redoStack.pop();
    if (next !== undefined) this.undoStack.push(current);
    return next;
  }
}
