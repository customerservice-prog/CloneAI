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

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run('npm', ['ci'], fe);
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
