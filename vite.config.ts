import { defineConfig } from 'vitest/config';
import { singleFile } from './plugins/single-file';

// `vite build --mode single` で、JS / CSS を埋め込んだ 1 ファイル版（dist-single/goban.html）を作る
export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    // 相対パスで出力し、GitHub Pages のサブディレクトリなどどこに置いても動くようにする
    base: './',
    plugins: single ? [singleFile({ fileName: 'goban.html' })] : [],
    build: {
      outDir: single ? 'dist-single' : 'dist',
    },
    test: {
      include: ['tests/**/*.test.ts'],
    },
  };
});
