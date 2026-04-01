#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..');
dotenv.config({ path: path.join(backendRoot, '.env') });

const appUrl = (process.env.BROWSER_VERIFY_URL || process.argv[2] || 'http://127.0.0.1:3050').replace(/\/$/, '');
const targetUrl = (process.env.BROWSER_VERIFY_TARGET_URL || process.argv[3] || 'https://www.python.org/about/').trim();
const outputDir =
  (process.env.BROWSER_VERIFY_OUTPUT_DIR || path.join(backendRoot, 'data', 'launch-proof')).trim();
const promoCode = (process.env.CLONEAI_PROMO_CODE || '').trim();

fs.mkdirSync(outputDir, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const resultShot = path.join(outputDir, `browser-results-${timestamp}.png`);
const extractionShot = path.join(outputDir, `browser-extraction-${timestamp}.png`);
const failShot = path.join(outputDir, `browser-failure-${timestamp}.png`);

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch (err) {
  console.error(
    JSON.stringify(
      {
        phase: 'browser_launch_failed',
        message: String(err?.message || err),
        hint: 'Run `npm run playwright:install --prefix backend` to install Chromium for repo-owned browser verification.',
      },
      null,
      2
    )
  );
  process.exit(1);
}

const page = await browser.newPage({ viewport: { width: 1440, height: 1800 } });
const apiEvents = [];
const browserErrors = [];
page.on('response', async (response) => {
  const url = response.url();
  if (!/\/api\/(extraction-jobs|analyze|billing\/status)/.test(url)) return;
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }
  apiEvents.push({
    url,
    status: response.status(),
    body: cleanText(body).slice(0, 240),
  });
});
page.on('pageerror', (error) => {
  browserErrors.push({ type: 'pageerror', message: String(error?.message || error) });
});
page.on('console', (msg) => {
  if (!['error', 'warning'].includes(msg.type())) return;
  browserErrors.push({ type: `console:${msg.type()}`, message: cleanText(msg.text()) });
});

try {
  await page.goto(appUrl, { waitUntil: 'networkidle', timeout: 120_000 });
  await page.fill('#url-input', targetUrl);
  if (promoCode) {
    const details = page.locator('#promo-details');
    await details.evaluate((node) => {
      node.open = true;
    });
    await page.fill('#promo-code-input', promoCode);
  }
  await page.click('.scan-mode-pill[data-scan-mode="images"]', { force: true });
  await page.click('.depth-pill[data-depth="shallow"]', { force: true });
  await page.click('.extraction-profile-pill[data-extraction-profile="full_harvest"]', { force: true });

  const harvestToggle = page.locator('#asset-harvest-toggle');
  if (!(await harvestToggle.isChecked())) await harvestToggle.check();

  const servicePackage = page.locator('#service-package-select');
  await servicePackage.selectOption('premium');
  await page.check('#pref-client-delivery');

  await page.click('#analyze-btn', { force: true });

  await page.waitForSelector('#results-section:not([hidden])', {
    timeout: 12 * 60 * 1000,
  });
  await page
    .waitForFunction(
      () => {
        const extraction = document.querySelector('#extraction-results');
        const artifact = document.querySelector('#artifact-panel');
        const zip = document.querySelector('#download-images-btn');
        return (
          (extraction && !extraction.hasAttribute('hidden')) ||
          (artifact && !artifact.hasAttribute('hidden')) ||
          (zip && !zip.hasAttribute('hidden'))
        );
      },
      { timeout: 3 * 60 * 1000 }
    )
    .catch(() => null);
  await page.waitForTimeout(1500);

  const extractionVisible = await page
    .locator('#extraction-results')
    .evaluate((el) => !el.hasAttribute('hidden'));
  const artifactVisible = await page
    .locator('#artifact-panel')
    .evaluate((el) => !el.hasAttribute('hidden'));

  await page.screenshot({ path: resultShot, fullPage: true });
  if (extractionVisible) {
    await page.locator('#extraction-results').screenshot({ path: extractionShot });
  }

  const stats = extractionVisible
    ? await page.$$eval('#extraction-stats-grid .extraction-stat-card', (cards) =>
        cards.map((card) => ({
          label: card.querySelector('.extraction-stat-label')?.textContent?.trim() || '',
          value: card.querySelector('.extraction-stat-value')?.textContent?.trim() || '',
        }))
      )
    : [];

  const artifactButtons = artifactVisible
    ? await page.$$eval('#artifact-panel [data-artifact-download]', (buttons) =>
        buttons.map((button) => button.textContent?.trim() || '')
      )
    : [];

  const extractionButtons = await page.$$eval(
    '#download-images-btn, #download-manifest-btn, #download-images-json-btn, #download-pages-json-btn',
    (buttons) =>
      buttons
        .filter((button) => !button.hasAttribute('hidden'))
        .map((button) => button.textContent?.trim() || '')
  );

  const result = {
    appUrl,
    targetUrl,
    extractionVisible,
    artifactVisible,
    stats,
    extractionSummary: cleanText(await page.locator('#extraction-results-sub').textContent().catch(() => '')),
    extractionNote: cleanText(await page.locator('#extraction-results-note').textContent().catch(() => '')),
    extractionButtons,
    artifactButtons,
    apiEvents,
    browserErrors,
    screenshots: {
      resultShot,
      extractionShot: extractionVisible ? extractionShot : null,
    },
  };

  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
  console.error(
    JSON.stringify(
      {
        phase: 'browser_verify_failed',
        message: String(err?.message || err),
        screenshot: failShot,
      },
      null,
      2
    )
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
