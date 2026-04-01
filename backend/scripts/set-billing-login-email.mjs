/**
 * One-off: set a user's login email in billing.json (email/password sign-in).
 *
 * Default billing file: <repo>/data/billing.json (override with BILLING_DATA_PATH).
 *
 * Examples:
 *   node backend/scripts/set-billing-login-email.mjs --from bryanp15 --to you@gmail.com
 *   BILLING_DATA_PATH=/data/billing.json node backend/scripts/set-billing-login-email.mjs --from bryanp15 --to you@gmail.com
 *
 * Optional: --user-id <uuid> when loginEmail was never set — sets loginEmail on that row.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadState, saveState } from '../billingStore.js';
import { applyLoginEmailRewriteSync } from '../billingService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRootData = path.resolve(__dirname, '..', '..', 'data', 'billing.json');

function argVal(name) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return '';
  return String(process.argv[i + 1] || '').trim();
}

const fromRaw = argVal('--from');
const toRaw = argVal('--to');
const userIdArg = argVal('--user-id');
const dryRun = process.argv.includes('--dry-run');

if (!toRaw) {
  console.error('Usage: node backend/scripts/set-billing-login-email.mjs --to <email> [--from <oldLoginOrEmail>] [--user-id <uuid>] [--dry-run]');
  process.exit(1);
}

if (!process.env.BILLING_DATA_PATH) {
  process.env.BILLING_DATA_PATH = repoRootData;
}

if (!fromRaw && !userIdArg) {
  console.error('Provide --from <currentLoginEmail> or --user-id <uuid> from localStorage cloneai_user_id.');
  process.exit(1);
}

const state = loadState();
const work = dryRun ? JSON.parse(JSON.stringify(state)) : state;
const out = applyLoginEmailRewriteSync(work, {
  fromRaw,
  toRaw,
  userIdRaw: userIdArg,
});

if (!out.ok) {
  console.error(out.error);
  process.exit(1);
}

if (dryRun) {
  const next = work.users[out.userId].loginEmail;
  console.log(`Would set user ${out.userId} loginEmail: "${out.previous}" -> "${next}"`);
  process.exit(0);
}

saveState(state);
const u = state.users[out.userId];
console.log(`Updated user ${out.userId}: loginEmail is now ${u.loginEmail} (was: ${JSON.stringify(out.previous || null)}).`);
if (!u.passwordHash) {
  console.warn('This user has no passwordHash — use POST /api/billing/claim-account after subscription checkout to set a password.');
}
