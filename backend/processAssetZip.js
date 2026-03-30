/**
 * In-memory post-process for CloneAI site-assets ZIPs (shared by CLI and HTTP API).
 * See docs/IMAGE_PIPELINE.md.
 */
import AdmZip from 'adm-zip';
import {
  buildGroundedCandidates,
  assignUniqueGroundedName,
  enhanceImageHd,
} from './imageIntelPipeline.js';
import { openAiPickCandidateIndex } from './aiImageNamePick.js';

function extFromName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return (m && m[1].toLowerCase()) || 'png';
}

function parseManifestLine(line) {
  const tab = line.indexOf('\t');
  if (tab === -1) return null;
  return { zipName: line.slice(0, tab).trim(), url: line.slice(tab + 1).trim() };
}

/**
 * @param {Buffer} zipBuffer
 * @param {object} [opts]
 * @param {boolean} [opts.skipHd]
 * @param {boolean} [opts.useAiPick] — only ranks existing URL-derived candidates (never invents names)
 * @param {string} [opts.apiKey] — OpenAI key when useAiPick
 * @param {number} [opts.maxRasterImages] — cap raster files processed (rest copied as-is)
 */
export async function processSiteAssetZipBuffer(zipBuffer, opts = {}) {
  const skipHd = Boolean(opts.skipHd);
  const apiKey = (opts.apiKey || '').trim();
  const useAiPick = Boolean(opts.useAiPick && apiKey);
  const maxRaster = Math.min(
    2000,
    Math.max(1, Number(opts.maxRasterImages) > 0 ? Number(opts.maxRasterImages) : 500)
  );

  const zip = new AdmZip(zipBuffer);
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
  let rasterProcessed = 0;

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

    if (rasterProcessed >= maxRaster) {
      outZip.addFile(name, e.getData());
      manifest.push({ original: name, passthrough: true, reason: 'max_raster_cap' });
      continue;
    }
    rasterProcessed += 1;

    const url = urlByZip.get(name) || '';
    const kind = name.startsWith('snapshots/') ? 'snapshot' : 'harvest';
    const pseudoUrl =
      url || `https://assets.local/${encodeURIComponent(name.split('/').pop() || 'image.png')}`;
    let candidates = buildGroundedCandidates(pseudoUrl, kind);
    if (useAiPick && candidates.length > 1) {
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

  const outBuffer = outZip.toBuffer();
  return {
    buffer: outBuffer,
    manifest: { generatedAt: new Date().toISOString(), items: manifest },
    stats: {
      itemCount: manifest.length,
      rasterProcessed,
      aiNaming: useAiPick,
      hd: !skipHd,
    },
  };
}
