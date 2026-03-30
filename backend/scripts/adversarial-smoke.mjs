#!/usr/bin/env node
/**
 * Attempt common bypasses against a running local API.
 * Run: NODE_ENV=development npm start (backend) then: BASE_URL=... npm run adversarial --prefix backend
 *
 * If NODE_ENV=production and CORS_ORIGINS is empty, POST /api/analyze returns 403 Forbidden
 * (by design). Use development or set CORS_ORIGINS + matching Origin header for scripted tests.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const INGRESS = process.env.CLONEAI_INGRESS_KEY?.trim();
const BILLING = String(process.env.BILLING_ENABLED || '').toLowerCase() === 'true';
const VALID_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const BAD_UUID = 'not-a-real-uuid';

function baseHeaders(over = {}) {
  const h = { ...over };
  if (INGRESS) h['X-CloneAI-Key'] = INGRESS;
  return h;
}

async function postAnalyze(form, headers) {
  return fetch(`${BASE}/api/analyze`, { method: 'POST', body: form, headers });
}

async function postJson(path, body, headers = {}) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...baseHeaders(headers) },
    body: JSON.stringify(body),
  });
}

let failed = false;
function pass(name) {
  console.log(`OK   ${name}`);
}
function fail(name, detail) {
  console.error(`FAIL ${name}: ${detail}`);
  failed = true;
}

function form(url, depth, extra = {}) {
  const fd = new FormData();
  fd.set('url', url);
  fd.set('depth', depth);
  fd.set('options', '[]');
  fd.set('hp', '');
  fd.set('comparePair', '0');
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

async function main() {
  console.log(`Base ${BASE} | billing=${BILLING} | ingress=${INGRESS ? 'on' : 'off'}\n`);

  try {
    const h = await fetch(`${BASE}/api/health`);
    if (!h.ok) fail('GET /api/health', `status ${h.status}`);
    else pass('GET /api/health');
  } catch (e) {
    fail('GET /api/health', e.message);
    console.error('\nStart the API: cd backend && npm start');
    process.exit(1);
  }

  if (INGRESS) {
    const fd = form('https://example.com', 'homepage');
    const r = await postAnalyze(fd, { 'X-CloneAI-Key': 'wrong-secret-xxxxxxxx', 'X-CloneAI-User-Id': VALID_UUID });
    if (r.status !== 403) fail('wrong X-CloneAI-Key', `expected 403, got ${r.status}`);
    else pass('wrong X-CloneAI-Key → 403');
  }

  if (BILLING) {
    const fd = form('https://example.com', 'homepage');
    const r = await postAnalyze(fd, baseHeaders({}));
    const j = await r.json().catch(() => ({}));
    if (r.status !== 400 || j.error !== 'MISSING_USER_ID')
      fail('analyze without X-CloneAI-User-Id', `got ${r.status} ${JSON.stringify(j).slice(0, 120)}`);
    else pass('analyze without user id → 400 MISSING_USER_ID');

    const fd2 = form('https://example.com', 'homepage');
    const r2 = await postAnalyze(fd2, baseHeaders({ 'X-CloneAI-User-Id': BAD_UUID }));
    const j2 = await r2.json().catch(() => ({}));
    if (r2.status !== 400 || j2.error !== 'MISSING_USER_ID')
      fail('analyze with invalid UUID', `expected 400 MISSING_USER_ID, got ${r2.status}`);
    else pass('invalid X-CloneAI-User-Id → 400');

    const fd3 = form('https://example.com', 'deep', { promoCode: 'totally-wrong-guess-12345' });
    const r3 = await postAnalyze(fd3, baseHeaders({ 'X-CloneAI-User-Id': VALID_UUID }));
    if (r3.status === 200) {
      fail('wrong promo + free user deep crawl', 'got 200 — should be blocked or downgraded');
    } else if (r3.status === 403) {
      const t3 = await r3.text();
      if (t3.includes('FEATURE_LOCKED') || t3.includes('LIMIT_REACHED')) pass('wrong promo cannot unlock deep (403)');
      else pass('wrong promo + deep → 403 (blocked)');
    } else {
      pass(`wrong promo + deep → ${r3.status} (non-success)`);
    }
  } else {
    pass('billing off — skip user-id / promo bypass checks');
  }

  const st = await fetch(`${BASE}/api/billing/status`, { headers: baseHeaders({ 'X-CloneAI-User-Id': VALID_UUID }) });
  if (st.status === 403 && INGRESS) {
    const st2 = await fetch(`${BASE}/api/billing/status`, {
      headers: { 'X-CloneAI-User-Id': VALID_UUID, 'X-CloneAI-Key': 'nope' },
    });
    if (st2.status !== 403) fail('billing/status wrong key', `got ${st2.status}`);
    else pass('billing/status wrong ingress key → 403');
  }

  const co = await postJson('/api/billing/checkout', { product: 'pro' }, { 'X-CloneAI-User-Id': VALID_UUID });
  if (co.status === 503) {
    const j = await co.json().catch(() => ({}));
    if (String(j.error || '').toLowerCase().includes('not enabled') || String(j.error || '').includes('Stripe'))
      pass('checkout without billing/Stripe → 503 (no silent success)');
    else pass(`checkout → 503 (${JSON.stringify(j).slice(0, 80)})`);
  } else if (co.status === 403 && INGRESS) {
    pass('checkout response as expected (403 or redirect flow not tested here)');
  } else if (co.status === 200) {
    const j = await co.json().catch(() => ({}));
    if (j.url && String(j.url).includes('stripe.com')) pass('checkout returned Stripe URL (configure keys for real charge)');
    else fail('checkout 200 unexpected body', JSON.stringify(j).slice(0, 100));
  } else {
    pass(`checkout → ${co.status} (no live payment attempted)`);
  }

  const fd4 = form('https://example.com', 'homepage');
  const r4 = await postAnalyze(fd4, baseHeaders({ 'X-CloneAI-User-Id': VALID_UUID, Origin: 'https://evil.com' }));
  if (process.env.NODE_ENV === 'production' && process.env.CORS_ORIGINS && !process.env.RELAX_ANALYZE_ORIGIN_CHECK) {
    if (r4.status !== 403) fail('spoof Origin evil.com in prod', `got ${r4.status}`);
    else pass('evil Origin → 403 (prod)');
  } else {
    pass('Origin spoof check skipped (not production CORS mode in this process)');
  }

  if (failed) {
    console.error('\nadversarial-smoke FAILED');
    process.exit(1);
  }
  console.log('\nAll adversarial checks passed for this environment.');
  console.log('Note: No real card charge — use Stripe test mode + Dashboard to confirm checkout end-to-end.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
