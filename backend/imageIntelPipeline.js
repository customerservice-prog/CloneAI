/**
 * Three-stage asset pipeline (CLI / post-process):
 * 1) Capture inventory — uses real page/screenshot URLs (no invented labels).
 * 2) HD enhance — Lanczos upscale via sharp (not generative “hallucination” pixels).
 * 3) Grounded names — URL path + safe slug; optional OpenAI picks ONLY among candidates.
 */
import sharp from 'sharp';

/** @param {string} url */
export function basenameFromSourceUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(seg.split('?')[0] || '') || '';
  } catch {
    return '';
  }
}

/** Safe single-segment filename stem (no path segments). */
export function sanitizeFilenameBase(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/\.(jpg|jpeg|png|webp|gif|svg|avif|bin)$/i, '');
  s = s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^\.+/, '');
  while (s.startsWith('-') || s.startsWith('_')) s = s.slice(1);
  while (s.endsWith('-') || s.endsWith('_')) s = s.slice(0, -1);
  if (s.length > 96) s = s.slice(0, 96);
  return s || 'asset';
}

/**
 * Ordered candidates derived only from URL / snapshot path — never fabricated prose.
 * @param {string} sourceUrl
 * @param {'harvest'|'snapshot'} kind
 */
export function buildGroundedCandidates(sourceUrl, kind) {
  const c = [];
  const bn = basenameFromSourceUrl(sourceUrl);
  if (bn) {
    c.push(sanitizeFilenameBase(bn));
    const simplified = bn.replace(/[-_][0-9]{2,4}x[0-9]{2,4}(?=\.[a-z])/i, '');
    if (simplified !== bn) c.push(sanitizeFilenameBase(simplified));
  }
  if (kind === 'snapshot' && sourceUrl) {
    try {
      const path = new URL(sourceUrl).pathname || '';
      const slug = path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 64);
      if (slug) c.push(sanitizeFilenameBase(`page-${slug}`));
    } catch {
      /* ignore */
    }
  }
  const out = [];
  const seen = new Set();
  for (const x of c) {
    if (!x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  if (!out.length) out.push('image');
  return out;
}

/**
 * @param {string[]} candidates
 * @param {string} ext
 * @param {Set<string>} used
 */
export function assignUniqueGroundedName(candidates, ext, used) {
  const e = (ext || 'png').replace(/^\./, '');
  for (const base of candidates) {
    let name = `${base}.${e}`;
    if (!used.has(name)) {
      used.add(name);
      return { filename: name, chosenStem: base, duplicateSuffix: 0 };
    }
  }
  const base0 = candidates[0] || 'image';
  let n = 1;
  while (n < 10_000) {
    const name = `${base0}-${n}.${e}`;
    if (!used.has(name)) {
      used.add(name);
      return { filename: name, chosenStem: base0, duplicateSuffix: n };
    }
    n += 1;
  }
  const fallback = `image-${Date.now()}.${e}`;
  used.add(fallback);
  return { filename: fallback, chosenStem: 'image', duplicateSuffix: 0 };
}

/**
 * Upscale smaller images with Lanczos (real pixels, not generative infill).
 * @param {Buffer} buffer
 * @param {{ minLongSide?: number, maxLongSide?: number, maxScale?: number }} [options]
 */
export async function enhanceImageHd(buffer, options = {}) {
  if (!buffer?.length) return { buffer, enhanced: false, reason: 'empty' };
  const minLongSide = Math.min(4096, Math.max(960, Number(options.minLongSide) || 1920));
  const maxLongSide = Math.min(3840, Math.max(minLongSide, Number(options.maxLongSide) || 2560));
  const maxScale = Math.min(4, Math.max(1, Number(options.maxScale) || 2));
  try {
    const meta = await sharp(buffer).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    const long = Math.max(w, h);
    if (!long) return { buffer, enhanced: false, reason: 'no_dimensions' };
    if (long >= minLongSide) {
      return { buffer, enhanced: false, reason: 'already_sufficient' };
    }
    let factor = minLongSide / long;
    if (factor > maxScale) factor = maxScale;
    const targetLong = Math.min(Math.round(long * factor), maxLongSide);
    if (targetLong <= long) return { buffer, enhanced: false, reason: 'no_upscale' };
    const scale = targetLong / long;
    const nw = Math.max(1, Math.round(w * scale));
    const nh = Math.max(1, Math.round(h * scale));
    const out = await sharp(buffer)
      .rotate()
      .resize({
        width: nw,
        height: nh,
        fit: 'fill',
        kernel: sharp.kernel.lanczos3,
      })
      .png({ compressionLevel: 6 })
      .toBuffer();
    return { buffer: out, enhanced: true, width: nw, height: nh, mime: 'image/png' };
  } catch (e) {
    return { buffer, enhanced: false, reason: 'sharp_error', error: String(e?.message || e) };
  }
}
