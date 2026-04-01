import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import axios from 'axios';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import {
  captchaRequiredForAnalyze,
  verifyTurnstileIfConfigured,
  noteSuccessfulAnalyzeForCaptcha,
} from './turnstileGate.js';
import { optimizeImageForModel } from './imageOptimize.js';
import { assertUrlSafeForServerFetch, isUnsafeIpLiteral } from './ssrf.js';
import {
  collectImageUrls,
  collectStylesheetHrefs,
  extractImageUrlsFromCss,
  extractImportUrlsFromCss,
  fetchHarvestedImages,
  zipImageEntries,
  buildImageManifestForPrompt,
  normalizeHarvestUrlKey,
} from './imageHarvest.js';
import { effectiveHarvestImageCap, effectiveHarvestZipCap } from './harvestBudget.js';
import { crawlFromSeed, normalizeUrlKey, fetchCrawlPageHtml } from './crawlSite.js';
import { crawlMaxPagesEnvCap, maxCrawlPagesForRun, crawlPageCapForRequest } from './crawlLimits.js';
import { cleanHtmlForModel } from './htmlCleanForModel.js';
import { tryAcquireAnalyzeSlot, releaseAnalyzeSlot } from './analyzeSlots.js';
import { estimateOpenAiUsd } from './aiCostEstimate.js';
import { openAiChatCompletionsRequest } from './aiChatProvider.js';
import { runInteractionSuite } from './playwrightInteraction.js';
import { screenshotUrls, snapshotZipName } from './screenshotPages.js';
import {
  isBillingEnabled,
  normalizeUserId,
  tryBeginRun,
  abortRun,
  getUsageSnapshot,
  getUsageSnapshotSync,
  getAnalyticsSnapshotSync,
  evaluateAnalyzeFeatureGate,
  PLANS,
  recordProductEvent,
} from './billingService.js';
import {
  postStripeWebhook,
  getBillingStatus,
  postBillingCheckout,
  getBillingAnalytics,
  postBillingClaimAccount,
  postAuthLogin,
} from './billingHttp.js';
import { appendLeadRecord } from './leadsStore.js';
import { promoMatchesRequest, configuredPromoCode } from './promoCode.js';
import { probeSinkMiddleware } from './probeSink.js';
import { resolveRootGet, formatRootLandingHtml, mergeStaticEnvWithSiteDefaults } from './rootRedirect.js';
import {
  analysisReuseEnabled,
  analysisFastReplayEnabled,
  analysisCacheMaxAgeMs,
  getAnalysisBaseDir,
  buildArchiveLookupContext,
  loadLatestSnapshot,
  isSnapshotFresh,
  saveAnalysisSnapshot,
  replayAnalysisFromArchive,
} from './analysisArchive.js';
import { processSiteAssetZipBuffer } from './processAssetZip.js';
import {
  getSiteAssetDownload,
  createSiteAssetDownload,
  startSiteAssetDownloadJanitor,
} from './siteAssetDownloads.js';
import {
  getExtractionJobsBaseDir,
  createExtractionJob,
  loadExtractionJob,
  loadExtractionJobInput,
  updateExtractionJob,
  appendExtractionJobEvent,
  readExtractionJobEventsSlice,
  saveExtractionJobArtifact,
  getExtractionJobArtifactPath,
  listExtractionJobs,
  listExtractionJobsForUser,
} from './extractionJobs.js';

dotenv.config();

const isProd = process.env.NODE_ENV === 'production';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const spaRoot = path.join(__dirname, 'public');
const spaIndex = path.join(spaRoot, 'index.html');
const serveSpa = isProd && fs.existsSync(spaIndex);

if (isProd && !serveSpa) {
  console.warn(
    '[cloneai] No SPA bundle at public/index.html — GET / will not serve the app. Use the repo-root Dockerfile (see render.yaml), or set STATIC_APP_URL / APEX_STATIC_FALLBACK_URL so apex traffic redirects to your static host.'
  );
}

const app = express();
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

(function applyTrustProxy() {
  const raw = (process.env.TRUST_PROXY || '').trim().toLowerCase();
  if (!raw) {
    if (isProd) app.set('trust proxy', 1);
    return;
  }
  if (raw === 'false' || raw === '0' || raw === 'no') {
    app.set('trust proxy', false);
    return;
  }
  if (raw === 'true' || raw === 'yes') {
    app.set('trust proxy', true);
    return;
  }
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) {
    app.set('trust proxy', n);
  }
})();

function isLoopbackRequest(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function enforceHttpsUnlessLocal(req, res, next) {
  if (!isProd) return next();
  if (process.env.RELAX_HTTPS_ENFORCEMENT === 'true') return next();
  if (isLoopbackRequest(req)) return next();
  const xf = (req.get('x-forwarded-proto') || '').split(',')[0]?.trim();
  const secure = req.secure === true || xf === 'https';
  if (secure) return next();
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'warn',
      msg: 'https_required_blocked',
      ip,
    })
  );
  res.status(403).json({ error: 'HTTPS is required.' });
}

app.use(enforceHttpsUnlessLocal);
app.use(probeSinkMiddleware);

app.post(
  '/api/billing/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    postStripeWebhook(req, res).catch((e) => {
      console.error('[billing] webhook route', e);
      if (!res.headersSent) res.status(500).send('error');
    });
  }
);
const envPortRaw = process.env.PORT;
const hasExplicitPort = envPortRaw != null && String(envPortRaw).trim() !== '';
const basePort = hasExplicitPort ? Number(envPortRaw) : 3001;
let listenPort = basePort;
const LISTEN_PORT_TRIES = 50;

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://[::1]:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://[::1]:4173',
];

function isLocalDevBrowserOrigin(origin) {
  try {
    const u = new URL(origin);
    return (
      u.protocol === 'http:' &&
      (u.hostname === 'localhost' ||
        u.hostname === '127.0.0.1' ||
        u.hostname === '::1')
    );
  } catch {
    return false;
  }
}

/** No wildcard: list explicit frontend origins. */
function parseCorsOrigins() {
  const raw = process.env.CORS_ORIGINS?.trim();
  if (!raw) {
    if (isProd) return [];
    return DEFAULT_DEV_ORIGINS;
  }
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((o) => {
      if (o === '*') {
        console.warn('CORS_ORIGINS must not use *. Remove * and list exact frontend URLs.');
        return false;
      }
      return true;
    });
  return list;
}

const corsOrigins = parseCorsOrigins();

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (!isProd && !process.env.CORS_ORIGINS?.trim() && isLocalDevBrowserOrigin(origin)) {
        return callback(null, true);
      }
      if (corsOrigins.length === 0) {
        if (isProd) {
          console.warn('CORS: set CORS_ORIGINS to your frontend URL(s).');
          return callback(null, false);
        }
        return callback(null, DEFAULT_DEV_ORIGINS.includes(origin));
      }
      return callback(null, corsOrigins.includes(origin));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'X-CloneAI-Key',
      'X-CloneAI-User-Id',
      'X-CloneAI-Promo-Code',
    ],
    maxAge: 86400,
  })
);

const JSON_BODY_MAX = String(process.env.JSON_BODY_LIMIT || '8mb').trim() || '8mb';
app.use(express.json({ limit: JSON_BODY_MAX }));

const GLOBAL_RATE_PER_MINUTE = Math.min(
  200,
  Math.max(10, Number(process.env.GLOBAL_RATE_LIMIT_PER_MINUTE) || 60)
);
const globalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: GLOBAL_RATE_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    req.method === 'OPTIONS' ||
    req.path === '/api/billing/webhook' ||
    req.path === '/api/health',
  message: { error: 'Too many requests. Please wait and try again.' },
});
app.use(globalApiLimiter);

const RATE_PER_MINUTE = Math.min(
  15,
  Math.max(3, Number(process.env.RATE_LIMIT_PER_MINUTE) || 10)
);

const DAILY_MAX = Math.min(
  5000,
  Math.max(20, Number(process.env.RATE_LIMIT_DAILY_PER_IP) || 200)
);

const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: `Rate limit: max ${RATE_PER_MINUTE} analyses per minute. Try again shortly.` },
});

const analyzeDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: DAILY_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Daily analysis limit reached for this network. Try again tomorrow.' },
});

const analyticsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many analytics events. Try again shortly.' },
});

const leadsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many lead submissions from this network. Try again later.' },
});

const authLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a few minutes.' },
});

const ASSET_PIPELINE_RATE_PER_MINUTE = Math.min(
  30,
  Math.max(3, Number(process.env.ASSET_PIPELINE_RATE_PER_MINUTE) || 12)
);
const assetPipelineLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: ASSET_PIPELINE_RATE_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many asset enhancements. Try again in a minute.' },
});

const MAX_URL_LENGTH = 2048;
const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 10,
    fields: 32,
    fieldSize: 128 * 1024,
    parts: 40,
  },
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase();
    if (ALLOWED_IMAGE_MIMES.has(mime)) return cb(null, true);
    cb(new Error('UNSUPPORTED_UPLOAD_TYPE'));
  },
});

/** True when OPENAI_API_KEY looks like a real key (matches analyze / revise gates). */
function isOpenAiConfigured() {
  const k = (process.env.OPENAI_API_KEY || '').trim();
  return Boolean(k && k !== 'your_key_here' && !k.startsWith('sk-your'));
}

function requireIngressKey(req, res, next) {
  const expected = process.env.CLONEAI_INGRESS_KEY?.trim();
  if (!expected) return next();
  const sent = req.get('x-cloneai-key');
  if (sent !== expected) {
    res.status(403).json({
      code: 'INGRESS_FORBIDDEN',
      error:
        'Missing or wrong API key. Set VITE_CLONEAI_KEY in the frontend to match CLONEAI_INGRESS_KEY on the server.',
    });
    return;
  }
  next();
}

/** In production, POST /api/analyze must include an Origin that matches CORS_ORIGINS (stops simple scripted abuse with spoofed cost). */
function requireProductionBrowserOrigin(req, res, next) {
  if (!isProd) return next();
  if (process.env.RELAX_ANALYZE_ORIGIN_CHECK === 'true') return next();
  if (!corsOrigins.length) {
    res.status(403).json({ error: 'Forbidden.' });
    return;
  }
  const origin = req.get('origin');
  if (!origin || !corsOrigins.includes(origin)) {
    logEvent('warn', 'analyze_blocked_origin', { ip: clientIp(req), origin: origin || null });
    res.status(403).json({ error: 'Forbidden.' });
    return;
  }
  next();
}

const HTML_FETCH_TIMEOUT_MS = Math.min(
  20000,
  Math.max(8000, Number(process.env.HTML_FETCH_TIMEOUT_MS) || 15000)
);
/** HTML kept for URL discovery (images, links). Default 8MB; cap 25MB. */
const MAX_HTML_BYTES = Math.min(
  25 * 1024 * 1024,
  Math.max(100_000, Number(process.env.MAX_HTML_BYTES) || 8 * 1024 * 1024)
);
const HTML_FETCH_MAX_CONTENT_LENGTH = Math.min(
  50 * 1024 * 1024,
  Math.max(MAX_HTML_BYTES, Number(process.env.HTML_FETCH_MAX_CONTENT_LENGTH) || MAX_HTML_BYTES)
);
const MAX_HTML_FOR_MODEL = Math.min(
  250_000,
  Math.max(40_000, Number(process.env.MAX_HTML_FOR_MODEL) || 120_000)
);

/** Unset, blank, 0, or invalid = no cap (fetch every URL discovered in HTML). */
function parseUnlimitedPositiveInt(envVal) {
  if (envVal === undefined || envVal === null) return Number.MAX_SAFE_INTEGER;
  const s = String(envVal).trim();
  if (s === '' || s === '0') return Number.MAX_SAFE_INTEGER;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.floor(n);
}

const IMAGE_HARVEST_MAX = parseUnlimitedPositiveInt(process.env.IMAGE_HARVEST_MAX);
const _rawPerImage = Number(process.env.IMAGE_HARVEST_MAX_BYTES);
const IMAGE_HARVEST_MAX_BYTES = Math.max(
  512 * 1024,
  Number.isFinite(_rawPerImage) && _rawPerImage > 0 ? _rawPerImage : 50 * 1024 * 1024
);
const IMAGE_HARVEST_ZIP_CAP = parseUnlimitedPositiveInt(process.env.IMAGE_HARVEST_ZIP_CAP);
const IMAGE_HARVEST_CONCURRENCY = Math.min(
  32,
  Math.max(2, Number(process.env.IMAGE_HARVEST_CONCURRENCY) || 12)
);

const HARVEST_CSS_MAX_SHEETS = Math.max(
  8,
  Math.min(150, Number(process.env.HARVEST_CSS_MAX_SHEETS) || 80)
);
const HARVEST_CSS_MAX_BYTES = Math.max(
  80_000,
  Math.min(6 * 1024 * 1024, Number(process.env.HARVEST_CSS_MAX_BYTES) || 2 * 1024 * 1024)
);
const HARVEST_CSS_FETCH_CONCURRENCY = Math.min(
  16,
  Math.max(2, Number(process.env.HARVEST_CSS_FETCH_CONCURRENCY) || 8)
);

const HTML_MODEL_MAX_CHARS_PER_PAGE = Math.min(
  150_000,
  Math.max(20_000, Number(process.env.HTML_MODEL_MAX_CHARS_PER_PAGE) || 96_000)
);

/** Progress UI: 0 = crawl, 1–14 = specialists, 15 = chief architect, 16 = OpenAI report writer */
const REPORT_WRITER_STAGE_INDEX = 16;
const CHIEF_ARCHITECT_STAGE_INDEX = 15;
/** Specialist row to “re-run” after chief review (theater only — no extra model call). */
const CHIEF_REVISIT_AGENT_INDEX = 8;

/** When Asset Harvest mode is on, trim HTML sent to the model to save tokens (images still use full HTML). */
const ASSET_HARVEST_HTML_MODEL_CHARS = Math.min(
  HTML_MODEL_MAX_CHARS_PER_PAGE,
  Math.max(12_000, Number(process.env.ASSET_HARVEST_HTML_MODEL_CHARS) || 32_000)
);

const CRAWL_MAX_WALL_CLOCK_MS = Math.min(
  600_000,
  Math.max(30_000, Number(process.env.CRAWL_MAX_DURATION_MS) || 120_000)
);

const MAX_ANALYSIS_IMAGES = Math.min(12, Math.max(1, Number(process.env.MAX_ANALYSIS_IMAGES) || 8));

const MAX_OPENAI_REQUEST_JSON_BYTES = Math.min(
  24 * 1024 * 1024,
  Math.max(2 * 1024 * 1024, Number(process.env.MAX_OPENAI_REQUEST_JSON_BYTES) || 14 * 1024 * 1024)
);

const GLOBAL_BURST_WINDOW_MS = Math.min(
  180_000,
  Math.max(20_000, Number(process.env.GLOBAL_ANALYZE_BURST_WINDOW_MS) || 60_000)
);
const GLOBAL_BURST_MAX = Math.min(
  500,
  Math.max(8, Number(process.env.GLOBAL_ANALYZE_BURST_MAX) || 80)
);
const globalAnalyzeBurstTimestamps = [];

function takeGlobalAnalyzeBurstSlot() {
  const now = Date.now();
  while (
    globalAnalyzeBurstTimestamps.length &&
    globalAnalyzeBurstTimestamps[0] < now - GLOBAL_BURST_WINDOW_MS
  ) {
    globalAnalyzeBurstTimestamps.shift();
  }
  if (globalAnalyzeBurstTimestamps.length >= GLOBAL_BURST_MAX) return false;
  globalAnalyzeBurstTimestamps.push(now);
  return true;
}

/** Undo last burst reservation (e.g. validation failed before SSE started). */
function refundGlobalAnalyzeBurstSlot() {
  globalAnalyzeBurstTimestamps.pop();
}

const GLOBAL_ANALYZE_MAX_IN_FLIGHT = Math.min(
  500,
  Math.max(2, Number(process.env.GLOBAL_ANALYZE_MAX_IN_FLIGHT) || 32)
);
let globalAnalyzeInFlight = 0;

function tryAcquireGlobalAnalyzeInFlightSlot() {
  if (globalAnalyzeInFlight >= GLOBAL_ANALYZE_MAX_IN_FLIGHT) return false;
  globalAnalyzeInFlight += 1;
  return true;
}

function releaseGlobalAnalyzeInFlightSlot() {
  globalAnalyzeInFlight = Math.max(0, globalAnalyzeInFlight - 1);
}
const CRAWL_FETCH_CONCURRENCY = Math.min(40, Math.max(1, Number(process.env.CRAWL_FETCH_CONCURRENCY) || 20));
const CRAWL_SCREENSHOT_CONCURRENCY = Math.min(
  24,
  Math.max(1, Number(process.env.CRAWL_SCREENSHOT_CONCURRENCY) || 10)
);
const SCREENSHOT_TIMEOUT_MS = Math.min(
  120000,
  Math.max(15000, Number(process.env.SCREENSHOT_TIMEOUT_MS) || 50000)
);

const INTERACTION_HUB_PAGES = Math.min(25, Math.max(1, Number(process.env.INTERACTION_HUB_PAGES) || 12));
const INTERACTION_THEME_CLICKS_PER_HUB = Math.min(
  200,
  Math.max(5, Number(process.env.INTERACTION_THEME_CLICKS_PER_HUB) || 100)
);
const INTERACTION_CHECKOUT_MAX_STEPS = Math.min(
  30,
  Math.max(2, Number(process.env.INTERACTION_CHECKOUT_MAX_STEPS) || 15)
);
const INTERACTION_EXTRA_URL_CAP = Math.min(
  300,
  Math.max(10, Number(process.env.INTERACTION_EXTRA_URL_CAP) || 120)
);

const MAX_REDIRECTS = Math.min(5, Math.max(0, Number(process.env.HTML_FETCH_MAX_REDIRECTS) || 2));

const ENABLE_ASSET_PIPELINE_API =
  String(process.env.ENABLE_ASSET_PIPELINE_API || 'true').toLowerCase() !== 'false';
