import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  promoMatchesRequest,
  configuredPromoCode,
  submittedPromoCode,
  ownerTokenMatchesRequest,
  privilegedAnalyzeBypass,
} from '../promoCode.js';

function mockReq({ header, body = {} } = {}) {
  return {
    get(name) {
      if (!header) return undefined;
      const k = String(name).toLowerCase();
      const h = Object.fromEntries(
        Object.entries(header).map(([a, b]) => [String(a).toLowerCase(), b])
      );
      return h[k];
    },
    body,
  };
}

test('no promo configured → never matches', () => {
  const prev = process.env.CLONEAI_PROMO_CODE;
  delete process.env.CLONEAI_PROMO_CODE;
  assert.equal(configuredPromoCode(), '');
  assert.equal(promoMatchesRequest(mockReq({ body: { promoCode: 'anything' } })), false);
  if (prev !== undefined) process.env.CLONEAI_PROMO_CODE = prev;
});

test('promo matches body field (constant-time path)', () => {
  const prev = process.env.CLONEAI_PROMO_CODE;
  const secret = 'OwnerPromoTestSecret999';
  process.env.CLONEAI_PROMO_CODE = secret;
  assert.equal(promoMatchesRequest(mockReq({ body: { promoCode: secret } })), true);
  assert.equal(promoMatchesRequest(mockReq({ body: { promoCode: `${secret}x` } })), false);
  assert.equal(promoMatchesRequest(mockReq({ body: { promoCode: ` ${secret} ` } })), false);
  if (prev !== undefined) process.env.CLONEAI_PROMO_CODE = prev;
  else delete process.env.CLONEAI_PROMO_CODE;
});

test('promo matches header when body empty', () => {
  const prev = process.env.CLONEAI_PROMO_CODE;
  process.env.CLONEAI_PROMO_CODE = 'abc123';
  assert.equal(
    promoMatchesRequest(
      mockReq({ header: { 'x-cloneai-promo-code': 'abc123' }, body: {} })
    ),
    true
  );
  assert.equal(submittedPromoCode(mockReq({ header: { 'X-CloneAI-Promo-Code': 'abc123' } })), 'abc123');
  if (prev !== undefined) process.env.CLONEAI_PROMO_CODE = prev;
  else delete process.env.CLONEAI_PROMO_CODE;
});

test('owner token without env → no match', () => {
  const prev = process.env.CLONEAI_OWNER_TOKEN;
  delete process.env.CLONEAI_OWNER_TOKEN;
  assert.equal(
    ownerTokenMatchesRequest(mockReq({ header: { 'x-cloneai-owner-token': 'x' } })),
    false
  );
  if (prev !== undefined) process.env.CLONEAI_OWNER_TOKEN = prev;
});

test('owner token header enables privileged bypass without promo body', () => {
  const prevP = process.env.CLONEAI_PROMO_CODE;
  const prevT = process.env.CLONEAI_OWNER_TOKEN;
  delete process.env.CLONEAI_PROMO_CODE;
  process.env.CLONEAI_OWNER_TOKEN = 'OwnTokTest';
  const req = mockReq({ header: { 'x-cloneai-owner-token': 'OwnTokTest' }, body: {} });
  assert.equal(promoMatchesRequest(req), false);
  assert.equal(ownerTokenMatchesRequest(req), true);
  assert.equal(privilegedAnalyzeBypass(req), true);
  if (prevP !== undefined) process.env.CLONEAI_PROMO_CODE = prevP;
  else delete process.env.CLONEAI_PROMO_CODE;
  if (prevT !== undefined) process.env.CLONEAI_OWNER_TOKEN = prevT;
  else delete process.env.CLONEAI_OWNER_TOKEN;
});

test('promo code also enables privileged bypass', () => {
  const prevP = process.env.CLONEAI_PROMO_CODE;
  const prevT = process.env.CLONEAI_OWNER_TOKEN;
  process.env.CLONEAI_PROMO_CODE = 'PromoPrivileged123';
  delete process.env.CLONEAI_OWNER_TOKEN;
  const req = mockReq({ header: { 'x-cloneai-promo-code': 'PromoPrivileged123' }, body: {} });
  assert.equal(promoMatchesRequest(req), true);
  assert.equal(privilegedAnalyzeBypass(req), true);
  if (prevP !== undefined) process.env.CLONEAI_PROMO_CODE = prevP;
  else delete process.env.CLONEAI_PROMO_CODE;
  if (prevT !== undefined) process.env.CLONEAI_OWNER_TOKEN = prevT;
});
