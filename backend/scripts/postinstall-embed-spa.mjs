import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendDir, '..');
const frontendPkg = path.join(repoRoot, 'frontend', 'package.json');
const publishScript = path.join(repoRoot, 'scripts', 'publish-spa-to-backend.mjs');

if (!existsSync(frontendPkg) || !existsSync(publishScript)) {
  console.log('[postinstall-embed-spa] Skipping SPA publish; frontend sources not present in this checkout.');
  process.exit(0);
}

const result = spawnSync(process.execPath, [publishScript], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
