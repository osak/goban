import { describe, expect, it } from 'vitest';
import { isLabelText, pickLabelText } from '../src/labels';

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
});
