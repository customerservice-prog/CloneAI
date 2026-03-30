import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode, command }) => {
  const root = path.resolve(__dirname);
  const env = loadEnv(mode, root, 'VITE_');
  const apiOrigin = (env.VITE_API_URL || '').trim();
  const escapedForMeta = apiOrigin
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');

  return {
    root,
    server: {
      port: 5173,
      strictPort: false,
    },
    plugins: [
      {
        name: 'cloneai-api-meta',
        transformIndexHtml(html) {
          if (!apiOrigin) return html;
          return html.replace(
            /(<meta\s+name="cloneai-api-origin"\s+content=")[^"]*(")/i,
            `$1${escapedForMeta}$2`
          );
        },
      },
      {
        name: 'cloneai-require-api-url-prod',
        configResolved(config) {
          if (command !== 'build' || config.mode !== 'production') return;
          const prodEnv = loadEnv('production', config.root, 'VITE_');
          const v = (prodEnv.VITE_API_URL || '').trim();
          if (!v) {
            throw new Error(
              'Production build requires VITE_API_URL (set in Render for cloneai-web, or in frontend/.env.production).'
            );
          }
          if (!/^https:\/\//i.test(v)) {
            throw new Error('VITE_API_URL must start with https:// for production builds.');
          }
        },
      },
    ],
  };
});
