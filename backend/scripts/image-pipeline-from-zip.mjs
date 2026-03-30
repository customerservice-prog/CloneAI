#!/usr/bin/env node
/**
 * Post-process a CloneAI site-assets ZIP:
 * 1) Inventory from _urls.txt / _snapshots.txt (ground truth URLs)
 * 2) HD upscale (sharp Lanczos) for images below target long side
 * 3) Rename files using URL-derived stems only (+ optional OpenAI index pick among candidates)
 *
 * Usage:
 *   node scripts/image-pipeline-from-zip.mjs ./site-assets.zip ./pipeline-out
 *
 * Env:
 *   OPENAI_API_KEY — optional; set IMAGE_PIPELINE_AI_NAMING=true to rank candidates (never invents names)
 *   IMAGE_PIPELINE_SKIP_HD=true — naming only
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { processSiteAssetZipBuffer } from '../processAssetZip.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const skipHd = String(process.env.IMAGE_PIPELINE_SKIP_HD || '').toLowerCase() === 'true';
const useAiPick = String(process.env.IMAGE_PIPELINE_AI_NAMING || '').toLowerCase() === 'true';
const apiKey = (process.env.OPENAI_API_KEY || '').trim();
const maxRaster = Math.min(
  2000,
  Math.max(1, Number(process.env.ASSET_PIPELINE_MAX_RASTER) || 500)
);

async function main() {
  const zipPath = path.resolve(process.argv[2] || '');
  const outDir = path.resolve(process.argv[3] || '');
  if (!zipPath || !outDir) {
    console.error('Usage: node scripts/image-pipeline-from-zip.mjs <input.zip> <output-dir>');
    process.exit(1);
  }
  if (!fs.existsSync(zipPath)) {
    console.error('ZIP not found:', zipPath);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const zipBuffer = fs.readFileSync(zipPath);
  const { buffer: outBuf, manifest, stats } = await processSiteAssetZipBuffer(zipBuffer, {
    skipHd,
    useAiPick,
    apiKey,
    maxRasterImages: maxRaster,
  });

  const manifestPath = path.join(outDir, 'pipeline-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const outZipPath = path.join(outDir, 'site-assets-processed.zip');
  fs.writeFileSync(outZipPath, outBuf);

  console.log('Wrote', manifestPath);
  console.log('Wrote', outZipPath);
  console.log(
    'Items:',
    stats.itemCount,
    '| AI naming:',
    stats.aiNaming ? 'on' : 'off',
    '| HD:',
    stats.hd ? 'on' : 'off'
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
