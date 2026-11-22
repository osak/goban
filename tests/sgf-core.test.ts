import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_NODES, SgfParseError, decodeSgf, parseSgf } from '../src/sgf/parse';
import {
  composed,
  decodeSimpleText,
  decodeText,
  encodeText,
  formatPoint,
  parseNumber,
  parsePoint,
  parsePointList,
  splitComposed,
} from '../src/sgf/values';
import { isWritableValue, writeSgf } from '../src/sgf/write';
import { createNode, type SgfNode } from '../src/tree';

/** ノードの中身を比べやすい形にする（id を除く） */
function shape(n: SgfNode): unknown {
  return { props: Object.fromEntries(n.props), children: n.children.map(shape) };
}

describe('values: 点', () => {
  it('点を読み書きする（a〜z、A〜Z）', () => {
    expect(parsePoint('aa')).toEqual({ x: 0, y: 0 });
    expect(parsePoint('sD')).toEqual({ x: 18, y: 29 });
    expect(parsePoint('')).toBeNull();
    expect(parsePoint('a')).toBeNull();
    expect(parsePoint('a1')).toBeNull();
    expect(formatPoint(18, 3)).toBe('sd');
    expect(() => formatPoint(52, 0)).toThrow(RangeError);
  });

  it('圧縮した点のリストを展開する', () => {
    expect(parsePointList(['aa:bb', 'dd'])).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 3, y: 3 },
    ]);
  });

  it('逆向きの長方形も読み、重なった点は 1 つにし、読めない値は飛ばす', () => {
    expect(parsePointList(['bb:aa', 'aa', 'zz9', 'a:b'])).toHaveLength(4);
  });
});

describe('values: テキスト', () => {
  it('エスケープを解く', () => {
    expect(decodeText('a\\]b\\\\c\\:d\\e')).toBe('a]b\\c:de');
  });

  it('ソフト改行を取り除き、改行は \\n にそろえる', () => {
    expect(decodeText('ab\\\ncd\\\r\nef')).toBe('abcdef');
    expect(decodeText('a\r\nb\rc\n\rd')).toBe('a\nb\nc\nd');
  });

  it('改行以外の空白はスペースにする（全角スペースは残す）', () => {
    expect(decodeText('a\tb　c')).toBe('a b　c');
  });

  it('SimpleText では改行をスペースにする', () => {
    expect(decodeSimpleText('a\nb\\\nc')).toBe('a bc');
  });

  it('エスケープして戻すと元に戻る', () => {
    for (const s of ['黒番', 'a]b', '\\', 'x:y', 'a\\]b']) {
      expect(decodeText(encodeText(s))).toBe(s);
    }
  });

  it('composed を最初のエスケープされていない : で分ける', () => {
    expect(splitComposed('aa:x\\:y')).toEqual(['aa', 'x\\:y']);
    expect(splitComposed('a\\:b:c')).toEqual(['a\\:b', 'c']);
    expect(splitComposed('abc')).toBeNull();
    expect(composed('aa', encodeText('1:2'))).toBe('aa:1\\:2');
  });

  it('数を読む', () => {
    expect(parseNumber(' 19 ')).toBe(19);
    expect(parseNumber('-3')).toBe(-3);
    expect(parseNumber('1.5')).toBeNull();
    expect(parseNumber('')).toBeNull();
  });
});

