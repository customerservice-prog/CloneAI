/**
 * Network check: download 1000+ distinct images (picsum) and build site-assets.zip.
 * Run: npm run verify-harvest-1k --prefix backend
 * Saves ZIP to %TEMP%\\cloneai-harvest-verify.zip (override with HARVEST_VERIFY_ZIP=path).
 * Requires outbound HTTPS. Billing caps apply only to /api/analyze — this script calls harvest directly (unlimited).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchHarvestedImages, zipImageEntries } from '../imageHarvest.js';

/** Picsum seeds often return identical tiny payloads → duplicate fingerprints. Vary id + dimensions so bytes differ. */
const WANT = 1100;
const urls = Array.from({ length: WANT }, (_, i) => {
  const id = (i % 998) + 1;
  const w = 12 + (i % 88);
  const h = 12 + ((i * 13) % 86);
  return `https://picsum.photos/id/${id}/${w}/${h}`;
});

console.log(`Fetching ${urls.length} images (picsum, concurrency 16)…`);
const t0 = Date.now();
const fetched = await fetchHarvestedImages(urls, {
  maxImages: Number.MAX_SAFE_INTEGER,
  maxTotalBytes: Number.MAX_SAFE_INTEGER,
  concurrency: 16,
  timeoutMs: 30000,
});
const ms = Date.now() - t0;
console.log(`Done in ${ms}ms — entries=${fetched.entries.length} skipped=${fetched.skipped} dupSkipped=${fetched.contentDuplicatesSkipped} errors(sample)=${fetched.errors.slice(0, 3).join(' | ')}`);

if (fetched.entries.length < 1000) {
  console.error(`FAIL: need at least 1000 images in ZIP, got ${fetched.entries.length}`);
  process.exit(1);
}

const zipBuf = await zipImageEntries(fetched.entries);
if (!zipBuf || zipBuf.length < 10_000) {
  console.error('FAIL: zip buffer missing or too small');
  process.exit(1);
}

const outPath = (process.env.HARVEST_VERIFY_ZIP || '').trim() || path.join(os.tmpdir(), 'cloneai-harvest-verify.zip');
fs.writeFileSync(outPath, zipBuf);
console.log(
  `OK — ZIP ${Math.round(zipBuf.length / 1024)} KiB, ${fetched.entries.length} files + _urls.txt — written ${outPath}`
);
