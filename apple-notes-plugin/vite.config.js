import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 作为扩展页面时资源必须使用相对路径
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome100'
  }
});
