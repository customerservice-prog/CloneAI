#!/usr/bin/env node
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..');
dotenv.config({ path: path.join(backendRoot, '.env') });

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:3050').replace(/\/$/, '');
const targetUrl = (process.argv[2] || 'https://www.python.org/about/').trim();
const depth = (process.argv[3] || 'deep').trim();
const scanMode = (process.argv[4] || 'images').trim();
const extractionProfile = (process.argv[5] || 'quality_first').trim();
const userId = randomUUID();
const origin = (process.env.TEST_ORIGIN || baseUrl).replace(/\/$/, '');

const headers = {
  Origin: origin,
  'X-CloneAI-User-Id': userId,
};
const ingressKey = (process.env.CLONEAI_INGRESS_KEY || '').trim();
if (ingressKey) headers['X-CloneAI-Key'] = ingressKey;
const ownerToken = (process.env.CLONEAI_OWNER_TOKEN || '').trim();
const promoCode = (process.env.CLONEAI_PROMO_CODE || '').trim();
if (ownerToken) headers['X-CloneAI-Owner-Token'] = ownerToken;
else if (promoCode) headers['X-CloneAI-Promo-Code'] = promoCode;

const form = new FormData();
form.append('url', targetUrl);
form.append('depth', depth);
form.append('scanMode', scanMode);
form.append('extractionProfile', extractionProfile);
form.append('options', JSON.stringify([]));
form.append('comparePair', '0');
form.append('removeImageBackground', '0');
form.append('assetHarvest', '1');
form.append('clientDelivery', '1');
form.append('servicePackage', 'premium');
form.append('hp', '');
if (promoCode && !ownerToken) form.append('promoCode', promoCode);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries(fn, { retries = 6, delayMs = 1500 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

async function getJson(url, init = {}) {
  const res = await withRetries(() => fetch(url, init), { retries: 3, delayMs: 1000 });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { res, json };
}

const created = await withRetries(
  () =>
    getJson(`${baseUrl}/api/extraction-jobs`, {
      method: 'POST',
      headers,
      body: form,
    }),
  { retries: 2, delayMs: 1000 }
);

if (!created.res.ok || !created.json?.jobId) {
  console.error(
    JSON.stringify(
      {
        phase: 'create_failed',
        status: created.res.status,
        response: created.json,
      },
      null,
      2
    )
  );
  process.exit(1);
}

const jobId = created.json.jobId;
let job = null;
for (let attempt = 0; attempt < 240; attempt += 1) {
  const polled = await getJson(`${baseUrl}/api/extraction-jobs/${encodeURIComponent(jobId)}`, {
    headers,
  });
  if (!polled.res.ok || !polled.json?.id) {
    console.error(
      JSON.stringify(
        {
          phase: 'poll_failed',
          attempt,
          status: polled.res.status,
          response: polled.json,
        },
        null,
        2
      )
    );
    process.exit(1);
  }
  job = polled.json;
  if (['completed', 'failed', 'cancelled'].includes(job.status)) break;
  await sleep(2000);
}

if (!job) {
  console.error(JSON.stringify({ phase: 'poll_failed', reason: 'missing_job' }, null, 2));
  process.exit(1);
}

const artifactNames = Array.isArray(job.artifacts) ? job.artifacts.map((item) => item?.name).filter(Boolean) : [];
const assets = job.assets || null;
const summary = {
  jobId: job.id,
  status: job.status,
  targetUrl,
  authMode: ownerToken ? 'owner_token' : promoCode ? 'promo_code' : 'none',
  progress: job.progress || null,
  error: job.error || null,
  assets: assets
    ? {
        crawl_status: assets.crawl_status ?? assets.crawlStatus ?? null,
        extraction_status: assets.extraction_status ?? assets.extractionStatus ?? null,
        download_status: assets.download_status ?? assets.downloadStatus ?? null,
        screenshot_status: assets.screenshot_status ?? assets.screenshotStatus ?? null,
        archive_status: assets.archive_status ?? assets.archiveStatus ?? null,
        manifest_status: assets.manifest_status ?? assets.manifestStatus ?? null,
        report_status: assets.report_status ?? assets.reportStatus ?? null,
        pages_discovered: assets.pages_discovered ?? assets.pagesDiscovered ?? null,
        pages_crawled: assets.pages_crawled ?? assets.pagesCrawled ?? null,
        image_candidates_found: assets.image_candidates_found ?? assets.imageCandidatesFound ?? null,
        images_downloaded: assets.images_downloaded ?? assets.imagesDownloaded ?? null,
        duplicates_skipped: assets.image_duplicates_skipped ?? assets.imageDuplicatesSkipped ?? assets.duplicatesSkipped ?? null,
        asset_failures: assets.asset_failures ?? assets.assetFailures ?? assets.failed ?? null,
        archive_file_count: assets.archive_file_count ?? assets.archiveFileCount ?? assets.count ?? null,
        archive_size_bytes: assets.archive_size_bytes ?? assets.archiveSizeBytes ?? assets.archiveBytes ?? null,
        manifest_count: assets.manifest_count ?? assets.manifestCount ?? null,
        zip_url: assets.zip_url ?? assets.zipUrl ?? assets.artifactUrl ?? null,
        manifests: assets.manifests || null,
        preview_assets: Array.isArray(assets.preview_assets)
          ? assets.preview_assets.length
          : Array.isArray(assets.previewAssets)
            ? assets.previewAssets.length
            : Array.isArray(assets.images)
              ? Math.min(assets.images.length, 24)
              : 0,
      }
    : null,
  artifactNames,
};

console.log(JSON.stringify(summary, null, 2));
