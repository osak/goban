import { describe, expect, it } from 'vitest';
import { BLACK, EMPTY, WHITE, type CaptureMode, type StoneColor } from '../src/board';
import {
  cursorNode,
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
  isNumberStartHere,
  setNumberStartHere,
  setTriangle,
  toggleTurn,
  trianglesAt,
  type Doc,
} from '../src/edit';
import { PositionCache, type GamePosition } from '../src/game';
import { writeSgf } from '../src/sgf/write';
import { getValue } from '../src/tree';

const SIZE = 5;
const at = (x: number, y: number) => y * SIZE + x;

class Session {
  readonly cache = new PositionCache();
  readonly pos = (n: Parameters<PositionCache['position']>[0]) => this.cache.position(n);
  doc: Doc = newDoc(SIZE, 'テスト');
  inheritMarks = true;

  get position(): GamePosition {
    return this.pos(docNodes(this.doc));
  }

  place(x: number, y: number, color: StoneColor, mode: CaptureMode = 'remove') {
    const res = placeStone(this.doc, this.pos, at(x, y), color, mode, { inheritMarks: this.inheritMarks });
    if (res.ok) this.doc = res.doc;
    return res;
  }

  erase(x: number, y: number, alternate = false) {
    const doc = eraseStone(this.doc, this.pos, at(x, y), alternate, { inheritMarks: this.inheritMarks });
    if (doc) this.doc = doc;
    return doc;
  }

  /** 盤を 1 行 1 文字列にする（. 空 / X 黒 / O 白） */
  rows(): string[] {
    const { board } = this.position;
    const out: string[] = [];
    for (let y = 0; y < SIZE; y++) {
      let line = '';
      for (let x = 0; x < SIZE; x++) line += '.XO'[board.grid[at(x, y)]];
      out.push(line);
    }
    return out;
  }

  /** 根より後のノードを 1 つずつ SGF にしたもの（本線） */
  nodes(): string[] {
    return writeSgf(this.doc.root).trim().slice(1, -1).split('\n').slice(1);
  }
}

describe('石を置く', () => {
  it('今のノードに子の着手ノードを足して移る', () => {
    const s = new Session();
    expect(s.place(1, 1, BLACK).ok).toBe(true);
    expect(s.place(2, 2, WHITE).ok).toBe(true);
    expect(s.doc.cursor).toEqual([0, 0]);
    expect(s.nodes()).toEqual([';B[bb]', ';W[cc]']);
  });

  it('石のある点には置けない', () => {
    const s = new Session();
    s.place(1, 1, BLACK);
    expect(s.place(1, 1, WHITE)).toEqual({ ok: false, reason: 'occupied' });
  });

  it('取り除く: 取りは打ち直しで起き、自殺手は置かない', () => {
    const s = new Session();
    s.place(1, 0, BLACK);
    s.place(0, 0, WHITE);
    s.place(0, 1, BLACK);
    expect(s.rows()[0]).toBe('.X...');
    expect(s.nodes().at(-1)).toBe(';B[ab]');
    expect(s.place(0, 0, WHITE)).toEqual({ ok: false, reason: 'suicide' });
  });

  it('△マーク: 普通の着手で、取られた石の点（△）にそのまま打てる。自殺手は置かない', () => {
    const s = new Session();
    s.place(1, 0, BLACK, 'mark');
    s.place(0, 0, WHITE, 'mark');
    s.place(0, 1, BLACK, 'mark');
    expect(s.position.captured).toEqual(new Map([[0, WHITE]]));
    expect(s.place(0, 0, WHITE, 'mark')).toEqual({ ok: false, reason: 'suicide' });
    expect(s.place(0, 0, BLACK, 'mark').ok).toBe(true);
    expect(s.position.captured.size).toBe(0);
  });

  it('何もしない: 取りや自殺が起きる手は「取りなしの着手」にする', () => {
    const s = new Session();
    s.place(1, 0, BLACK, 'none');
    s.place(0, 0, WHITE, 'none');
    s.place(0, 1, BLACK, 'none'); // 白を取る形
    expect(s.rows()[0]).toBe('OX...');
    expect(s.nodes()).toEqual([';B[ba]', ';W[aa]', ';AB[ab]GBMV[]']);
    expect(s.position.moves).toHaveLength(3);
    expect(s.position.moves[2].captureless).toBe(true);
    // 呼吸点のない所にも置ける
    s.place(4, 4, WHITE, 'none');
    s.place(3, 4, BLACK, 'none');
    s.place(4, 3, BLACK, 'none');
    expect(s.rows()[4]).toBe('...XO');
    expect(s.nodes().at(-1)).toBe(';AB[ed]GBMV[]');
  });

  it('同じ手の子がすでにあれば、足さずにその子へ移る', () => {
    const s = new Session();
    s.place(1, 1, BLACK);
    const root = s.doc.root;
    s.doc = { ...s.doc, cursor: [] };
    s.place(1, 1, BLACK);
    expect(s.doc.root).toBe(root);
    expect(s.doc.cursor).toEqual([0]);
  });

  it('子のある所に違う手を打つと変化になる', () => {
    const s = new Session();
    s.place(1, 1, BLACK);
    s.doc = { ...s.doc, cursor: [] };
    s.place(2, 2, BLACK);
    expect(s.doc.cursor).toEqual([1]);
    expect(s.doc.root.children).toHaveLength(2);
  });

  it('子を作るとき、文字と盤上に残る石の△を引き継ぐ（設定で切れる）', () => {
    const s = new Session();
    s.place(1, 0, BLACK);
    s.place(0, 0, WHITE);
    s.doc = setTriangle(s.doc, at(0, 0), true);
    s.doc = setTriangle(s.doc, at(1, 0), true);
    s.doc = setLabel(s.doc, at(3, 3), 'A');
    s.place(0, 1, BLACK); // 白 (0,0) を取る
    expect(trianglesAt(s.doc)).toEqual(new Set([at(1, 0)]));
    expect(labelsAt(s.doc)).toEqual(new Map([[at(3, 3), 'A']]));
    s.inheritMarks = false;
    s.place(4, 4, WHITE);
    expect(trianglesAt(s.doc).size).toBe(0);
    expect(labelsAt(s.doc).size).toBe(0);
  });
});

