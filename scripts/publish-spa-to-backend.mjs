/**
 * For Render "Native Node" (npm start in backend): build the Vite app and copy dist → backend/public
 * so server.js can serve the SPA (serveSpa === true). Docker deploys use repo-root Dockerfile instead.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fe = join(root, 'frontend');
const dist = join(fe, 'dist');
const pub = join(root, 'backend', 'public');
const frontendNodeModules = join(fe, 'node_modules');
const viteCli = join(frontendNodeModules, 'vite', 'bin', 'vite.js');

// Match Docker frontend-builder: one dashboard secret (CLONEAI_INGRESS_KEY) can bake X-CloneAI-Key into the SPA.
const ingress = (process.env.VITE_CLONEAI_KEY || process.env.CLONEAI_INGRESS_KEY || '').trim();
if (ingress) process.env.VITE_CLONEAI_KEY = ingress;

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (existsSync(viteCli)) {
  console.log('[publish-spa-to-backend] Reusing existing frontend/node_modules');
} else if (existsSync(frontendNodeModules)) {
  console.log('[publish-spa-to-backend] frontend/node_modules exists but is incomplete; refreshing dependencies');
  run('npm', ['install'], fe);
} else {
  run('npm', ['ci'], fe);
}
run('npm', ['run', 'build'], fe);

const indexHtml = join(dist, 'index.html');
if (!existsSync(indexHtml)) {
  console.error('[publish-spa-to-backend] Missing frontend/dist/index.html after build.');
  process.exit(1);
}

rmSync(pub, { recursive: true, force: true });
mkdirSync(pub, { recursive: true });
cpSync(dist, pub, { recursive: true });
console.log('[publish-spa-to-backend] OK → backend/public (SPA + API same service)');
