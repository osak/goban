import { describe, expect, it } from 'vitest';
import { deserializeLabels, isLabelText, pickLabelText, sameLabels, serializeLabels } from '../src/labels';

describe('交点に書く文字', () => {
  it('1 文字だけを書ける文字とする', () => {
    for (const ok of ['A', 'あ', '甲', '1', '★', '👍', '👨‍👩‍👧', 'é']) expect(isLabelText(ok)).toBe(true);
    for (const ng of ['', 'AB', ' ', '　', '\n', '\u0007', 1, null]) expect(isLabelText(ng)).toBe(false);
  });

  it('入力欄からは最後に入力した 1 文字を使う', () => {
    expect(pickLabelText('A')).toBe('A');
    expect(pickLabelText('AB')).toBe('B');
    expect(pickLabelText('あいう')).toBe('う');
    expect(pickLabelText('a👍')).toBe('👍');
    expect(pickLabelText(' x ')).toBe('x');
    expect(pickLabelText('')).toBe('');
    expect(pickLabelText('  ')).toBe('');
  });

  it('保存用の形式にして元に戻せる', () => {
    const labels = new Map([
      [9 * 4 + 3, 'あ'],
      [0, 'A'],
    ]);
    const data = serializeLabels(labels, 9);
    expect(data).toEqual({ aa: 'A', de: 'あ' });
    expect(Object.keys(data)).toEqual(['aa', 'de']); // 交点の順
    expect(deserializeLabels(9, JSON.parse(JSON.stringify(data)))).toEqual(labels);
  });

  it('不正な項目は除き、形式が違えば null', () => {
    expect(deserializeLabels(9, { aa: 'A', zz: 'B', bb: 'CD', cc: '', d: 'E', ee: 3 })).toEqual(new Map([[0, 'A']]));
    expect(deserializeLabels(9, 'aaA')).toBeNull();
    expect(deserializeLabels(9, null)).toBeNull();
    expect(deserializeLabels(9, ['A'])).toBeNull();
  });

  it('同じ配置か', () => {
    expect(sameLabels(new Map([[1, 'A']]), new Map([[1, 'A']]))).toBe(true);
    expect(sameLabels(new Map([[1, 'A']]), new Map([[1, 'B']]))).toBe(false);
    expect(sameLabels(new Map([[1, 'A']]), new Map([[2, 'A']]))).toBe(false);
    expect(sameLabels(new Map(), new Map([[2, 'A']]))).toBe(false);
  });
});
