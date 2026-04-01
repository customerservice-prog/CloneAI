import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanHtmlForModel } from '../htmlCleanForModel.js';
import { isSkippableCrawlPath } from '../crawlSite.js';
import {
  maxCrawlPagesForRun,
  crawlMaxPagesEnvCap,
  powerCrawlPageCap,
  crawlPageCapForRequest,
} from '../crawlLimits.js';
import { PLANS } from '../billingService.js';
import { estimateOpenAiUsd } from '../aiCostEstimate.js';

test('cleanHtmlForModel removes scripts and caps length', () => {
  const raw = `<html><head><style>.x{color:red}</style></head><body>
  <script>alert(1)</script>
  <div data-track="1" aria-label="x" onclick="evil()">Hi</div>
  </body></html>`;
  const out = cleanHtmlForModel(raw, { maxChars: 5000 });
  assert.match(out, /Hi/);
  assert.equal(/<script/i.test(out), false);
  assert.equal(out.includes('alert'), false);
  assert.equal(out.includes('data-track'), false);
  assert.equal(out.includes('onclick'), false);
});

test('cleanHtmlForModel preserves data-src for lazy images', () => {
  const raw = '<img src="a.png" data-src="b.png" data-foo="bar" alt="x"/>';
  const out = cleanHtmlForModel(raw, { maxChars: 2000 });
  assert.match(out, /data-src/);
  assert.doesNotMatch(out, /data-foo/);
});

test('isSkippableCrawlPath skips boilerplate routes', () => {
  assert.equal(isSkippableCrawlPath('/login'), true);
  assert.equal(isSkippableCrawlPath('/privacy-policy'), true);
  assert.equal(isSkippableCrawlPath('/terms'), true);
  assert.equal(isSkippableCrawlPath('/wp-admin'), true);
  assert.equal(isSkippableCrawlPath('/products/shoes'), false);
  assert.equal(isSkippableCrawlPath('/'), false);
});

test('maxCrawlPagesForRun enforces plan caps', () => {
  assert.equal(maxCrawlPagesForRun(PLANS.FREE, 'homepage'), 1);
  assert.equal(maxCrawlPagesForRun(PLANS.FREE, 'shallow'), 1);
  assert.equal(maxCrawlPagesForRun(PLANS.STARTER, 'shallow'), Math.min(25, crawlMaxPagesEnvCap()));
  assert.equal(maxCrawlPagesForRun(PLANS.PRO, 'deep'), crawlMaxPagesEnvCap());
  assert.equal(maxCrawlPagesForRun(PLANS.POWER, 'deep'), powerCrawlPageCap());
  assert.ok(crawlMaxPagesEnvCap() <= 500);
  assert.ok(powerCrawlPageCap() <= 600);
});

test('crawlPageCapForRequest: promo owner >= power deep', () => {
  const powerDeep = maxCrawlPagesForRun(PLANS.POWER, 'deep');
  const promoDeep = crawlPageCapForRequest({
    plan: PLANS.POWER,
    depth: 'deep',
    promoOwner: true,
  });
  assert.ok(promoDeep >= powerDeep);
  assert.ok(promoDeep <= 200_000);
  assert.equal(
    crawlPageCapForRequest({ plan: PLANS.FREE, depth: 'homepage', promoOwner: true }),
    1
  );
});

test('estimateOpenAiUsd is non-negative', () => {
  const v = estimateOpenAiUsd('gpt-4o', 1000, 500);
  assert.ok(v >= 0);
  assert.ok(Number.isFinite(v));
});