const ASSET_PIPELINE_MAX_ZIP_BYTES = Math.min(
  150 * 1024 * 1024,
  Math.max(5 * 1024 * 1024, Number(process.env.ASSET_PIPELINE_MAX_ZIP_BYTES) || 90 * 1024 * 1024)
);
const ASSET_PIPELINE_MAX_RASTER = Math.min(
  2000,
  Math.max(10, Number(process.env.ASSET_PIPELINE_MAX_RASTER) || 500)
);
startSiteAssetDownloadJanitor();
const extractionJobsBaseDir = getExtractionJobsBaseDir();
const EXTRACTION_JOB_RUNNER_CONCURRENCY = Math.min(
  4,
  Math.max(1, Number(process.env.EXTRACTION_JOB_RUNNER_CONCURRENCY) || 1)
);

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function logEvent(level, msg, extra = {}) {
  const { ip, ...rest } = extra;
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...(ip ? { ip } : {}),
      ...rest,
    })
  );
}

app.use((req, res, next) => {
  const started = Date.now();
  const p = req.path || '';
  res.on('finish', () => {
    logEvent('info', 'http_request_close', {
      ip: clientIp(req),
      method: req.method,
      path: p,
      status: res.statusCode,
      ms: Date.now() - started,
      userId: normalizeUserId(req.get('x-cloneai-user-id')) || undefined,
    });
  });
  next();
});

function hostKey(h) {
  return String(h || '')
    .replace(/^www\./i, '')
    .toLowerCase();
}

function normalizeAndValidateUrlShape(raw) {
  const s = (raw || '').trim();
  if (!s) return { ok: true, url: '' };
  if (s.length > MAX_URL_LENGTH) {
    return { ok: false, error: `URL is too long (max ${MAX_URL_LENGTH} characters).` };
  }
  let parsed;
  try {
    const withProto = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(s) ? s : `https://${s}`;
    parsed = new URL(withProto);
  } catch {
    return { ok: false, error: 'Invalid URL. Example: https://example.com' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only http and https URLs are allowed.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URLs with embedded credentials are not allowed.' };
  }
  const host = parsed.hostname;
  if (net.isIP(host) && isUnsafeIpLiteral(host)) {
    return { ok: false, error: 'That address is not allowed.' };
  }
  return { ok: true, url: parsed.toString() };
}

async function validateAnalyzeRequest(req, res, next) {
  try {
    const hp = (req.body.hp ?? req.body.honeypot ?? '').toString().trim();
    if (hp.length > 0) {
      logEvent('warn', 'analyze_honeypot_triggered', { ip: clientIp(req) });
      res.status(400).json({ error: 'Request rejected.' });
      return;
    }

    const ipGate = clientIp(req);
    req._promoValid = promoMatchesRequest(req);
    if (!req._promoValid && captchaRequiredForAnalyze(ipGate)) {
      const token = String(
        req.body.cf_turnstile_response || req.body['cf-turnstile-response'] || ''
      ).trim();
      const v = await verifyTurnstileIfConfigured(token, ipGate);
      if (!v.ok) {
        logEvent('warn', 'analyze_turnstile_failed', { ip: ipGate });
        res.status(400).json({ error: v.error || 'Verification failed.' });
        return;
      }
    }

    const urlCheck = normalizeAndValidateUrlShape(req.body.url || '');
    if (!urlCheck.ok) {
      res.status(400).json({ error: urlCheck.error });
      return;
    }
    req.body.url = urlCheck.url;

    if (req.body.url) {
      const ssrf = await assertUrlSafeForServerFetch(req.body.url);
      if (!ssrf.ok) {
        res.status(400).json({ error: ssrf.error });
        return;
      }
    }

    const depth = String(req.body.depth || 'homepage').trim();
    if (!['homepage', 'shallow', 'deep'].includes(depth)) {
      res.status(400).json({ error: 'Invalid scan depth.' });
      return;
    }
    req.body.depth = depth;

    const scanModeRaw = String(req.body.scanMode || req.body.scan_mode || 'elite').trim().toLowerCase();
    let scanMode = 'elite';
    if (scanModeRaw === 'images') scanMode = 'images';
    else if (scanModeRaw === 'screenshots') scanMode = 'screenshots';
    req.body.scanMode = scanMode;
    req._scanMode = scanMode;

    if (scanMode === 'screenshots') {
      if (!(req.body.url || '').trim()) {
        res.status(400).json({ error: 'Screenshot sweep requires a website URL.' });
        return;
      }
      if ((req.files || []).length > 0) {
        res.status(400).json({
          error: 'Screenshot sweep cannot be combined with image uploads. Use the URL field only.',
        });
        return;
      }
    }

    let options = [];
    try {
      options = JSON.parse(req.body.options || '[]');
    } catch {
      res.status(400).json({ error: 'Invalid analysis options payload.' });
      return;
    }
    if (!Array.isArray(options)) {
      res.status(400).json({ error: 'Analysis options must be a JSON array.' });
      return;
    }
    req.body._options = options;

    const exProf = String(req.body.extractionProfile || req.body.extraction_profile || 'standard')
      .trim()
      .toLowerCase();
    const allowedEx = new Set(['quick_brief', 'standard', 'full_harvest', 'quality_first']);
    req._extractionProfile = allowedEx.has(exProf) ? exProf : 'standard';

    req._removeImageBackground = ['1', 'true', 'yes', 'on'].includes(
      String(req.body.removeImageBackground || '').trim().toLowerCase()
    );

    req._clientDelivery = ['1', 'true', 'yes', 'on'].includes(
      String(req.body.clientDelivery || '').trim().toLowerCase()
    );
    const servicePackage = String(req.body.servicePackage || '').trim().toLowerCase();
    req._servicePackage = ['basic', 'standard', 'premium'].includes(servicePackage) ? servicePackage : '';

    const harvestFromBody = ['1', 'true', 'yes', 'on'].includes(
      String(req.body.assetHarvest || req.body.deepAssetHarvest || '').trim().toLowerCase()
    );
    req._assetHarvestMode =
      harvestFromBody || (req._scanMode === 'images' && Boolean((req.body.url || '').trim()));
    if (
      ['full_harvest', 'quality_first'].includes(req._extractionProfile) &&
      (req.body.url || '').trim() &&
      req._scanMode !== 'screenshots'
    ) {
      req._assetHarvestMode = true;
    }
    if (
      req._privilegedAnalyze &&
      !['full_harvest', 'quality_first'].includes(req._extractionProfile) &&
      (req.body.url || '').trim()
    ) {
      req._extractionProfile = 'quality_first';
      if (req._scanMode !== 'screenshots') req._assetHarvestMode = true;
    }

    const files = req.files || [];
    if (!req.body.url && !files.length) {
      res.status(400).json({ error: 'Enter a URL and/or upload at least one image.' });
      return;
    }
    if (files.length > MAX_ANALYSIS_IMAGES) {
      res.status(400).json({
        error: `Too many images for one analysis (max ${MAX_ANALYSIS_IMAGES}). Remove some and try again.`,
      });
      return;
    }

    let i = 0;
    for (const f of files) {
      const mime = (f.mimetype || '').toLowerCase();
      if (!ALLOWED_IMAGE_MIMES.has(mime)) {
        res.status(400).json({ error: `Unsupported file type. Use PNG, JPG, or WebP only.` });
        return;
      }
      if (!bufferLooksLikeImage(f.buffer, mime)) {
        res.status(400).json({ error: 'One or more files are not valid images.' });
        return;
      }
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      f.originalname = `upload-${i}.${ext}`;
      i += 1;
    }

    next();
  } catch (e) {
    logEvent('error', 'validate_analyze_exception', { ip: clientIp(req), detail: String(e?.message || e) });
    res.status(400).json({ error: 'Invalid request.' });
  }
}

function bufferLooksLikeImage(buf, mime) {
  if (!buf || buf.length < 12) return false;
  const b0 = buf[0];
  const b1 = buf[1];
  const b2 = buf[2];
  const b3 = buf[3];
  if (mime === 'image/png' && b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return true;
  if (mime === 'image/jpeg' && b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return true;
  if (mime === 'image/webp' && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return true;
  }
  return false;
}

function analyzeRequestLogger(req, res, next) {
  req._analyzeStartedAt = Date.now();
  logEvent('info', 'analyze_request', {
    ip: clientIp(req),
    scanMode: req._scanMode || 'elite',
    promo: Boolean(req._promoValid),
  });
  next();
}

function reviseRequestLogger(req, res, next) {
  req._analyzeStartedAt = Date.now();
  logEvent('info', 'revise_request', { ip: clientIp(req), promo: Boolean(req._promoValid) });
  next();
}

async function abortBillingIfNeeded(req) {
  const uid = req._billingUserId;
  const r = req._billingReservation;
  if (!uid || !r?.ok) return;
  await abortRun(uid, r);
  req._billingReservation = null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => sleep(a + Math.floor(Math.random() * (b - a + 1)));

const activeExtractionJobIds = new Set();
let extractionJobPumpScheduled = false;

function isTerminalExtractionJobStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function extractionJobArtifactUrl(jobId, artifactName) {
  return `/api/extraction-jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactName)}`;
}

function buildCursorReadyExport(reportText, summary) {
  const url = String(summary?.url || '').trim();
  return [
    '# CloneAI Cursor Export',
    url ? `Source URL: ${url}` : 'Source URL: (none)',
    `Depth: ${String(summary?.depth || 'homepage')}`,
    `Scan mode: ${String(summary?.scanMode || 'elite')}`,
    `Extraction profile: ${String(summary?.extractionProfile || 'standard')}`,
    '',
    'Use the report and manifests in this extraction package as the source of truth.',
    '',
    reportText,
  ].join('\n');
}

function buildAiHandoffExport(reportText, summary) {
  const url = String(summary?.url || '').trim();
  return [
    '# CloneAI AI Handoff',
    url ? `Target: ${url}` : 'Target: (none)',
    '',
    'This package is a durable extraction output. Prefer manifests, pages, images, and archive artifacts over assumptions.',
    '',
    '## Report',
    '',
    reportText,
  ].join('\n');
}

function buildExtractionJobInputFromRequest(req) {
  const clientDelivery = ['1', 'true', 'yes', 'on'].includes(
    String(req.body?.clientDelivery || '').trim().toLowerCase()
  );
  const servicePackage = ['basic', 'standard', 'premium'].includes(String(req.body?.servicePackage || '').trim())
    ? String(req.body?.servicePackage || '').trim()
    : '';
  return {
    headers: {
      userId: String(req.get('x-cloneai-user-id') || '').trim(),
      promoCode: String(req.get('x-cloneai-promo-code') || '').trim(),
    },
    body: {
      ...req.body,
    },
    derived: {
      promoValid: Boolean(req._promoValid),
      privilegedAnalyze: Boolean(req._privilegedAnalyze),
      scanMode: req._scanMode || 'elite',
      extractionProfile: req._extractionProfile || 'standard',
      removeImageBackground: Boolean(req._removeImageBackground),
      assetHarvestMode: Boolean(req._assetHarvestMode),
      clientDelivery,
      servicePackage,
    },
    files: (req.files || []).map((file) => ({
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      buffer: file.buffer,
    })),
  };
}

function buildJobRequestFromInput(input) {
  return {
    body: { ...(input.body || {}) },
    files: Array.isArray(input.files) ? input.files : [],
    ip: input.sourceIp || '127.0.0.1',
    socket: { remoteAddress: input.sourceIp || '127.0.0.1' },
    _promoValid: Boolean(input.derived?.promoValid),
    _privilegedAnalyze: Boolean(input.derived?.privilegedAnalyze),
    _scanMode: input.derived?.scanMode || 'elite',
    _extractionProfile: input.derived?.extractionProfile || 'standard',
    _removeImageBackground: Boolean(input.derived?.removeImageBackground),
    _assetHarvestMode: Boolean(input.derived?.assetHarvestMode),
    _clientDelivery: Boolean(input.derived?.clientDelivery),
    _servicePackage: input.derived?.servicePackage || '',
    _jobArtifacts: {},
    _analyzeStartedAt: Date.now(),
    get(name) {
      const key = String(name || '').trim().toLowerCase();
      if (key === 'x-cloneai-user-id') return input.headers?.userId || '';
      if (key === 'x-cloneai-promo-code') return input.headers?.promoCode || '';
      return '';
    },
  };
}

function createMockExtractionJobResponse(jobId, onEvent, onErrorResponse) {
  class MockResponse extends EventEmitter {
    constructor() {
      super();
      this.headers = {};
      this.headersSent = false;
      this.statusCode = 200;
      this.ended = false;
      this.pending = Promise.resolve();
      this.sseBuffer = '';
    }
    setHeader(name, value) {
      this.headers[String(name)] = value;
    }
    flushHeaders() {}
    status(code) {
      this.statusCode = code;
      return this;
    }
    json(payload) {
      this.headersSent = true;
      this.pending = this.pending.then(() =>
        onErrorResponse({
          statusCode: this.statusCode,
          payload,
        })
      );
      this.end();
      return this;
    }
    send(payload) {
      this.headersSent = true;
      this.pending = this.pending.then(() =>
        onErrorResponse({
          statusCode: this.statusCode,
          payload,
        })
      );
      this.end();
      return this;
    }
    write(chunk) {
      this.headersSent = true;
      this.sseBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      let splitAt = this.sseBuffer.indexOf('\n\n');
      while (splitAt >= 0) {
        const block = this.sseBuffer.slice(0, splitAt);
        this.sseBuffer = this.sseBuffer.slice(splitAt + 2);
        if (!block.startsWith(':')) {
          for (const line of block.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload) continue;
            this.pending = this.pending.then(async () => {
              try {
                await onEvent(JSON.parse(payload));
              } catch (err) {
                logEvent('warn', 'job_event_parse_failed', {
                  jobId,
                  detail: String(err?.message || err),
                });
              }
            });
          }
        }
        splitAt = this.sseBuffer.indexOf('\n\n');
      }
      return true;
    }
    end(chunk) {
      if (chunk) this.write(chunk);
      if (this.ended) return this;
      this.ended = true;
      this.emit('finish');
      return this;
    }
    async flushPending() {
      await this.pending;
    }
  }

  return new MockResponse();
}

function updateExtractionJobSummaryFromEvent(job, event) {
  if (!job || !event || typeof event !== 'object') return job;
  if (!job.progress || typeof job.progress !== 'object') job.progress = {};
  if (event.type === 'stage') {
    job.progress.phase = event.phase || job.progress.phase || 'running';
    job.progress.label = event.label || job.progress.label || 'Running';
    if (typeof event.index === 'number') job.progress.stageIndex = event.index;
  }
  if (event.type === 'harvest_progress') {
    job.progress.phase = event.phase || job.progress.phase || 'crawl';
    job.progress.phaseLabel = event.phaseLabel || job.progress.phaseLabel || null;
    job.progress.pagesDiscovered = Number(event.pagesDiscovered) || job.progress.pagesDiscovered || 0;
    job.progress.pagesCrawled = Number(event.pagesCrawled) || job.progress.pagesCrawled || 0;
    job.progress.queueLength = Number(event.queueLength) || 0;
    job.progress.imagesFound = Number(event.imagesFound) || job.progress.imagesFound || 0;
    job.progress.imagesDownloaded = Number(event.imagesDownloaded) || job.progress.imagesDownloaded || 0;
    job.progress.imagesFailed = Number(event.imagesFailed) || job.progress.imagesFailed || 0;
    job.progress.duplicatesSkipped = Number(event.duplicatesSkipped) || job.progress.duplicatesSkipped || 0;
    job.progress.zipBytesSoFar = Number(event.zipBytesSoFar) || job.progress.zipBytesSoFar || 0;
    job.progress.elapsedMs = Number(event.elapsedMs) || job.progress.elapsedMs || 0;
  }
  if (event.type === 'meta') {
    if (event.scraper && typeof event.scraper === 'object') {
      job.scraper = event.scraper;
      job.progress.duplicatesSkipped =
        Number(event.scraper.harvestContentDuplicatesSkipped) || job.progress.duplicatesSkipped || 0;
    }
    if (event.assets && typeof event.assets === 'object') {
      job.assets = event.assets;
    }
    if (event.billing && typeof event.billing === 'object') {
      job.billing = {
        ...(job.billing || {}),
        plan: event.billing.plan || job.billing?.plan || null,
        promoUnlocked: Boolean(event.billing.promoRun || job.billing?.promoUnlocked),
      };
    }
  }
  if (event.type === 'error') {
    job.error = {
      message: String(event.message || 'Extraction failed.'),
      at: new Date().toISOString(),
    };
  }
  return job;
}

async function appendAndApplyJobEvent(jobId, event) {
  await appendExtractionJobEvent(extractionJobsBaseDir, jobId, event);
  if (event?.type === 'text' || event?.type === 'warning' || event?.type === 'done') return;
  await updateExtractionJob(extractionJobsBaseDir, jobId, (job) => updateExtractionJobSummaryFromEvent(job, event));
}

async function finalizeExtractionJob(jobId, finalState) {
  await updateExtractionJob(extractionJobsBaseDir, jobId, (job) => {
    job.status = finalState.status;
    job.completedAt = new Date().toISOString();
    if (finalState.scraper) job.scraper = finalState.scraper;
    if (finalState.assets) job.assets = finalState.assets;
    if (finalState.error) {
      job.error = {
        message: finalState.error,
        at: new Date().toISOString(),
      };
      job.progress = {
        ...(job.progress || {}),
        phase: 'failed',
        label: 'Failed',
      };
    } else {
      job.progress = {
        ...(job.progress || {}),
        phase: 'completed',
        label: 'Completed',
      };
      job.error = null;
    }
    return job;
  });
}

async function runExtractionJob(jobId) {
  const current = loadExtractionJob(extractionJobsBaseDir, jobId);
  if (!current || current.status !== 'queued') return;
  const input = loadExtractionJobInput(extractionJobsBaseDir, jobId);
  if (!input) {
    await finalizeExtractionJob(jobId, {
      status: 'failed',
      error: 'Job input could not be loaded.',
    });
    return;
  }

  await updateExtractionJob(extractionJobsBaseDir, jobId, (job) => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.progress = {
      ...(job.progress || {}),
      phase: 'starting',
      label: 'Preparing extraction job',
    };
    return job;
  });

  let fullText = '';
  let latestScraper = null;
  let latestAssets = null;
  let finalError = null;
  let sawDone = false;

  const req = buildJobRequestFromInput(input);
  const res = createMockExtractionJobResponse(
    jobId,
    async (event) => {
      if (event?.type === 'text' && event.content) fullText += event.content;
      if (event?.type === 'warning' && event.message) fullText += event.message;
      if (event?.type === 'meta' && event.scraper) latestScraper = event.scraper;
      if (event?.type === 'meta' && event.assets) latestAssets = event.assets;
      if (event?.type === 'error') finalError = String(event.message || 'Extraction failed');
      if (event?.type === 'done') sawDone = true;
      await appendAndApplyJobEvent(jobId, event);
    },
    async ({ statusCode, payload }) => {
      finalError =
        String(payload?.message || payload?.error || payload?.code || `Request failed (${statusCode || 500})`);
      await appendAndApplyJobEvent(jobId, {
        type: 'error',
        message: finalError,
        statusCode,
      });
    }
  );

  try {
    await runAnalyzePipeline(req, res);
    await res.flushPending();
  } catch (err) {
    finalError = String(err?.message || err || 'Extraction failed');
    await appendAndApplyJobEvent(jobId, {
      type: 'error',
      message: finalError,
    });
  }

  let durableAssets = latestAssets && typeof latestAssets === 'object' ? { ...latestAssets } : null;
  try {
    if (fullText.trim()) {
      await saveExtractionJobArtifact(extractionJobsBaseDir, jobId, {
        name: 'report.md',
        text: fullText,
        contentType: 'text/markdown; charset=utf-8',
      });
      await saveExtractionJobArtifact(extractionJobsBaseDir, jobId, {
        name: 'cursor-ready.md',
        text: buildCursorReadyExport(fullText, current.summary),
        contentType: 'text/markdown; charset=utf-8',
      });
      await saveExtractionJobArtifact(extractionJobsBaseDir, jobId, {
        name: 'ai-handoff.md',
        text: buildAiHandoffExport(fullText, current.summary),
        contentType: 'text/markdown; charset=utf-8',
      });
    }

    if (req._jobArtifacts?.pagesJson) {
      await saveExtractionJobArtifact(extractionJobsBaseDir, jobId, {
        name: 'pages.json',
        text: JSON.stringify(req._jobArtifacts.pagesJson, null, 2),
        contentType: 'application/json; charset=utf-8',
      });
    }
    if (req._jobArtifacts?.imagesJson) {
      await saveExtractionJobArtifact(extractionJobsBaseDir, jobId, {
        name: 'images.json',
        text: JSON.stringify(req._jobArtifacts.imagesJson, null, 2),
        contentType: 'application/json; charset=utf-8',
      });
    }
    if (req._jobArtifacts?.pagesCsvText) {
      await saveExtractionJobArtifact(extractionJobsBaseDir, jobId, {
        name: 'pages.csv',
        text: String(req._jobArtifacts.pagesCsvText || ''),
        contentType: 'text/csv; charset=utf-8',
      });
    }
    if (req._jobArtifacts?.imagesCsvText) {
      await saveExtractionJobArtifact(extractionJobsBaseDir, jobId, {
        name: 'images.csv',
        text: String(req._jobArtifacts.imagesCsvText || ''),
        contentType: 'text/csv; charset=utf-8',
      });
    }
    if (req._jobArtifacts?.manifestJson) {
      const manifestJsonText = JSON.stringify(req._jobArtifacts.manifestJson, null, 2);
      await saveExtractionJobArtifact(extractionJobsBaseDir, jobId, {
        name: 'manifest.json',
        text: manifestJsonText,
        contentType: 'application/json; charset=utf-8',
      });
      await saveExtractionJobArtifact(extractionJobsBaseDir, jobId, {
        name: 'manifest.csv',
        text: String(req._jobArtifacts.manifestCsvText || ''),
        contentType: 'text/csv; charset=utf-8',
      });
    }
    if (req._jobArtifacts?.siteMapText) {
      await saveExtractionJobArtifact(extractionJobsBaseDir, jobId, {
        name: 'site-map.txt',
        text: String(req._jobArtifacts.siteMapText || ''),
        contentType: 'text/plain; charset=utf-8',
      });
    }

    if (latestAssets?.token) {
      const siteZip = getSiteAssetDownload(latestAssets.token);
      if (siteZip?.buffer?.length) {
        const saved = await saveExtractionJobArtifact(extractionJobsBaseDir, jobId, {
          name: siteZip.filename || 'site-assets.zip',
          buffer: siteZip.buffer,
          contentType: 'application/zip',
        });
        if (saved?.name) {
          durableAssets = {
            ...latestAssets,
            token: null,
            artifactName: saved.name,
            artifactUrl: extractionJobArtifactUrl(jobId, saved.name),
            filename: saved.name,
          };
          await appendAndApplyJobEvent(jobId, {
            type: 'meta',
            assets: durableAssets,
          });
        }
      }
    }
  } catch (artifactErr) {
    logEvent('warn', 'job_artifact_save_failed', {
      jobId,
      detail: String(artifactErr?.message || artifactErr),
    });
  }

  await finalizeExtractionJob(jobId, {
    status: !finalError && sawDone ? 'completed' : 'failed',
    scraper: latestScraper,
    assets: durableAssets,
    error: !finalError && sawDone ? null : finalError || 'Extraction did not complete cleanly.',
  });
}

function scheduleExtractionJobPump() {
  if (extractionJobPumpScheduled) return;
  extractionJobPumpScheduled = true;
  setImmediate(async () => {
    extractionJobPumpScheduled = false;
    try {
      while (activeExtractionJobIds.size < EXTRACTION_JOB_RUNNER_CONCURRENCY) {
        const nextJob = listExtractionJobs(extractionJobsBaseDir, {
          limit: 50,
          statuses: ['queued'],
        })
          .sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0))
          .find((job) => !activeExtractionJobIds.has(job.id));
        if (!nextJob) break;
        activeExtractionJobIds.add(nextJob.id);
        void runExtractionJob(nextJob.id)
          .catch((err) => {
            logEvent('error', 'job_runner_failure', {
              jobId: nextJob.id,
              detail: String(err?.stack || err?.message || err),
            });
          })
          .finally(() => {
            activeExtractionJobIds.delete(nextJob.id);
            scheduleExtractionJobPump();
          });
      }
    } catch (err) {
      logEvent('error', 'job_pump_failure', {
        detail: String(err?.stack || err?.message || err),
      });
    }
  });
}