describe('parseSgf', () => {
  it('手順と変化を読む', () => {
    const [root] = parseSgf('(;GM[1]SZ[9];B[ee];W[cc](;B[gg];W[gc])(;B[cg]))');
    expect(root.props.get('SZ')).toEqual(['9']);
    const w = root.children[0].children[0];
    expect(w.props.get('W')).toEqual(['cc']);
    expect(w.children).toHaveLength(2);
    expect(w.children[0].props.get('B')).toEqual(['gg']);
    expect(w.children[0].children[0].props.get('W')).toEqual(['gc']);
    expect(w.children[1].props.get('B')).toEqual(['cg']);
  });

  it('コレクションの各ゲームツリーを根として返す', () => {
    const roots = parseSgf('(;GN[a])\n(;GN[b])');
    expect(roots.map((r) => r.props.get('GN'))).toEqual([['a'], ['b']]);
  });

  it('値はエスケープを解かずに持ち、複数の値も読む', () => {
    const [root] = parseSgf('(;C[a\\]b\\\\]AB[aa][bb:cc] LB [aa:x\\:y])');
    expect(root.props.get('C')).toEqual(['a\\]b\\\\']);
    expect(root.props.get('AB')).toEqual(['aa', 'bb:cc']);
    expect(root.props.get('LB')).toEqual(['aa:x\\:y']);
  });

  it('空白はノード・プロパティ・値の間のどこにあってもよい', () => {
    const [root] = parseSgf(' ( ; GM [1] \n ; B [aa] ) ');
    expect(root.props.get('GM')).toEqual(['1']);
    expect(root.children[0].props.get('B')).toEqual(['aa']);
  });

  it('前後のものは無視する', () => {
    const roots = parseSgf('﻿header text (;GM[1]) trailing');
    expect(roots).toHaveLength(1);
  });

  it('FF[3] の小文字を含むプロパティ名を読む', () => {
    const [root] = parseSgf('(;GaMe[1]AddBlack[aa])');
    expect(root.props.get('GM')).toEqual(['1']);
    expect(root.props.get('AB')).toEqual(['aa']);
  });

  it('1 つのノードの同じプロパティは値をつなげる', () => {
    const [root] = parseSgf('(;AB[aa]AW[bb]AB[cc])');
    expect(root.props.get('AB')).toEqual(['aa', 'cc']);
    expect([...root.props.keys()]).toEqual(['AB', 'AW']);
  });

  it('ノードごとに違う id を振る', () => {
    const [root] = parseSgf('(;;B[aa](;W[bb])(;W[cc]))');
    const ids = [root.id, root.children[0].id, root.children[0].children[0].id, root.children[0].children[1].id];
    expect(new Set(ids).size).toBe(4);
  });

  it.each([
    ['', 1, 1],
    ['(;B[aa]', 1, 8],
    ['(;C[abc)', 1, 4],
    ['(;B)', 1, 4],
    ['(()', 1, 2],
    ['(;B[aa]\n  ?)', 2, 3],
    ['(;B[aa](;W[bb]);B[cc])', 1, 16],
    ['(;b[aa])', 1, 3],
  ])('構文の誤りを位置つきで知らせる: %j', (text, line, column) => {
    try {
      parseSgf(text);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SgfParseError);
      expect((e as SgfParseError).line).toBe(line);
      expect((e as SgfParseError).column).toBe(column);
    }
  });

  it('ノードの数に上限を設ける', () => {
    expect(DEFAULT_MAX_NODES).toBeGreaterThan(1000);
    expect(() => parseSgf('(;;;;)', { maxNodes: 3 })).toThrow(SgfParseError);
    expect(parseSgf('(;;;)', { maxNodes: 3 })).toHaveLength(1);
  });

  it('長い手順でも呼び出しの深さで落ちない', () => {
    const text = '(;SZ[19]' + ';B[aa];W[bb]'.repeat(20000) + ')';
    const [root] = parseSgf(text);
    expect(writeSgf(root).replace(/\n/g, '')).toBe(text);
  });
});

describe('writeSgf', () => {
  it('手順を 1 ノード 1 行、変化を 1 つずつ書く', () => {
    const [root] = parseSgf('(;GM[1]SZ[9];B[ee](;W[cc];B[gg])(;W[gg]))');
    expect(writeSgf(root)).toBe('(;GM[1]SZ[9]\n;B[ee]\n(;W[cc]\n;B[gg])\n(;W[gg]))\n');
  });

  it('読み書きで変わらない（知らないプロパティ・ソフト改行・圧縮・composed を含む）', () => {
    const text =
      '(;GM[1]FF[4]CA[UTF-8]SZ[19]GN[名前\\]]XX[unknown][2]AB[aa:cc]C[1行目\\\n続き\n2行目]\n;B[pd]LB[pd:A\\:1]GBNS[]\n(;W[dd]\n;B[pp])\n(;W[dp]))\n(;SZ[9])\n';
    const roots = parseSgf(text);
    expect(writeSgf(roots)).toBe(text);
    expect(parseSgf(writeSgf(roots)).map(shape)).toEqual(roots.map(shape));
  });

  it('構文を壊す値やプロパティ名は書かない', () => {
    expect(isWritableValue('a\\]b')).toBe(true);
    expect(isWritableValue('a]b')).toBe(false);
    expect(isWritableValue('a\\')).toBe(false);
    expect(() => writeSgf(createNode([['C', ['a]b']]]))).toThrow();
    expect(() => writeSgf(createNode([['b', ['aa']]]))).toThrow();
  });

  it('空のコレクションは空文字列', () => {
    expect(writeSgf([])).toBe('');
  });
});

describe('decodeSgf', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it('CA がなければ UTF-8 として読む', () => {
    expect(decodeSgf(enc('(;GN[黒番])'))).toBe('(;GN[黒番])');
  });

  it('UTF-8 の BOM を取り除く', () => {
    expect(decodeSgf(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('(;)')]))).toBe('(;)');
  });

  it('CA の文字コードで読む', () => {
    // 「黒」の Shift_JIS は 0x8D 0x95
    const bytes = new Uint8Array([...enc('(;CA[Shift_JIS]GN['), 0x8d, 0x95, ...enc('])')]);
    expect(decodeSgf(bytes)).toBe('(;CA[Shift_JIS]GN[黒])');
  });

  it('CA がなく UTF-8 でなければ Shift_JIS、それもだめなら ISO-8859-1 で読む', () => {
    expect(decodeSgf(new Uint8Array([...enc('(;GN['), 0x8d, 0x95, ...enc('])')]))).toBe('(;GN[黒])');
    expect(decodeSgf(new Uint8Array([...enc('(;GN['), 0xe9, 0xff, ...enc('])')]))).toBe('(;GN[éÿ])');
  });

  it('知らない文字コード名なら判定で読む', () => {
    expect(decodeSgf(enc('(;CA[no-such-charset]GN[黒])'))).toBe('(;CA[no-such-charset]GN[黒])');
  });
});