describe('石を取り除く', () => {
  it('今のノードの手の石なら、そのノードを消して親へ移る', () => {
    const s = new Session();
    s.place(1, 1, BLACK);
    s.place(2, 2, WHITE);
    s.erase(2, 2);
    expect(s.doc.cursor).toEqual([0]);
    expect(s.nodes()).toEqual([';B[bb]']);
  });

  it('今のノードに子があるときは、消さずに親へ移るだけ', () => {
    const s = new Session();
    s.place(1, 1, BLACK);
    s.place(2, 2, WHITE);
    s.doc = { ...s.doc, cursor: [0] };
    s.erase(1, 1);
    expect(s.doc.cursor).toEqual([]);
    expect(s.nodes()).toEqual([';B[bb]', ';W[cc]']);
  });

  it('ほかの石は子の配置ノード（AE）で消し、続けて消すとそのノードを直す', () => {
    const s = new Session();
    s.place(1, 1, BLACK);
    s.place(2, 2, WHITE);
    s.place(3, 3, BLACK);
    s.erase(1, 1);
    s.erase(2, 2);
    expect(s.nodes().slice(3)).toEqual([';AE[bb][cc]']);
    expect(s.rows()).toEqual(['.....', '.....', '.....', '...X.', '.....']);
    expect(s.erase(0, 0)).toBeNull();
  });

  it('最後に置いた石は、後ろが配置ノードの一本道だけなら、その手のノードを抜く', () => {
    const s = new Session();
    s.place(1, 1, BLACK);
    s.place(2, 2, WHITE);
    s.place(3, 3, BLACK);
    s.doc = setNumberStartHere(s.doc, s.doc.cursor, true); // 次の手から（B[dd] に GBNS）
    s.erase(1, 1); // AE の子ができる
    s.erase(3, 3); // 最後に置いた石
    // 番号の起点の印は抜いたノードの親に移るので、番号の付き方は変わらない
    expect(s.nodes()).toEqual([';B[bb]', ';W[cc]GBNS[]', ';AE[bb]']);
    expect(s.doc.cursor).toEqual([0, 0, 0]);
    expect(s.position.moves).toHaveLength(2);
    expect(s.position.numberFrom).toBe(2);
  });

  it('最後の手の後ろに分かれ目があれば、その手は抜かずに AE で消す', () => {
    const s = new Session();
    s.place(0, 0, BLACK);
    s.place(1, 1, BLACK); // [0, 0]
    s.place(2, 2, WHITE); // [0, 0, 0]
    s.doc = { ...s.doc, cursor: [0, 0] };
    s.place(3, 3, WHITE); // 変化 [0, 0, 1]
    s.doc = { ...s.doc, cursor: [0, 0] };
    s.erase(0, 0); // 着手ノードなので AE の子 [0, 0, 2]
    expect(s.doc.cursor).toEqual([0, 0, 2]);
    s.erase(1, 1); // B[bb] には子が 3 つあるので抜かない
    expect(s.doc.cursor).toEqual([0, 0, 2]);
    expect(s.doc.root.children[0].children[0].children).toHaveLength(3);
    expect(getValue(cursorNode(s.doc), 'AE')).toBe('aa');
    expect(cursorNode(s.doc).props.get('AE')).toEqual(['aa', 'bb']);
  });

  it('配置ノードで置いた石を消すときは、AB / AW から外す', () => {
    const s = new Session();
    s.doc = { ...s.doc, root: { ...s.doc.root, props: new Map([...s.doc.root.props, ['AB', ['aa', 'bb']]]) } };
    s.erase(0, 0);
    expect(getValue(s.doc.root, 'AB')).toBe('bb');
    expect(s.doc.root.props.has('AE')).toBe(false);
    expect(s.doc.cursor).toEqual([]);
  });

  it('交互モードでは、消した石の色を次の手番（PL）にする', () => {
    const s = new Session();
    s.place(1, 1, BLACK);
    s.place(2, 2, WHITE);
    s.place(3, 3, BLACK);
    s.erase(2, 2, true);
    expect(s.nodes().at(-1)).toBe(';AE[cc]PL[W]');
    expect(s.position.nextColor).toBe(WHITE);
  });

  it('消した石の△は外す', () => {
    const s = new Session();
    s.place(1, 1, BLACK);
    s.place(2, 2, WHITE);
    s.erase(1, 1);
    s.place(3, 3, BLACK);
    s.doc = setTriangle(s.doc, at(2, 2), true);
    s.erase(4, 4);
    expect(s.erase(2, 2)).not.toBeNull();
    // 着手ノードの石を消したので AE の子ができ、△は盤上に残る石の分だけ引き継ぐ
    expect(trianglesAt(s.doc).size).toBe(0);
  });
});

