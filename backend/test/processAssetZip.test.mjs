import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { processSiteAssetZipBuffer } from '../processAssetZip.js';

test('processSiteAssetZipBuffer passthrough manifest txt and renames raster', async () => {
  const png = await sharp({
    create: {
      width: 32,
      height: 24,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  })
    .png()
    .toBuffer();

  const z = new AdmZip();
  z.addFile('_urls.txt', Buffer.from('snapshots/page-0.png\thttps://cdn.example.com/products/hero-shot.jpg\n', 'utf8'));
  z.addFile('snapshots/page-0.png', png);
  z.addFile('readme.txt', Buffer.from('hello', 'utf8'));
  const inBuf = z.toBuffer();

  const { buffer: outBuf, stats } = await processSiteAssetZipBuffer(inBuf, {
    skipHd: true,
    useAiPick: false,
    maxRasterImages: 50,
  });

  assert.equal(stats.hd, false);
  assert.equal(stats.aiNaming, false);
  const out = new AdmZip(outBuf);
  const names = new Set(out.getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName.replace(/\\/g, '/')));
  assert.ok(names.has('_urls.txt'));
  assert.ok(names.has('readme.txt'));
  const processed = [...names].find((n) => n.startsWith('processed/') && n.endsWith('.png'));
  assert.ok(processed, `expected processed/*.png in ${[...names].join(', ')}`);
});
