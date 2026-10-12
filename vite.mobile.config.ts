// The phone web app (docs/mobile-web.md): mobile/ → dist-mobile/, served at /app/.
// Desktop code is reused untouched; its Tauri layer is swapped for mobile/platform/
// here, and any other @tauri-apps import fails the build.
import path from 'path';
import fs from 'fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const here = (p: string) => path.resolve(__dirname, p);

// By the resolved file, so './desktop', '../utils/desktop' and '@/utils/desktop' all land.
const SWAP: Record<string, string> = {
  [here('utils/desktop.ts')]: here('mobile/platform/desktop.ts'),
  [here('utils/localDict.ts')]: here('mobile/platform/localDict.ts'),
};

const platform: Plugin = {
  name: 'mobile-platform',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (source.startsWith('@tauri-apps/')) {
      this.error(`手机版不能用 Tauri：${source}（被 ${importer ?? '?'} 引用）`);
    }
    if (!importer || source.startsWith('\0')) return null;
    const r = await this.resolve(source, importer, { ...options, skipSelf: true });
    return r && SWAP[r.id] ? SWAP[r.id] : null;
  },
};

export default defineConfig({
  root: here('mobile'),
  base: '/app/',
  // index.css's Tailwind: the root postcss config, wherever vite's root is.
  css: { postcss: here('.') },
  build: { outDir: here('dist-mobile'), emptyOutDir: true },
  // /starter/ lives on our site (same origin as /app/ there); dev and preview borrow it.
  server: { host: '127.0.0.1', proxy: { '/starter': { target: 'https://linguaclipapp.com', changeOrigin: true } } },
  preview: { host: '127.0.0.1', proxy: { '/starter': { target: 'https://linguaclipapp.com', changeOrigin: true } } },
  plugins: [platform, react()],
  resolve: {
    alias: {
      '@pro': here(fs.existsSync(here('pro/index.ts')) ? 'pro/index.ts' : 'utils/proStub.ts'),
      '@tauri-apps/plugin-http': here('mobile/platform/http.ts'),
      '@': here('.'),
    },
  },
});