describe('印・文字・番号の起点・手番・名前', () => {
  it('△と文字は今のノードに付ける', () => {
    const s = new Session();
    s.place(1, 1, BLACK);
    s.doc = setTriangle(s.doc, at(1, 1), true);
    s.doc = setLabel(s.doc, at(0, 0), 'あ');
    s.doc = setLabel(s.doc, at(4, 4), ':]');
    expect(s.nodes()).toEqual([';B[bb]TR[bb]LB[aa:あ][ee:\\:\\]]']);
    expect(labelsAt(s.doc).get(at(4, 4))).toBe(':]');
    s.doc = setLabel(s.doc, at(0, 0), null);
    s.doc = setTriangle(s.doc, at(1, 1), false);
    expect(s.nodes()).toEqual([';B[bb]LB[ee:\\:\\]]']);
  });

  it('番号の起点は今のノードに付け、今の手順の上のほかの起点は外す', () => {
    const s = new Session();
    s.place(0, 0, BLACK);
    s.place(1, 1, WHITE);
    s.place(2, 2, BLACK);
    const line = s.doc.cursor;
    s.doc = setNumberStartHere(s.doc, line, true); // 次の手から
    expect(s.position.numberFrom).toBe(3);
    expect(isNumberStartHere(s.doc)).toBe(true);
    // 1 手目に戻って起点を付けると、先の手順の起点は外れる
    s.doc = { ...s.doc, cursor: [0] };
    s.doc = setNumberStartHere(s.doc, line, true);
    expect(s.nodes()).toEqual([';B[aa]GBNS[]', ';W[bb]', ';B[cc]']);
    expect(s.position.numberFrom).toBe(1);
    s.doc = setNumberStartHere(s.doc, line, false);
    expect(writeSgf(s.doc.root)).not.toContain('GBNS');
    expect(isNumberStartHere(s.doc)).toBe(false);
    // 根では付けない（最初の手から）
    s.doc = setNumberStartHere({ ...s.doc, cursor: [] }, line, true);
    expect(writeSgf(s.doc.root)).not.toContain('GBNS');
    expect(() => setNumberStartHere({ ...s.doc, cursor: [1] }, line, true)).toThrow();
  });

  it('手番の入れ替え: 配置ノードでは PL、着手ノードでは一時的に持つ', () => {
    const s = new Session();
    s.doc = toggleTurn(s.doc, s.position);
    expect(getValue(s.doc.root, 'PL')).toBe('W');
    expect(nextColorOf(s.doc, s.position)).toBe(WHITE);
    s.place(1, 1, WHITE);
    const root = s.doc.root;
    s.doc = toggleTurn(s.doc, s.position);
    expect(s.doc.root).toBe(root);
    expect(nextColorOf(s.doc, s.position)).toBe(WHITE);
    s.doc = toggleTurn(s.doc, s.position);
    expect(s.doc.turn).toBeNull();
    // ノードを移ると消える
    s.doc = toggleTurn(s.doc, s.position);
    s.place(2, 2, WHITE);
    expect(s.doc.turn).toBeNull();
  });

  it('名前は根の GN', () => {
    const s = new Session();
    expect(docName(s.doc)).toBe('テスト');
    s.doc = renameDoc(s.doc, ' 定石 [1] ');
    expect(getValue(s.doc.root, 'GN')).toBe('定石 [1\\]');
    expect(docName(s.doc)).toBe('定石 [1]');
  });

  it('盤のクリアは名前を残して新しいツリーにする', () => {
    const s = new Session();
    expect(hasContent(s.doc, s.position)).toBe(false);
    s.place(1, 1, BLACK);
    expect(hasContent(s.doc, s.position)).toBe(true);
    const cleared = resetDoc(s.doc, 9);
    expect(docName(cleared)).toBe('テスト');
    expect(getValue(cleared.root, 'SZ')).toBe('9');
    expect(cleared.root.children).toHaveLength(0);
    expect(cursorNode(cleared)).toBe(cleared.root);
  });

  it('文字だけの盤面もクリアの対象', () => {
    const s = new Session();
    s.doc = setLabel(s.doc, 0, 'A');
    expect(hasContent(s.doc, s.position)).toBe(true);
    expect(s.position.board.grid[0]).toBe(EMPTY);
  });
});
