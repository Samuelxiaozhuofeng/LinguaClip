// Android native build (docs/android.md): mobile/ → dist-android/ bundled into Tauri 2 Android APK.
// Unlike vite.mobile.config.ts (PWA), this keeps REAL @tauri-apps/* APIs, plugin-http (no CORS),
// and utils/localDict.ts (Yomitan SQLite), while swapping utils/desktop.ts for desktop.android.ts.
import path from 'path';
import fs from 'fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const here = (p: string) => path.resolve(__dirname, p);

const SWAP: Record<string, string> = {
  [here('utils/desktop.ts')]: here('mobile/platform/desktop.android.ts'),
  [here('mobile/platform/desktop.ts')]: here('mobile/platform/desktop.android.ts'),
  [here('mobile/platform/androidInit.ts')]: here('mobile/platform/androidInit.android.ts'),
  [here('mobile/platform/audioEngine.ts')]: here('mobile/platform/audioEngine.android.ts'),
  [here('mobile/platform/wordPlatform.ts')]: here('mobile/platform/wordPlatform.android.ts'),
  [here('mobile/importAudio.ts')]: here('mobile/platform/importAudio.android.ts'),
  [here('mobile/platform/homePlatform.ts')]: here('mobile/platform/homePlatform.android.ts'),
};

const androidPlatform: Plugin = {
  name: 'android-platform',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || source.startsWith('\0')) return null;
    const r = await this.resolve(source, importer, { ...options, skipSelf: true });
    return r && SWAP[r.id] ? SWAP[r.id] : null;
  },
};

export default defineConfig({
  root: here('mobile'),
  base: '/',
  css: { postcss: here('.') },
  build: { outDir: here('dist-android'), emptyOutDir: true },
  plugins: [androidPlatform, react()],
  resolve: {
    alias: {
      '@pro': here(fs.existsSync(here('pro/index.ts')) ? 'pro/index.ts' : 'utils/proStub.ts'),
      '@': here('.'),
    },
  },
});
