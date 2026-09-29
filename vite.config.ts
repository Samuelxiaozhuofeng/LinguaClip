import path from 'path';
import fs from 'fs';
import os from 'os';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Browser dev only: the Tauri http plugin skips CORS, a browser doesn't, so
// dev/browserMock.ts sends cross-origin requests here and we forward them.
const corsProxy: Plugin = {
  name: 'dev-cors-proxy',
  configureServer(server) {
    server.middlewares.use('/__proxy', async (req, res) => {
      const origin = req.headers.origin;
      const target = req.headers['x-proxy-url'];
      // Only the page this server itself serves, on whatever port it was handed.
      if ((origin && origin !== `http://${req.headers.host}`) || typeof target !== 'string') {
        res.statusCode = 403;
        return res.end();
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = { ...req.headers } as Record<string, string>;
      for (const h of ['host', 'origin', 'referer', 'connection', 'content-length', 'x-proxy-url']) delete headers[h];
      try {
        const r = await fetch(target, {
          method: req.method,
          headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
        });
        res.statusCode = r.status;
        r.headers.forEach((v, k) => {
          if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k)) res.setHeader(k, v);
        });
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch (e) {
        res.statusCode = 502;
        res.end(String(e));
      }
    });
  },
};

export default defineConfig(({ command }) => {
    // `npm run dev` in a plain browser (no `tauri dev`): dev/browserMock.ts
    // fakes the shell and local files are served over /@fs, so stay on
    // localhost and keep the yt-dlp login cookies out of reach.
    const browserDev = command === 'serve' && !process.env.TAURI_ENV_PLATFORM;
    const home = os.homedir();
    return {
      // No SPA fallback, else a missing /@fs file comes back as index.html (200)
      // and the mock thinks it exists.
      appType: browserDev ? 'mpa' : 'spa',
      server: {
        // tauri dev expects 3000; a browser preview takes the port it is handed.
        port: browserDev && process.env.PORT ? Number(process.env.PORT) : 3000,
        host: browserDev ? '127.0.0.1' : '0.0.0.0',
        ...(browserDev && {
          fs: {
            allow: ['.', path.join(home, 'Movies'), path.join(home, 'Downloads')],
            deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/cookies.txt', '**/.yt-login/**'],
          },
        }),
      },
      plugins: [react(), ...(browserDev ? [corsProxy] : [])],
      define: {
        __DEV_HOME__: JSON.stringify(browserDev ? home : ''),
      },
      resolve: {
        alias: {
          // Pro build when pro/ is here (private repo), open-source build otherwise.
          '@pro': path.resolve(__dirname, fs.existsSync(path.resolve(__dirname, 'pro/index.ts')) ? 'pro/index.ts' : 'utils/proStub.ts'),
          '@': path.resolve(__dirname, '.'),
          ...(browserDev && { '@tauri-apps/plugin-http': path.resolve(__dirname, 'dev/browserMock.ts') }),
        }
      }
    };
});