function authorizeExtractionJobAccess(req, res, job) {
  const requester = normalizeUserId(req.get('x-cloneai-user-id'));
  if (!job) {
    res.status(404).json({ error: 'Extraction job not found.' });
    return false;
  }
  if (!requester || requester !== normalizeUserId(job.userId)) {
    res.status(403).json({ error: 'Forbidden.' });
    return false;
  }
  return true;
}

function streamExtractionJobEvents(req, res, job) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let offset = 0;
  let timer = null;
  const flush = () => {
    const slice = readExtractionJobEventsSlice(extractionJobsBaseDir, job.id, offset);
    offset = slice.nextOffset;
    for (const event of slice.events) sseWrite(res, event);
    const latest = loadExtractionJob(extractionJobsBaseDir, job.id);
    if (latest && isTerminalExtractionJobStatus(latest.status)) {
      if (!slice.events.some((event) => event?.type === 'done') && latest.status === 'completed') {
        sseWrite(res, { type: 'done' });
      }
      if (latest.status === 'failed' && latest.error?.message && !slice.events.some((event) => event?.type === 'error')) {
        sseWrite(res, { type: 'error', message: latest.error.message });
      }
      clearInterval(timer);
      res.end();
    }
  };

  timer = setInterval(flush, 1000);
  timer.unref?.();
  req.on('close', () => clearInterval(timer));
  flush();
}

if (!serveSpa) {
  function rootGetPrefersHtml(req) {
    if (String(req.query?.format || '').toLowerCase() === 'json') return false;
    const a = String(req.get('accept') || '').toLowerCase();
    const jsonOnly =
      a.includes('application/json') &&
      !a.includes('*/*') &&
      !a.includes('text/html') &&
      !a.includes('text/plain');
    if (jsonOnly) return false;
    return true;
  }

  app.get('/', (req, res) => {
    const front = (process.env.FRONTEND_URL || process.env.PUBLIC_APP_URL || '').trim();
    const staticExplicit = (process.env.STATIC_APP_URL || process.env.WEB_APP_PUBLIC_URL || '').trim();
    const apexExplicit = (process.env.APEX_STATIC_FALLBACK_URL || '').trim();
    const merged = mergeStaticEnvWithSiteDefaults(
      req.hostname || req.get('host') || '',
      staticExplicit,
      apexExplicit
    );
    const staticApp = merged.staticAppUrl;
    const apexFallback = merged.apexStaticFallbackUrl;
    const r = resolveRootGet(req, {
      frontendUrl: front,
      staticAppUrl: staticApp,
      apexStaticFallbackUrl: apexFallback,
      corsOrigins: (process.env.CORS_ORIGINS || '').trim(),
    });
    if (r.kind === 'redirect') {
      res.redirect(r.status, r.location);
      return;
    }
    if (rootGetPrefersHtml(req)) {
      res.type('html').send(
        formatRootLandingHtml({
          hint: r.hint,
          frontendUrl: front || null,
          staticAppUrl: staticApp || null,
          apexStaticFallbackUrl: apexFallback || null,
          requestHost: req.hostname || req.get('host') || '',
        })
      );
      return;
    }
    res.type('application/json').send({
      ok: true,
      service: 'cloneai-api',
      docs: 'Use POST /api/analyze, POST /api/analyze-revise (JSON), and GET /api/health — the web app is hosted separately.',
      health: '/api/health',
      hint: r.hint,
    });
  });
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', openaiConfigured: isOpenAiConfigured() });
});

app.get('/api/billing/status', requireIngressKey, (req, res) => {
  getBillingStatus(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'Status failed.' });
  });
});

app.post('/api/billing/checkout', requireIngressKey, (req, res) => {
  postBillingCheckout(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'Checkout failed.' });
  });
});

app.post('/api/billing/claim-account', requireIngressKey, (req, res) => {
  postBillingClaimAccount(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'Claim failed.' });
  });
});

app.post('/api/auth/login', authLoginLimiter, requireIngressKey, (req, res) => {
  postAuthLogin(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'Login failed.' });
  });
});

app.post(
  '/api/leads/dfy',
  express.json({ limit: '64kb' }),
  requireIngressKey,
  leadsLimiter,
  async (req, res) => {
    const email = String(req.body?.email || '')
      .trim()
      .slice(0, 200);
    const name = String(req.body?.name || '')
      .trim()
      .slice(0, 120);
    const website = String(req.body?.website || '')
      .trim()
      .slice(0, 500);
    const budget = String(req.body?.budget || '')
      .trim()
      .slice(0, 120);
    const notes = String(req.body?.notes || '')
      .trim()
      .slice(0, 4000);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ code: 'INVALID_REQUEST', error: 'INVALID_REQUEST' });
      return;
    }
    const userId = normalizeUserId(req.get('x-cloneai-user-id'));
    const record = {
      at: new Date().toISOString(),
      ip: clientIp(req),
      userId: userId || null,
      name: name || null,
      email,
      website: website || null,
      budget: budget || null,
      notes: notes || null,
    };
    try {
      appendLeadRecord(record);
    } catch (e) {
      console.error('[leads] append failed', e);
      res.status(500).json({ error: 'Could not save lead.' });
      return;
    }
    const hook = process.env.LEADS_WEBHOOK_URL?.trim();
    if (hook) {
      fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      }).catch((e) => console.warn('[leads] webhook failed', e?.message || e));
    }
    void recordProductEvent(userId, null, 'lead_form_submitted', { website: record.website });
    res.json({ ok: true });
  }
);

app.post('/api/analytics/track', requireIngressKey, analyticsLimiter, (req, res) => {
  const userId = normalizeUserId(req.get('x-cloneai-user-id'));
  let plan = null;
  if (isBillingEnabled() && userId) {
    try {
      plan = getUsageSnapshotSync(userId).plan;
    } catch {
      plan = null;
    }
  }
  const event = String(req.body?.event || '').trim().slice(0, 64);
  if (!event || !/^[a-z][a-z0-9_]*$/.test(event)) {
    res.status(400).json({ ok: false, error: 'Invalid or missing event name.' });
    return;
  }
  const rawMeta = req.body?.meta;
  const meta =
    rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta)
      ? { ...rawMeta, ip: clientIp(req) }
      : { ip: clientIp(req) };
  recordProductEvent(userId, plan, event, meta)
    .then(() => res.json({ ok: true }))
    .catch((e) => {
      console.error('[analytics] track failed', e);
      if (!res.headersSent) res.status(500).json({ ok: false });
    });
});

app.get('/api/billing/analytics', requireIngressKey, (req, res) => {
  try {
    getBillingAnalytics(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'Analytics failed.' });
  }
});

/** Operator dashboard JSON — set ADMIN_OPS_KEY; send header x-cloneai-admin-key. */
app.get('/api/admin/ops-summary', (req, res) => {
  const key = process.env.ADMIN_OPS_KEY?.trim();
  if (!key || req.get('x-cloneai-admin-key') !== key) {
    res.status(404).json({ error: 'Not found.' });
    return;
  }
  res.json({
    ok: true,
    billingAnalytics: getAnalyticsSnapshotSync(),
    crawlMaxPagesEnvCap: crawlMaxPagesEnvCap(),
    env: process.env.NODE_ENV || null,
  });
});

function todayISO() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

const OUTPUT_STRUCTURE = `
# WEBSITE CLONE DEVELOPER BRIEF
## Site: [site name/URL]
## Generated: [today's date]
---
## 1. EXECUTIVE OVERVIEW
## 2. GLOBAL LAYOUT & PAGE STRUCTURE
## 3. NAVIGATION / HEADER (include full menu trees: categories, dropdowns, mega-menus, footer links)
## 4. COLOR PALETTE (every color with exact hex and usage)
## 5. TYPOGRAPHY (every font, weight, size for every element)
## 6. HERO / ABOVE-THE-FOLD SECTION
## 7. SECTION-BY-SECTION BREAKDOWN (strict top → bottom, spatial precision) — must include **complete categories & items inventory** (rental SKUs, product grids, service tiers, listing tiles) when present
## 8. COMPONENTS CATALOG (every button, card, badge, form, **product/item tile**, filter, search)
## 9. IMAGES & MEDIA
## 10. FOOTER
## 11. RESPONSIVENESS NOTES
## 12. CRITICAL ISSUES & MISSING ELEMENTS (numbered, pixel-level detail)
## 13. PRIORITY FIX LIST FOR DEVELOPER (top 10 in priority order)
`.trim();

const OPTION_LABEL_SET = new Set([
  'Layout & Structure',
  'Typography',
  'Colors & Theme',
  'Navigation',
  'Components',
  'Content & Copy',
  'Categories & inventory',
  'Images & Media',
  'Responsiveness',
  'Animations',
]);

function buildOptionInstructions(selectedLabels) {
  const picked = (selectedLabels || []).filter((l) => typeof l === 'string' && OPTION_LABEL_SET.has(l));
  if (!picked.length) {
    return `\n---\nANALYSIS FOCUS: No option toggles were selected. Provide a balanced brief across all 13 sections at moderate depth.\n`;
  }
  const lines = picked.map((l) => `- ${l}: provide rich, specific detail (measurements, tokens, names).`).join('\n');
  const omitted = [...OPTION_LABEL_SET].filter((l) => !picked.includes(l));
  const omitLine =
    omitted.length > 0
      ? `\nFor sections that mainly map to NON-SELECTED categories (${omitted.join(
          ', '
        )}), keep content to 1–2 short sentences or state "(Not requested in this run)" rather than inventing detail.\n`
      : '';
  const animTight = picked.includes('Animations')
    ? ''
    : '\n**Animations** were not selected: do not expand on transitions, keyframes, or micro-interactions (at most one short sentence if safety-relevant).\n';
  return `\n---\nANALYSIS FOCUS — expand deeply ONLY for these selected areas:\n${lines}\n${omitLine}${animTight}\nStill output all 13 section headings for consistency; respect the focus rules above within each section.\n`;
}

const SYSTEM_PROMPT_BASE = `You are an elite web development consultant. Produce an extremely detailed, developer-ready brief.

Hard requirements:
- Include ALL 13 section headings exactly as provided (numbered ## 1 through ## 13). Each must have substantive content, not placeholders.
- Use ### sub-headings and bullet lists where it improves clarity.
- **Where things live (critical):** In sections 2, 3, 6, 7, 8, 9, and 10, every major block must state (1) its **vertical order** (e.g. "Block 1 — immediately below nav", "Block 4 — mid-page before footer"), (2) **horizontal placement** (full-bleed, centered column, left third, right rail), (3) **approximate width** (e.g. ~1140px container, 33% grid column) when inferable, (4) **DOM hints** from HTML when present (tag names, \`id\`, \`class\`, landmark elements like \`<header>\`, \`<main>\`, \`<section>\`, \`<footer>\`), and (5) **above-the-fold vs below** for the first screen. Never describe the page only as generic "sections"; tie each item to position and structure.
- **Section 7 format:** Use a numbered list **in strict DOM/viewport order** (1., 2., 3., …). Each item must start with a short **location line** (position + layout), then nested bullets for content, styles, and components inside that block.
- **Categories & items (critical for clones):** For rental, e‑commerce, booking, or catalog sites, you must **enumerate** (not summarize) what the user would need to rebuild: every **category** (nav label + href attribute when in HTML), every **visible item/product/rental card** (title, price or CTA, short description if shown, thumbnail/hero image reference, link target), and **groupings** (e.g. "3-column category grid — items: …"). If HTML only shows a subset, state that **additional inventory lives on linked subpages** and list those URLs. Mirror visible structure from screenshots when HTML is thin.
- **Theme marketplaces / multi-demo sites:** The pipeline may include **snapshots/interaction/** PNGs from automated theme/demo clicks and a **checkout walk**. Reference those filenames when describing distinct themes or checkout steps; note limitations (heuristic clicks, not every vendor UI).
- **Section 3:** Expand **all** levels of navigation (primary, dropdowns, mobile menu) as an outline with link labels and paths when extractable.
- Colors: always give hex codes (#RRGGBB) and where they apply (background, text, border, etc.).
- Typography: list font families, weights, approximate sizes (px or rem), line-height, letter-spacing when inferable from HTML or screenshots.
- Layout: describe structure (grid/flex), key spacing, max-widths, alignment, and breakpoints when visible or inferable.
- Components: name each distinct UI pattern (buttons, cards, nav items, forms) with variants and states **and where on the page each variant appears**.
- **Section 9:** If a "HARVESTED PAGE IMAGES" list is provided, map each \`image-NNN.*\` file to what it shows and **where** it sits on the page (section + position). If no harvest list, still list every visible image/video from HTML and screenshots with placement. Explicitly call out **non-\`<img>\` visuals**: CSS \`background-image\` / \`url()\`, lazy \`data-*\` sources, \`srcset\` alternates, sprites, icons, video posters, and theme-preview assets referenced only in style or JSON.
- Never use vague filler ("modern", "clean") without concrete measurements or tokens. If something cannot be determined, write "Unknown from available input" instead of inventing.
- If data is missing, say what is unknown instead of guessing.
- **Section 13 closing:** After the priority fix list, add a **Scorecard** subsection (### Scorecard) with 4–6 bullets: overall clone difficulty (Low/Med/High), structure confidence, visual fidelity confidence, content/inventory completeness, top risk, and estimated rebuild effort — each grounded in what you actually saw in the inputs.

**Efficiency (cost / latency):** Prefer dense bullets over narrative prose. Do not repeat the user prompt or quote large chunks of HTML. Honor "not requested" sections with minimal text.`;

