/**
 * Launch smoke checks (no OpenAI key required).
 * Run: npm run smoke  (from backend/)
 * Optional: BASE_URL=http://127.0.0.1:3001 npm run smoke
 *
 * Requires NODE_ENV=development OR production with CORS_ORIGINS set (otherwise /api/analyze → 403).
 */
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const SMOKE_USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

async function req(method, path, { form, expectStatus, headers } = {}) {
  const url = `${BASE}${path}`;
  const init = { method };
  if (headers) init.headers = headers;
  if (form) {
    init.body = form;
  }
  const res = await fetch(url, init);
  const text = await res.text();
  if (expectStatus != null && res.status !== expectStatus) {
    throw new Error(`${method} ${path} expected ${expectStatus}, got ${res.status}: ${text.slice(0, 200)}`);
  }
  return { res, text };
}

let failed = false;
function ok(name) {
  console.log(`OK  ${name}`);
}
function bad(name, err) {
  console.error(`FAIL ${name}:`, err.message || err);
  failed = true;
}

async function main() {
  try {
    const h = await req('GET', '/api/health', { expectStatus: 200 });
    if (!h.text.includes('"ok"')) throw new Error('health body unexpected');
    ok('GET /api/health');

    const fd1 = new FormData();
    fd1.set('url', '');
    fd1.set('depth', 'homepage');
    fd1.set('options', '[]');
    fd1.set('hp', '');
    fd1.set('comparePair', '0');
    await req('POST', '/api/analyze', { form: fd1, expectStatus: 400 });
    ok('POST /api/analyze empty input → 400');

    const fd2 = new FormData();
    fd2.set('url', 'http://127.0.0.1/');
    fd2.set('depth', 'shallow');
    fd2.set('options', '[]');
    fd2.set('hp', '');
    fd2.set('comparePair', '0');
    await req('POST', '/api/analyze', {
      form: fd2,
      expectStatus: 400,
      headers: { 'X-CloneAI-User-Id': SMOKE_USER },
    });
    ok('POST /api/analyze SSRF 127.0.0.1 → 400');

    const fd3 = new FormData();
    fd3.set('url', 'https://example.com');
    fd3.set('depth', 'homepage');
    fd3.set('options', '[]');
    fd3.set('hp', 'x');
    fd3.set('comparePair', '0');
    await req('POST', '/api/analyze', {
      form: fd3,
      expectStatus: 400,
      headers: { 'X-CloneAI-User-Id': SMOKE_USER },
    });
    ok('POST /api/analyze honeypot → 400');
  } catch (e) {
    bad('smoke suite', e);
  }

  if (failed) {
    console.error('\nSmoke tests FAILED.');
    process.exit(1);
  }
  console.log('\nAll smoke checks passed.');
}

main();
