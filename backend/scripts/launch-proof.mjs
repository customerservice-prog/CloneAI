#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..');

const steps = [
  {
    label: 'launch-check',
    command: ['node', ['scripts/launch-check.mjs']],
  },
  {
    label: 'api-extraction-proof',
    command: [
      'node',
      ['scripts/live-extraction-verify.mjs', process.env.LAUNCH_PROOF_TARGET_URL || 'https://www.python.org/about/', 'shallow', 'images', 'full_harvest'],
    ],
  },
  {
    label: 'browser-proof',
    command: [
      'node',
      ['scripts/verify-browser-extraction.mjs', process.env.BROWSER_VERIFY_URL || 'http://127.0.0.1:3050', process.env.LAUNCH_PROOF_TARGET_URL || 'https://www.python.org/about/'],
    ],
  },
];

let failed = false;
for (const step of steps) {
  console.log(`\n== ${step.label} ==`);
  const [cmd, args] = step.command;
  const run = spawnSync(cmd, args, {
    cwd: backendRoot,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if ((run.status || 0) !== 0) {
    failed = true;
    break;
  }
}

process.exit(failed ? 1 : 0);