/** Owner coupon: quality-first instructions and in-brief QA (no extra model round-trip). */
function buildPromoOwnerQualityAddon(promoAuthorized) {
  if (!promoAuthorized) return '';
  return `

OWNER COUPON MODE (operator’s key — billing caps waived, quality prioritized):
- **Ignore** the global "Efficiency (cost / latency)" block for this run: prefer **exhaustive** coverage over terse summaries. Longer output is expected.
- Treat every specialist area as **must be deep** where the HTML, crawl list, harvest manifest, or screenshots support it.
- Before the **Scorecard** inside ## 13, add a subsection **### Independent QA audit** written as a **second reviewer** who did not draft sections 1–12:
  - Per-section line: **§N — Complete / Partial / Missing** vs available evidence.
  - **Contradictions or thin claims** in the draft (cite section).
  - **Send-back list:** numbered imperatives (“Expand §7 with …”, “Re-check §9 against image-042…”) as if routing work back to specialists.
  - **Underused evidence:** concrete facts still visible in inputs that deserve more ink.
`;
}

function buildScanModeSystemAddon(scanMode, promoAuthorized) {
  const sm = scanMode === 'images' ? 'images' : scanMode === 'screenshots' ? 'screenshots' : 'elite';
  let s = '';
  if (sm === 'images') {
    s +=
      '\n\nSCAN MODE — IMAGE EXTRACT:\nThe operator chose **Image extract**. Keep all 13 numbered ## sections, but **prioritize media and downloadable assets**: Section 9 must be exhaustive (every visible and harvested image, CSS backgrounds, lazy src, srcset, icons, video posters, og/twitter images). Sections 2–8 and 10–12: **concise** unless the content is directly image- or asset-related. Section 13 Scorecard must foreground **asset coverage** (found vs likely missing) and ZIP/harvest usefulness.\n';
  } else if (sm === 'screenshots') {
    s +=
      '\n\nSCAN MODE — SCREENSHOT SWEEP:\nThe operator chose **Screenshot sweep**. The pipeline captured a **full-page PNG per crawled URL** (ZIP `snapshots/`). Raw HTML was withheld from this prompt; **treat the page list + snapshot filenames as your main structural guide** and reason about visuals the way you would from real screenshots (you may not see pixel data in-chat — infer from filenames/order and state unknowns honestly). Keep all 13 ## sections: be **visual/layout-first**; Section 9 maps snapshot files to pages/sections; Section 13 Scorecard must stress **screenshot coverage** (pages captured vs missing) and ZIP usefulness for handoff.\n';
  } else {
    s +=
      '\n\nSCAN MODE — ELITE:\nThe operator chose **Elite scan**: maximum balanced depth across every section per your base instructions (full clone specification).\n';
  }
  if (promoAuthorized) {
    s +=
      '\nAUTHORIZED PROMO CONTEXT:\nThis session uses the **owner coupon**: treat **full-site extraction** (crawl coverage, ZIP, snapshots, CSS-linked assets) as top priority alongside the selected scan mode. Map every `image-NNN.*`, hotlink vs bundled asset, and CDN URL that matters for a pixel-faithful clone.\n';
  }
  return s;
}

function buildScanModeUserBlock(scanMode, promoAuthorized) {
  const sm = scanMode === 'images' ? 'images' : scanMode === 'screenshots' ? 'screenshots' : 'elite';
  let t =
    sm === 'images'
      ? '\n---\nRUN FOCUS (operator UI): **IMAGE EXTRACT** — prioritize harvested files, Section 9, and every image URL pattern in HTML/CSS.\n'
      : sm === 'screenshots'
        ? '\n---\nRUN FOCUS (operator UI): **SCREENSHOT SWEEP** — full-page PNG per crawled URL in ZIP `snapshots/`; minimal HTML in prompt; brief must prioritize visual capture coverage and page-by-page notes.\n'
      : '\n---\nRUN FOCUS (operator UI): **ELITE SCAN** — full-spectrum developer specification.\n';
  if (promoAuthorized) {
    t +=
      '- **Owner coupon active:** maximize **crawl + harvest + snapshot** usefulness; brief must reflect everything the pipeline captured.\n';
  }
  return t;
}

function buildAnalyzerDeliveryAddons(clientDelivery, servicePackage) {
  let s = '';
  if (clientDelivery) {
    s += `\n\nCLIENT DELIVERY MODE: The primary reader is a client receiving a paid deliverable. Use polished, professional language. Do not describe crawlers, scrapers, or internal analysis steps. Avoid "we analyzed" / "from the HTML dump". Present content as a clean technical specification suitable for PDF or client email.\n`;
  }
  if (servicePackage === 'basic') {
    s += `\n\nDELIVERABLE SCOPE (Basic): Prioritize sections 1–2, 6 (hero), and a concise navigation outline (3). Keep section 7 shorter — focus on above-the-fold and primary homepage blocks unless the URL is clearly a single-page app.\n`;
  } else if (servicePackage === 'standard') {
    s += `\n\nDELIVERABLE SCOPE (Standard): Emphasize multi-page structure in sections 2–3, 6–8; section 7 as structured bullets per major page region; solid but not exhaustive inventory.\n`;
  } else if (servicePackage === 'premium') {
    s += `\n\nDELIVERABLE SCOPE (Premium): Maximum practical depth across all 13 sections, exhaustive visible inventory where applicable, and highly actionable notes in section 13.\n`;
  }
  return s;
}

/** User message for OpenAI Chat Completions: text + optional image_url parts (vision). */
function buildOpenAiUserContent({
  url,
  depth,
  options,
  htmlContext,
  files,
  scraperMeta,
  comparePair,
  harvestedImageManifest,
  clientDelivery,
  servicePackage,
  scanMode = 'elite',
  promoAuthorized = false,
}) {
  let text = `Analyze the following and produce the complete developer brief using EXACTLY this output structure (fill all sections; respect focus rules):\n\n${OUTPUT_STRUCTURE}\n\nReplace "[site name/URL]" with the actual site name or URL. Replace "[today's date]" with: ${todayISO()}\n`;
  text += buildOptionInstructions(options);

  text += `\n---\nINPUT CONTEXT:\n- URL: ${url || '(none)'}\n- Scan depth: ${depth}\n`;
  text += buildScanModeUserBlock(scanMode, promoAuthorized);

  if (depth === 'homepage' && (url || htmlContext)) {
    text += `\n---\nHOMEPAGE / SINGLE-PAGE **DEEP THEME** PASS:\n- Treat the document as **one complete theme surface** (above and below the fold, including footers and sticky UI).\n- Enumerate **hidden** visual assets where possible: CSS \`background-image\` / \`url()\`, inline \`style=\` URLs, lazy \`data-src\` / \`data-srcset\`, \`<picture>\` / \`srcset\`, sprites, SVG symbols, video \`poster\`, favicons / \`apple-touch\`, and image URLs embedded in JSON or inline scripts.\n- Relate **full-page or viewport screenshots** (if present in inputs) to vertical regions of the page; note fixed/sticky headers or bars.\n- In section 9, separate **hero / product / decorative / icon** imagery when inferable.\n`;
  }

  if (comparePair && files.length >= 2) {
    text += `\n---\nCOMPARISON MODE: Images are uploaded in order. Treat EARLIER images as the **reference / original** and LATER images as the **candidate / clone**. In sections 7, 12, and 13, explicitly list visual and structural differences (layout, typography, color, spacing, copy, imagery). If only one image exists, state that comparison was not possible.\n`;
  } else if (comparePair && files.length < 2) {
    text += `\n---\nCOMPARISON MODE was requested but fewer than two images were provided. In section 12, note that original-vs-clone comparison was skipped, and suggest uploading paired screenshots.\n`;
  } else {
    text += `\n---\nDIFF / COMPARE: No explicit original+clone image pair was requested. In section 7 and 12, if multiple images appear to show different versions, note that briefly; otherwise focus on a single target experience.\n`;
  }

  if ((options || []).includes('Categories & inventory')) {
    text += `\n---\nCATALOG / INVENTORY (required when the site lists categories, rentals, products, or bookable items):\n- List **every** category and **every** distinct item/card visible in the HTML or screenshots (group by section if there are many).\n- For each item: visible name, price or primary CTA label, and URL/path from \`href\` when present in HTML.\n- Tie thumbnails to \`image-NNN.*\` harvest filenames or alt text when possible.\n- Do not replace long lists with "various products" — a developer needs an exhaustive inventory for cloning.\n`;
  } else {
    text += `\n---\nCATALOG / INVENTORY: **Categories & inventory** was not selected. Keep category/product enumeration brief unless essential for cloning; do not expand exhaustive SKU-style lists.\n`;
  }

  if (scraperMeta?.blocked || scraperMeta?.hint === 'http_error') {
    text += `\n---\nSCRAPER STATUS: HTML could not be retrieved reliably. Do NOT invent DOM/CSS. Use URL + screenshots; label uncertainty.\n`;
  }

  if (htmlContext) {
    if (scraperMeta?.screenshotSweepMode) {
      text += `\n---\nSCREENSHOT SWEEP CONTEXT (no raw HTML in prompt — use ZIP \`snapshots/*.png\`):\n\n${htmlContext}\n`;
    } else {
      text += `\n---\nRAW HTML (truncated for model context):\n\n${htmlContext}\n`;
      if (scraperMeta?.modelHtmlTruncated) {
        text += `\n(Note: HTML was truncated for token limits; rely on screenshots + structure hints for gaps.)\n`;
      }
    }
  } else if (url) {
    text += `\n(No usable HTML body. Prioritize screenshots; otherwise best-effort from URL only.)\n`;
  }

  if (harvestedImageManifest) {
    text += `\n${harvestedImageManifest}\n`;
  }

  if (clientDelivery) {
    text += `\n---\nOUTPUT TONE: Follow CLIENT DELIVERY MODE in system instructions (client-facing spec).\n`;
  }
  if (servicePackage) {
    text += `\n---\nPACKAGE: Honor the **${servicePackage}** deliverable scope defined in system instructions.\n`;
  }

  const content = [{ type: 'text', text }];
  for (const file of files) {
    const mime = file.mimetype || 'image/png';
    if (!mime.startsWith('image/')) continue;
    const base64 = file.buffer.toString('base64');
    content.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${base64}` },
    });
  }
  return content;
}

async function fetchHtmlDetailed(url, depth) {
  const meta = {
    ok: false,
    blocked: false,
    statusCode: null,
    hint: null,
    bytes: 0,
    truncated: false,
    timeout: false,
  };

  if (!url) {
    meta.hint = 'no_url';
    return { html: '', meta };
  }

  const initial = new URL(url);
  const allowedHost = hostKey(initial.hostname);

  try {
    const u = url.startsWith('http') ? url : `https://${url}`;
    const res = await axios.get(u, {
      timeout: HTML_FETCH_TIMEOUT_MS,
      maxContentLength: HTML_FETCH_MAX_CONTENT_LENGTH,
      maxRedirects: MAX_REDIRECTS,
      beforeRedirect: (opts) => {
        const proto = opts.protocol || '';
        if (proto && proto !== 'http:' && proto !== 'https:') {
          throw new Error('redirect_blocked');
        }
        if (opts.auth) throw new Error('redirect_blocked');
        const h = opts.hostname;
        if (!h) throw new Error('redirect_blocked');
        if (hostKey(h) !== allowedHost) throw new Error('redirect_blocked');
      },
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 CloneAI/1.0',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      validateStatus: () => true,
    });

    meta.statusCode = res.status;
    let html = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    meta.bytes = html.length;

    if (res.status >= 400) {
      meta.blocked = true;
      meta.hint = 'http_error';
      return { html: '', meta };
    }

    const head = html.slice(0, 6000).toLowerCase();
    const challenge =
      head.includes('captcha') ||
      head.includes('cf-browser-verification') ||
      head.includes('attention required') ||
      head.includes('access denied') ||
      head.includes('enable javascript') ||
      head.includes('just a moment') ||
      head.includes('blocked by') ||
      head.includes('bot detection');

    if (challenge) {
      meta.blocked = true;
      meta.hint = 'challenge_or_waf';
      return { html: '', meta };
    }

    if (html.length < 800) {
      meta.blocked = true;
      meta.hint = 'body_too_small';
      return { html: html.slice(0, 50000), meta };
    }

    if (html.length > MAX_HTML_BYTES) {
      meta.truncated = true;
      html = html.slice(0, MAX_HTML_BYTES);
    }

    meta.ok = true;
    meta.hint = 'ok';
    return { html, meta };
  } catch (e) {
    const code = e.code || '';
    const isTimeout = code === 'ECONNABORTED' || /timeout/i.test(e.message || '');
    const isRedirectBlock = e.message === 'redirect_blocked';
    logEvent('warn', 'html_fetch_failed', {
      code: code || null,
      message: e.message,
      redirectBlock: isRedirectBlock,
    });
    meta.blocked = true;
    meta.hint = isTimeout ? 'fetch_timeout' : isRedirectBlock ? 'redirect_blocked' : 'network_or_tls';
    meta.timeout = isTimeout;
    return { html: '', meta };
  }
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** Comment frames keep reverse proxies from closing long idle streams while OpenAI is thinking. */
async function withSseKeepalive(res, fn) {
  const ms = Math.min(
    120_000,
    Math.max(10_000, Number(process.env.SSE_KEEPALIVE_MS) || 20_000)
  );
  const id = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      /* client disconnected */
    }
  }, ms);
  try {
    return await fn();
  } finally {
    clearInterval(id);
  }
}

const MAX_OUTPUT_TOKENS = Math.min(
  16384,
  Math.max(512, Number(process.env.OPENAI_MAX_TOKENS) || Number(process.env.CLAUDE_MAX_TOKENS) || 8000)
);

const OPENAI_STREAM_MS = Math.min(
  300000,
  Math.max(60000, Number(process.env.OPENAI_STREAM_TIMEOUT_MS) || Number(process.env.CLAUDE_STREAM_TIMEOUT_MS) || 180000)
);

const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4o').trim();

const OPENAI_STREAM_INCLUDE_USAGE =
  String(process.env.OPENAI_STREAM_INCLUDE_USAGE || 'true').toLowerCase() !== 'false';

function ssePublicError() {
  return 'We could not complete this analysis. Please try again.';
}

const MAX_REVISE_PRIOR_CHARS = Math.min(
  900_000,
  Math.max(80_000, Number(process.env.MAX_REVISE_PRIOR_CHARS) || 480_000)
);
const MAX_REVISE_NOTE_CHARS = 4000;

const ZIP_EXTRACT_HTML_PER_PAGE = Math.min(
  3 * 1024 * 1024,
  Math.max(80_000, Number(process.env.ZIP_EXTRACT_HTML_PER_PAGE) || 2 * 1024 * 1024)
);
const ZIP_EXTRACT_HTML_TOTAL = Math.min(
  16 * 1024 * 1024,
  Math.max(ZIP_EXTRACT_HTML_PER_PAGE, Number(process.env.ZIP_EXTRACT_HTML_TOTAL) || 9 * 1024 * 1024)
);

/** @param {{ url: string, html: string }[]} pages */
function buildCrawlHtmlExtractEntries(pages) {
  const list = Array.isArray(pages) ? pages : [];
  if (!list.length) return [];
  const extras = [];
  extras.push({
    name: 'extract/README.txt',
    buffer: Buffer.from(
      [
        'CloneAI — crawled extract',
        '',
        'html/: HTML body captured per page (used for image URL discovery and analysis).',
        'urls.txt: crawled URLs in order.',
        '_discovered_image_urls.txt: every unique image-related URL found (HTML + linked CSS), even if not all were downloaded.',
        'manifests/: pages, images, and extraction summary manifests for developer / AI handoff.',
        '',
        'Large pages may be truncated per-file or by total budget; truncated files include "-truncated" in the name.',
      ].join('\n'),
      'utf8'
    ),
  });
  extras.push({
    name: 'extract/urls.txt',
    buffer: Buffer.from(
      list.map((p) => p.url).join('\n'),
      'utf8'
    ),
  });
  let used = extras.reduce((a, x) => a + x.buffer.length, 0);
  let pi = 0;
  for (const p of list) {
    if (used >= ZIP_EXTRACT_HTML_TOTAL) break;
    pi += 1;
    let raw = Buffer.from(p.html || '', 'utf8');
    let trunc = false;
    if (raw.length > ZIP_EXTRACT_HTML_PER_PAGE) {
      raw = raw.subarray(0, ZIP_EXTRACT_HTML_PER_PAGE);
      trunc = true;
    }
    if (used + raw.length > ZIP_EXTRACT_HTML_TOTAL) {
      raw = raw.subarray(0, Math.max(0, ZIP_EXTRACT_HTML_TOTAL - used));
      trunc = true;
    }
    used += raw.length;
    const name = `extract/html/page-${String(pi).padStart(3, '0')}${trunc ? '-truncated' : ''}.html`;
    extras.push({ name, buffer: raw });
  }
  return extras;
}

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

/**
 * Fetch linked stylesheets (and shallow @import chain) and collect url(...) targets.
 * @param {{ url: string, html: string }[]} pages
 * @returns {Promise<{ imageUrls: string[], sheetsProcessed: number }>}
 */
