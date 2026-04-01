import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DEV_ORIGINS,
  isLocalDevBrowserOrigin,
  isServedFromSameOrigin,
  parseCorsOrigins,
  shouldAllowBrowserOrigin,
} from '../originPolicy.js';

function mockReq({
  protocol = 'https',
  host = 'siteclonerpro.com',
  forwardedHost = '',
  forwardedProto = '',
} = {}) {
  return {
    protocol,
    get(name) {
      if (name === 'host') return host;
      if (name === 'x-forwarded-host') return forwardedHost;
      if (name === 'x-forwarded-proto') return forwardedProto;
      return '';
    },
  };
}

test('parseCorsOrigins falls back to default dev origins outside production', () => {
  assert.deepEqual(parseCorsOrigins('', { isProd: false }), DEFAULT_DEV_ORIGINS);
});

test('isLocalDevBrowserOrigin detects localhost variants', () => {
  assert.equal(isLocalDevBrowserOrigin('http://localhost:5173'), true);
  assert.equal(isLocalDevBrowserOrigin('http://127.0.0.1:4173'), true);
  assert.equal(isLocalDevBrowserOrigin('https://siteclonerpro.com'), false);
});

test('isServedFromSameOrigin matches protocol and host', () => {
  assert.equal(
    isServedFromSameOrigin(mockReq({ protocol: 'https', host: 'siteclonerpro.com' }), 'https://siteclonerpro.com'),
    true
  );
  assert.equal(
    isServedFromSameOrigin(mockReq({ protocol: 'https', host: 'siteclonerpro.com' }), 'https://other.com'),
    false
  );
});

test('shouldAllowBrowserOrigin accepts same-origin SPA requests in production', () => {
  const allowed = shouldAllowBrowserOrigin({
    isProd: true,
    serveSpa: true,
    origin: 'http://127.0.0.1:3050',
    corsOrigins: [],
    reqLike: mockReq({ protocol: 'http', host: '127.0.0.1:3050' }),
  });
  assert.equal(allowed, true);
});

test('shouldAllowBrowserOrigin rejects mismatched origins in production when not same-origin', () => {
  const allowed = shouldAllowBrowserOrigin({
    isProd: true,
    serveSpa: false,
    origin: 'https://evil.com',
    corsOrigins: ['https://siteclonerpro.com'],
    reqLike: mockReq(),
  });
  assert.equal(allowed, false);
});
