#!/usr/bin/env node
/**
 * Validate environment before production deploy (no secrets printed).
 * Usage (from backend/): node scripts/launch-check.mjs [--production]
 * Or: npm run launch-check --prefix backend
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..');

dotenv.config({ path: path.join(backendRoot, '.env') });

const wantProd =
  process.argv.includes('--production') || String(process.env.NODE_ENV).toLowerCase() === 'production';

const issues = [];

function need(name, ok) {
  if (!ok) issues.push(name);
}

const key = (process.env.OPENAI_API_KEY || '').trim();
need(
  'OPENAI_API_KEY (non-placeholder)',
  key.length > 0 && !key.startsWith('sk-your') && key !== 'your_key_here'
);

if (wantProd) {
  need(
    'CORS_ORIGINS (comma-separated frontend URLs, no *)',
    Boolean((process.env.CORS_ORIGINS || '').trim()) &&
      !(process.env.CORS_ORIGINS || '').includes('*')
  );
}

if (String(process.env.BILLING_ENABLED || '').toLowerCase() === 'true') {
  need('STRIPE_SECRET_KEY', Boolean((process.env.STRIPE_SECRET_KEY || '').trim()));
  need('STRIPE_WEBHOOK_SECRET', Boolean((process.env.STRIPE_WEBHOOK_SECRET || '').trim()));
  need('STRIPE_PRICE_STARTER', Boolean((process.env.STRIPE_PRICE_STARTER || '').trim()));
  need('STRIPE_PRICE_PRO', Boolean((process.env.STRIPE_PRICE_PRO || '').trim()));
  need('STRIPE_PRICE_EXTRA_RUN', Boolean((process.env.STRIPE_PRICE_EXTRA_RUN || '').trim()));
  need('FRONTEND_URL (Stripe success/cancel redirects)', Boolean((process.env.FRONTEND_URL || '').trim()));
}

const ingress = (process.env.CLONEAI_INGRESS_KEY || '').trim();
if (ingress) {
  need('CLONEAI_INGRESS_KEY length (use 16+ chars)', ingress.length >= 16);
}

if (issues.length) {
  console.error('Launch check failed — set or fix the following in backend/.env (or host env):\n');
  for (const i of issues) console.error(`  - ${i}`);
  console.error('\nCopy backend/.env.example → backend/.env and fill values.');
  console.error('For production-only rules, run: node scripts/launch-check.mjs --production\n');
  process.exit(1);
}

console.log('Launch check passed.');
if (wantProd) {
  console.log('(production rules: CORS + billing bundle verified)');
} else {
  console.log('(dev mode: set NODE_ENV=production or pass --production to enforce CORS/billing checks)');
}
process.exit(0);
