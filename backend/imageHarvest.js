import axios from 'axios';
import archiver from 'archiver';
import { assertUrlSafeForServerFetch } from './ssrf.js';

const IMG_ATTR_RE = /<(img|source|video|link|meta)\b([^>]*?)>/gis;

function attrVal(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'is');
  const m = re.exec(tag);
  return m ? m[2].trim() : null;
}

/** Parse srcset; prefer largest `w` or `x` candidate. */
export function bestUrlFromSrcset(srcset, baseHref) {
  if (!srcset || !srcset.trim()) return null;
  const parts = srcset.split(',').map((p) => p.trim()).filter(Boolean);
  let best = null;
  let bestScore = -1;
  for (const part of parts) {
    const tokens = part.split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const u = tokens[0];
    let score = 1;
    const desc = tokens[1] || '';
    const w = /^(\d+)w$/i.exec(desc);
    const x = /^(\d+(?:\.\d+)?)x$/i.exec(desc);
    if (w) score = Number(w[1]) || 1;
    else if (x) score = (Number(x[1]) || 1) * 1000;
    if (score > bestScore) {
      bestScore = score;
      best = u;
    }
  }
  if (!best) return null;
  try {
    const abs = new URL(best, baseHref).href;
    if (abs.startsWith('data:') || abs.startsWith('blob:')) return null;
    return abs;
  } catch {
    return null;
  }
}

function resolveHref(raw, baseHref) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.startsWith('data:') || s.startsWith('blob:')) return null;
  try {
    return new URL(s, baseHref).href;
  } catch {
    return null;
  }
}

/** Collect image-like URLs in document order (deduped). */
export function collectImageUrls(html, pageUrl) {
  if (!html || !pageUrl) return [];
  let baseHref = pageUrl;
  try {
    baseHref = new URL(pageUrl).href;
  } catch {
    return [];
  }

  const ordered = [];
  const seen = new Set();

  function push(u) {
    if (!u || seen.has(u)) return;
    seen.add(u);
    ordered.push(u);
  }

  const lower = html; // case-sensitive for URLs inside strings
  let m;
  const re = IMG_ATTR_RE;
  re.lastIndex = 0;
  while ((m = re.exec(lower)) !== null) {
    const tagName = m[1].toLowerCase();
    const inner = m[2] || '';

    if (tagName === 'img') {
      const srcset = attrVal(inner, 'srcset');
      if (srcset) {
        const u = bestUrlFromSrcset(srcset, baseHref);
        if (u) push(u);
      }
      const dataSrcset = attrVal(inner, 'data-srcset');
      if (dataSrcset) {
        const u = bestUrlFromSrcset(dataSrcset, baseHref);
        if (u) push(u);
      }
      for (const a of ['src', 'data-src', 'data-lazy-src', 'data-original']) {
        const v = attrVal(inner, a);
        if (v) {
          const u = resolveHref(v, baseHref);
          if (u) push(u);
        }
      }
    }

    if (tagName === 'source') {
      const srcset = attrVal(inner, 'srcset');
      if (srcset) {
        const u = bestUrlFromSrcset(srcset, baseHref);
        if (u) push(u);
      }
      const src = attrVal(inner, 'src');
      if (src) {
        const u = resolveHref(src, baseHref);
        if (u) push(u);
      }
    }

    if (tagName === 'video') {
      const poster = attrVal(inner, 'poster');
      if (poster) {
        const u = resolveHref(poster, baseHref);
        if (u) push(u);
      }
    }

    if (tagName === 'link') {
      const rel = (attrVal(inner, 'rel') || '').toLowerCase();
      if (!/icon|apple-touch|preload|image_src/i.test(rel)) continue;
      const href = attrVal(inner, 'href');
      if (href) {
        const u = resolveHref(href, baseHref);
        if (u) push(u);
      }
    }

    if (tagName === 'meta') {
      const prop = (attrVal(inner, 'property') || '').toLowerCase();
      const name = (attrVal(inner, 'name') || '').toLowerCase();
      const content = attrVal(inner, 'content');
      if (
        content &&
        (prop === 'og:image' ||
          prop === 'og:image:url' ||
          prop === 'twitter:image' ||
          name === 'twitter:image')
      ) {
        const u = resolveHref(content, baseHref);
        if (u) push(u);
      }
    }
  }

  // Inline styles: background-image: url(...)
  const urlInStyle = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  let um;
  while ((um = urlInStyle.exec(html)) !== null) {
    const u = resolveHref(um[1], baseHref);
    if (u) push(u);
  }

  return ordered;
}

