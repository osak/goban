import { describe, expect, it } from 'vitest';
import { inlineAssets } from '../plugins/single-file';

const HTML = `<!doctype html>
<html>
<head>
  <script type="module" crossorigin src="./assets/index-abc.js"></script>
  <link rel="stylesheet" crossorigin href="./assets/index-def.css">
</head>
<body></body>
</html>`;

describe('inlineAssets', () => {
  it('script と stylesheet を中身に置き換える', () => {
    const { html, unused } = inlineAssets(HTML, [
      { fileName: 'assets/index-abc.js', kind: 'script', content: 'console.log(1);' },
      { fileName: 'assets/index-def.css', kind: 'style', content: 'body{color:red}' },
    ]);
    expect(unused).toEqual([]);
    expect(html).toContain('<script type="module">console.log(1);</script>');
    expect(html).toContain('<style>body{color:red}</style>');
    expect(html).not.toMatch(/src=|href=|crossorigin/);
  });

  it('base が / の場合の参照も置き換える', () => {
    const { html, unused } = inlineAssets('<script type="module" src="/assets/a.js"></script>', [
      { fileName: 'assets/a.js', kind: 'script', content: 'x()' },
    ]);
    expect(unused).toEqual([]);
    expect(html).toBe('<script type="module">x()</script>');
  });

  it('HTML の解析を壊す並びと $ を含む中身も安全に埋め込む', () => {
    const js = 'const s = "</script><!-- $& $1";';
    const { html } = inlineAssets(HTML, [
      { fileName: 'assets/index-abc.js', kind: 'script', content: js },
      { fileName: 'assets/index-def.css', kind: 'style', content: 'a::after{content:"</style>"}' },
    ]);
    expect(html).toContain('<script type="module">const s = "<\\/script><\\!-- $& $1";</script>');
    expect(html).toContain('<style>a::after{content:"<\\/style>"}</style>');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it('参照されていないファイルは unused で返す', () => {
    const { unused } = inlineAssets(HTML, [{ fileName: 'assets/other.js', kind: 'script', content: '' }]);
    expect(unused).toEqual(['assets/other.js']);
  });

  it('似た名前のファイルを取り違えない', () => {
    const { unused } = inlineAssets(HTML, [{ fileName: 'assets/index-abcjs', kind: 'script', content: '' }]);
    expect(unused).toEqual(['assets/index-abcjs']);
  });
});
