import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectImageUrls,
  collectStylesheetHrefs,
  extractImageUrlsFromCss,
  extractImportUrlsFromCss,
  normalizeHarvestUrlKey,
  dedupeHarvestUrls,
  imageBytesFingerprint,
} from '../imageHarvest.js';

test('collectImageUrls finds imgs after 120kB of preamble (full-page HTML)', () => {
  const pad = 'x'.repeat(120_000);
  const html = `${pad}<img src="/late.png" alt="late" />`;
  const urls = collectImageUrls(html, 'https://example.com/products/');
  assert.ok(urls.some((u) => u.endsWith('/late.png')), `expected late.png in ${urls.join(',')}`);
});

test('collectImageUrls picks data-srcset and loose CDN URLs', () => {
  const html = `
    <img data-srcset="/a.webp 1x, /b.webp 2x" src="data:," />
    <script type="application/json">{"thumb":"https://cdn.example.com/p/x.jpg?q=1"}</script>
  `;
  const urls = collectImageUrls(html, 'https://shop.example/');
  assert.ok(urls.some((u) => u.includes('cdn.example.com/p/x.jpg')));
  assert.ok(urls.some((u) => u.includes('/b.webp')));
});

test('collectImageUrls finds url() inside style tags', () => {
  const html = '<style>.hero{background-image:url(/tile.png)}</style>';
  const urls = collectImageUrls(html, 'https://x.example/');
  assert.ok(urls.some((u) => u.includes('/tile.png')));
});

test('collectStylesheetHrefs and extractImageUrlsFromCss cover linked CSS', () => {
  const html = '<link rel="stylesheet" href="/assets/app.css?v=1">';
  const sheets = collectStylesheetHrefs(html, 'https://cdn.example/site/page');
  assert.ok(sheets.some((u) => u.includes('/assets/app.css')));
  const css = '.x{background:url(../img/banner.webp)}';
  const fromCss = extractImageUrlsFromCss(css, 'https://cdn.example/assets/app.css');
  assert.ok(fromCss.some((u) => u.includes('/img/banner.webp')));
});

test('extractImportUrlsFromCss finds chained stylesheets', () => {
  const css = '@import url("/fonts/extra.css"); body{}';
  const im = extractImportUrlsFromCss(css, 'https://x.example/main.css');
  assert.ok(im.some((u) => u.includes('/fonts/extra.css')));
});

test('collectImageUrls finds SVG image href', () => {
  const html = '<svg><image href="/icons/logo.svg" width="10" height="10"/></svg>';
  const urls = collectImageUrls(html, 'https://app.example/');
  assert.ok(urls.some((u) => u.includes('/icons/logo.svg')));
});

test('normalizeHarvestUrlKey strips tracking params; dedupeHarvestUrls merges', () => {
  const a = 'https://cdn.example/i.jpg?utm_source=x';
  const b = 'https://cdn.example/i.jpg?utm_medium=y';
  assert.equal(normalizeHarvestUrlKey(a), normalizeHarvestUrlKey(b));
  const out = dedupeHarvestUrls([a, b, 'https://other/z.png']);
  assert.equal(out.length, 2);
});

test('imageBytesFingerprint is stable for identical buffers', () => {
  const a = Buffer.from([0, 1, 2, 255]);
  const b = Buffer.from([0, 1, 2, 255]);
  assert.equal(imageBytesFingerprint(a), imageBytesFingerprint(b));
  assert.notEqual(imageBytesFingerprint(a), imageBytesFingerprint(Buffer.from([1])));
});
