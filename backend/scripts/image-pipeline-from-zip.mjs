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
import AdmZip from 'adm-zip';
import {
  buildGroundedCandidates,
  assignUniqueGroundedName,
  enhanceImageHd,
  basenameFromSourceUrl,
} from '../imageIntelPipeline.js';
import { openAiPickCandidateIndex } from '../aiImageNamePick.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const skipHd = String(process.env.IMAGE_PIPELINE_SKIP_HD || '').toLowerCase() === 'true';
const useAiPick = String(process.env.IMAGE_PIPELINE_AI_NAMING || '').toLowerCase() === 'true';
const apiKey = (process.env.OPENAI_API_KEY || '').trim();

function extFromName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return (m && m[1].toLowerCase()) || 'png';
}

function parseManifestLine(line) {
  const tab = line.indexOf('\t');
  if (tab === -1) return null;
  return { zipName: line.slice(0, tab).trim(), url: line.slice(tab + 1).trim() };
}

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

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  const byName = new Map(entries.map((e) => [e.entryName.replace(/\\/g, '/'), e]));

  const urlByZip = new Map();
  for (const key of ['_urls.txt', '_snapshots.txt']) {
    const ent = byName.get(key);
    if (!ent) continue;
    const text = ent.getData().toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      const p = parseManifestLine(line);
      if (p && p.zipName) urlByZip.set(p.zipName, p.url);
    }
  }

  const used = new Set();
  const manifest = [];
  const outZip = new AdmZip();

  for (const e of entries) {
    const name = e.entryName.replace(/\\/g, '/');
    if (name.endsWith('.txt') && name.startsWith('_')) {
      outZip.addFile(name, e.getData());
      continue;
    }
    if (!/\.(png|jpe?g|webp|gif)$/i.test(name)) {
      outZip.addFile(name, e.getData());
      manifest.push({ original: name, passthrough: true });
      continue;
    }

    const url = urlByZip.get(name) || '';
    const kind = name.startsWith('snapshots/') ? 'snapshot' : 'harvest';
    const pseudoUrl =
      url ||
      `https://assets.local/${encodeURIComponent(name.split('/').pop() || 'image.png')}`;
    let candidates = buildGroundedCandidates(pseudoUrl, kind);
    if (useAiPick && apiKey && candidates.length > 1) {
      const idx = await openAiPickCandidateIndex(candidates, { apiKey });
      const chosen = candidates[idx] || candidates[0];
      candidates = [chosen, ...candidates.filter((c) => c !== chosen)];
    }

    let buf = e.getData();
    let ext = extFromName(name);
    if (!skipHd) {
      const hd = await enhanceImageHd(buf, {});
      if (hd.enhanced) {
        buf = hd.buffer;
        ext = 'png';
      }
    }

    const { filename } = assignUniqueGroundedName(candidates, ext, used);
    const destPath = filename.includes('/') ? filename : `processed/${filename}`;
    outZip.addFile(destPath, buf);

    manifest.push({
      original: name,
      output: destPath,
      sourceUrl: url || null,
      candidates,
      hd: !skipHd,
    });
  }

  const manifestPath = path.join(outDir, 'pipeline-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ generatedAt: new Date().toISOString(), items: manifest }, null, 2));
  const outZipPath = path.join(outDir, 'site-assets-processed.zip');
  outZip.writeZip(outZipPath);

  console.log('Wrote', manifestPath);
  console.log('Wrote', outZipPath);
  console.log('Items:', manifest.length, '| AI naming:', useAiPick && apiKey ? 'on' : 'off', '| HD:', skipHd ? 'off' : 'on');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
