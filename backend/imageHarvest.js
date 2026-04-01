import axios from 'axios';
import archiver from 'archiver';
import { createHash } from 'node:crypto';
import { assertUrlSafeForServerFetch } from './ssrf.js';

const IMG_ATTR_RE =
  /<(img|source|video|link|meta|picture|object|embed|image)\b([^>]*?)>/gis;
const LINK_TAG_RE = /<link\b([^>]*?)>/gis;
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const NO_SCRIPT_RE = /<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi;

const GENERIC_MEDIA_ATTRS = [
  'src',
  'srcset',
  'data-src',
  'data-srcset',
  'data-lazy-src',
  'data-original',
  'data-lazy',
  'data-zoom-image',
  'data-large_image',
  'data-large-image',
  'data-bg',
  'data-bgset',
  'data-background',
  'data-background-image',
  'data-image',
  'data-img',
  'data-thumb',
  'data-thumbnail',
  'data-poster',
  'poster',
];

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

function looksLikeMediaPath(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  if (/^data:|^blob:/i.test(s)) return false;
  if (/\.(?:jpg|jpeg|png|webp|gif|avif|svg|ico|bmp|tiff?)(?:[?#]|$)/i.test(s)) return true;
  if (/(?:image|img|photo|thumb|thumbnail|banner|hero|gallery|poster|background)/i.test(s)) return true;
  return false;
}

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  '_ga',
]);

/** Stable key for deduplicating image URLs (tracking params stripped). */
export function normalizeHarvestUrlKey(href) {
  try {
    const u = new URL(href);
    u.hash = '';
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    return u.href;
  } catch {
    return null;
  }
}

/** Deduplicate while preserving first-seen order. */
export function dedupeHarvestUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    const k = normalizeHarvestUrlKey(u);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
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
      for (const a of [
        'src',
        'data-src',
        'data-srcset',
        'data-lazy-src',
        'data-original',
        'data-lazy',
        'data-zoom-image',
        'data-large_image',
        'data-large-image',
        'data-bg',
        'data-background',
        'data-background-image',
        'data-image',
        'data-img',
        'data-url',
        'data-href',
      ]) {
        const v = attrVal(inner, a);
        if (v) {
          if (a === 'data-srcset' || /srcset$/i.test(a)) {
            const u = bestUrlFromSrcset(v, baseHref);
            if (u) push(u);
          } else {
            const u = resolveHref(v, baseHref);
            if (u) push(u);
          }
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
      const asAttr = (attrVal(inner, 'as') || '').toLowerCase();
      const isImagePreload =
        asAttr === 'image' && /\bpreload\b|\bprefetch\b/i.test(rel);
      if (
        !/icon|apple-touch|preload|image_src|prefetch/i.test(rel) &&
        !isImagePreload
      ) {
        continue;
      }
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

    if (tagName === 'picture') {
      for (const a of ['src', 'data-src', 'href']) {
        const v = attrVal(inner, a);
        if (v) {
          const u = resolveHref(v, baseHref);
          if (u) push(u);
        }
      }
    }

    if (tagName === 'object') {
      const data = attrVal(inner, 'data');
      if (data) {
        const u = resolveHref(data, baseHref);
        if (u) push(u);
      }
    }

    if (tagName === 'embed') {
      const src = attrVal(inner, 'src');
      if (src) {
        const u = resolveHref(src, baseHref);
        if (u) push(u);
      }
    }

    if (tagName === 'image') {
      for (const a of ['href', 'xlink:href', 'src']) {
        const v = attrVal(inner, a);
        if (v) {
          const u = resolveHref(v, baseHref);
          if (u) push(u);
        }
      }
    }

    for (const attrName of GENERIC_MEDIA_ATTRS) {
      const value = attrVal(inner, attrName);
      if (!value) continue;
      if (/srcset$/i.test(attrName) || attrName === 'data-bgset') {
        for (const part of String(value).split(',')) {
          const candidate = part.trim().split(/\s+/)[0] || '';
          const u = resolveHref(candidate, baseHref);
          if (u) push(u);
        }
        const best = bestUrlFromSrcset(value, baseHref);
        if (best) push(best);
        continue;
      }
      if (!looksLikeMediaPath(value) && !/^https?:\/\//i.test(value) && !value.startsWith('/')) continue;
      const u = resolveHref(value, baseHref);
      if (u) push(u);
    }
  }

  // <img ...> anywhere (catches malformed or non-standard wrappers)
  const looseImg = /<img\b[^>]*>/gi;
  let lim;
  while ((lim = looseImg.exec(html)) !== null) {
    const frag = lim[0];
    const srcset = attrVal(frag, 'srcset') || attrVal(frag, 'data-srcset');
    if (srcset) {
      const u = bestUrlFromSrcset(srcset, baseHref);
      if (u) push(u);
    }
    for (const a of ['src', 'data-src', 'data-lazy-src', 'data-original']) {
      const v = attrVal(frag, a);
      if (v && !/srcset$/i.test(a)) {
        const u = resolveHref(v, baseHref);
        if (u) push(u);
      }
    }
  }

  NO_SCRIPT_RE.lastIndex = 0;
  let ns;
  while ((ns = NO_SCRIPT_RE.exec(html)) !== null) {
    const inner = ns[1] || '';
    const nested = collectImageUrls(inner, baseHref);
    for (const u of nested) push(u);
  }

  // Inline + <style> blocks: background-image: url(...)
  const urlInStyle = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  const scanCss = (block) => {
    if (!block) return;
    let um;
    urlInStyle.lastIndex = 0;
    while ((um = urlInStyle.exec(block)) !== null) {
      const u = resolveHref(um[1], baseHref);
      if (u) push(u);
    }
  };
  let sb;
  STYLE_BLOCK_RE.lastIndex = 0;
  while ((sb = STYLE_BLOCK_RE.exec(html)) !== null) {
    scanCss(sb[1]);
  }
  scanCss(html);

  // Absolute image URLs embedded in JSON/config blobs (common on storefronts)
  const looseRe =
    /https?:\/\/[^"'\\\s<>(){}\[\]`]{8,2000}\.(?:jpg|jpeg|png|webp|gif|avif|svg)\b(?:\?[^"'\\\s<>]{0,800})?/gi;
  let looseHits = 0;
  const looseCap = 8000;
  let lm;
  while ((lm = looseRe.exec(html)) !== null && looseHits < looseCap) {
    const raw = lm[0].replace(/&amp;/g, '&');
    const u = resolveHref(raw, baseHref);
    if (u) push(u);
    looseHits += 1;
  }

  const relativeRe =
    /["']((?:\/|\.\/|\.\.\/)[^"'\\\s<>(){}\[\]`]{2,1200}\.(?:jpg|jpeg|png|webp|gif|avif|svg)\b(?:\?[^"'\\\s<>]{0,800})?)["']/gi;
  let relativeHits = 0;
  relativeRe.lastIndex = 0;
  while ((lm = relativeRe.exec(html)) !== null && relativeHits < 8000) {
    const u = resolveHref(lm[1], baseHref);
    if (u) push(u);
    relativeHits += 1;
  }

  return ordered;
}

const CSS_URL_FUNC_RE = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;

/**
 * Stylesheet URLs from `<link rel=stylesheet>` (and alternate stylesheets).
 * @param {string} html
 * @param {string} pageUrl
 * @returns {string[]}
 */
export function collectStylesheetHrefs(html, pageUrl) {
  if (!html || !pageUrl) return [];
  let baseHref = pageUrl;
  try {
    baseHref = new URL(pageUrl).href;
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  LINK_TAG_RE.lastIndex = 0;
  let m;
  while ((m = LINK_TAG_RE.exec(html)) !== null) {
    const inner = m[1] || '';
    const rel = (attrVal(inner, 'rel') || '').toLowerCase();
    if (!/\bstylesheet\b/i.test(rel)) continue;
    const href = attrVal(inner, 'href');
    if (!href) continue;
    const u = resolveHref(href, baseHref);
    const k = u ? normalizeHarvestUrlKey(u) : null;
    if (!u || !k || seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}

/**
 * Resolve `url(...)` references in CSS text (backgrounds, masks, fonts filtered at fetch time).
 * @param {string} cssText
 * @param {string} sheetUrl Absolute URL of the stylesheet (for relative paths).
 * @returns {string[]}
 */
export function extractImageUrlsFromCss(cssText, sheetUrl) {
  if (!cssText || !sheetUrl) return [];
  let baseHref = sheetUrl;
  try {
    baseHref = new URL(sheetUrl).href;
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  CSS_URL_FUNC_RE.lastIndex = 0;
  let um;
  while ((um = CSS_URL_FUNC_RE.exec(cssText)) !== null) {
    const raw = (um[1] || '').trim();
    if (!raw || /^#/i.test(raw)) continue;
    const u = resolveHref(raw, baseHref);
    const k = u ? normalizeHarvestUrlKey(u) : null;
    if (!u || !k || seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}

/**
 * `@import` targets (typically other `.css` files) for chained harvesting.
 * @param {string} cssText
 * @param {string} sheetUrl
 * @returns {string[]}
 */
export function extractImportUrlsFromCss(cssText, sheetUrl) {
  if (!cssText || !sheetUrl) return [];
  let baseHref = sheetUrl;
  try {
    baseHref = new URL(sheetUrl).href;
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();

  const pushImportTarget = (chunk) => {
    let raw = String(chunk || '').trim();
    if (!raw) return;
    raw = raw.replace(/\s+layer\s*$/i, '').trim();
    if (!raw || /^(screen|print|all|speech|only|not)\b/i.test(raw)) return;
    const u = resolveHref(raw, baseHref);
    const k = u ? normalizeHarvestUrlKey(u) : null;
    if (!u || !k || seen.has(k)) return;
    seen.add(k);
    out.push(u);
  };

  const urlForm = /@import\s+url\s*\(\s*["']?([^'")]+)["']?\s*\)/gi;
  const quotedForm = /@import\s+["']([^'"\n;]+)["']\s*(?:;|$)/gi;
  let im;
  urlForm.lastIndex = 0;
  while ((im = urlForm.exec(cssText)) !== null) {
    pushImportTarget(im[1]);
  }
  quotedForm.lastIndex = 0;
  while ((im = quotedForm.exec(cssText)) !== null) {
    pushImportTarget(im[1]);
  }
  return out;
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

/** SHA-256 hex of raw bytes — used to skip identical images from different URLs. */
export function imageBytesFingerprint(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function poolMap(items, concurrency, fn, onProgress = null) {
  const results = new Array(items.length);
  let next = 0;
  let fetchCompleted = 0;
  async function worker() {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
      fetchCompleted += 1;
      onProgress?.({ fetchCompleted, fetchTotal: items.length });
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
  onProgress = null,
} = {}) {
  const cap =
    Number.isFinite(maxImages) && maxImages < urls.length ? Math.max(0, Math.floor(maxImages)) : urls.length;
  const slice = urls.slice(0, cap);
  const errors = [];
  let total = 0;
  const entries = [];
  const seenContent = new Set();
  let contentDuplicatesSkipped = 0;
  let fetchFailures = 0;
  let nonImageSkipped = 0;
  let oversizedSkipped = 0;
  let totalFetchAttempts = 0;

  const results = await poolMap(slice, concurrency, async (imageUrl) => {
    totalFetchAttempts += 1;
    const safe = await assertUrlSafeForServerFetch(imageUrl);
    if (!safe.ok) {
      errors.push(`${imageUrl}: ${safe.error}`);
      fetchFailures += 1;
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
        nonImageSkipped += 1;
        return null;
      }
      const buf = Buffer.from(res.data);
      if (buf.length > maxBytesPerImage) {
        errors.push(`${imageUrl}: exceeds per-file size limit`);
        oversizedSkipped += 1;
        return null;
      }
      return { buffer: buf, ext: extFromContentType(ct), url: imageUrl };
    } catch (e) {
      errors.push(`${imageUrl}: ${e.message || 'fetch failed'}`);
      fetchFailures += 1;
      return null;
    }
  }, onProgress);

  const totalCap = Number.isFinite(maxTotalBytes) ? maxTotalBytes : Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (!r) continue;
    const fp = imageBytesFingerprint(r.buffer);
    if (seenContent.has(fp)) {
      contentDuplicatesSkipped += 1;
      continue;
    }
    seenContent.add(fp);
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
    onProgress?.({
      imagesInZip: entries.length,
      bytesSoFar: total,
      contentDuplicatesSkipped,
      fetchTotal: slice.length,
      fetchCompleted: slice.length,
    });
  }

  return {
    entries,
    skipped: slice.length - entries.length,
    contentDuplicatesSkipped,
    fetchFailures,
    nonImageSkipped,
    oversizedSkipped,
    totalFetchAttempts,
    archiveBytes: total,
    errors: errors.slice(0, 250),
  };
}

/**
 * @param {{ name: string, buffer: Buffer, sourceUrl?: string }[]} entries
 * @param {{ name: string, buffer: Buffer, url: string }[]} [snapshots]
 * @param {{ name: string, buffer: Buffer }[]} [extras] — e.g. crawled HTML under extract/
 */
export async function zipImageEntries(entries, snapshots = [], extras = []) {
  if (!entries.length && !snapshots.length && !(extras && extras.length)) return null;
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
    for (const x of extras || []) {
      if (x?.buffer?.length && x?.name) archive.append(x.buffer, { name: x.name });
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