async function harvestLinkedStylesheetImageUrls(pages) {
  const list = Array.isArray(pages) ? pages.filter((p) => (p.html || '').length > 0) : [];
  if (!list.length) {
    return { imageUrls: [], sheetsProcessed: 0 };
  }

  const sheetKey = (u) => normalizeHarvestUrlKey(u) || u;
  const pending = [];
  const pendingKeys = new Set();
  const processedKeys = new Set();

  for (const p of list) {
    for (const href of collectStylesheetHrefs(p.html, p.url)) {
      const k = sheetKey(href);
      if (processedKeys.has(k) || pendingKeys.has(k)) continue;
      pendingKeys.add(k);
      pending.push(href);
    }
  }

  const imageUrls = [];
  const imgKeys = new Set();

  async function fetchOneStylesheet(sheetUrl) {
    const safe = await assertUrlSafeForServerFetch(sheetUrl);
    if (!safe.ok) return '';
    try {
      const res = await axios.get(sheetUrl, {
        responseType: 'text',
        timeout: 18_000,
        maxContentLength: HARVEST_CSS_MAX_BYTES,
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 300,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 CloneAI/1.0',
          Accept: 'text/css,*/*;q=0.8',
        },
      });
      const ct = String(res.headers['content-type'] || '').toLowerCase();
      if (
        ct &&
        !ct.includes('text/css') &&
        !ct.includes('text/plain') &&
        !ct.includes('application/octet-stream')
      ) {
        return '';
      }
      return String(res.data || '');
    } catch {
      return '';
    }
  }

  while (pending.length && processedKeys.size < HARVEST_CSS_MAX_SHEETS) {
    const batch = [];
    while (
      batch.length < HARVEST_CSS_FETCH_CONCURRENCY &&
      pending.length &&
      processedKeys.size + batch.length < HARVEST_CSS_MAX_SHEETS
    ) {
      const href = pending.shift();
      const k = sheetKey(href);
      pendingKeys.delete(k);
      if (processedKeys.has(k)) continue;
      processedKeys.add(k);
      batch.push(href);
    }
    if (!batch.length) break;

    const cssTexts = await Promise.all(batch.map((u) => fetchOneStylesheet(u)));
    for (let i = 0; i < batch.length; i += 1) {
      const sheetUrl = batch[i];
      const css = cssTexts[i];
      if (!css) continue;
      for (const iu of extractImageUrlsFromCss(css, sheetUrl)) {
        const ik = normalizeHarvestUrlKey(iu);
        if (!ik || imgKeys.has(ik)) continue;
        imgKeys.add(ik);
        imageUrls.push(iu);
      }
      if (processedKeys.size >= HARVEST_CSS_MAX_SHEETS) break;
      for (const imp of extractImportUrlsFromCss(css, sheetUrl)) {
        const sk = sheetKey(imp);
        if (processedKeys.has(sk) || pendingKeys.has(sk)) continue;
        if (processedKeys.size + pendingKeys.size >= HARVEST_CSS_MAX_SHEETS) break;
        pendingKeys.add(sk);
        pending.push(imp);
      }
    }
  }

  return { imageUrls, sheetsProcessed: processedKeys.size };
}

const SYSTEM_PROMPT_REVISE = `${SYSTEM_PROMPT_BASE}

**REVISION MODE:** You receive an existing developer brief below. Output one **complete replacement** brief (not a changelog) that obeys every rule above, including all 13 numbered ## sections. Tighten **## 12** to only genuine remaining gaps; rebuild **## 13** to match; align **## 1–11** for internal consistency. Do not add preamble or postscript outside the brief structure.`;

function buildReviseUserMessage(priorBrief, fixNote) {
  let t = `Revise the following WEBSITE CLONE DEVELOPER BRIEF. Output the full replacement using EXACTLY this outline (fill every section):\n\n${OUTPUT_STRUCTURE}\n\nPreserve accurate "## Site:" from the prior brief when possible. Set "## Generated:" to: ${todayISO()}\n\n---\nPRIOR BRIEF:\n\n${priorBrief}\n`;
  const n = (fixNote || '').trim();
  if (n) t += `\n---\nUSER FOCUS (optional):\n${n}\n`;
  return t;
}

async function validateReviseRequest(req, res, next) {
  try {
    const hp = (req.body?.hp ?? req.body?.honeypot ?? '').toString().trim();
    if (hp.length > 0) {
      logEvent('warn', 'analyze_honeypot_triggered', { ip: clientIp(req) });
      res.status(400).json({ error: 'Request rejected.' });
      return;
    }

    req._promoValid = promoMatchesRequest(req);
    const ipGate = clientIp(req);
    if (!req._promoValid && captchaRequiredForAnalyze(ipGate)) {
      const token = String(
        req.body?.cf_turnstile_response || req.body?.['cf-turnstile-response'] || ''
      ).trim();
      const v = await verifyTurnstileIfConfigured(token, ipGate);
      if (!v.ok) {
        logEvent('warn', 'analyze_turnstile_failed', { ip: ipGate });
        res.status(400).json({ error: v.error || 'Verification failed.' });
        return;
      }
    }

    const priorBrief = String(req.body?.priorBrief || '').trim();
    if (priorBrief.length < 80) {
      res.status(400).json({ error: 'Report text is too short to revise.' });
      return;
    }
    if (priorBrief.length > MAX_REVISE_PRIOR_CHARS) {
      res.status(400).json({ error: 'Report text is too long to revise in one request.' });
      return;
    }
    req._revisePriorBrief = priorBrief;
    const fixNote = String(req.body?.fixNote || '').trim();
    req._reviseFixNote =
      fixNote.length > MAX_REVISE_NOTE_CHARS ? fixNote.slice(0, MAX_REVISE_NOTE_CHARS) : fixNote;
    req.body.depth = 'homepage';
    next();
  } catch (e) {
    logEvent('error', 'validate_revise_exception', { ip: clientIp(req), detail: String(e?.message || e) });
    res.status(400).json({ error: 'Invalid request.' });
  }
}

function mapOpenAiFailureStatus(status) {
  if (isProd) return 'The analysis service returned an error. Try again later.';
  if (status === 401) return 'Analysis service is misconfigured (invalid API key).';
  if (status === 429) return 'Analysis service is busy. Try again later.';
  return 'The analysis service returned an error. Try again later.';
}

