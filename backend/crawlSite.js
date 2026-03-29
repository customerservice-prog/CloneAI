import axios from 'axios';
import net from 'node:net';
import { assertUrlSafeForServerFetch, isUnsafeIpLiteral } from './ssrf.js';

export function hostKeyFromHostname(h) {
  return String(h || '')
    .replace(/^www\./i, '')
    .toLowerCase();
}

export function normalizeUrlKey(href) {
  try {
    const u = new URL(href);
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/** Skip low-value / boilerplate routes to save crawl + token budget. */
export function isSkippableCrawlPath(pathname) {
  const p = String(pathname || '').toLowerCase();
  if (!p || p === '/') return false;
  const patterns = [
    /\/(login|signin|sign-in|signup|sign-up|register|logout|signout)(\/|$)/,
    /\/(privacy|terms|legal|cookie|cookies|gdpr|ccpa|accessibility)(\/|$|-)/,
    /\/(admin|dashboard|wp-admin|wp-login|cpanel)(\/|$)/,
    /\/account\/(login|signin|register)(\/|$)/,
    /\.(pdf|zip|gz|tar|xml|rss|atom)$/,
  ];
  return patterns.some((re) => re.test(p));
}

const A_HREF_RE = /<a\s[^>]*\bhref\s*=\s*(["'])([^"']*?)\1/gi;

export function extractInternalLinks(html, pageUrl, allowedHostKey) {
  if (!html || !pageUrl) return [];
  let base;
  try {
    base = new URL(pageUrl).href;
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  let m;
  A_HREF_RE.lastIndex = 0;
  while ((m = A_HREF_RE.exec(html)) !== null) {
    const raw = (m[2] || '').trim();
    if (!raw || raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('tel:'))
      continue;
    if (raw === '#' || raw.startsWith('#')) continue;
    let abs;
    try {
      abs = new URL(raw, base).href;
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs)) continue;
    let parsed;
    try {
      parsed = new URL(abs);
    } catch {
      continue;
    }
    if (parsed.username || parsed.password) continue;
    if (hostKeyFromHostname(parsed.hostname) !== allowedHostKey) continue;
    if (isSkippableCrawlPath(parsed.pathname || '')) continue;
    const host = parsed.hostname;
    if (net.isIP(host) && isUnsafeIpLiteral(host)) continue;
    const key = normalizeUrlKey(abs);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function isChallengePage(html) {
  const head = html.slice(0, 6000).toLowerCase();
  return (
    head.includes('captcha') ||
    head.includes('cf-browser-verification') ||
    head.includes('attention required') ||
    head.includes('access denied') ||
    head.includes('enable javascript') ||
    head.includes('just a moment') ||
    head.includes('blocked by') ||
    head.includes('bot detection')
  );
}

async function axiosFetchHtml(targetUrl, allowedHostKey, { timeoutMs, maxContentLength, maxRedirects }) {
  const res = await axios.get(targetUrl, {
    timeout: timeoutMs,
    maxContentLength,
    maxRedirects,
    beforeRedirect: (opts) => {
      const proto = opts.protocol || '';
      if (proto && proto !== 'http:' && proto !== 'https:') throw new Error('redirect_blocked');
      if (opts.auth) throw new Error('redirect_blocked');
      const h = opts.hostname;
      if (!h) throw new Error('redirect_blocked');
      if (hostKeyFromHostname(h) !== allowedHostKey) throw new Error('redirect_blocked');
    },
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 SiteClonerPRO/1.0',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    validateStatus: () => true,
  });
  const html = typeof res.data === 'string' ? res.data : String(res.data ?? '');
  const ok = res.status >= 200 && res.status < 400 && html.length >= 200 && !isChallengePage(html);
  return { html, status: res.status, ok };
}

/**
 * BFS crawl same-host pages. Seed page is already fetched (html + url).
 * Does not drop pages that share a similar header — only URL de-duplication.
 * @param {{ onProgress?: (p: { pagesCrawled: number, queueLength: number }) => void }} [opts]
 * @returns {Promise<{ results: { url: string, html: string }[], stopReason: 'exhausted' | 'page_cap' | 'timeout', queueRemaining: number }>}
 */
export async function crawlFromSeed(startUrl, seedHtml, {
  maxPages = 20,
  fetchConcurrency = 16,
  htmlTimeoutMs = 20000,
  maxHtmlBytes = 8 * 1024 * 1024,
  maxContentLength = 50 * 1024 * 1024,
  maxRedirects = 2,
  maxCrawlWallClockMs = 120000,
  onProgress,
} = {}) {
  let initial;
  try {
    initial = new URL(startUrl.startsWith('http') ? startUrl : `https://${startUrl}`);
  } catch {
    return { results: [], stopReason: 'exhausted', queueRemaining: 0 };
  }
  const allowedHostKey = hostKeyFromHostname(initial.hostname);
  const startKey = normalizeUrlKey(initial.href);
  if (!startKey || !seedHtml || seedHtml.length < 200)
    return { results: [], stopReason: 'exhausted', queueRemaining: 0 };

  const deadline = Date.now() + Math.max(10_000, Math.min(600_000, maxCrawlWallClockMs));

  const visited = new Set();
  const queue = [];
  const results = [];

  function enqueue(u) {
    const k = normalizeUrlKey(u);
    if (!k || visited.has(k)) return;
    visited.add(k);
    queue.push(k);
  }

  visited.add(startKey);
  const seedSlice = seedHtml.length > maxHtmlBytes ? seedHtml.slice(0, maxHtmlBytes) : seedHtml;
  results.push({
    url: startKey,
    html: seedSlice,
  });

  for (const link of extractInternalLinks(seedHtml, startKey, allowedHostKey)) {
    enqueue(link);
  }

  try {
    onProgress?.({ pagesCrawled: results.length, queueLength: queue.length });
  } catch {
    /* ignore */
  }

  /** Allow large discovery queues on media-heavy sites (visited set caps real work). */
  const maxQueuedLinks = Math.max(maxPages * 500, 5000);

  async function fetchOne(pageUrl) {
    if (pageUrl === startKey) return null;
    const safe = await assertUrlSafeForServerFetch(pageUrl);
    if (!safe.ok) return null;
    try {
      const { html, ok } = await axiosFetchHtml(pageUrl, allowedHostKey, {
        timeoutMs: htmlTimeoutMs,
        maxContentLength,
        maxRedirects,
      });
      if (!ok) return null;
      let slice = html.length > maxHtmlBytes ? html.slice(0, maxHtmlBytes) : html;
      try {
        const path = new URL(pageUrl).pathname || '';
        if (isSkippableCrawlPath(path)) return null;
      } catch {
        /* skip */
      }
      for (const link of extractInternalLinks(slice, pageUrl, allowedHostKey)) {
        if (queue.length >= maxQueuedLinks) break;
        enqueue(link);
      }
      return { url: pageUrl, html: slice };
    } catch {
      return null;
    }
  }

  let stopReason = 'exhausted';

  while (results.length < maxPages && queue.length > 0) {
    if (Date.now() > deadline) {
      stopReason = 'timeout';
      break;
    }
    const batch = [];
    while (queue.length > 0 && batch.length < fetchConcurrency && results.length + batch.length < maxPages) {
      const next = queue.shift();
      if (next === startKey) continue;
      batch.push(next);
    }
    if (batch.length === 0) break;
    const settled = await Promise.all(batch.map((u) => fetchOne(u)));
    for (const item of settled) {
      if (item && results.length < maxPages) results.push(item);
    }
    try {
      onProgress?.({ pagesCrawled: results.length, queueLength: queue.length });
    } catch {
      /* ignore */
    }
    if (results.length >= maxPages) {
      stopReason = 'page_cap';
      break;
    }
  }

  if (stopReason === 'exhausted' && (queue.length > 0 || results.length >= maxPages)) {
    stopReason = results.length >= maxPages ? 'page_cap' : 'exhausted';
  }

  return { results, stopReason, queueRemaining: queue.length };
}

/**
 * Fetch one same-host page (for URLs discovered via Playwright interactions).
 */
export async function fetchCrawlPageHtml(
  pageUrl,
  seedUrl,
  { htmlTimeoutMs = 20000, maxHtmlBytes = 8 * 1024 * 1024, maxContentLength = 50 * 1024 * 1024, maxRedirects = 2 } = {}
) {
  let initial;
  try {
    initial = new URL(seedUrl.startsWith('http') ? seedUrl : `https://${seedUrl}`);
  } catch {
    return null;
  }
  const allowedHostKey = hostKeyFromHostname(initial.hostname);
  const k = normalizeUrlKey(pageUrl);
  if (!k) return null;
  let target;
  try {
    target = new URL(k);
  } catch {
    return null;
  }
  if (hostKeyFromHostname(target.hostname) !== allowedHostKey) return null;
  const safe = await assertUrlSafeForServerFetch(k);
  if (!safe.ok) return null;
  try {
    const { html, ok } = await axiosFetchHtml(k, allowedHostKey, {
      timeoutMs: htmlTimeoutMs,
      maxContentLength,
      maxRedirects,
    });
    if (!ok) return null;
    const slice = html.length > maxHtmlBytes ? html.slice(0, maxHtmlBytes) : html;
    return { url: k, html: slice };
  } catch {
    return null;
  }
}
