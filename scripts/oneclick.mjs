/**
 * Single entry: installs deps, Playwright, full verify, 1k harvest smoke.
 * Run from Cursor/VS Code: green Play ▶ "CloneAI: one-click verify", or `npm run oneclick`.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(label, npmArgs) {
  console.log(`\n━━ ${label} ━━\n`);
  const result = spawnSync(npmCmd, npmArgs, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('Install backend dependencies', ['install', '--prefix', 'backend']);
run('Install frontend dependencies', ['install', '--prefix', 'frontend']);
run('Playwright Chromium (snapshots)', ['run', 'playwright:install', '--prefix', 'backend']);
run('Backend tests + frontend production build', ['run', 'verify']);
run('Network: 1000+ image harvest + ZIP', ['run', 'verify-harvest-1k', '--prefix', 'backend']);

console.log('\nCloneAI one-click finished successfully.\n');
