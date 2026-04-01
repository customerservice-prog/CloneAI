import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRootGet,
  normalizePublicAppBase,
  redirectTargetWhenFrontendHostHitsApi,
  apexMismatchRedirectTarget,
  frontendMarketingHostMatches,
  acceptLooksLikeBrowserNavigation,
  browserSafeFrontendRedirectTarget,
  bareApexWwwTryUrl,
  formatRootLandingHtml,
  hostInCorsOriginsList,
  mergeStaticEnvWithSiteDefaults,
  redirectKnownMarketingApexToStatic,
} from '../rootRedirect.js';

function mockReq({
  protocol = 'https',
  hostname = 'example.com',
  hostHeader,
  accept = 'text/html',
  query,
}) {
  return {
    protocol,
    hostname,
    query: query ?? {},
    get(name) {
      if (name === 'host') return hostHeader ?? hostname;
      if (name === 'accept') return accept;
      return undefined;
    },
  };
}

test('normalizePublicAppBase trims and adds https', () => {
  assert.equal(normalizePublicAppBase('app.onrender.com'), 'https://app.onrender.com');
  assert.equal(normalizePublicAppBase('https://app.onrender.com/'), 'https://app.onrender.com');
  assert.equal(normalizePublicAppBase(''), '');
});

test('acceptLooksLikeBrowserNavigation', () => {
  assert.equal(acceptLooksLikeBrowserNavigation('text/html'), true);
  assert.equal(acceptLooksLikeBrowserNavigation('*/*'), true);
  assert.equal(acceptLooksLikeBrowserNavigation('application/json'), false);
  assert.equal(acceptLooksLikeBrowserNavigation(''), true);
});

test('frontendMarketingHostMatches: www in FRONTEND_URL matches bare apex request', () => {
  assert.equal(frontendMarketingHostMatches('siteclonerpro.com', 'https://www.siteclonerpro.com'), true);
  assert.equal(frontendMarketingHostMatches('www.siteclonerpro.com', 'https://siteclonerpro.com'), true);
  assert.equal(frontendMarketingHostMatches('other.com', 'https://siteclonerpro.com'), false);
});

test('STATIC_APP_URL: apex request redirects when FRONTEND_URL uses www', () => {
  const req = mockReq({
    protocol: 'https',
    hostname: 'siteclonerpro.com',
    accept: 'text/html',
  });
  const r = resolveRootGet(req, {
    frontendUrl: 'https://www.siteclonerpro.com',
    staticAppUrl: 'https://cloneai-web-abc.onrender.com',
  });
  assert.equal(r.kind, 'redirect');
  assert.equal(r.location, 'https://cloneai-web-abc.onrender.com/');
});

test('STATIC_APP_URL: same host as FRONTEND_URL redirects to static origin', () => {
  const req = mockReq({
    protocol: 'https',
    hostname: 'siteclonerpro.com',
    accept: 'text/html',
  });
  const r = resolveRootGet(req, {
    frontendUrl: 'https://siteclonerpro.com',
    staticAppUrl: 'https://cloneai-web-abc.onrender.com',
  });
  assert.equal(r.kind, 'redirect');
  assert.equal(r.status, 302);
  assert.equal(r.location, 'https://cloneai-web-abc.onrender.com/');
});

test('STATIC_APP_URL: no redirect when request already on static host', () => {
  const req = mockReq({
    protocol: 'https',
    hostname: 'cloneai-web-abc.onrender.com',
    accept: 'text/html',
  });
  const loc = redirectTargetWhenFrontendHostHitsApi(
    req,
    'https://siteclonerpro.com',
    'https://cloneai-web-abc.onrender.com'
  );
  assert.equal(loc, null);
});

test('APEX_STATIC_FALLBACK_URL: apex host hits API → 302 to www (or other host)', () => {
  const req = mockReq({
    hostname: 'siteclonerpro.com',
    accept: 'text/html',
  });
  const r = resolveRootGet(req, {
    frontendUrl: 'https://siteclonerpro.com',
    staticAppUrl: '',
    apexStaticFallbackUrl: 'https://www.siteclonerpro.com',
  });
  assert.equal(r.kind, 'redirect');
  assert.equal(r.status, 302);
  assert.equal(r.location, 'https://www.siteclonerpro.com/');
});

test('apexMismatchRedirectTarget null when fallback host same as request', () => {
  const req = mockReq({ hostname: 'siteclonerpro.com', accept: 'text/html' });
  assert.equal(
    apexMismatchRedirectTarget(req, 'https://siteclonerpro.com', 'https://siteclonerpro.com'),
    null
  );
});

test('misconfigured apex + no STATIC_APP_URL → json with hint', () => {
  const req = mockReq({
    hostname: 'siteclonerpro.com',
    accept: 'text/html',
  });
  const r = resolveRootGet(req, {
    frontendUrl: 'https://siteclonerpro.com',
    staticAppUrl: '',
  });
  assert.equal(r.kind, 'json');
  assert.match(r.hint || '', /STATIC_APP_URL/);
});

test('different API host + FRONTEND_URL → 301 to FRONTEND_URL', () => {
  const req = mockReq({
    hostname: 'cloneai-mf0z.onrender.com',
    accept: 'text/html',
  });
  const r = resolveRootGet(req, {
    frontendUrl: 'https://siteclonerpro.com',
    staticAppUrl: '',
  });
  assert.equal(r.kind, 'redirect');
  assert.equal(r.status, 301);
  assert.equal(r.location, 'https://siteclonerpro.com/');
});