async function runAnalyzePipeline(req, res) {
  const apiKey = process.env.OPENAI_API_KEY;
  const openAiConfigured = isOpenAiConfigured();

  const ipGate = clientIp(req);
  const slotTry = tryAcquireAnalyzeSlot(req.get('x-cloneai-user-id'), ipGate);
  if (!slotTry.ok) {
    res.status(429).json({
      error: 'An analysis is already running for this session. Wait for it to finish before starting another.',
    });
    return;
  }
  const slotKey = slotTry.key;
  let slotReleased = false;
  let inFlightAcquired = false;
  const releaseSlotOnce = () => {
    if (slotReleased) return;
    slotReleased = true;
    releaseAnalyzeSlot(slotKey);
    if (inFlightAcquired) {
      inFlightAcquired = false;
      releaseGlobalAnalyzeInFlightSlot();
    }
  };

  const urlForBilling = (req.body.url || '').trim();
  const filesForGate = req.files || [];
  let analyzePlan = null;
  let analyzeUserId = normalizeUserId(req.get('x-cloneai-user-id'));

  const promoBypass = Boolean(req._promoValid);

  if (isBillingEnabled()) {
    const billingUserId = normalizeUserId(req.get('x-cloneai-user-id'));
    if (!billingUserId) {
      releaseSlotOnce();
      res.status(400).json({
        success: false,
        code: 'MISSING_USER_ID',
        error: 'MISSING_USER_ID',
      });
      return;
    }
    analyzeUserId = billingUserId;

    if (promoBypass) {
      logEvent('info', 'analyze_promo_run', { ip: clientIp(req), userId: billingUserId });
      analyzePlan = PLANS.POWER;
      req._planGateNotes = [];
      req._billingUserId = billingUserId;
      req._billingReservation = null;
      req._billingPlan = PLANS.POWER;
      /* Owner coupon: no usage reservation, no feature gate (same limits as POWER+ for crawl/harvest; see crawlPageCapForRequest / harvest caps). */
    } else {
      const usageSnap = await getUsageSnapshot(billingUserId);
      analyzePlan = usageSnap.plan || PLANS.FREE;

      req._planGateNotes = [];
      let requestedDepth = String(req.body.depth || 'homepage').trim();
      if (!['homepage', 'shallow', 'deep'].includes(requestedDepth)) {
        requestedDepth = 'homepage';
      }
      req.body.depth = requestedDepth;

      if (analyzePlan === PLANS.FREE && requestedDepth !== 'homepage') {
        releaseSlotOnce();
        res.status(403).json({
          success: false,
          code: 'FEATURE_LOCKED',
          error: 'FEATURE_LOCKED',
          feature: 'multi_page_scan',
          message:
            'Multi-page crawls need Starter or higher. Upgrade below to scan more than the homepage. (Promo code field is only if you were given one.)',
        });
        return;
      }
      if (analyzePlan === PLANS.STARTER && requestedDepth === 'deep') {
        releaseSlotOnce();
        res.status(403).json({
          success: false,
          code: 'FEATURE_LOCKED',
          error: 'FEATURE_LOCKED',
          feature: 'deep_crawl',
          message:
            'Full-site depth (up to ~300 pages) needs Pro or Power. Upgrade below. (Promo code only if you were given one.)',
        });
        return;
      }

      const featureGate = evaluateAnalyzeFeatureGate(analyzePlan, {
        hasUrl: Boolean(urlForBilling),
        imageCount: filesForGate.length,
        depth: req.body.depth,
      });
      if (!featureGate.ok) {
        releaseSlotOnce();
        res.status(403).json({
          success: false,
          code: featureGate.code,
          error: featureGate.code,
          message: featureGate.message,
          feature: featureGate.feature,
        });
        return;
      }

      const billingReservation = await tryBeginRun(billingUserId);
      if (!billingReservation.ok) {
        releaseSlotOnce();
        res.status(403).json({
          success: false,
          code: 'LIMIT_REACHED',
          error: 'LIMIT_REACHED',
          message: 'You have reached your analysis limit. Upgrade or buy an extra run to continue.',
          plan: billingReservation.plan,
          used: billingReservation.used,
          limit: billingReservation.limit,
          remaining: billingReservation.remaining,
          bonusRuns: billingReservation.bonusRuns,
        });
        return;
      }
      req._billingUserId = billingUserId;
      req._billingReservation = billingReservation;
      req._billingPlan = analyzePlan;
    }
  } else {
    req._billingPlan = null;
    analyzePlan = PLANS.PRO;
  }

  const url = (req.body.url || '').trim();
  const depth = req.body.depth;
  const options = req.body._options || [];
  const comparePair =
    req.body.comparePair === '1' ||
    req.body.comparePair === 'true' ||
    req.body.comparePair === true;

  let files = req.files || [];

  if (!takeGlobalAnalyzeBurstSlot()) {
    releaseSlotOnce();
    res.status(503).json({
      error: 'Service is temporarily busy due to high demand. Please try again in a minute.',
    });
    return;
  }
  if (!tryAcquireGlobalAnalyzeInFlightSlot()) {
    refundGlobalAnalyzeBurstSlot();
    releaseSlotOnce();
    res.status(503).json({
      error: 'Server is at capacity for concurrent analyses. Try again in a moment.',
    });
    return;
  }
  inFlightAcquired = true;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  res.once('close', releaseSlotOnce);
  res.once('finish', releaseSlotOnce);

  const send = (obj) => sseWrite(res, obj);
  let streamStopReason = null;
  let streamedReportText = '';

  const appOrigin = (process.env.FRONTEND_URL || process.env.PUBLIC_APP_URL || '').replace(/\/$/, '') || null;
  send({
    type: 'meta',
    billing: {
      plan: isBillingEnabled() ? analyzePlan : null,
      billingEnabled: isBillingEnabled(),
      isFreePlan: isBillingEnabled() && analyzePlan === PLANS.FREE,
      appOrigin,
      promoRun: Boolean(isBillingEnabled() && promoBypass),
    },
    planTier: isBillingEnabled() ? analyzePlan : null,
    priorityQueue:
      isBillingEnabled() &&
      (analyzePlan === PLANS.PRO || analyzePlan === PLANS.POWER || promoBypass),
  });

  const gateNotes = Array.isArray(req._planGateNotes) ? req._planGateNotes : [];
  if (gateNotes.length) {
    send({ type: 'plan_notice', plan: isBillingEnabled() ? analyzePlan : 'guest', messages: gateNotes });
  }

  void recordProductEvent(analyzeUserId, isBillingEnabled() ? analyzePlan : null, 'run_started', {
    depth: req.body.depth,
    ip: clientIp(req),
    promo: Boolean(promoBypass),
    assetHarvest: Boolean(req._assetHarvestMode),
    scanMode: req._scanMode || 'elite',
  });

  let crawledPages = [];

  try {
    const archiveCtx = buildArchiveLookupContext(req, { openaiModel: OPENAI_MODEL });
    if (
      archiveCtx.eligible &&
      analysisReuseEnabled() &&
      analysisFastReplayEnabled()
    ) {
      const snap = loadLatestSnapshot(
        getAnalysisBaseDir(),
        archiveCtx.hostSlug,
        archiveCtx.fingerprint
      );
      if (
        snap &&
        isSnapshotFresh(snap, analysisCacheMaxAgeMs()) &&
        typeof snap.fullText === 'string' &&
        snap.fullText.length > 80
      ) {
        const billingMetaThin =
          isBillingEnabled() && req._billingPlan
            ? {
                planTier: req._billingPlan,
                priorityQueue: req._billingPlan === PLANS.PRO || req._billingPlan === PLANS.POWER,
              }
            : {};
        await replayAnalysisFromArchive({
          send,
          jitter,
          snapshot: snap,
          reportWriterStageIndex: REPORT_WRITER_STAGE_INDEX,
          billingMetaThin,
        });
        await abortBillingIfNeeded(req);
        const ms = Date.now() - (req._analyzeStartedAt || Date.now());
        logEvent('info', 'analyze_archive_replay', {
          ip: clientIp(req),
          ms,
          host: archiveCtx.hostSlug,
        });
        if (!req._promoValid) {
          noteSuccessfulAnalyzeForCaptcha(clientIp(req));
        }
        if (analyzeUserId) {
          void recordProductEvent(analyzeUserId, isBillingEnabled() ? analyzePlan : null, 'run_completed', {
            ms,
            archiveReplay: true,
            crawlPages: snap.scraperMeta?.crawlPageCount ?? null,
          });
        }
        res.end();
        return;
      }
    }

    if (!openAiConfigured) {
      send({ type: 'error', message: isProd ? ssePublicError() : 'Server misconfiguration: OPENAI_API_KEY is not set (add it to backend/.env).' });
      await abortBillingIfNeeded(req);
      res.end();
      return;
    }

    send({ type: 'stage', index: 0, phase: 'running', label: 'Multi-page crawl & assets' });
    const { html: rawHtml, meta: scraperMeta } = await fetchHtmlDetailed(url, depth);

    const harvestBlockedHints = new Set([
      'no_url',
      'http_error',
      'challenge_or_waf',
      'fetch_timeout',
      'network_or_tls',
      'redirect_blocked',
    ]);

    const canCrawl =
      Boolean(url) &&
      rawHtml.length > 200 &&
      scraperMeta.ok &&
      !scraperMeta.blocked &&
      !harvestBlockedHints.has(scraperMeta.hint || '');

    const assetHarvestMode = Boolean(req._assetHarvestMode);
    scraperMeta.assetHarvestMode = assetHarvestMode;
    scraperMeta.runFocus = req._scanMode || 'elite';
    const htmlModelMaxChars = assetHarvestMode ? ASSET_HARVEST_HTML_MODEL_CHARS : HTML_MODEL_MAX_CHARS_PER_PAGE;
    const harvestImageCap = effectiveHarvestImageCap(
      isBillingEnabled() ? analyzePlan : null,
      assetHarvestMode,
      IMAGE_HARVEST_MAX,
      Boolean(promoBypass)
    );
    const harvestZipCap = effectiveHarvestZipCap(
      isBillingEnabled() ? analyzePlan : null,
      assetHarvestMode,
      IMAGE_HARVEST_ZIP_CAP,
      Boolean(promoBypass)
    );
    const archiveExportAllowed =
      Boolean(promoBypass) ||
      !isBillingEnabled() ||
      analyzePlan === PLANS.PRO ||
      analyzePlan === PLANS.POWER;
    const pageCapForCrawl = crawlPageCapForRequest({
      plan: analyzePlan,
      depth,
      promoOwner: Boolean(promoBypass),
    });
    const extractionProfile = req._extractionProfile || 'standard';
    let crawlWallMs;
    if (promoBypass) {
      const basePriv = Math.min(7_200_000, Math.max(CRAWL_MAX_WALL_CLOCK_MS * 4, 600_000));
      const profMul =
        extractionProfile === 'quality_first' ? 1.5 : extractionProfile === 'full_harvest' ? 1.25 : 1;
      crawlWallMs = Math.min(7_200_000, Math.floor(basePriv * profMul));
    } else {
      const profMul =
        extractionProfile === 'quality_first' ? 3 : extractionProfile === 'full_harvest' ? 2 : 1;
      crawlWallMs = Math.min(1_800_000, Math.floor(CRAWL_MAX_WALL_CLOCK_MS * profMul));
    }

    let crawlStopReason = null;
    let crawlQueueRemaining = 0;

    let harvestProgressLastMs = 0;
    let harvestProgressPending = null;
    const harvestProgressThrottleMs = Math.min(
      10_000,
      Math.max(150, Number(process.env.HARVEST_PROGRESS_MIN_MS) || 400)
    );
    const pushHarvestProgress = (p) => {
      harvestProgressPending = p;
      const now = Date.now();
      if (now - harvestProgressLastMs >= harvestProgressThrottleMs) {
        harvestProgressLastMs = now;
        harvestProgressPending = null;
        send({
          type: 'harvest_progress',
          phase: p.phase || 'crawl',
          phaseLabel: p.phaseLabel || null,
          pagesCrawled: p.pagesCrawled,
          queueLength: p.queueLength,
          pagesDiscovered: p.pagesDiscovered,
          imagesFound: p.imagesFound,
          imagesDownloaded: p.imagesDownloaded,
          imagesFailed: p.imagesFailed,
          duplicatesSkipped: p.duplicatesSkipped,
          zipBytesSoFar: p.zipBytesSoFar,
          elapsedMs: p.elapsedMs,
        });
      }
    };
    const flushHarvestProgress = () => {
      if (harvestProgressPending != null) {
        send({
          type: 'harvest_progress',
          phase: harvestProgressPending.phase || 'crawl',
          phaseLabel: harvestProgressPending.phaseLabel || null,
          pagesCrawled: harvestProgressPending.pagesCrawled,
          queueLength: harvestProgressPending.queueLength,
          pagesDiscovered: harvestProgressPending.pagesDiscovered,
          imagesFound: harvestProgressPending.imagesFound,
          imagesDownloaded: harvestProgressPending.imagesDownloaded,
          imagesFailed: harvestProgressPending.imagesFailed,
          duplicatesSkipped: harvestProgressPending.duplicatesSkipped,
          zipBytesSoFar: harvestProgressPending.zipBytesSoFar,
          elapsedMs: harvestProgressPending.elapsedMs,
        });
        harvestProgressPending = null;
        harvestProgressLastMs = Date.now();
      }
    };

    if (canCrawl) {
      const mp = pageCapForCrawl;
      if (mp <= 1) {
        const u0 = normalizeUrlKey(url.startsWith('http') ? url : `https://${url}`);
        crawledPages = u0 ? [{ url: u0, html: rawHtml }] : [];
        crawlStopReason = 'exhausted';
        crawlQueueRemaining = 0;
      } else {
        const out = await crawlFromSeed(url, rawHtml, {
          maxPages: mp,
          fetchConcurrency: CRAWL_FETCH_CONCURRENCY,
          htmlTimeoutMs: HTML_FETCH_TIMEOUT_MS,
          maxHtmlBytes: MAX_HTML_BYTES,
          maxContentLength: HTML_FETCH_MAX_CONTENT_LENGTH,
          maxRedirects: MAX_REDIRECTS,
          maxCrawlWallClockMs: crawlWallMs,
          onProgress: (p) =>
            pushHarvestProgress({
              phase: 'crawl',
              phaseLabel: 'Crawling internal pages',
              pagesCrawled: p.pagesCrawled,
              queueLength: p.queueLength,
              pagesDiscovered: p.pagesCrawled + p.queueLength,
              elapsedMs: Date.now() - (req._analyzeStartedAt || Date.now()),
            }),
        });
        crawledPages = out.results;
        crawlStopReason = out.stopReason;
        crawlQueueRemaining = out.queueRemaining;
        flushHarvestProgress();
      }
    } else if (url && rawHtml.length > 200) {
      const u0 = normalizeUrlKey(url.startsWith('http') ? url : `https://${url}`);
      crawledPages = u0 ? [{ url: u0, html: rawHtml }] : [];
    }

    scraperMeta.crawlStopReason = crawlStopReason;
    scraperMeta.crawlQueueRemaining = crawlQueueRemaining;
    if (crawlStopReason === 'timeout') {
      scraperMeta.crawlPartial = true;
      scraperMeta.crawlPartialMessage =
        'Partial extraction: crawl stopped at the time limit. More pages may still exist — upgrade or try again with Asset Harvest mode.';
    } else if (crawlStopReason === 'page_cap' && crawlQueueRemaining > 0) {
      scraperMeta.crawlPartial = true;
      scraperMeta.crawlPartialMessage =
        'Partial extraction: reached the page cap with more internal links still queued. Power tier allows the largest crawls.';
    }

    let interactionSnapshots = [];

    const screenshotSweep = req._scanMode === 'screenshots';

    const canInteraction =
      !screenshotSweep &&
      Boolean(url) &&
      crawledPages.length > 0 &&
      !harvestBlockedHints.has(scraperMeta.hint || '') &&
      process.env.ENABLE_INTERACTION_CRAWL !== 'false' &&
      process.env.ENABLE_PAGE_SCREENSHOTS !== 'false';

    if (canInteraction) {
      try {
        const baseCap = pageCapForCrawl;
        const maxCrawlTotal = promoBypass
          ? Math.min(400, baseCap + Math.min(INTERACTION_EXTRA_URL_CAP * 2, 120))
          : Math.min(160, baseCap + Math.min(INTERACTION_EXTRA_URL_CAP, 40));
        const hubUrls = crawledPages.slice(0, INTERACTION_HUB_PAGES).map((p) => p.url);
        let commerceUrl = null;
        for (const p of crawledPages) {
          try {
            if (/\/(cart|checkout|basket|bag|shop\/cart|my-cart)/i.test(new URL(p.url).pathname)) {
              commerceUrl = p.url;
              break;
            }
          } catch {
            /* skip */
          }
        }

        const suite = await runInteractionSuite({
          hubPageUrls: hubUrls,
          commercePageUrl: commerceUrl,
          navigationTimeoutMs: SCREENSHOT_TIMEOUT_MS,
          maxHubPages: INTERACTION_HUB_PAGES,
          maxThemeClicksPerHub: INTERACTION_THEME_CLICKS_PER_HUB,
          maxCheckoutSteps: INTERACTION_CHECKOUT_MAX_STEPS,
          maxDiscoveredUrlList: INTERACTION_EXTRA_URL_CAP * 3,
        });

        interactionSnapshots = suite.snapshots || [];
        scraperMeta.interactionDiscoveredUrls = (suite.discoveredUrls || []).length;
        scraperMeta.interactionSnapshots = interactionSnapshots.length;

        const existingKeys = new Set(crawledPages.map((p) => normalizeUrlKey(p.url)));
        for (const u of suite.discoveredUrls || []) {
          if (crawledPages.length >= maxCrawlTotal) break;
          const k = normalizeUrlKey(u);
          if (!k || existingKeys.has(k)) continue;
          const row = await fetchCrawlPageHtml(k, url, {
            htmlTimeoutMs: HTML_FETCH_TIMEOUT_MS,
            maxHtmlBytes: MAX_HTML_BYTES,
            maxContentLength: HTML_FETCH_MAX_CONTENT_LENGTH,
            maxRedirects: MAX_REDIRECTS,
          });
          if (row) {
            existingKeys.add(k);
            crawledPages.push(row);
          }
        }
      } catch (e) {
        logEvent('warn', 'interaction_suite_failed', { detail: String(e?.message || e) });
      }
    }

    /** Full HTML per URL for image URL discovery (skipped in screenshot sweep). */
    let pagesForImageHarvest;
    if (screenshotSweep) {
      pagesForImageHarvest = [];
      crawledPages = crawledPages.map((p) => ({ url: p.url, html: '' }));
      scraperMeta.htmlModelCleaned = true;
      scraperMeta.htmlModelMaxCharsPerPage = 0;
      scraperMeta.screenshotSweepMode = true;
    } else {
      pagesForImageHarvest = crawledPages.map((p) => ({ url: p.url, html: p.html }));
      crawledPages = crawledPages.map((p) => ({
        url: p.url,
        html: cleanHtmlForModel(p.html, { maxChars: htmlModelMaxChars }),
      }));
      scraperMeta.htmlModelCleaned = true;
      scraperMeta.htmlModelMaxCharsPerPage = htmlModelMaxChars;
    }

    scraperMeta.crawlPageCount = crawledPages.length;
    scraperMeta.crawlMaxPagesRequested = pageCapForCrawl;

    let firstHtml;
    let htmlContext;
    if (screenshotSweep) {
      firstHtml = '';
      if (crawledPages.length > 0) {
        const siteMapLines = crawledPages.map((p, i) => `${i + 1}. ${p.url}`).join('\n');
        const n = crawledPages.length;
        htmlContext = `SCREENSHOT SWEEP MODE\nFull-page PNG captures were taken for each URL below and added to the downloadable ZIP under snapshots/ (001-… through ${String(n).padStart(3, '0')}-…).\nThose PNGs are the primary visual record. Raw HTML was omitted from this prompt to save context — infer structure from the URL list and snapshot ordering; state uncertainty where you cannot see pixels.\n\nCAPTURED PAGES (${n}, same host only):\n${siteMapLines}\n`;
      } else {
        htmlContext = `SCREENSHOT SWEEP MODE\nNo crawl pages were captured (blocked fetch, empty crawl, or seed URL only without HTML). The ZIP may contain few or no snapshots.\nSeed URL: ${url || '(none)'}\n`;
      }
      scraperMeta.modelHtmlTruncated = false;
    } else {
      firstHtml = crawledPages[0]?.html || rawHtml;
      htmlContext = firstHtml;
      if (htmlContext.length > Math.floor(MAX_HTML_FOR_MODEL * 0.88)) {
        scraperMeta.modelHtmlTruncated = true;
        htmlContext = firstHtml.slice(0, Math.floor(MAX_HTML_FOR_MODEL * 0.88));
      }
      if (crawledPages.length > 0) {
        const siteMapLines = crawledPages.map((p, i) => `${i + 1}. ${p.url}`).join('\n');
        htmlContext += `\n\n---\nCRAWLED PAGES (${crawledPages.length} pages, same host only):\n${siteMapLines}\n---\nZIP includes full-page PNGs under snapshots/, extra theme/checkout steps under snapshots/interaction/ when Playwright interaction crawl ran. Harvested images + HTML + screenshots should be combined for cloning.\n`;
      }
      if (htmlContext.length > MAX_HTML_FOR_MODEL) {
        scraperMeta.modelHtmlTruncated = true;
        htmlContext = htmlContext.slice(0, MAX_HTML_FOR_MODEL);
      }
    }

    if (depth === 'deep' && (firstHtml?.length > 0 || screenshotSweep)) {
      scraperMeta.deepWarning = screenshotSweep
        ? 'Screenshot sweep uses a same-host multi-page crawl; each URL gets a full-page PNG. Large sites take longer.'
        : 'Deep scan uses a same-host multi-page crawl; very large pages are truncated per URL for safety.';
    }

    let harvestedImageManifest = '';
    const assetsPayload = {
      count: 0,
      imageCount: 0,
      snapshotCount: 0,
      token: null,
      filename: 'site-assets.zip',
      skipped: 0,
      discoveredUrlCount: 0,
      cssSheetsProcessed: 0,
    };

    const canHarvest =
      Boolean(url) &&
      crawledPages.length > 0 &&
      (screenshotSweep ||
        pagesForImageHarvest.some((p) => (p.html || '').length > 200)) &&
      !harvestBlockedHints.has(scraperMeta.hint || '');

    const snapshotEntries = [];

    if (canHarvest) {
      try {
        const shotUrls = crawledPages.map((p) => p.url);
        scraperMeta.snapshotAttemptCount = shotUrls.length;
        const shots = await screenshotUrls(shotUrls, {
          concurrency: Math.min(CRAWL_SCREENSHOT_CONCURRENCY, shotUrls.length),
          timeoutMs: SCREENSHOT_TIMEOUT_MS,
        });
        let snapIndex = 0;
        for (const sh of shots) {
          if (sh.buffer?.length) {
            snapshotEntries.push({
              name: snapshotZipName(snapIndex, sh.url),
              buffer: sh.buffer,
              url: sh.url,
            });
            snapIndex += 1;
          }
        }
        for (const s of interactionSnapshots) {
          if (s.buffer?.length) {
            snapshotEntries.push({
              name: s.name,
              buffer: s.buffer,
              url: s.url,
            });
          }
        }
        scraperMeta.snapshotCount = snapshotEntries.length;
        scraperMeta.snapshotFailed = shots.filter((s) => !s.buffer).length;
      } catch (e) {
        logEvent('warn', 'screenshot_batch_failed', { detail: String(e?.message || e) });
        scraperMeta.snapshotError = String(e?.message || e).slice(0, 200);
      }

      try {
        const imgSeen = new Set();
        const allImageUrls = [];
        for (const p of pagesForImageHarvest) {
          for (const u of collectImageUrls(p.html, p.url)) {
            const k = normalizeHarvestUrlKey(u);
            if (!k || imgSeen.has(k)) continue;
            imgSeen.add(k);
            allImageUrls.push(u);
          }
        }
        if (pagesForImageHarvest.length > 0) {
          const { imageUrls: cssImageUrls, sheetsProcessed } =
            await harvestLinkedStylesheetImageUrls(pagesForImageHarvest);
          scraperMeta.cssSheetsProcessed = sheetsProcessed;
          for (const u of cssImageUrls) {
            const k = normalizeHarvestUrlKey(u);
            if (!k || imgSeen.has(k)) continue;
            imgSeen.add(k);
            allImageUrls.push(u);
          }
        }
        scraperMeta.imagesDiscoveredCount = allImageUrls.length;
        scraperMeta.pagesDiscoveredCount = crawledPages.length + crawlQueueRemaining;
        assetsPayload.discoveredUrlCount = allImageUrls.length;
        assetsPayload.cssSheetsProcessed = Number(scraperMeta.cssSheetsProcessed) || 0;
        assetsPayload.pagesCrawled = crawledPages.length;
        assetsPayload.pagesDiscovered = crawledPages.length + crawlQueueRemaining;
        assetsPayload.pagesRemaining = crawlQueueRemaining;
        assetsPayload.crawlStopReason = crawlStopReason;
        pushHarvestProgress({
          phase: 'discover_images',
          phaseLabel: 'Discovering images and CSS assets',
          pagesCrawled: crawledPages.length,
          queueLength: crawlQueueRemaining,
          pagesDiscovered: crawledPages.length + crawlQueueRemaining,
          imagesFound: allImageUrls.length,
          elapsedMs: Date.now() - (req._analyzeStartedAt || Date.now()),
        });
        flushHarvestProgress();
        const fetched = await fetchHarvestedImages(allImageUrls, {
          maxImages: harvestImageCap,
          maxBytesPerImage: IMAGE_HARVEST_MAX_BYTES,
          maxTotalBytes: harvestZipCap,
          concurrency: IMAGE_HARVEST_CONCURRENCY,
          onProgress: (ev) =>
            pushHarvestProgress({
              phase: 'download_images',
              phaseLabel: 'Downloading harvested assets',
              pagesCrawled: crawledPages.length,
              queueLength: crawlQueueRemaining,
              pagesDiscovered: crawledPages.length + crawlQueueRemaining,
              imagesFound: allImageUrls.length,
              imagesDownloaded: ev.imagesInZip ?? 0,
              duplicatesSkipped: ev.contentDuplicatesSkipped ?? 0,
              zipBytesSoFar: ev.bytesSoFar ?? 0,
              elapsedMs: Date.now() - (req._analyzeStartedAt || Date.now()),
            }),
        });
        scraperMeta.harvestContentDuplicatesSkipped = fetched.contentDuplicatesSkipped || 0;
        scraperMeta.imagesFailedCount = fetched.fetchFailures || 0;
        scraperMeta.archiveBytes = fetched.archiveBytes || 0;
        const crawlHtmlExtras = buildCrawlHtmlExtractEntries(pagesForImageHarvest);
        if (allImageUrls.length > 0) {
          crawlHtmlExtras.push({
            name: 'extract/_discovered_image_urls.txt',
            buffer: Buffer.from(
              [
                '# Unique image-related URLs discovered from HTML + linked CSS (one per line).',
                '# Fetching may skip some URLs (plan caps, SSRF rules, non-image responses, size limits).',
                '',
                ...allImageUrls,
              ].join('\n'),
              'utf8'
            ),
          });
        }
        const pagesManifestJson = pagesForImageHarvest.map((p, index) => ({
          order: index + 1,
          url: p.url,
          htmlBytes: Buffer.byteLength(p.html || '', 'utf8'),
        }));
        const imagesManifestJson = fetched.entries.map((e, index) => ({
          order: index + 1,
          file: e.name,
          sourceUrl: e.sourceUrl || '',
        }));
        const manifestJson = {
          generatedAt: new Date().toISOString(),
          extractionProfile: req._extractionProfile || 'standard',
          runFocus: req._scanMode || 'elite',
          crawlStopReason,
          pagesDiscovered: crawledPages.length + crawlQueueRemaining,
          pagesCrawled: crawledPages.length,
          pagesRemaining: crawlQueueRemaining,
          imagesDiscovered: allImageUrls.length,
          imagesArchived: fetched.entries.length,
          imagesFailed: fetched.fetchFailures || 0,
          duplicatesSkipped: fetched.contentDuplicatesSkipped || 0,
          skippedEntries: fetched.skipped,
          snapshots: snapshotEntries.length,
          archiveBytes: fetched.archiveBytes || 0,
          cssSheetsProcessed: Number(scraperMeta.cssSheetsProcessed) || 0,
          elapsedMs: Date.now() - (req._analyzeStartedAt || Date.now()),
        };
        const manifestExtras = [
          {
            name: 'manifests/pages.json',
            buffer: Buffer.from(JSON.stringify(pagesManifestJson, null, 2), 'utf8'),
          },
          {
            name: 'manifests/pages.csv',
            buffer: Buffer.from(
              ['order,url,html_bytes', ...pagesManifestJson.map((p) => `${p.order},${csvEscape(p.url)},${p.htmlBytes}`)].join('\n'),
              'utf8'
            ),
          },
          {
            name: 'manifests/images.json',
            buffer: Buffer.from(JSON.stringify(imagesManifestJson, null, 2), 'utf8'),
          },
          {
            name: 'manifests/images.csv',
            buffer: Buffer.from(
              ['order,file,source_url', ...imagesManifestJson.map((p) => `${p.order},${csvEscape(p.file)},${csvEscape(p.sourceUrl)}`)].join('\n'),
              'utf8'
            ),
          },
          {
            name: 'manifests/manifest.json',
            buffer: Buffer.from(JSON.stringify(manifestJson, null, 2), 'utf8'),
          },
          {
            name: 'manifests/manifest.csv',
            buffer: Buffer.from(
              [
                'metric,value',
                ...Object.entries(manifestJson).map(([k, v]) => `${csvEscape(k)},${csvEscape(v)}`),
              ].join('\n'),
              'utf8'
            ),
          },
          {
            name: 'manifests/site-map.txt',
            buffer: Buffer.from(pagesForImageHarvest.map((p) => p.url).join('\n'), 'utf8'),
          },
        ];
        const pagesCsvText = ['order,url,html_bytes', ...pagesManifestJson.map((p) => `${p.order},${csvEscape(p.url)},${p.htmlBytes}`)].join('\n');
        const imagesCsvText = ['order,file,source_url', ...imagesManifestJson.map((p) => `${p.order},${csvEscape(p.file)},${csvEscape(p.sourceUrl)}`)].join('\n');
        const manifestCsvText = [
          'metric,value',
          ...Object.entries(manifestJson).map(([k, v]) => `${csvEscape(k)},${csvEscape(v)}`),
        ].join('\n');
        req._jobArtifacts = {
          ...(req._jobArtifacts || {}),
          pagesJson: pagesManifestJson,
          imagesJson: imagesManifestJson,
          manifestJson,
          pagesCsvText,
          imagesCsvText,
          manifestCsvText,
          siteMapText: pagesForImageHarvest.map((p) => p.url).join('\n'),
        };
        const zipBuf = await zipImageEntries(fetched.entries, snapshotEntries, [...crawlHtmlExtras, ...manifestExtras]);
        if (zipBuf?.length) {
          if (fetched.entries.length > 0) {
            harvestedImageManifest = buildImageManifestForPrompt(fetched.entries);
          }
          assetsPayload.imageCount = fetched.entries.length;
          assetsPayload.snapshotCount = snapshotEntries.length;
          assetsPayload.count =
            fetched.entries.length + snapshotEntries.length + crawlHtmlExtras.length + manifestExtras.length;
          assetsPayload.skipped = fetched.skipped;
          assetsPayload.archiveBytes = fetched.archiveBytes || 0;
          assetsPayload.failed = fetched.fetchFailures || 0;
          assetsPayload.duplicatesSkipped = fetched.contentDuplicatesSkipped || 0;
          assetsPayload.pagesManifestCount = pagesManifestJson.length;
          assetsPayload.imagesManifestCount = imagesManifestJson.length;
          if (archiveExportAllowed) {
            assetsPayload.token = createSiteAssetDownload(zipBuf, 'site-assets.zip');
          } else {
            assetsPayload.token = null;
            assetsPayload.archiveLocked = true;
            scraperMeta.archiveLockedMessage =
              'Archive downloads are unlocked on Pro, Power, or owner mode. This run still recorded completeness metrics and manifests internally.';
          }
          pushHarvestProgress({
            phase: 'package',
            phaseLabel: 'Packaging ZIP and manifests',
            pagesCrawled: crawledPages.length,
            queueLength: crawlQueueRemaining,
            pagesDiscovered: crawledPages.length + crawlQueueRemaining,
            imagesFound: allImageUrls.length,
            imagesDownloaded: fetched.entries.length,
            imagesFailed: fetched.fetchFailures || 0,
            duplicatesSkipped: fetched.contentDuplicatesSkipped || 0,
            zipBytesSoFar: fetched.archiveBytes || 0,
            elapsedMs: Date.now() - (req._analyzeStartedAt || Date.now()),
          });
          flushHarvestProgress();
          logEvent('info', 'asset_bundle_ok', {
            ip: clientIp(req),
            images: fetched.entries.length,
            snapshots: snapshotEntries.length,
            crawlPages: crawledPages.length,
            contentDupes: fetched.contentDuplicatesSkipped || 0,
          });
        }
      } catch (e) {
        logEvent('warn', 'image_harvest_failed', { detail: String(e?.message || e) });
      }
    }

    send({ type: 'stage', index: 0, phase: 'done' });
    const billingMeta =
      isBillingEnabled() && req._billingPlan
        ? {
            planTier: req._billingPlan,
            priorityQueue: req._billingPlan === PLANS.PRO || req._billingPlan === PLANS.POWER,
          }
        : {};
    send({
      type: 'meta',
      scraper: scraperMeta,
      assets: assetsPayload,
      runFocus: req._scanMode || 'elite',
      ...billingMeta,
    });

    const stages = [
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

    for (const s of stages) {
      send({ type: 'stage', index: s.index, phase: 'running', label: s.label });
      await jitter(120, 280);
      send({ type: 'stage', index: s.index, phase: 'done' });
    }

    send({
      type: 'stage',
      index: CHIEF_ARCHITECT_STAGE_INDEX,
      phase: 'running',
      label: 'Chief architect — every specialist reports here',
    });
    await jitter(280, 520);
    send({
      type: 'stage',
      index: CHIEF_ARCHITECT_STAGE_INDEX,
      phase: 'done',
      label: 'Chief architect — stack approved for final brief',
    });
    send({
      type: 'stage',
      index: CHIEF_REVISIT_AGENT_INDEX,
      phase: 'running',
      label: 'States & micro-interactions (chief-requested revisit)',
    });
    await jitter(140, 280);
    send({
      type: 'stage',
      index: CHIEF_REVISIT_AGENT_INDEX,
      phase: 'done',
      label: 'States & micro-interactions (chief-requested revisit)',
    });

    send({
      type: 'stage',
      index: REPORT_WRITER_STAGE_INDEX,
      phase: 'running',
      label: 'Report writer (AI)',
    });

    const optimized = [];
    const imgMaxW = files.length > 6 ? 1280 : files.length > 3 ? 1600 : 2048;
    for (const f of files) {
      const { buffer, mime } = await optimizeImageForModel(f.buffer, f.mimetype, {
        maxWidth: imgMaxW,
        trimSolidBackground: Boolean(req._removeImageBackground),
      });
      optimized.push(Object.assign({}, f, { buffer, mimetype: mime }));
    }
    files = optimized;

    const userContent = buildOpenAiUserContent({
      url,
      depth,
      options,
      htmlContext,
      files,
      scraperMeta,
      comparePair,
      harvestedImageManifest,
      clientDelivery: Boolean(req._clientDelivery),
      servicePackage: req._servicePackage || '',
      scanMode: req._scanMode || 'elite',
      promoAuthorized: Boolean(req._promoValid),
    });

    const systemContent =
      SYSTEM_PROMPT_BASE +
      buildPromoOwnerQualityAddon(Boolean(req._promoValid)) +
      buildAnalyzerDeliveryAddons(Boolean(req._clientDelivery), req._servicePackage || '') +
      buildScanModeSystemAddon(req._scanMode || 'elite', Boolean(req._promoValid));

    const reportMaxTokens = req._promoValid
      ? Math.min(
          16384,
          Math.max(MAX_OUTPUT_TOKENS, Number(process.env.OPENAI_MAX_TOKENS_PROMO_OWNER) || 12000)
        )
      : MAX_OUTPUT_TOKENS;

    const body = {
      model: OPENAI_MODEL,
      max_tokens: reportMaxTokens,
      stream: true,
      ...(OPENAI_STREAM_INCLUDE_USAGE ? { stream_options: { include_usage: true } } : {}),
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent },
      ],
    };

    const payloadJson = JSON.stringify(body);
    const payloadBytes = Buffer.byteLength(payloadJson, 'utf8');
    if (payloadBytes > MAX_OPENAI_REQUEST_JSON_BYTES) {
      send({ type: 'stage', index: REPORT_WRITER_STAGE_INDEX, phase: 'error' });
      send({
        type: 'error',
        message: isProd
          ? 'This scan produced too much input for one run. Use fewer images, shallower depth, or fewer analysis toggles.'
          : `OpenAI request payload too large (${payloadBytes} bytes, max ${MAX_OPENAI_REQUEST_JSON_BYTES}).`,
      });
      logEvent('warn', 'analyze_payload_too_large', {
        ip: clientIp(req),
        bytes: payloadBytes,
        crawlPages: crawledPages.length,
      });
      await abortBillingIfNeeded(req);
      res.end();
      return;
    }

    const streamBudgetMs = req._promoValid
      ? Math.min(3_600_000, OPENAI_STREAM_MS * 4 + crawledPages.length * 40000)
      : Math.min(900000, OPENAI_STREAM_MS + crawledPages.length * 25000);
    const ac = new AbortController();
    const streamTimer = setTimeout(() => ac.abort(), streamBudgetMs);

    let response;
    try {
      response = await openAiChatCompletionsRequest({
        apiKey,
        body,
        signal: ac.signal,
        maxAttempts: 2,
      });
    } catch (e) {
      clearTimeout(streamTimer);
      if (e.name === 'AbortError') {
        send({ type: 'stage', index: REPORT_WRITER_STAGE_INDEX, phase: 'error' });
        send({
          type: 'error',
          message: isProd
            ? 'The analysis timed out. Try fewer images or shallower depth.'
            : 'OpenAI request timed out.',
        });
        logEvent('error', 'analyze_openai_timeout', { ip: clientIp(req) });
        await abortBillingIfNeeded(req);
        res.end();
        return;
      }
      throw e;
    }
    clearTimeout(streamTimer);

    if (!response.ok) {
      const errText = await response.text();
      logEvent('error', 'analyze_openai_http', {
        ip: clientIp(req),
        status: response.status,
        ...(isProd ? {} : { bodySnippet: errText.slice(0, 400) }),
      });
      send({ type: 'stage', index: REPORT_WRITER_STAGE_INDEX, phase: 'error' });
      send({
        type: 'error',
        message: isProd ? mapOpenAiFailureStatus(response.status) : errText.slice(0, 2000),
      });
      await abortBillingIfNeeded(req);
      res.end();
      return;
    }

    if (!response.body) {
      send({ type: 'stage', index: REPORT_WRITER_STAGE_INDEX, phase: 'error' });
      send({ type: 'error', message: ssePublicError() });
      await abortBillingIfNeeded(req);
      res.end();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let streamUsage = null;

    const flushEventBlock = (block) => {
      const lines = block.split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        if (!payload) continue;
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        if (ev.usage && typeof ev.usage === 'object') {
          streamUsage = ev.usage;
        }
        if (ev.error) {
          send({
            type: 'error',
            message: isProd ? ssePublicError() : ev.error?.message || JSON.stringify(ev.error),
          });
          continue;
        }
        const choice = ev.choices && ev.choices[0];
        if (!choice) continue;
        const piece = choice.delta?.content;
        if (typeof piece === 'string' && piece.length) {
          streamedReportText += piece;
          send({ type: 'text', content: piece });
        }
        if (choice.finish_reason) {
          streamStopReason = choice.finish_reason;
        }
      }
    };

    await withSseKeepalive(res, async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = sseBuffer.indexOf('\n\n')) !== -1) {
          const block = sseBuffer.slice(0, sep);
          sseBuffer = sseBuffer.slice(sep + 2);
          flushEventBlock(block);
        }
      }
      sseBuffer += decoder.decode();
      if (sseBuffer.trim()) flushEventBlock(sseBuffer);
    });

    if (streamStopReason === 'max_tokens' || streamStopReason === 'length') {
      send({
        type: 'warning',
        code: 'truncated',
        message: req._promoValid
          ? '\n\n---\n\n> **Output limit reached.** Raise `OPENAI_MAX_TOKENS_PROMO_OWNER` (cap 16384) or use a model with a higher completion limit, then re-run.\n'
          : '\n\n---\n\n> **Output limit reached.** The brief was truncated at the model token ceiling. Re-run with fewer images, shallower depth, or fewer analysis toggles for a complete report.\n',
      });
    }

    send({
      type: 'stage',
      index: REPORT_WRITER_STAGE_INDEX,
      phase: 'done',
      label: 'Report writer (AI)',
    });
    send({ type: 'done' });

    const ms = Date.now() - (req._analyzeStartedAt || Date.now());
    logEvent('info', 'analyze_success', { ip: clientIp(req), ms });
    if (!req._promoValid) {
      noteSuccessfulAnalyzeForCaptcha(clientIp(req));
    }
    if (analyzeUserId) {
      const pt = streamUsage?.prompt_tokens;
      const ct = streamUsage?.completion_tokens;
      const estUsd = estimateOpenAiUsd(OPENAI_MODEL, pt, ct);
      void recordProductEvent(analyzeUserId, isBillingEnabled() ? analyzePlan : null, 'run_completed', {
        ms,
        model: OPENAI_MODEL,
        promptTokens: pt,
        completionTokens: ct,
        totalTokens: streamUsage?.total_tokens,
        estUsd: Number(estUsd.toFixed(6)),
        htmlContextChars: htmlContext.length,
        crawlPages: crawledPages.length,
        promo: Boolean(req._promoValid),
      });
    }

    const archSave = buildArchiveLookupContext(req, { openaiModel: OPENAI_MODEL });
    if (archSave.eligible && streamedReportText.length > 80) {
      let metaJson;
      let assetsJson;
      try {
        metaJson = JSON.parse(JSON.stringify(scraperMeta));
      } catch {
        metaJson = { note: 'scraperMeta not serializable; truncated', crawlPageCount: scraperMeta?.crawlPageCount };
      }
      try {
        assetsJson = JSON.parse(JSON.stringify(assetsPayload));
      } catch {
        assetsJson = { count: 0, token: null, filename: 'site-assets.zip' };
      }
      saveAnalysisSnapshot({
        baseDir: getAnalysisBaseDir(),
        hostSlug: archSave.hostSlug,
        fingerprint: archSave.fingerprint,
        record: {
          version: 1,
          savedAt: new Date().toISOString(),
          normalizedUrl: archSave.normalizedUrl,
          depth,
          options,
          comparePair,
          fullText: streamedReportText,
          openaiModel: OPENAI_MODEL,
          scraperMeta: metaJson,
          assetsPayload: assetsJson,
        },
      });
    }

    res.end();
  } catch (err) {
    await abortBillingIfNeeded(req);
    logEvent('error', 'analyze_failure', {
      ip: clientIp(req),
      detail: String(err?.stack || err?.message || err),
    });
    if (!isProd) console.error(err);
    send({ type: 'stage', index: REPORT_WRITER_STAGE_INDEX, phase: 'error' });
    send({
      type: 'error',
      message: isProd ? ssePublicError() : err.message || ssePublicError(),
    });
    res.end();
  }
}

