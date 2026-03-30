import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import axios from 'axios';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
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
  fetchHarvestedImages,
  zipImageEntries,
  buildImageManifestForPrompt,
  normalizeHarvestUrlKey,
} from './imageHarvest.js';
import { effectiveHarvestImageCap, effectiveHarvestZipCap } from './harvestBudget.js';
import { crawlFromSeed, normalizeUrlKey, fetchCrawlPageHtml } from './crawlSite.js';
import { crawlMaxPagesEnvCap, maxCrawlPagesForRun } from './crawlLimits.js';
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

dotenv.config();

const isProd = process.env.NODE_ENV === 'production';

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
const basePort = Number(process.env.PORT) || 3001;
let listenPort = basePort;
const LISTEN_PORT_TRIES = 50;

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

function isLocalDevBrowserOrigin(origin) {
  try {
    const u = new URL(origin);
    return (
      u.protocol === 'http:' &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
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

const HTML_MODEL_MAX_CHARS_PER_PAGE = Math.min(
  150_000,
  Math.max(20_000, Number(process.env.HTML_MODEL_MAX_CHARS_PER_PAGE) || 80_000)
);

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

const SITE_ASSET_TTL_MS = Math.min(
  2 * 60 * 60 * 1000,
  Math.max(5 * 60 * 1000, Number(process.env.SITE_ASSET_TTL_MS) || 30 * 60 * 1000)
);
const MAX_REDIRECTS = Math.min(5, Math.max(0, Number(process.env.HTML_FETCH_MAX_REDIRECTS) || 2));

/** Short-lived ZIP blobs for GET /api/site-images/:token (not logged). */
const siteAssetDownloads = new Map();
const MAX_SITE_ASSET_DOWNLOADS = Math.min(
  20_000,
  Math.max(200, Number(process.env.MAX_SITE_ASSET_DOWNLOADS) || 2500)
);

function rememberSiteAssetDownload(token, rec) {
  while (siteAssetDownloads.size >= MAX_SITE_ASSET_DOWNLOADS) {
    let oldestKey = null;
    let oldestExp = Infinity;
    for (const [k, v] of siteAssetDownloads) {
      if (v.expires < oldestExp) {
        oldestExp = v.expires;
        oldestKey = k;
      }
    }
    if (oldestKey != null) siteAssetDownloads.delete(oldestKey);
    else break;
  }
  siteAssetDownloads.set(token, rec);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of siteAssetDownloads) {
    if (v.expires < now) siteAssetDownloads.delete(k);
  }
}, 5 * 60 * 1000).unref?.();

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

    req._removeImageBackground = ['1', 'true', 'yes', 'on'].includes(
      String(req.body.removeImageBackground || '').trim().toLowerCase()
    );

    req._assetHarvestMode = ['1', 'true', 'yes', 'on'].includes(
      String(req.body.assetHarvest || req.body.deepAssetHarvest || '').trim().toLowerCase()
    );

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
  logEvent('info', 'analyze_request', { ip: clientIp(req) });
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

app.get('/', (req, res) => {
  const front = (process.env.FRONTEND_URL || process.env.PUBLIC_APP_URL || '').trim().replace(/\/$/, '');
  const accept = String(req.get('accept') || '');
  // Apex domain often points at this API by mistake; send real browsers to the static app.
  if (front && accept.includes('text/html')) {
    res.redirect(301, `${front}/`);
    return;
  }
  res.type('application/json').send({
    ok: true,
    service: 'cloneai-api',
    docs: 'Use POST /api/analyze and GET /api/health — the web app is hosted separately.',
    health: '/api/health',
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
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
- **Section 9:** If a "HARVESTED PAGE IMAGES" list is provided, map each \`image-NNN.*\` file to what it shows and **where** it sits on the page (section + position). If no harvest list, still list every visible image/video from HTML and screenshots with placement.
- Never use vague filler ("modern", "clean") without concrete measurements or tokens. If something cannot be determined, write "Unknown from available input" instead of inventing.
- If data is missing, say what is unknown instead of guessing.
- **Section 13 closing:** After the priority fix list, add a **Scorecard** subsection (### Scorecard) with 4–6 bullets: overall clone difficulty (Low/Med/High), structure confidence, visual fidelity confidence, content/inventory completeness, top risk, and estimated rebuild effort — each grounded in what you actually saw in the inputs.

**Efficiency (cost / latency):** Prefer dense bullets over narrative prose. Do not repeat the user prompt or quote large chunks of HTML. Honor "not requested" sections with minimal text.`;

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
}) {
  let text = `Analyze the following and produce the complete developer brief using EXACTLY this output structure (fill all sections; respect focus rules):\n\n${OUTPUT_STRUCTURE}\n\nReplace "[site name/URL]" with the actual site name or URL. Replace "[today's date]" with: ${todayISO()}\n`;
  text += buildOptionInstructions(options);

  text += `\n---\nINPUT CONTEXT:\n- URL: ${url || '(none)'}\n- Scan depth: ${depth}\n`;

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
    text += `\n---\nRAW HTML (truncated for model context):\n\n${htmlContext}\n`;
    if (scraperMeta?.modelHtmlTruncated) {
      text += `\n(Note: HTML was truncated for token limits; rely on screenshots + structure hints for gaps.)\n`;
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
  if (!apiKey || apiKey === 'your_key_here' || apiKey.startsWith('sk-your')) {
    res.status(500).json({
      error: isProd
        ? 'Service temporarily unavailable.'
        : 'Server misconfiguration: OPENAI_API_KEY is not set (add it to backend/.env).',
    });
    return;
  }

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
      analyzePlan = PLANS.PRO;
      req._planGateNotes = [];
      req._billingUserId = billingUserId;
      req._billingReservation = null;
      req._billingPlan = PLANS.PRO;
      const promoFeatureGate = evaluateAnalyzeFeatureGate(PLANS.PRO, {
        hasUrl: Boolean(urlForBilling),
        imageCount: filesForGate.length,
        depth: req.body.depth,
      });
      if (!promoFeatureGate.ok) {
        releaseSlotOnce();
        res.status(403).json({
          success: false,
          code: promoFeatureGate.code,
          error: promoFeatureGate.code,
          message: promoFeatureGate.message,
          feature: promoFeatureGate.feature,
        });
        return;
      }
    } else {
      const usageSnap = await getUsageSnapshot(billingUserId);
      analyzePlan = usageSnap.plan || PLANS.FREE;

      req._planGateNotes = [];
      if (analyzePlan === PLANS.FREE && req.body.depth !== 'homepage') {
        req._planGateNotes.push('Free plan uses a single-page scan. Upgrade for multi-page crawls.');
        req.body.depth = 'homepage';
      }
      if (analyzePlan === PLANS.STARTER && req.body.depth === 'deep') {
        req._planGateNotes.push(
          'Deep multi-page crawl (up to ~300 pages on Pro, higher on Power) is not on Starter. Using balanced depth (~25 pages).'
        );
        req.body.depth = 'shallow';
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
      isBillingEnabled() && (analyzePlan === PLANS.PRO || analyzePlan === PLANS.POWER),
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
  });

  let crawledPages = [];

  try {
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
    const htmlModelMaxChars = assetHarvestMode ? ASSET_HARVEST_HTML_MODEL_CHARS : HTML_MODEL_MAX_CHARS_PER_PAGE;
    const harvestImageCap = effectiveHarvestImageCap(
      isBillingEnabled() ? analyzePlan : null,
      assetHarvestMode,
      IMAGE_HARVEST_MAX
    );
    const harvestZipCap = effectiveHarvestZipCap(
      isBillingEnabled() ? analyzePlan : null,
      assetHarvestMode,
      IMAGE_HARVEST_ZIP_CAP
    );

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
        send({ type: 'harvest_progress', pagesCrawled: p.pagesCrawled, queueLength: p.queueLength });
      }
    };
    const flushHarvestProgress = () => {
      if (harvestProgressPending != null) {
        send({
          type: 'harvest_progress',
          pagesCrawled: harvestProgressPending.pagesCrawled,
          queueLength: harvestProgressPending.queueLength,
        });
        harvestProgressPending = null;
        harvestProgressLastMs = Date.now();
      }
    };

    if (canCrawl) {
      const mp = maxCrawlPagesForRun(analyzePlan, depth);
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
          maxCrawlWallClockMs: CRAWL_MAX_WALL_CLOCK_MS,
          onProgress: pushHarvestProgress,
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

    const canInteraction =
      Boolean(url) &&
      crawledPages.length > 0 &&
      !harvestBlockedHints.has(scraperMeta.hint || '') &&
      process.env.ENABLE_INTERACTION_CRAWL !== 'false' &&
      process.env.ENABLE_PAGE_SCREENSHOTS !== 'false';

    if (canInteraction) {
      try {
        const baseCap = maxCrawlPagesForRun(analyzePlan, depth);
        const maxCrawlTotal = Math.min(160, baseCap + Math.min(INTERACTION_EXTRA_URL_CAP, 40));
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

    /** Full HTML per URL for image URL discovery (model path truncates/cleans and would miss late-page imgs). */
    const pagesForImageHarvest = crawledPages.map((p) => ({ url: p.url, html: p.html }));

    crawledPages = crawledPages.map((p) => ({
      url: p.url,
      html: cleanHtmlForModel(p.html, { maxChars: htmlModelMaxChars }),
    }));
    scraperMeta.htmlModelCleaned = true;
    scraperMeta.htmlModelMaxCharsPerPage = htmlModelMaxChars;

    scraperMeta.crawlPageCount = crawledPages.length;
    scraperMeta.crawlMaxPagesRequested = maxCrawlPagesForRun(analyzePlan, depth);

    const firstHtml = crawledPages[0]?.html || rawHtml;
    let htmlContext = firstHtml;
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

    if (depth === 'deep' && firstHtml.length > 0) {
      scraperMeta.deepWarning =
        'Deep scan uses a same-host multi-page crawl; very large pages are truncated per URL for safety.';
    }

    let harvestedImageManifest = '';
    const assetsPayload = {
      count: 0,
      imageCount: 0,
      snapshotCount: 0,
      token: null,
      filename: 'site-assets.zip',
      skipped: 0,
    };

    const canHarvest =
      Boolean(url) &&
      crawledPages.length > 0 &&
      crawledPages.some((p) => p.html.length > 200) &&
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
        scraperMeta.imagesDiscoveredCount = allImageUrls.length;
        const fetched = await fetchHarvestedImages(allImageUrls, {
          maxImages: harvestImageCap,
          maxBytesPerImage: IMAGE_HARVEST_MAX_BYTES,
          maxTotalBytes: harvestZipCap,
          concurrency: IMAGE_HARVEST_CONCURRENCY,
        });
        scraperMeta.harvestContentDuplicatesSkipped = fetched.contentDuplicatesSkipped || 0;
        const crawlHtmlExtras = buildCrawlHtmlExtractEntries(pagesForImageHarvest);
        const zipBuf = await zipImageEntries(fetched.entries, snapshotEntries, crawlHtmlExtras);
        if (zipBuf?.length) {
          const token = randomBytes(24).toString('hex');
          rememberSiteAssetDownload(token, {
            buffer: zipBuf,
            expires: Date.now() + SITE_ASSET_TTL_MS,
          });
          if (fetched.entries.length > 0) {
            harvestedImageManifest = buildImageManifestForPrompt(fetched.entries);
          }
          assetsPayload.imageCount = fetched.entries.length;
          assetsPayload.snapshotCount = snapshotEntries.length;
          assetsPayload.count =
            fetched.entries.length + snapshotEntries.length + crawlHtmlExtras.length;
          assetsPayload.token = token;
          assetsPayload.skipped = fetched.skipped;
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
    send({ type: 'meta', scraper: scraperMeta, assets: assetsPayload, ...billingMeta });

    const stages = [
      { index: 1, label: 'Layout Analyst' },
      { index: 2, label: 'Typography Extractor' },
      { index: 3, label: 'Color Extractor' },
      { index: 4, label: 'Component Mapper' },
      { index: 5, label: 'Content Indexer' },
      { index: 6, label: 'Diff Analyzer' },
    ];

    for (const s of stages) {
      send({ type: 'stage', index: s.index, phase: 'running', label: s.label });
      await jitter(320, 680);
      send({ type: 'stage', index: s.index, phase: 'done' });
    }

    send({ type: 'stage', index: 7, phase: 'running', label: 'Report writer' });

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
    });

    const systemContent =
      SYSTEM_PROMPT_BASE +
      buildAnalyzerDeliveryAddons(Boolean(req._clientDelivery), req._servicePackage || '');

    const body = {
      model: OPENAI_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
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
      send({ type: 'stage', index: 7, phase: 'error' });
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

    const streamBudgetMs = Math.min(900000, OPENAI_STREAM_MS + crawledPages.length * 25000);
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
        send({ type: 'stage', index: 7, phase: 'error' });
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
      send({ type: 'stage', index: 7, phase: 'error' });
      send({
        type: 'error',
        message: isProd ? mapOpenAiFailureStatus(response.status) : errText.slice(0, 2000),
      });
      await abortBillingIfNeeded(req);
      res.end();
      return;
    }

    if (!response.body) {
      send({ type: 'stage', index: 7, phase: 'error' });
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
          send({ type: 'text', content: piece });
        }
        if (choice.finish_reason) {
          streamStopReason = choice.finish_reason;
        }
      }
    };

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
    if (sseBuffer.trim()) flushEventBlock(sseBuffer);

    if (streamStopReason === 'max_tokens' || streamStopReason === 'length') {
      send({
        type: 'warning',
        code: 'truncated',
        message:
          '\n\n---\n\n> **Output limit reached.** The brief was truncated at the model token ceiling. Re-run with fewer images, shallower depth, or fewer analysis toggles for a complete report.\n',
      });
    }

    send({ type: 'stage', index: 7, phase: 'done', label: 'Report writer' });
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
    res.end();
  } catch (err) {
    await abortBillingIfNeeded(req);
    logEvent('error', 'analyze_failure', {
      ip: clientIp(req),
      detail: String(err?.stack || err?.message || err),
    });
    if (!isProd) console.error(err);
    send({ type: 'stage', index: 7, phase: 'error' });
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
  const rec = siteAssetDownloads.get(raw);
  if (!rec || rec.expires < Date.now()) {
    res.status(404).json({ error: 'Download link expired or invalid. Run analysis again.' });
    return;
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="site-assets.zip"');
  res.setHeader('Cache-Control', 'no-store');
  res.send(rec.buffer);
});

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
  console.log(`CloneAI backend listening on http://localhost:${listenPort}`);
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
    `Cost guards: HTML clean per page ≤ ${HTML_MODEL_MAX_CHARS_PER_PAGE} chars, max ${MAX_ANALYSIS_IMAGES} images, OpenAI body ≤ ${Math.round(MAX_OPENAI_REQUEST_JSON_BYTES / (1024 * 1024))}MiB, global burst ${GLOBAL_BURST_MAX}/${Math.round(GLOBAL_BURST_WINDOW_MS / 1000)}s, max concurrent analyses (instance) ${GLOBAL_ANALYZE_MAX_IN_FLIGHT}, concurrent analyses/user ${String(process.env.ANALYZE_MAX_CONCURRENT_PER_USER || '1')}, asset download cache ≤ ${MAX_SITE_ASSET_DOWNLOADS}`
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
      'Promo: CLONEAI_PROMO_CODE is set — valid code skips usage quota (CORS, rate limits, SSRF, and API cost still apply).'
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
  for (let p = basePort; p < basePort + LISTEN_PORT_TRIES; p++) {
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
  console.error(`No free port in range ${basePort}–${basePort + LISTEN_PORT_TRIES - 1}`);
  process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
