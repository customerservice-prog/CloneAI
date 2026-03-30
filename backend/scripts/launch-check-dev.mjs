#!/usr/bin/env node
/**
 * Same as launch-check.mjs but forces NODE_ENV=development so global
 * NODE_ENV=production in your shell does not trigger CORS / prod-only rules.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, 'launch-check.mjs');
const env = { ...process.env, NODE_ENV: 'development' };
const r = spawnSync(process.execPath, [script, ...process.argv.slice(2)], {
  cwd: path.join(__dirname, '..'),
  env,
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
