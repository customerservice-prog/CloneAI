import { normalizeUrlKey, hostKeyFromHostname } from './crawlSite.js';

function slugPart(url, max = 40) {
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

async function settle(page, ms = 700) {
  await new Promise((r) => setTimeout(r, ms));
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
}

/**
 * Heuristic Playwright pass: collect theme/demo/template links, click through grids (reset hub each time),
 * optionally walk checkout-style steps. Best-effort for private cloning; not guaranteed for every theme vendor.
 */
export async function runInteractionSuite({
  hubPageUrls = [],
  commercePageUrl = null,
  navigationTimeoutMs = 50000,
  maxHubPages = 12,
  maxThemeClicksPerHub = 100,
  maxCheckoutSteps = 15,
  maxDiscoveredUrlList = 250,
  viewportWidth = 1280,
  viewportHeight = 720,
} = {}) {
  const discovered = new Set();
  const snapshots = [];

  if (process.env.ENABLE_INTERACTION_CRAWL === 'false') {
    return { discoveredUrls: [], snapshots: [] };
  }

  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    return { discoveredUrls: [], snapshots: [], error: 'playwright_missing' };
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let snapSeq = 0;
  function pushSnapshot(name, buffer, url, label) {
    if (!buffer?.length) return;
    snapSeq += 1;
    snapshots.push({
      name,
      buffer,
      url,
      label,
    });
  }

  try {
    const hubs = hubPageUrls.slice(0, maxHubPages).filter(Boolean);

    for (const hubUrl of hubs) {
      let origin;
      let allowedKey;
      try {
        const u = new URL(hubUrl);
        origin = u.origin;
        allowedKey = hostKeyFromHostname(u.hostname);
      } catch {
        continue;
      }

      const context = await browser.newContext({
        viewport: { width: viewportWidth, height: viewportHeight },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();

      try {
        await page.goto(hubUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
        await settle(page);

        const hrefList = await page.evaluate((org) => {
          const re =
            /theme|demo|preview|template|skin|variant|layout|starter|install|try it|live preview|view demo|select theme|choose template/i;
          const out = [];
          for (const a of document.querySelectorAll('a[href]')) {
            const h = (a.getAttribute('href') || '').trim();
            if (!h || h.startsWith('javascript:') || h === '#' || h.startsWith('#')) continue;
            const blob = `${h} ${(a.textContent || '').slice(0, 200)} ${a.getAttribute('title') || ''}`;
            if (!re.test(blob)) continue;
            try {
              const abs = new URL(h, location.href).href;
              if (new URL(abs).origin === org) out.push(abs);
            } catch {
              /* skip */
            }
          }
          return [...new Set(out)];
        }, origin);

        for (const h of hrefList) {
          if (discovered.size >= maxDiscoveredUrlList) break;
          const nk = normalizeUrlKey(h);
          if (nk && hostKeyFromHostname(new URL(nk).hostname) === allowedKey) discovered.add(nk);
        }

        const selectorList = [
          'a[href*="theme"]',
          'a[href*="demo"]',
          'a[href*="template"]',
          'a[href*="preview"]',
          '[data-theme]',
          '[data-demo-url]',
          '[data-preview-url]',
          '[data-template-id]',
          '[data-theme-slug]',
        ].join(', ');

        for (let i = 0; i < maxThemeClicksPerHub; i += 1) {
          if (discovered.size >= maxDiscoveredUrlList) break;
          await page.goto(hubUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs }).catch(() => {});
          await settle(page, 500);

          const themeLocator = page.locator(selectorList);
          const nClickable = await themeLocator.count();
          if (i >= nClickable) break;

          const el = themeLocator.nth(i);
          const vis = await el.isVisible().catch(() => false);
          if (!vis) continue;

          try {
            await el.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 18000 }).catch(() => {}),
              el.click({ timeout: 6000 }),
            ]).catch(() => {});
            await settle(page, 900);
            const after = normalizeUrlKey(page.url());
            if (after && hostKeyFromHostname(new URL(after).hostname) === allowedKey) discovered.add(after);
            const buf = await page.screenshot({ fullPage: true, type: 'png' });
            pushSnapshot(
              `snapshots/interaction/${slugPart(hubUrl)}-theme-${String(i + 1).padStart(3, '0')}.png`,
              Buffer.from(buf),
              page.url(),
              `theme-variant-${i + 1}`
            );
          } catch {
            /* next */
          }
        }
      } finally {
        await context.close();
      }
    }

    if (commercePageUrl && maxCheckoutSteps > 0) {
      const ctx2 = await browser.newContext({
        viewport: { width: viewportWidth, height: viewportHeight },
        deviceScaleFactor: 1,
      });
      const p2 = await ctx2.newPage();
      try {
        await p2.goto(commercePageUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
        await settle(p2);

        const looksCommerce = await p2.evaluate(() => {
          const t = document.body?.innerText?.slice(0, 8000) || '';
          return /add to cart|buy now|checkout|view cart|shopping bag|your cart|proceed to checkout|payment|shipping address/i.test(
            t
          );
        });
        const pathCommerce = /cart|checkout|basket|bag|order|payment|shipping|billing/i.test(
          new URL(p2.url()).pathname
        );

        if (looksCommerce || pathCommerce) {
          for (let step = 0; step < maxCheckoutSteps; step += 1) {
            const buf = await p2.screenshot({ fullPage: true, type: 'png' });
            pushSnapshot(
              `snapshots/interaction/checkout-step-${String(step + 1).padStart(2, '0')}.png`,
              Buffer.from(buf),
              p2.url(),
              `checkout-step-${step + 1}`
            );

            const nextLoc = p2
              .getByRole('button', {
                name: /continue|next|proceed|checkout|pay|place order|complete|submit order|confirm/i,
              })
              .first()
              .or(
                p2.getByRole('link', {
                  name: /continue|next|proceed|checkout|pay|place order|complete/i,
                })
              )
              .first();

            if ((await nextLoc.count()) === 0) break;
            try {
              await Promise.all([
                p2.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
                nextLoc.click({ timeout: 10000 }),
              ]);
              await settle(p2, 1000);
            } catch {
              break;
            }
          }
        }
      } catch {
        /* optional checkout */
      } finally {
        await ctx2.close();
      }
    }
  } finally {
    await browser.close();
  }

  return { discoveredUrls: [...discovered], snapshots, error: null };
}
