/**
 * ビルド結果の JS / CSS を HTML に埋め込み、1 ファイルだけで動くページにする Vite プラグイン。
 * file:// で直接開いても動く（外部ファイルを読み込まない）。
 */

import type { Plugin } from 'vite';

export interface InlineAsset {
  /** 出力ディレクトリからの相対パス（例: assets/index-abc.js） */
  readonly fileName: string;
  readonly kind: 'script' | 'style';
  readonly content: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** HTML の解析を途中で終わらせてしまう並び（</script など）を無害化する */
function escapeForTag(content: string, tag: 'script' | 'style'): string {
  return content.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1').replace(/<!--/g, '<\\!--');
}

/**
 * HTML 中の <script src> / <link rel="stylesheet" href> を、対応するファイルの中身に置き換える。
 * 置き換えられなかったファイル名を unused に返す。
 */
export function inlineAssets(html: string, assets: readonly InlineAsset[]): { html: string; unused: string[] } {
  const unused: string[] = [];
  for (const asset of assets) {
    // base が './' なら "./assets/x.js"、'/' なら "/assets/x.js" になる
    const url = `(?:\\.?/)?${escapeRegExp(asset.fileName)}`;
    const pattern =
      asset.kind === 'script'
        ? new RegExp(`<script\\b[^>]*\\bsrc="${url}"[^>]*>\\s*</script>`)
        : new RegExp(`<link\\b[^>]*\\bhref="${url}"[^>]*>`);
    if (!pattern.test(html)) {
      unused.push(asset.fileName);
      continue;
    }
    const replacement =
      asset.kind === 'script'
        ? `<script type="module">${escapeForTag(asset.content, 'script')}</script>`
        : `<style>${escapeForTag(asset.content, 'style')}</style>`;
    // 置換文字列中の $ を特別扱いさせないよう関数で渡す
    html = html.replace(pattern, () => replacement);
  }
  return { html, unused };
}

export interface SingleFileOptions {
  /** 出力する HTML のファイル名（省略時は index.html のまま） */
  readonly fileName?: string;
}

export function singleFile(options: SingleFileOptions = {}): Plugin {
  return {
    name: 'goban:single-file',
    apply: 'build',
    enforce: 'post',
    config: () => ({
      build: {
        cssCodeSplit: false,
        assetsInlineLimit: Number.MAX_SAFE_INTEGER,
        modulePreload: { polyfill: false },
      },
    }),
    generateBundle(_, bundle) {
      const htmlKey = Object.keys(bundle).find((k) => k.endsWith('.html'));
      const htmlAsset = htmlKey ? bundle[htmlKey] : undefined;
      if (!htmlKey || htmlAsset?.type !== 'asset') {
        this.error('HTML の出力が見つかりません');
        return;
      }

      const assets: InlineAsset[] = [];
      for (const [key, output] of Object.entries(bundle)) {
        if (key === htmlKey) continue;
        if (output.type === 'chunk') {
          assets.push({ fileName: output.fileName, kind: 'script', content: output.code });
        } else if (output.fileName.endsWith('.css')) {
          assets.push({ fileName: output.fileName, kind: 'style', content: String(output.source) });
        } else {
          this.error(`1 ファイルにまとめられない出力があります: ${output.fileName}`);
        }
      }

      const { html, unused } = inlineAssets(String(htmlAsset.source), assets);
      if (unused.length) this.error(`HTML から参照されていない出力があります: ${unused.join(', ')}`);

      for (const key of Object.keys(bundle)) delete bundle[key];
      this.emitFile({ type: 'asset', fileName: options.fileName ?? htmlAsset.fileName, source: html });
    },
  };
}
