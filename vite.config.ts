import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'src/webview'),
  test: {
    include: [
      resolve(__dirname, 'src/webview/**/*.test.ts'),
      resolve(__dirname, 'src/extension/**/*.test.ts'),
    ],
    environment: 'node',
  },
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom/test-utils': 'preact/test-utils',
      'react-dom': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    outDir: resolve(__dirname, 'dist/webview'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/webview/main.tsx'),
      output: {
        entryFileNames: 'webview.js',
        assetFileNames: 'webview[extname]',
        format: 'iife',
        inlineDynamicImports: true,
      },
    },
    sourcemap: true,
    target: 'es2022',
    minify: false,
  },
});
