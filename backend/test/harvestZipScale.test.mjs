import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { zipImageEntries, fetchHarvestedImages } from '../imageHarvest.js';

const TARGET = 1100;

test(`zipImageEntries holds ${TARGET}+ distinct image files and manifest`, async () => {
  const entries = Array.from({ length: TARGET }, (_, i) => ({
    name: `image-${String(i + 1).padStart(6, '0')}.png`,
    buffer: Buffer.from([i & 0xff, (i >> 8) & 0xff, (i >> 16) & 0xff]),
    sourceUrl: `https://example.com/asset/${i}.png`,
  }));
  const zipBuf = await zipImageEntries(entries);
  assert.ok(zipBuf && zipBuf.length > 1000, 'expected non-trivial zip');
  const z = new AdmZip(zipBuf);
  const files = z
    .getEntries()
    .filter((e) => !e.isDirectory)
    .map((e) => e.entryName.replace(/\\/g, '/'));
  const imgs = files.filter((n) => /^image-\d{6}\.png$/.test(n.split('/').pop() || ''));
  assert.equal(imgs.length, TARGET, `expected ${TARGET} image-*.png entries, got ${imgs.length}`);
  assert.ok(files.some((n) => n.endsWith('_urls.txt')), 'expected _urls.txt manifest');
});

test('fetchHarvestedImages runs end-to-end on a public image CDN', async () => {
  const fetched = await fetchHarvestedImages(['https://picsum.photos/id/237/5/5'], {
    concurrency: 2,
    timeoutMs: 25000,
    maxImages: 5,
  });
  assert.ok(fetched.entries.length >= 1, `expected at least one entry, got ${fetched.entries.length}; errors=${fetched.errors.join('; ')}`);
  assert.equal(fetched.contentDuplicatesSkipped, 0);
});
