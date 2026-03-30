import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hostKeyFromHostname } from './crawlSite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STAGE_DEFS = [
  { index: 1, label: 'DOM & landmark mapper' },
  { index: 2, label: 'Layout grid & spacing analyst' },
  { index: 3, label: 'Typography & scale systems' },
  { index: 4, label: 'Font faces & loading patterns' },
  { index: 5, label: 'Color tokens & gradients' },
  { index: 6, label: 'Theme mode scout (light/dark)' },
  { index: 7, label: 'Component & pattern library' },
  { index: 8, label: 'States & micro-interactions' },
  { index: 9, label: 'Content, CTAs & meta copy' },
  { index: 10, label: 'Catalog / cards / pricing grid' },
  { index: 11, label: 'Hidden media hunter' },
  { index: 12, label: 'Full-viewport theme alignment' },
  { index: 13, label: 'Cross-block consistency' },
  { index: 14, label: 'A11y & SEO surface pass' },
];

export function analysisArchiveEnabled() {
  return String(process.env.ANALYSIS_ARCHIVE_ENABLED || 'true').toLowerCase() !== 'false';
}

export function analysisReuseEnabled() {
  if (!analysisArchiveEnabled()) return false;
  return String(process.env.ANALYSIS_REUSE_ENABLED || 'true').toLowerCase() !== 'false';
}

export function analysisFastReplayEnabled() {
  return String(process.env.ANALYSIS_FAST_REPLAY || 'true').toLowerCase() !== 'false';
}

export function analysisCacheMaxAgeMs() {
  const d = Number(process.env.ANALYSIS_CACHE_MAX_AGE_DAYS);
  const days = Number.isFinite(d) && d > 0 ? d : 90;
  return days * 24 * 60 * 60 * 1000;
}

export function getAnalysisBaseDir() {
  const raw = (process.env.ANALYSIS_ARCHIVE_DIR || '').trim();
  if (raw) return path.resolve(raw);
  return path.join(__dirname, 'data', 'analyses');
}

function slugHost(hostname) {
  const h = hostKeyFromHostname(hostname);
  const s = String(h || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '_')
    .slice(0, 200);
  return s || 'unknown';
}

/**
 * @param {object} input
 * @returns {string} sha256 hex
 */
