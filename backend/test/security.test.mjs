import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertUrlSafeForServerFetch, isUnsafeIpLiteral } from '../ssrf.js';

test('SSRF: rejects 127.0.0.1 literal', async () => {
  const r = await assertUrlSafeForServerFetch('http://127.0.0.1:8080/');
  assert.equal(r.ok, false);
});

test('SSRF: rejects 10.0.0.1', async () => {
  const r = await assertUrlSafeForServerFetch('http://10.0.0.1/');
  assert.equal(r.ok, false);
});

test('SSRF: rejects 192.168.x', async () => {
  const r = await assertUrlSafeForServerFetch('https://192.168.1.1/');
  assert.equal(r.ok, false);
});

test('SSRF: rejects file://', async () => {
  const r = await assertUrlSafeForServerFetch('file:///etc/passwd');
  assert.equal(r.ok, false);
});

test('SSRF: rejects ftp://', async () => {
  const r = await assertUrlSafeForServerFetch('ftp://example.com/');
  assert.equal(r.ok, false);
});

test('SSRF: allows public example.com', async () => {
  const r = await assertUrlSafeForServerFetch('https://example.com/');
  assert.equal(r.ok, true);
});

test('isUnsafeIpLiteral: metadata hostnames as literals', () => {
  assert.equal(isUnsafeIpLiteral('127.0.0.1'), true);
  assert.equal(isUnsafeIpLiteral('8.8.8.8'), false);
});