function extFromContentType(ct) {
  const s = (ct || '').toLowerCase();
  if (s.includes('png')) return 'png';
  if (s.includes('webp')) return 'webp';
  if (s.includes('gif')) return 'gif';
  if (s.includes('svg')) return 'svg';
  if (s.includes('jpeg') || s.includes('jpg')) return 'jpg';
  if (s.includes('avif')) return 'avif';
  return 'bin';
}

function sanitizeZipName(i, ext) {
  const n = String(i + 1).padStart(6, '0');
  return `image-${n}.${ext}`;
}

async function poolMap(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Fetch remote images (original bytes, no recompression).
 * @returns {Promise<{ entries: { name: string, buffer: Buffer }[], skipped: number, errors: string[] }>}
 */
export async function fetchHarvestedImages(urls, {
  maxImages = Number.MAX_SAFE_INTEGER,
  maxBytesPerImage = 50 * 1024 * 1024,
  maxTotalBytes = Number.MAX_SAFE_INTEGER,
  concurrency = 12,
  timeoutMs = 25000,
} = {}) {
  const cap =
    Number.isFinite(maxImages) && maxImages < urls.length ? Math.max(0, Math.floor(maxImages)) : urls.length;
  const slice = urls.slice(0, cap);
  const errors = [];
  let total = 0;
  const entries = [];

  const results = await poolMap(slice, concurrency, async (imageUrl) => {
    const safe = await assertUrlSafeForServerFetch(imageUrl);
    if (!safe.ok) {
      errors.push(`${imageUrl}: ${safe.error}`);
      return null;
    }
    try {
      const res = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        maxContentLength: maxBytesPerImage,
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 300,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 CloneAI/1.0',
          Accept: 'image/*,*/*;q=0.8',
        },
      });
      const ct = res.headers['content-type'] || '';
      if (!/^image\//i.test(ct) && !/octet-stream/i.test(ct)) {
        errors.push(`${imageUrl}: not an image (${ct || 'no content-type'})`);
        return null;
      }
      const buf = Buffer.from(res.data);
      if (buf.length > maxBytesPerImage) {
        errors.push(`${imageUrl}: exceeds per-file size limit`);
        return null;
      }
      return { buffer: buf, ext: extFromContentType(ct), url: imageUrl };
    } catch (e) {
      errors.push(`${imageUrl}: ${e.message || 'fetch failed'}`);
      return null;
    }
  });

  const totalCap = Number.isFinite(maxTotalBytes) ? maxTotalBytes : Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (!r) continue;
    if (total + r.buffer.length > totalCap) {
      errors.push('ZIP total size cap reached (set IMAGE_HARVEST_ZIP_CAP=0 for no cap).');
      break;
    }
    total += r.buffer.length;
    entries.push({
      name: sanitizeZipName(entries.length, r.ext),
      buffer: r.buffer,
      sourceUrl: r.url,
    });
  }

  return {
    entries,
    skipped: slice.length - entries.length,
    errors: errors.slice(0, 250),
  };
}

/**
 * @param {{ name: string, buffer: Buffer, sourceUrl?: string }[]} entries
 * @param {{ name: string, buffer: Buffer, url: string }[]} [snapshots]
 */
export async function zipImageEntries(entries, snapshots = []) {
  if (!entries.length && !snapshots.length) return null;
  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', reject);
    archive.on('data', (c) => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const e of entries) {
      archive.append(e.buffer, { name: e.name });
    }
    for (const s of snapshots) {
      if (s.buffer?.length) archive.append(s.buffer, { name: s.name });
    }
    if (entries.length) {
      const manifest = entries.map((e) => `${e.name}\t${e.sourceUrl || ''}`).join('\n');
      archive.append(Buffer.from(manifest, 'utf8'), { name: '_urls.txt' });
    }
    if (snapshots.length) {
      const snapManifest = snapshots.filter((s) => s.buffer?.length).map((s) => `${s.name}\t${s.url}`).join('\n');
      if (snapManifest) archive.append(Buffer.from(snapManifest, 'utf8'), { name: '_snapshots.txt' });
    }
    archive.finalize();
  });
}

export function buildImageManifestForPrompt(entries) {
  if (!entries.length) return '';
  const lines = entries.map((e, i) => `- \`${e.name}\` ← ${e.sourceUrl || '(unknown source)'}`);
  return [
    '---',
    'HARVESTED PAGE IMAGES (saved server-side; user can download ZIP). Reference these filenames in section 9 when describing placement.',
    ...lines,
    '---',
  ].join('\n');
}