export function buildAnalysisFingerprint(input) {
  const sortedOptions = Array.isArray(input.options)
    ? [...input.options].map(String).sort()
    : [];
  const payload = JSON.stringify({
    u: input.normalizedUrl,
    d: String(input.depth || ''),
    o: sortedOptions,
    c: Boolean(input.comparePair),
    cd: Boolean(input.clientDelivery),
    sp: String(input.servicePackage || ''),
    rib: Boolean(input.removeImageBackground),
    ah: Boolean(input.assetHarvestMode),
    m: String(input.openaiModel || ''),
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * @param {string} urlRaw
 * @returns {{ normalizedUrl: string, hostSlug: string } | null}
 */
export function normalizeUrlForArchive(urlRaw) {
  const trimmed = String(urlRaw || '').trim();
  if (!trimmed) return null;
  const href = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  u.hash = '';
  const normalizedUrl = u.href;
  const hostSlug = slugHost(u.hostname);
  return { normalizedUrl, hostSlug };
}

/**
 * @param {import('express').Request} req
 * @param {object} opts
 * @returns {{ eligible: boolean, normalizedUrl?: string, hostSlug?: string, fingerprint?: string }}
 */
export function buildArchiveLookupContext(req, opts) {
  const files = req.files || [];
  if (files.length > 0) return { eligible: false };
  const url = String(req.body?.url || '').trim();
  if (!url) return { eligible: false };

  const norm = normalizeUrlForArchive(url);
  if (!norm) return { eligible: false };

  const depth = String(req.body?.depth || 'homepage').trim();
  const options = req.body?._options || [];
  const comparePair =
    req.body?.comparePair === '1' ||
    req.body?.comparePair === 'true' ||
    req.body?.comparePair === true;

  const fingerprint = buildAnalysisFingerprint({
    normalizedUrl: norm.normalizedUrl,
    depth,
    options,
    comparePair,
    clientDelivery: Boolean(req._clientDelivery),
    servicePackage: req._servicePackage || '',
    removeImageBackground: Boolean(req._removeImageBackground),
    assetHarvestMode: Boolean(req._assetHarvestMode),
    openaiModel: opts.openaiModel,
  });

  return {
    eligible: true,
    normalizedUrl: norm.normalizedUrl,
    hostSlug: norm.hostSlug,
    fingerprint,
  };
}

/**
 * @param {string} baseDir
 * @param {string} hostSlug
 * @param {string} fingerprint
 * @returns {object | null}
 */
export function loadLatestSnapshot(baseDir, hostSlug, fingerprint) {
  const dir = path.join(baseDir, hostSlug, fingerprint);
  const indexPath = path.join(dir, 'index.json');
  if (!fs.existsSync(indexPath)) return null;
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    return null;
  }
  const latestId = index?.latestRunId;
  if (!latestId || typeof latestId !== 'string') return null;
  const runPath = path.join(dir, 'runs', `${latestId}.json`);
  if (!fs.existsSync(runPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(runPath, 'utf8'));
  } catch {
    return null;
  }
}

export function isSnapshotFresh(snap, maxAgeMs) {
  const t = Date.parse(snap?.savedAt || '');
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= maxAgeMs;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * @param {object} params
 * @param {string} params.baseDir
 * @param {string} params.hostSlug
 * @param {string} params.fingerprint
 * @param {object} params.record — must include fullText, scraperMeta, assetsPayload, etc.
 * @returns {string | null} run id
 */
export function saveAnalysisSnapshot({ baseDir, hostSlug, fingerprint, record }) {
  if (!analysisArchiveEnabled()) return null;
  try {
    const dir = path.join(baseDir, hostSlug, fingerprint);
    const runsDir = path.join(dir, 'runs');
    ensureDir(runsDir);

    const runId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const runPath = path.join(runsDir, `${runId}.json`);
    fs.writeFileSync(runPath, JSON.stringify(record, null, 2), 'utf8');

    const indexPath = path.join(dir, 'index.json');
    let prevRuns = [];
    if (fs.existsSync(indexPath)) {
      try {
        const prev = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        if (Array.isArray(prev.runs)) prevRuns = prev.runs;
      } catch {
        /* ignore */
      }
    }
    prevRuns.push({
      id: runId,
      savedAt: record.savedAt,
      normalizedUrl: record.normalizedUrl,
      depth: record.depth,
    });
    const trimmed = prevRuns.slice(-80);
    fs.writeFileSync(
      indexPath,
      JSON.stringify(
        {
          version: 1,
          hostSlug,
          fingerprint,
          latestRunId: runId,
          runs: trimmed,
        },
        null,
        2
      ),
      'utf8'
    );
    return runId;
  } catch (e) {
    console.error('[analysisArchive] save failed', e?.message || e);
    return null;
  }
}

/**
 * Replays the same SSE shape as a live run (stages + meta + streamed text).
 * @param {object} o
 * @param {(obj: object) => void} o.send
 * @param {(a: number, b: number) => Promise<void>} o.jitter
 * @param {object} o.snapshot
 * @param {number} o.reportWriterStageIndex
 * @param {Record<string, unknown>} o.billingMetaThin
 */
export async function replayAnalysisFromArchive(o) {
  const { send, jitter, snapshot, reportWriterStageIndex, billingMetaThin } = o;
  const scraperMeta = {
    ...(snapshot.scraperMeta && typeof snapshot.scraperMeta === 'object' ? snapshot.scraperMeta : {}),
    analysisFromArchive: true,
    analysisArchiveSavedAt: snapshot.savedAt || null,
    analysisArchiveNotice:
      'This report was served from a saved analysis for this URL and settings — no new AI call was made. Run a fresh scan anytime for an updated crawl and asset bundle.',
  };
  const assetsPayload =
    snapshot.assetsPayload && typeof snapshot.assetsPayload === 'object'
      ? {
          ...snapshot.assetsPayload,
          token: null,
          fromArchive: true,
        }
      : {
          count: 0,
          imageCount: 0,
          snapshotCount: 0,
          token: null,
          filename: 'site-assets.zip',
          skipped: 0,
          fromArchive: true,
        };

  send({ type: 'stage', index: 0, phase: 'running', label: 'Multi-page crawl & assets' });
  await jitter(40, 120);
  send({ type: 'stage', index: 0, phase: 'done' });

  send({
    type: 'meta',
    scraper: scraperMeta,
    assets: assetsPayload,
    ...billingMetaThin,
  });

  for (const s of STAGE_DEFS) {
    send({ type: 'stage', index: s.index, phase: 'running', label: s.label });
    await jitter(25, 70);
    send({ type: 'stage', index: s.index, phase: 'done' });
  }

  send({
    type: 'stage',
    index: 15,
    phase: 'running',
    label: 'Chief architect — every specialist reports here',
  });
  await jitter(40, 100);
  send({
    type: 'stage',
    index: 15,
    phase: 'done',
    label: 'Chief architect — stack approved for final brief',
  });
  send({
    type: 'stage',
    index: 8,
    phase: 'running',
    label: 'States & micro-interactions (chief-requested revisit)',
  });
  await jitter(28, 70);
  send({
    type: 'stage',
    index: 8,
    phase: 'done',
    label: 'States & micro-interactions (chief-requested revisit)',
  });

  send({
    type: 'stage',
    index: reportWriterStageIndex,
    phase: 'running',
    label: 'Report writer (saved analysis)',
  });

  const text = String(snapshot.fullText || '');
  const chunk = Math.max(80, Math.min(400, Number(process.env.ANALYSIS_REPLAY_CHUNK_CHARS) || 200));
  for (let i = 0; i < text.length; i += chunk) {
    send({ type: 'text', content: text.slice(i, i + chunk) });
    if (i + chunk < text.length) {
      await jitter(0, 12);
    }
  }

  send({
    type: 'stage',
    index: reportWriterStageIndex,
    phase: 'done',
    label: 'Report writer (saved analysis)',
  });
  send({ type: 'done' });
}
