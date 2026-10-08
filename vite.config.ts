import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  root: 'ui',
  base: './',
  build: { outDir: '../build/ui', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:37821' } },
});
