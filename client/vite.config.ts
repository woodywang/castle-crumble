import { defineConfig } from 'vite';

// base: './' 让打包产物可以放在任意静态托管路径下（Vercel / Cloudflare Pages / 子目录）
export default defineConfig({
  base: './',
  server: { port: 5173 },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 2000,
  },
});
