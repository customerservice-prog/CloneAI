/**
 * Playwright pass: post-hydration DOM, lazy-load scroll, and network image capture.
 * Complements static HTML + linked-CSS harvesting.
 */
import { hostKeyFromHostname, normalizeUrlKey } from './crawlSite.js';

function slugFromUrl(url, max = 48) {
  try {
    return (url || 'page')
      .replace(/^https?:\/\//i, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .slice(0, max);
  } catch {
    return 'page';
  }
}

/**
 * @param {string[]} pageUrls
 * @param {string} seedUrl — used for same-host guard
 * @param {{
 *   concurrency?: number,
 *   navigationTimeoutMs?: number,
 *   maxNetworkImageUrlsPerPage?: number,
 *   maxElementsForComputedBg?: number,
 * }} [opts]
 */
export async function runBrowserAssetHarvest(pageUrls, seedUrl, opts = {}) {
  const concurrency = Math.max(1, Math.min(6, Number(opts.concurrency) || 2));
  const navigationTimeoutMs = Math.max(5000, Number(opts.navigationTimeoutMs) || 55_000);
  const maxNet = Math.max(50, Math.min(5000, Number(opts.maxNetworkImageUrlsPerPage) || 800));
  const maxBg = Math.max(100, Math.min(5000, Number(opts.maxElementsForComputedBg) || 900));

  const out = {
    perPage: [],
    error: null,
  };

  if (process.env.ENABLE_BROWSER_ASSET_PASS === 'false') {
    return out;
  }

  let initial;
  try {
    initial = new URL(seedUrl.startsWith('http') ? seedUrl : `https://${seedUrl}`);
  } catch {
    return { ...out, error: 'bad_seed' };
  }
  const allowedKey = hostKeyFromHostname(initial.hostname);

  const urls = (pageUrls || [])
    .map((u) => normalizeUrlKey(u))
    .filter(Boolean)
    .filter((u) => {
      try {
        return hostKeyFromHostname(new URL(u).hostname) === allowedKey;
      } catch {
        return false;
      }
    });

  if (!urls.length) return out;

  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    return { ...out, error: 'playwright_missing' };
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const deviceScaleFactor = Math.min(
    3,
    Math.max(1, Number(process.env.BROWSER_HARVEST_DEVICE_SCALE) || 1)
  );

  try {
    let next = 0;
    async function worker() {
      while (true) {
        const i = next;
        next += 1;
        if (i >= urls.length) return;
        const pageUrl = urls[i];
        const context = await browser.newContext({
          viewport: { width: 1280, height: 720 },
          deviceScaleFactor,
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 CloneAI/1.0',
        });
        const page = await context.newPage();
        const networkImages = [];
        const seenNet = new Set();

        page.on('response', (res) => {
          try {
            const ct = (res.headers()['content-type'] || '').split(';')[0].trim().toLowerCase();
            if (!ct.startsWith('image/')) return;
            const u = res.url();
            if (!u || seenNet.size >= maxNet || seenNet.has(u)) return;
            seenNet.add(u);
            networkImages.push({ url: u, contentType: ct, status: res.status() });
          } catch {
            /* ignore */
          }
        });

        try {
          await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: navigationTimeoutMs });
          await page.waitForTimeout(400);

          await page.evaluate(async () => {
            await new Promise((resolve) => {
              const step = () => {
                const sh = Math.max(
                  document.body?.scrollHeight || 0,
                  document.documentElement?.scrollHeight || 0
                );
                const y = window.scrollY + window.innerHeight;
                window.scrollBy(0, Math.floor(window.innerHeight * 0.92));
                if (y >= sh - 4 || window.scrollY + window.innerHeight >= sh - 2) {
                  window.scrollTo(0, 0);
                  resolve();
                  return;
                }
                setTimeout(step, 180);
              };
              step();
            });
          });

          await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
          await page.waitForTimeout(350);

          const evaluated = await page.evaluate(
            ({ maxBg: mb }) => {
              function abs(u) {
                try {
                  return new URL(u, location.href).href;
                } catch {
                  return null;
                }
              }

              const records = [];
              const seen = new Set();
              function add(url, method, extra = null) {
                if (!url || url.startsWith('data:') || url.startsWith('blob:')) return;
                const key = `${method}|${url}`;
                if (seen.has(key)) return;
                seen.add(key);
                records.push({ url, method, extra });
              }

              for (const img of document.images) {
                if (img.currentSrc) add(img.currentSrc, 'src');
                if (img.src && img.src !== img.currentSrc) add(img.src, 'src');
                const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset');
                if (ss) {
                  for (const part of ss.split(',')) {
                    const raw = part.trim().split(/\s+/)[0];
                    if (raw) {
                      const u = abs(raw);
                      if (u) add(u, 'srcset');
                    }
                  }
                }
                for (const a of [
                  'data-src',
                  'data-lazy-src',
                  'data-original',
                  'data-bg',
                  'data-background',
                  'data-background-image',
                ]) {
                  const v = img.getAttribute(a);
                  if (v) {
                    const u = abs(v.split(/\s+/)[0]);
                    if (u) add(u, 'data-attr', { attr: a });
                  }
                }
              }

              for (const srcEl of document.querySelectorAll('picture source[srcset], picture source[src]')) {
                const st = srcEl.getAttribute('srcset');
                if (st) {
                  for (const part of st.split(',')) {
                    const raw = part.trim().split(/\s+/)[0];
                    if (raw) {
                      const u = abs(raw);
                      if (u) add(u, 'srcset');
                    }
                  }
                }
                const s = srcEl.getAttribute('src');
                if (s) {
                  const u = abs(s);
                  if (u) add(u, 'src');
                }
              }

              for (const v of document.querySelectorAll('video')) {
                const poster = v.getAttribute('poster');
                if (poster) {
                  const u = abs(poster);
                  if (u) add(u, 'poster');
                }
                if (v.src) add(v.src, 'src');
              }
              for (const s of document.querySelectorAll('video source[src]')) {
                const u = abs(s.getAttribute('src'));
                if (u) add(u, 'src');
              }

              for (const l of document.querySelectorAll(
                'link[rel~="icon"], link[rel~="apple-touch-icon"], link[rel~="mask-icon"], link[rel~="preload"][as="image"]'
              )) {
                const h = l.getAttribute('href');
                if (h) {
                  const u = abs(h);
                  if (u) add(u, 'meta');
                }
              }

              for (const m of document.querySelectorAll(
                'meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"], meta[property="twitter:image"]'
              )) {
                const c = m.getAttribute('content');
                if (c) {
                  const u = abs(c);
                  if (u) add(u, 'meta');
                }
              }

              const bgUrls = new Set();
              let elCount = 0;
              for (const el of document.querySelectorAll('body *')) {
                if (elCount >= mb) break;
                elCount += 1;
                let bg;
                try {
                  bg = getComputedStyle(el).backgroundImage;
                } catch {
                  continue;
                }
                if (!bg || bg === 'none') continue;
                const re = /url\(\s*["']?([^"')]+)["']?\s*\)/g;
                let mm;
                while ((mm = re.exec(bg)) !== null) {
                  const raw = (mm[1] || '').trim();
                  if (raw.startsWith('data:')) continue;
                  const u = abs(raw);
                  if (u) bgUrls.add(u);
                }
              }
              for (const u of bgUrls) add(u, 'css-bg');

              const svgUses = [];
              for (const u of document.querySelectorAll('use')) {
                const ref = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
                if (!ref) continue;
                svgUses.push(ref);
                if (ref.startsWith('#')) continue;
                const url = abs(ref.split('#')[0]);
                if (url) add(url, 'svg-use', { fragment: ref.includes('#') ? `#${ref.split('#').pop()}` : '' });
              }

              const inlineSvgs = [];
              let si = 0;
              for (const svg of document.querySelectorAll('svg')) {
                if (si >= 80) break;
                if (!svg.parentElement || svg.parentElement.closest('svg')) continue;
                try {
                  const xml = svg.outerHTML || '';
                  if (xml.length > 30 && xml.length < 2_500_000) {
                    inlineSvgs.push({ index: si, xml: xml.slice(0, 2_000_000) });
                    si += 1;
                  }
                } catch {
                  /* skip */
                }
              }

              let srcsetCandidates = 0;
              for (const img of document.images) {
                const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
                srcsetCandidates += ss ? ss.split(',').filter((x) => x.trim()).length : 0;
              }
              for (const s of document.querySelectorAll('picture source[srcset]')) {
                const ss = s.getAttribute('srcset') || '';
                srcsetCandidates += ss ? ss.split(',').filter((x) => x.trim()).length : 0;
              }

              return {
                records,
                stats: {
                  documentImagesLength: document.images.length,
                  backgroundImageUniqueCount: bgUrls.size,
                  svgUseRefCount: svgUses.length,
                  srcsetCandidateCount: srcsetCandidates,
                },
                inlineSvgs,
                href: location.href,
              };
            },
            { maxBg }
          );

          const pageSlug = slugFromUrl(pageUrl);
          const svgExtras = (evaluated.inlineSvgs || []).map((s, j) => ({
            name: `svg/inline-${pageSlug}-${String(s.index ?? j).padStart(3, '0')}.svg`,
            buffer: Buffer.from(s.xml, 'utf8'),
            pageUrl,
          }));

          out.perPage.push({
            pageUrl,
            href: evaluated.href || pageUrl,
            stats: evaluated.stats,
            records: evaluated.records,
            networkImages,
            svgFiles: svgExtras.map((x) => ({ name: x.name, pageUrl: x.pageUrl })),
            _svgBuffers: svgExtras,
          });
        } catch (e) {
          out.perPage.push({
            pageUrl,
            error: String(e?.message || e).slice(0, 400),
            records: [],
            networkImages,
            stats: null,
            svgFiles: [],
            _svgBuffers: [],
          });
        } finally {
          await context.close();
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
    await Promise.all(workers);
  } finally {
    await browser.close();
  }

  return out;
}
