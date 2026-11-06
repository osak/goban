import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 相対パスで出力し、GitHub Pages のサブディレクトリなどどこに置いても動くようにする
  base: './',
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
