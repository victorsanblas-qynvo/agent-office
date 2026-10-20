import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { mintPanelToken } from '../hub/src/panel-auth';

const root = dirname(fileURLToPath(import.meta.url));
const home = process.env.AGENT_OFFICE_HOME ?? join(homedir(), '.config/agent-office');

function hubPort(): number {
  try {
    const port = Number(readFileSync(join(home, 'port'), 'utf8').trim());
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch {}
  return 4747;
}

const hub = `http://127.0.0.1:${hubPort()}`;

function officePanel(): Plugin {
  return {
    name: 'office-panel',
    apply: 'serve',
    transformIndexHtml(html) {
      let key = '';
      try {
        key = readFileSync(join(home, 'key'), 'utf8').trim();
      } catch {
        return html;
      }
      if (!key) return html;
      const literal = JSON.stringify(mintPanelToken(key, Date.now())).replace(/</g, '\\u003c');
      return html.replace('</head>', `<script>window.__OFFICE_PANEL__=${literal}</script></head>`);
    },
  };
}

function customModels(): Plugin {
  return {
    name: 'office-custom-models',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/assets/characters/custom/index.json', (_req, res) => {
        let names: string[] = [];
        try {
          names = readdirSync(join(root, 'public', 'assets', 'characters', 'custom'))
            .filter((name) => /^[A-Za-z0-9_-]+\.glb$/.test(name))
            .sort();
        } catch {}
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(names));
      });
    },
  };
}

export default defineConfig({
  root,
  plugins: [officePanel(), customModels()],
  build: {
    outDir: '../hub/public',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: hub, changeOrigin: true },
      '/live': { target: hub.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
    },
  },
});