async function runRevisePipeline(req, res) {
  const apiKey = process.env.OPENAI_API_KEY;
  const openAiConfigured = isOpenAiConfigured();

  const ipGate = clientIp(req);
  const slotTry = tryAcquireAnalyzeSlot(req.get('x-cloneai-user-id'), ipGate);
  if (!slotTry.ok) {
    res.status(429).json({
      error: 'An analysis is already running for this session. Wait for it to finish before starting another.',
    });
    return;
  }
  const slotKey = slotTry.key;
  let slotReleased = false;
  let inFlightAcquired = false;
  const releaseSlotOnce = () => {
    if (slotReleased) return;
    slotReleased = true;
    releaseAnalyzeSlot(slotKey);
    if (inFlightAcquired) {
      inFlightAcquired = false;
      releaseGlobalAnalyzeInFlightSlot();
    }
  };

  let analyzePlan = null;
  let analyzeUserId = normalizeUserId(req.get('x-cloneai-user-id'));
  const promoBypass = Boolean(req._promoValid);

  if (isBillingEnabled()) {
    const billingUserId = normalizeUserId(req.get('x-cloneai-user-id'));
    if (!billingUserId) {
      releaseSlotOnce();
      res.status(400).json({
        success: false,
        code: 'MISSING_USER_ID',
        error: 'MISSING_USER_ID',
      });
      return;
    }
    analyzeUserId = billingUserId;

    if (promoBypass) {
      logEvent('info', 'revise_promo_run', { ip: clientIp(req), userId: billingUserId });
      analyzePlan = PLANS.POWER;
      req._billingUserId = billingUserId;
      req._billingReservation = null;
      req._billingPlan = PLANS.POWER;
    } else {
      const billingReservation = await tryBeginRun(billingUserId);
      if (!billingReservation.ok) {
        releaseSlotOnce();
        res.status(403).json({
          success: false,
          code: 'LIMIT_REACHED',
          error: 'LIMIT_REACHED',
          message: 'You have reached your analysis limit. Upgrade or buy an extra run to continue.',
          plan: billingReservation.plan,
          used: billingReservation.used,
          limit: billingReservation.limit,
          remaining: billingReservation.remaining,
          bonusRuns: billingReservation.bonusRuns,
        });
        return;
      }
      req._billingUserId = billingUserId;
      req._billingReservation = billingReservation;
      analyzePlan = billingReservation.plan;
      req._billingPlan = analyzePlan;
    }
  } else {
    req._billingPlan = null;
    analyzePlan = PLANS.PRO;
  }

  if (!openAiConfigured) {
    releaseSlotOnce();
    res.status(503).json({
      error: isProd ? 'Analysis service is not configured.' : 'OPENAI_API_KEY is not set.',
    });
    return;
  }

  if (!takeGlobalAnalyzeBurstSlot()) {
    releaseSlotOnce();
    res.status(503).json({
      error: 'Service is temporarily busy due to high demand. Please try again in a minute.',
    });
    return;
  }
  if (!tryAcquireGlobalAnalyzeInFlightSlot()) {
    refundGlobalAnalyzeBurstSlot();
    releaseSlotOnce();
    res.status(503).json({
      error: 'Server is at capacity for concurrent analyses. Try again in a moment.',
    });
    return;
  }
  inFlightAcquired = true;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  res.once('close', releaseSlotOnce);
  res.once('finish', releaseSlotOnce);

  const send = (obj) => sseWrite(res, obj);
  const appOrigin = (process.env.FRONTEND_URL || process.env.PUBLIC_APP_URL || '').replace(/\/$/, '') || null;

  send({
    type: 'meta',
    billing: {
      plan: isBillingEnabled() ? analyzePlan : null,
      billingEnabled: isBillingEnabled(),
      isFreePlan: isBillingEnabled() && analyzePlan === PLANS.FREE,
      appOrigin,
      promoRun: Boolean(isBillingEnabled() && promoBypass),
    },
    planTier: isBillingEnabled() ? analyzePlan : null,
    priorityQueue:
      isBillingEnabled() && (analyzePlan === PLANS.PRO || analyzePlan === PLANS.POWER || promoBypass),
    assets: { count: 0, token: null, filename: 'site-assets.zip', skipped: 0 },
  });

  void recordProductEvent(analyzeUserId, isBillingEnabled() ? analyzePlan : null, 'run_started', {
    ip: clientIp(req),
    promo: Boolean(promoBypass),
    revise: true,
  });

  const prior = req._revisePriorBrief;
  const fixNote = req._reviseFixNote;

  try {
    const userMsg = buildReviseUserMessage(prior, fixNote);
    const reviseMaxTokens = promoBypass
      ? Math.min(
          16384,
          Math.max(MAX_OUTPUT_TOKENS, Number(process.env.OPENAI_MAX_TOKENS_PROMO_OWNER) || 12000)
        )
      : MAX_OUTPUT_TOKENS;
    const body = {
      model: OPENAI_MODEL,
      max_tokens: reviseMaxTokens,
      stream: true,
      ...(OPENAI_STREAM_INCLUDE_USAGE ? { stream_options: { include_usage: true } } : {}),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT_REVISE },
        { role: 'user', content: userMsg },
      ],
    };

    const payloadJson = JSON.stringify(body);
    const payloadBytes = Buffer.byteLength(payloadJson, 'utf8');
    if (payloadBytes > MAX_OPENAI_REQUEST_JSON_BYTES) {
      send({ type: 'stage', index: REPORT_WRITER_STAGE_INDEX, phase: 'error' });
      send({
        type: 'error',
        message: isProd
          ? 'This brief is too large to revise in one request. Trim the report or split the edit.'
          : `OpenAI request payload too large (${payloadBytes} bytes, max ${MAX_OPENAI_REQUEST_JSON_BYTES}).`,
      });
      await abortBillingIfNeeded(req);
      res.end();
      return;
    }

    send({
      type: 'stage',
      index: REPORT_WRITER_STAGE_INDEX,
      phase: 'running',
      label: 'Report writer (AI revise)',
    });

    const reviseStreamBudgetMs = promoBypass
      ? Math.min(3_600_000, OPENAI_STREAM_MS * 4)
      : OPENAI_STREAM_MS;
    const ac = new AbortController();
    const streamTimer = setTimeout(() => ac.abort(), reviseStreamBudgetMs);

    let response;
    try {
      response = await openAiChatCompletionsRequest({
        apiKey,
        body,
        signal: ac.signal,
        maxAttempts: 2,
      });
    } catch (e) {
      clearTimeout(streamTimer);
      if (e.name === 'AbortError') {
        send({ type: 'stage', index: REPORT_WRITER_STAGE_INDEX, phase: 'error' });
        send({
          type: 'error',
          message: isProd
            ? 'The revision timed out. For coupon runs, try a shorter focus note or increase OPENAI_STREAM_TIMEOUT_MS.'
            : 'OpenAI request timed out.',
        });
        logEvent('error', 'revise_openai_timeout', { ip: clientIp(req) });
        await abortBillingIfNeeded(req);
        res.end();
        return;
      }
      throw e;
    }
    clearTimeout(streamTimer);

    if (!response.ok) {
      const errText = await response.text();
      logEvent('error', 'revise_openai_http', {
        ip: clientIp(req),
        status: response.status,
        ...(isProd ? {} : { bodySnippet: errText.slice(0, 400) }),
      });
      send({ type: 'stage', index: REPORT_WRITER_STAGE_INDEX, phase: 'error' });
      send({
        type: 'error',
        message: isProd ? mapOpenAiFailureStatus(response.status) : errText.slice(0, 2000),
      });
      await abortBillingIfNeeded(req);
      res.end();
      return;
    }

    if (!response.body) {
      send({ type: 'stage', index: REPORT_WRITER_STAGE_INDEX, phase: 'error' });
      send({ type: 'error', message: ssePublicError() });
      await abortBillingIfNeeded(req);
      res.end();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let streamUsage = null;
    let streamedReportText = '';
    let streamStopReason = null;

    const flushEventBlock = (block) => {
      const lines = block.split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        if (!payload) continue;
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        if (ev.usage && typeof ev.usage === 'object') {
          streamUsage = ev.usage;
        }
        if (ev.error) {
          send({
            type: 'error',
            message: isProd ? ssePublicError() : ev.error?.message || JSON.stringify(ev.error),
          });
          continue;
        }
        const choice = ev.choices && ev.choices[0];
        if (!choice) continue;
        const piece = choice.delta?.content;
        if (typeof piece === 'string' && piece.length) {
          streamedReportText += piece;
          send({ type: 'text', content: piece });
        }
        if (choice.finish_reason) {
          streamStopReason = choice.finish_reason;
        }
      }
    };

    await withSseKeepalive(res, async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = sseBuffer.indexOf('\n\n')) !== -1) {
          const block = sseBuffer.slice(0, sep);
          sseBuffer = sseBuffer.slice(sep + 2);
          flushEventBlock(block);
        }
      }
      sseBuffer += decoder.decode();
      if (sseBuffer.trim()) flushEventBlock(sseBuffer);
    });

    if (streamStopReason === 'max_tokens' || streamStopReason === 'length') {
      send({
        type: 'warning',
        code: 'truncated',
        message:
          '\n\n---\n\n> **Output limit reached.** The revised brief was truncated. Try again with a shorter prior report or narrower focus.\n',
      });
    }

    send({
      type: 'stage',
      index: REPORT_WRITER_STAGE_INDEX,
      phase: 'done',
      label: 'Report writer (AI revise)',
    });
    send({ type: 'done' });

    const ms = Date.now() - (req._analyzeStartedAt || Date.now());
    logEvent('info', 'revise_success', { ip: clientIp(req), ms });
    if (!req._promoValid) {
      noteSuccessfulAnalyzeForCaptcha(clientIp(req));
    }
    if (analyzeUserId) {
      const pt = streamUsage?.prompt_tokens;
      const ct = streamUsage?.completion_tokens;
      const estUsd = estimateOpenAiUsd(OPENAI_MODEL, pt, ct);
      void recordProductEvent(analyzeUserId, isBillingEnabled() ? analyzePlan : null, 'run_completed', {
        ms,
        model: OPENAI_MODEL,
        promptTokens: pt,
        completionTokens: ct,
        totalTokens: streamUsage?.total_tokens,
        estUsd: Number(estUsd.toFixed(6)),
        promo: Boolean(promoBypass),
        revise: true,
      });
    }

    res.end();
  } catch (err) {
    await abortBillingIfNeeded(req);
    logEvent('error', 'revise_failure', {
      ip: clientIp(req),
      detail: String(err?.stack || err?.message || err),
    });
    if (!isProd) console.error(err);
    send({ type: 'stage', index: REPORT_WRITER_STAGE_INDEX, phase: 'error' });
    send({
      type: 'error',
      message: isProd ? ssePublicError() : err.message || ssePublicError(),
    });
    res.end();
  }
}