test('?format=json on API host skips FRONTEND_URL redirect (JSON client)', () => {
  const req = mockReq({
    hostname: 'cloneai-mf0z.onrender.com',
    accept: '*/*',
    query: { format: 'json' },
  });
  const r = resolveRootGet(req, {
    frontendUrl: 'https://siteclonerpro.com',
    staticAppUrl: '',
  });
  assert.equal(r.kind, 'json');
  assert.equal(r.hint, undefined);
});

test('application/json Accept → no redirect, no hint pressure', () => {
  const req = mockReq({
    hostname: 'siteclonerpro.com',
    accept: 'application/json',
  });
  const r = resolveRootGet(req, {
    frontendUrl: 'https://siteclonerpro.com',
    staticAppUrl: 'https://web.onrender.com',
  });
  assert.equal(r.kind, 'json');
  assert.equal(r.hint, undefined);
});

test('browserSafeFrontendRedirectTarget null when already on front origin', () => {
  const req = mockReq({ hostname: 'site.com', accept: 'text/html' });
  assert.equal(browserSafeFrontendRedirectTarget(req, 'https://site.com'), null);
});

test('bareApexWwwTryUrl: bare domain only', () => {
  assert.equal(bareApexWwwTryUrl('siteclonerpro.com'), 'https://www.siteclonerpro.com/');
  assert.equal(bareApexWwwTryUrl('www.siteclonerpro.com'), '');
  assert.equal(bareApexWwwTryUrl('api.siteclonerpro.com'), '');
  assert.equal(bareApexWwwTryUrl('example.co.uk'), '');
});

test('formatRootLandingHtml: misconfigured apex includes www try and /?format=json link', () => {
  const html = formatRootLandingHtml({
    hint: 'This hostname matches FRONTEND_URL, but this response is from the API.',
    frontendUrl: 'https://siteclonerpro.com',
    staticAppUrl: '',
    apexStaticFallbackUrl: '',
    requestHost: 'siteclonerpro.com',
  });
  assert.match(html, /https:\/\/www\.siteclonerpro\.com\//);
  assert.match(html, /\?format=json/);
});

test('hostInCorsOriginsList parses comma-separated origins', () => {
  assert.equal(
    hostInCorsOriginsList(
      'siteclonerpro.com',
      'https://siteclonerpro.com,https://www.siteclonerpro.com,https://cloneai-web.onrender.com'
    ),
    true
  );
  assert.equal(hostInCorsOriginsList('evil.com', 'https://siteclonerpro.com'), false);
});

test('CORS + STATIC_APP_URL: redirect apex when FRONTEND_URL does not match host', () => {
  const req = mockReq({
    hostname: 'siteclonerpro.com',
    accept: 'text/html',
  });
  const r = resolveRootGet(req, {
    frontendUrl: 'https://wrong-example.com',
    staticAppUrl: 'https://cloneai-web-abc.onrender.com',
    apexStaticFallbackUrl: '',
    corsOrigins: 'https://siteclonerpro.com,https://www.siteclonerpro.com',
  });
  assert.equal(r.kind, 'redirect');
  assert.equal(r.location, 'https://cloneai-web-abc.onrender.com/');
});

test('APEX_STATIC_FALLBACK to static host redirects when STATIC_APP_URL unset (marketing match)', () => {
  const req = mockReq({
    hostname: 'siteclonerpro.com',
    accept: 'text/html',
  });
  const r = resolveRootGet(req, {
    frontendUrl: 'https://siteclonerpro.com',
    staticAppUrl: '',
    apexStaticFallbackUrl: 'https://cloneai-web-xyz.onrender.com',
    corsOrigins: '',
  });
  assert.equal(r.kind, 'redirect');
  assert.equal(r.status, 302);
  assert.equal(r.location, 'https://cloneai-web-xyz.onrender.com/');
});

test('mergeStaticEnvWithSiteDefaults fills static for siteclonerpro.com', () => {
  const m = mergeStaticEnvWithSiteDefaults('siteclonerpro.com', '', '');
  assert.equal(m.staticAppUrl, 'https://cloneai-web.onrender.com');
  assert.equal(m.apexStaticFallbackUrl, 'https://cloneai-web.onrender.com');
});

test('mergeStaticEnvWithSiteDefaults leaves other hosts unchanged when env empty', () => {
  const m = mergeStaticEnvWithSiteDefaults('other.com', '', '');
  assert.equal(m.staticAppUrl, '');
  assert.equal(m.apexStaticFallbackUrl, '');
});

test('known marketing apex redirects with static base even if FRONTEND_URL empty', () => {
  const req = mockReq({
    hostname: 'siteclonerpro.com',
    accept: 'text/html',
  });
  const r = resolveRootGet(req, {
    frontendUrl: '',
    staticAppUrl: 'https://cloneai-web-abc.onrender.com',
    apexStaticFallbackUrl: '',
    corsOrigins: '',
  });
  assert.equal(r.kind, 'redirect');
  assert.equal(r.location, 'https://cloneai-web-abc.onrender.com/');
});

test('redirectKnownMarketingApexToStatic null for non-marketing host', () => {
  const req = mockReq({ hostname: 'api.other.com', accept: 'text/html' });
  assert.equal(redirectKnownMarketingApexToStatic(req, 'https://app.example.com'), null);
});
