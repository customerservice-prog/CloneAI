#!/usr/bin/env node
/**
 * Optional smoke checks against deployed URLs (no secrets).
 *
 * Usage:
 *   CHECK_APEX=https://siteclonerpro.com CHECK_API=https://cloneai-mf0z.onrender.com node scripts/verify-live.mjs
 */
import https from 'node:https';
import { URL } from 'node:url';

const apex = (process.env.CHECK_APEX || process.argv[2] || '').trim().replace(/\/$/, '');
const api = (process.env.CHECK_API || process.argv[3] || '').trim().replace(/\/$/, '');

function get(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: `${u.pathname}${u.search}` || '/',
      method: 'GET',
      headers,
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

let failed = false;

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok  ${name}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL ${name}: ${e?.message || e}`);
  }
}

if (!apex && !api) {
  console.log('verify-live: set CHECK_APEX and/or CHECK_API (or pass URL args) to run remote checks.');
  process.exit(0);
}

if (api) {
  await check('API health', async () => {
    const { status, body } = await get(`${api}/api/health`);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const j = JSON.parse(body);
    if (j.status !== 'ok') throw new Error(`unexpected body ${body.slice(0, 200)}`);
  });
}

if (apex) {
  await check('Apex document response', async () => {
    const { status, headers, body } = await get(`${apex}/`, {
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0 (compatible; CloneAI-verify-live/1.0)',
    });
    const loc = headers.location;
    const ct = String(headers['content-type'] || '').toLowerCase();
    if (status === 302 || status === 301) {
      if (!loc) throw new Error('redirect without Location');
      console.log(`      → ${status} ${Array.isArray(loc) ? loc[0] : loc}`);
      return;
    }
    if (status === 200 && ct.includes('text/html')) {
      if (
        body.includes('<title>CloneAI API</title>') ||
        body.includes('This URL is the <strong>API</strong>')
      ) {
        throw new Error(
          'apex returned API landing HTML (not the SPA). Use repo-root build (backend/public/index.html), set STATIC_APP_URL + CORS on the API, or fix DNS — see render.yaml and docs/NAMECHEAP_RENDER.md'
        );
      }
      return;
    }
    if (status === 200 && ct.includes('application/json')) {
      throw new Error(
        'got JSON (API root). Set STATIC_APP_URL on the API or point DNS apex at cloneai-web — see docs/NAMECHEAP_RENDER.md'
      );
    }
    throw new Error(`unexpected ${status} content-type=${ct || '?'}`);
  });
}

process.exitCode = failed ? 1 : 0;