app.get('/api/site-images/:token', requireIngressKey, (req, res) => {
  const raw = (req.params.token || '').trim();
  if (!/^[a-f0-9]{48}$/i.test(raw)) {
    res.status(400).json({ error: 'Invalid download link.' });
    return;
  }
  const rec = getSiteAssetDownload(raw);
  if (!rec) {
    res.status(404).json({ error: 'Download link expired or invalid. Run analysis again.' });
    return;
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="site-assets.zip"');
  res.setHeader('Cache-Control', 'no-store');
  res.send(rec.buffer);
});

app.post(
  '/api/asset-pipeline/enhance',
  requireIngressKey,
  assetPipelineLimiter,
  async (req, res) => {
    if (!ENABLE_ASSET_PIPELINE_API) {
      res.status(503).json({ error: 'Asset pipeline API is disabled.' });
      return;
    }
    const token = String(req.body?.token || '').trim();
    if (!/^[a-f0-9]{48}$/i.test(token)) {
      res.status(400).json({ error: 'Invalid token.' });
      return;
    }
    const rec = getSiteAssetDownload(token);
    if (!rec) {
      res.status(404).json({ error: 'Download link expired or invalid. Run analysis again.' });
      return;
    }
    const buf = rec.buffer;
    if (!buf?.length) {
      res.status(400).json({ error: 'Empty asset bundle.' });
      return;
    }
    if (buf.length > ASSET_PIPELINE_MAX_ZIP_BYTES) {
      res.status(413).json({ error: 'Asset bundle too large for enhancement.' });
      return;
    }
    try {
      const skipHd = String(process.env.IMAGE_PIPELINE_SKIP_HD || '').toLowerCase() === 'true';
      const useAiPick = String(process.env.IMAGE_PIPELINE_AI_NAMING || '').toLowerCase() === 'true';
      const apiKey = (process.env.OPENAI_API_KEY || '').trim();
      const { buffer: outBuf, stats } = await processSiteAssetZipBuffer(buf, {
        skipHd,
        useAiPick: useAiPick && Boolean(apiKey),
        apiKey,
        maxRasterImages: ASSET_PIPELINE_MAX_RASTER,
      });
      const newToken = createSiteAssetDownload(outBuf, 'site-assets-ready.zip');
      logEvent('info', 'asset_pipeline_enhance_ok', {
        ip: clientIp(req),
        userId: normalizeUserId(req.get('x-cloneai-user-id')) || undefined,
        ...stats,
      });
      res.json({
        token: newToken,
        filename: 'site-assets-ready.zip',
        stats,
      });
    } catch (err) {
      logEvent('warn', 'asset_pipeline_enhance_fail', {
        ip: clientIp(req),
        detail: String(err?.message || err).slice(0, 400),
      });
      res.status(500).json({
        error: isProd ? 'Enhancement failed.' : String(err?.message || err),
      });
    }
  }
);

app.post(
  '/api/analyze-revise',
  analyzeLimiter,
  analyzeDailyLimiter,
  requireIngressKey,
  requireProductionBrowserOrigin,
  validateReviseRequest,
  reviseRequestLogger,
  (req, res, next) => {
    runRevisePipeline(req, res).catch(next);
  }
);

app.get('/api/extraction-jobs', requireIngressKey, (req, res) => {
  const userId = normalizeUserId(req.get('x-cloneai-user-id'));
  if (!userId) {
    res.status(400).json({ error: 'Missing user id.' });
    return;
  }
  const jobs = listExtractionJobsForUser(extractionJobsBaseDir, userId, {
    limit: Math.max(1, Math.min(50, Number(req.query?.limit) || 20)),
  });
  res.json({
    jobs: jobs.map((job) => ({
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      summary: job.summary,
      progress: job.progress,
      artifacts: job.artifacts,
      assets: job.assets,
      scraper: job.scraper,
      error: job.error,
    })),
  });
});

app.get('/api/extraction-jobs/:id', requireIngressKey, (req, res) => {
  const job = loadExtractionJob(extractionJobsBaseDir, String(req.params.id || '').trim());
  if (!authorizeExtractionJobAccess(req, res, job)) return;
  res.json(job);
});

app.get('/api/extraction-jobs/:id/events', requireIngressKey, (req, res) => {
  const job = loadExtractionJob(extractionJobsBaseDir, String(req.params.id || '').trim());
  if (!authorizeExtractionJobAccess(req, res, job)) return;
  streamExtractionJobEvents(req, res, job);
});

app.get('/api/extraction-jobs/:id/artifacts/:name', requireIngressKey, (req, res) => {
  const job = loadExtractionJob(extractionJobsBaseDir, String(req.params.id || '').trim());
  if (!authorizeExtractionJobAccess(req, res, job)) return;
  const artifactName = String(req.params.name || '').trim();
  const artifact = Array.isArray(job.artifacts) ? job.artifacts.find((item) => item?.name === artifactName) : null;
  const filePath = getExtractionJobArtifactPath(extractionJobsBaseDir, job.id, artifactName);
  if (!artifact || !filePath) {
    res.status(404).json({ error: 'Artifact not found.' });
    return;
  }
  res.setHeader('Content-Type', artifact.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${artifact.name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(filePath);
});

app.post(
  '/api/extraction-jobs',
  analyzeLimiter,
  analyzeDailyLimiter,
  requireIngressKey,
  requireProductionBrowserOrigin,
  upload.array('images', 10),
  validateAnalyzeRequest,
  analyzeRequestLogger,
  async (req, res) => {
    const userId = normalizeUserId(req.get('x-cloneai-user-id'));
    if (!userId) {
      res.status(400).json({ error: 'MISSING_USER_ID' });
      return;
    }
    try {
      const job = await createExtractionJob({
        baseDir: extractionJobsBaseDir,
        userId,
        sourceIp: clientIp(req),
        input: buildExtractionJobInputFromRequest(req),
      });
      scheduleExtractionJobPump();
      res.status(202).json({
        ok: true,
        jobId: job.id,
        status: job.status,
        createdAt: job.createdAt,
        summary: job.summary,
        eventsUrl: `/api/extraction-jobs/${encodeURIComponent(job.id)}/events`,
        jobUrl: `/api/extraction-jobs/${encodeURIComponent(job.id)}`,
      });
    } catch (err) {
      logEvent('error', 'job_create_failed', {
        ip: clientIp(req),
        detail: String(err?.stack || err?.message || err),
      });
      res.status(500).json({ error: 'Could not create extraction job.' });
    }
  }
);

app.post(
  '/api/analyze',
  analyzeLimiter,
  analyzeDailyLimiter,
  requireIngressKey,
  requireProductionBrowserOrigin,
  upload.array('images', 10),
  validateAnalyzeRequest,
  analyzeRequestLogger,
  (req, res, next) => {
    runAnalyzePipeline(req, res).catch(next);
  }
);

if (serveSpa) {
  app.use(
    express.static(spaRoot, {
      maxAge: '2h',
      etag: true,
      fallthrough: true,
      index: 'index.html',
    })
  );
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api')) return next();
    res.sendFile(spaIndex, (err) => next(err));
  });
}

app.use((err, _req, res, next) => {
  if (err && err.message === 'UNSUPPORTED_UPLOAD_TYPE') {
    res.status(400).json({ error: 'Unsupported file type. Use PNG, JPG, or WebP only.' });
    return;
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ error: 'Each image must be 20MB or smaller.' });
      return;
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      res.status(400).json({ error: 'Maximum 10 images per request.' });
      return;
    }
    if (err.code === 'LIMIT_FIELD_COUNT' || err.code === 'LIMIT_PART_COUNT') {
      res.status(400).json({ error: 'Upload payload is too large or malformed.' });
      return;
    }
    res.status(400).json({ error: 'Upload failed.' });
    return;
  }
  logEvent('error', 'unhandled_express_error', { detail: String(err?.stack || err?.message || err) });
  if (!res.headersSent) {
    res.status(500).json({ error: isProd ? 'Something went wrong.' : err.message || 'Error' });
  }
});

function onListen() {
  scheduleExtractionJobPump();
  console.log(`CloneAI backend listening on http://localhost:${listenPort}`);
  if (serveSpa) {
    console.log(`Serving bundled SPA from ${spaRoot} (same origin as API)`);
  }
  const corsLog =
    isProd && corsOrigins.length === 0
      ? '(none — set CORS_ORIGINS)'
      : !isProd && !process.env.CORS_ORIGINS?.trim()
        ? 'any http://localhost or http://127.0.0.1 (any port)'
        : corsOrigins.join(', ');
  console.log(`CORS allowlist: ${corsLog}`);
  console.log(
    `Global API rate limit: ${GLOBAL_RATE_PER_MINUTE}/minute per IP (webhook + health excluded)`
  );
  console.log(`Rate limits: ${RATE_PER_MINUTE}/minute and ${DAILY_MAX}/day per IP on /api/analyze`);
  console.log(
    `OpenAI model: ${OPENAI_MODEL}, max_tokens: ${MAX_OUTPUT_TOKENS}, stream timeout: ${OPENAI_STREAM_MS}ms`
  );
  const harvestCap =
    IMAGE_HARVEST_MAX >= Number.MAX_SAFE_INTEGER - 1 ? 'unlimited' : String(IMAGE_HARVEST_MAX);
  const zipCap =
    IMAGE_HARVEST_ZIP_CAP >= Number.MAX_SAFE_INTEGER - 1 ? 'unlimited' : `${Math.round(IMAGE_HARVEST_ZIP_CAP / (1024 * 1024))}MiB`;
  console.log(
    `Image harvest: max images ${harvestCap}, per-file ${Math.round(IMAGE_HARVEST_MAX_BYTES / (1024 * 1024))}MiB, ZIP total ${zipCap}, concurrency ${IMAGE_HARVEST_CONCURRENCY}, HTML buffer ${Math.round(MAX_HTML_BYTES / 1024)}KiB`
  );
  console.log(
    `Crawl: max pages (Pro cap) ${crawlMaxPagesEnvCap()}, HTML concurrency ${CRAWL_FETCH_CONCURRENCY}, screenshot concurrency ${CRAWL_SCREENSHOT_CONCURRENCY}`
  );
  console.log(
    `Cost guards: HTML clean per page ≤ ${HTML_MODEL_MAX_CHARS_PER_PAGE} chars, max ${MAX_ANALYSIS_IMAGES} images, OpenAI body ≤ ${Math.round(MAX_OPENAI_REQUEST_JSON_BYTES / (1024 * 1024))}MiB, global burst ${GLOBAL_BURST_MAX}/${Math.round(GLOBAL_BURST_WINDOW_MS / 1000)}s, max concurrent analyses (instance) ${GLOBAL_ANALYZE_MAX_IN_FLIGHT}, concurrent analyses/user ${String(process.env.ANALYZE_MAX_CONCURRENT_PER_USER || '1')}, asset downloads use expiring token storage`
  );
  console.log(
    `Interaction: hub pages ${INTERACTION_HUB_PAGES}, theme clicks/hub ${INTERACTION_THEME_CLICKS_PER_HUB}, checkout steps ${INTERACTION_CHECKOUT_MAX_STEPS}, extra URL cap ${INTERACTION_EXTRA_URL_CAP}`
  );
  if (isBillingEnabled()) {
    console.log(
      'Billing: ENABLED — limits enforced; ensure STRIPE_*, FRONTEND_URL, webhook route /api/billing/webhook'
    );
  } else {
    console.log('Billing: disabled (set BILLING_ENABLED=true to enforce usage + Stripe)');
  }
  if (configuredPromoCode()) {
    console.log(
      'Promo: CLONEAI_PROMO_CODE is set — valid code skips Stripe run quota and uses owner-quality crawl/harvest/output limits (CORS, rate limits, SSRF, and OpenAI cost still apply).'
    );
  }
}

function tryBindListen(appInstance, port) {
  return new Promise((resolve, reject) => {
    const srv = appInstance.listen(port);
    const onOk = () => {
      srv.off('error', onErr);
      resolve(srv);
    };
    const onErr = (err) => {
      srv.off('listening', onOk);
      srv.close(() => reject(err));
    };
    srv.once('listening', onOk);
    srv.once('error', onErr);
  });
}

let httpServer;
(async () => {
  if (isProd && hasExplicitPort) {
    const p = basePort;
    if (!Number.isFinite(p) || p < 1 || p > 65535) {
      console.error(`Invalid PORT: ${JSON.stringify(envPortRaw)}`);
      process.exit(1);
    }
    try {
      httpServer = await tryBindListen(app, p);
      listenPort = p;
      onListen();
    } catch (e) {
      console.error(`Failed to listen on PORT=${p} (required in production):`, e);
      process.exit(1);
    }
    return;
  }
  const start = Number.isFinite(basePort) && basePort > 0 ? basePort : 3001;
  for (let p = start; p < start + LISTEN_PORT_TRIES; p++) {
    try {
      httpServer = await tryBindListen(app, p);
      listenPort = p;
      onListen();
      return;
    } catch (e) {
      if (e.code === 'EADDRINUSE') {
        console.warn(`Port ${p} is in use, trying ${p + 1}…`);
        continue;
      }
      throw e;
    }
  }
  console.error(`No free port in range ${start}–${start + LISTEN_PORT_TRIES - 1}`);
  process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
