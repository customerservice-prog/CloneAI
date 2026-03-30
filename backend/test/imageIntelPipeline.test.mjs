import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  basenameFromSourceUrl,
  sanitizeFilenameBase,
  buildGroundedCandidates,
  assignUniqueGroundedName,
  enhanceImageHd,
} from '../imageIntelPipeline.js';
import sharp from 'sharp';

test('basenameFromSourceUrl decodes path', () => {
  assert.equal(
    basenameFromSourceUrl('https://cdn.example.com/foo/bar/hero%20image.jpg?v=1'),
    'hero image.jpg'
  );
});

test('sanitizeFilenameBase strips unsafe chars', () => {
  assert.equal(sanitizeFilenameBase('  ../evil  '), 'evil');
  assert.ok(sanitizeFilenameBase('a'.repeat(120)).length <= 96);
});

test('assignUniqueGroundedName dedupes', () => {
  const used = new Set();
  const a = assignUniqueGroundedName(['hero', 'hero'], 'jpg', used);
  const b = assignUniqueGroundedName(['hero', 'hero'], 'jpg', used);
  assert.notEqual(a.filename, b.filename);
  assert.match(b.filename, /^hero-1\.jpg$/);
});

test('enhanceImageHd upscales small png', async () => {
  const small = await sharp({
    create: {
      width: 400,
      height: 300,
      channels: 3,
      background: { r: 40, g: 80, b: 120 },
    },
  })
    .png()
    .toBuffer();
  const out = await enhanceImageHd(small, { minLongSide: 1200, maxScale: 2 });
  assert.equal(out.enhanced, true);
  const meta = await sharp(out.buffer).metadata();
  assert.ok((meta.width || 0) > 400);
});
