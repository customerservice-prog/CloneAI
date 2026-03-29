/**
 * Full-page PNG screenshots via Playwright (Chromium).
 * Set ENABLE_PAGE_SCREENSHOTS=false to skip. Run once: npx playwright install chromium
 */
export function snapshotZipName(index, pageUrl) {
  try {
    const u = new URL(pageUrl);
    let slug = (u.pathname + u.search).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'index';
    slug = slug.slice(0, 72);
    return `snapshots/${String(index + 1).padStart(3, '0')}-${slug}.png`;
  } catch {
    return `snapshots/${String(index + 1).padStart(3, '0')}.png`;
  }
}

export async function screenshotUrls(urls, {
  concurrency = 8,
  timeoutMs = 45000,
  viewportWidth = 1280,
  viewportHeight = 720,
} = {}) {
  if (process.env.ENABLE_PAGE_SCREENSHOTS === 'false') {
    return urls.map((u) => ({ url: u, buffer: null, error: 'disabled' }));
  }
  if (!urls.length) return [];

  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    return urls.map((u) => ({ url: u, buffer: null, error: 'playwright_not_installed' }));
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const out = new Array(urls.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next;
      next += 1;
      if (i >= urls.length) return;
      const target = urls[i];
      const context = await browser.newContext({
        viewport: { width: viewportWidth, height: viewportHeight },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await new Promise((r) => setTimeout(r, 800));
        const buf = await page.screenshot({ fullPage: true, type: 'png' });
        out[i] = { url: target, buffer: Buffer.from(buf), error: null };
      } catch (e) {
        out[i] = { url: target, buffer: null, error: String(e?.message || e) };
      } finally {
        await context.close();
      }
    }
  }

  try {
    const n = Math.min(concurrency, urls.length);
    await Promise.all(Array.from({ length: n }, () => worker()));
  } finally {
    await browser.close();
  }

  return out;
}
