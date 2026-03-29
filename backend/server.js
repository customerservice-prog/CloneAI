import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import axios from 'axios';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { optimizeImageForModel } from './imageOptimize.js';
import { assertUrlSafeForServerFetch, isUnsafeIpLiteral } from './ssrf.js';
import {
  collectImageUrls,
  fetchHarvestedImages,
  zipImageEntries,
  buildImageManifestForPrompt,
} from './imageHarvest.js';
import { crawlFromSeed, normalizeUrlKey, fetchCrawlPageHtml } from './crawlSite.js';
import { runInteractionSuite } from './playwrightInteraction.js';
import { screenshotUrls, snapshotZipName } from './screenshotPages.js';
import {
  isBillingEnabled,
  normalizeUserId,
  tryBeginRun,
  abortRun,
  getUsageSnapshot,
  getUsageSnapshotSync,
  evaluateAnalyzeFeatureGate,
  PLANS,
  recordProductEvent,
} from './billingService.js';
import {
  postStripeWebhook,
  getBillingStatus,
  postBillingCheckout,
  getBillingAnalytics,
} from './billingHttp.js';
import { appendLeadRecord } from './leadsStore.js';

dotenv.config();

const app = express();

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
const isProd = process.env.NODE_ENV === 'production';

if (isProd) {
  app.set('trust proxy', 1);
}

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
    allowedHeaders: ['Content-Type', 'X-CloneAI-Key', 'X-CloneAI-User-Id'],
    maxAge: 86400,
  })
);

app.use(express.json({ limit: '512kb' }));

const RATE_PER_MINUTE = Math.min(
  30,
  Math.max(5, Number(process.env.RATE_LIMIT_PER_MINUTE) || 8)
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 10,
    fields: 24,
    fieldSize: 64 * 1024,
    parts: 32,
  },
});

function requireIngressKey(req, res, next) {
  const expected = process.env.CLONEAI_INGRESS_KEY?.trim();
  if (!expected) return next();
  const sent = req.get('x-cloneai-key');
  if (sent !== expected) {
    res.status(403).json({ error: 'Forbidden.' });
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

const MAX_URL_LENGTH = 2048;
const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
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

const CRAWL_MAX_PAGES = Math.min(250, Math.max(1, Number(process.env.CRAWL_MAX_PAGES) || 100));
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

    const files = req.files || [];
    if (!req.body.url && !files.length) {
      res.status(400).json({ error: 'Enter a URL and/or upload at least one image.' });
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
  return `\n---\nANALYSIS FOCUS — expand deeply ONLY for these selected areas:\n${lines}\n${omitLine}\nStill output all 13 section headings for consistency; respect the focus rules above within each section.\n`;
}

const SYSTEM_PROMPT_BASE = `You are an elite web development consultant. Produce an extremely detailed, developer-ready brief.

Hard requirements:
- Include ALL 13 section headings exactly as provided (numbered ## 1 through ## 13). Each must have substantive content, not placeholders.
- Use ### sub-headings and bullet lists where it improves clarity.
- **Where things live (critical):** In sections 2, 3, 6, 7, 8, 9, and 10, every major block must state (1) its **vertical order** (e.g. "Block 1 — immediately below nav", "Block 4 — mid-page before footer"), (2) **horizontal placement** (full-bleed, centered column, left third, right rail), (3) **approximate width** (e.g. ~1140px container, 33% grid column) when inferable, (4) **DOM hints** from HTML when present (tag names, \`id\`, \`class\`, \`data-*\`, \`role\`, landmark elements like \`<header>\`, \`<main>\`, \`<section>\`, \`<footer>\`), and (5) **above-the-fold vs below** for the first screen. Never describe the page only as generic "sections"; tie each item to position and structure.
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
- **Section 13 closing:** After the priority fix list, add a **Scorecard** subsection (### Scorecard) with 4–6 bullets: overall clone difficulty (Low/Med/High), structure confidence, visual fidelity confidence, content/inventory completeness, top risk, and estimated rebuild effort — each grounded in what you actually saw in the inputs.`;

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

  text += `\n---\nCATALOG / INVENTORY (required when the site lists categories, rentals, products, or bookable items):\n- List **every** category and **every** distinct item/card visible in the HTML or screenshots (group by section if there are many).\n- For each item: visible name, price or primary CTA label, and URL/path from \`href\` when present in HTML.\n- Tie thumbnails to \`image-NNN.*\` harvest filenames or alt text when possible.\n- Do not replace long lists with "various products" — a developer needs an exhaustive inventory for cloning.\n`;

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

function ssePublicError() {
  return 'We could not complete this analysis. Please try again.';
}

function mapOpenAiFailureStatus(status) {
  if (status === 401) return 'Analysis service is misconfigured (invalid API key).';
  if (status === 429) return 'Analysis service is busy. Try again later.';
  return 'The analysis service returned an error. Try again later.';
}

function maxPagesForDepth(depth) {
  if (depth === 'homepage') return 1;
  if (depth === 'shallow') return Math.min(25, CRAWL_MAX_PAGES);
  return CRAWL_MAX_PAGES;
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

  const urlForBilling = (req.body.url || '').trim();
  const filesForGate = req.files || [];
  let analyzePlan = null;
  let analyzeUserId = normalizeUserId(req.get('x-cloneai-user-id'));
  const planGateWarnings = [];

  if (isBillingEnabled()) {
    const billingUserId = normalizeUserId(req.get('x-cloneai-user-id'));
    if (!billingUserId) {
      res.status(400).json({
        success: false,
        code: 'MISSING_USER_ID',
        error: 'MISSING_USER_ID',
      });
      return;
    }
    analyzeUserId = billingUserId;
    const usageSnap = await getUsageSnapshot(billingUserId);
    analyzePlan = usageSnap.plan || PLANS.FREE;

    if (analyzePlan === PLANS.FREE && req.body.depth !== 'homepage') {
      req.body.depth = 'homepage';
      planGateWarnings.push(
        'Free plan uses a single homepage scan. Upgrade for multi-page or full-site crawls.'
      );
    }
    if (analyzePlan === PLANS.STARTER && req.body.depth === 'deep') {
      req.body.depth = 'shallow';
      planGateWarnings.push('Full crawl (100+ pages) is included with Pro. Using balanced depth (~25 pages).');
    }

    const featureGate = evaluateAnalyzeFeatureGate(analyzePlan, {
      hasUrl: Boolean(urlForBilling),
      imageCount: filesForGate.length,
      depth: req.body.depth,
    });
    if (!featureGate.ok) {
      res.status(403).json({
        success: false,
        code: featureGate.code,
        error: featureGate.code,
        message: featureGate.message,
        feature: featureGate.feature,
        upgradeHint: Boolean(featureGate.upgradeHint),
      });
      return;
    }

    const billingReservation = await tryBeginRun(billingUserId);
    if (!billingReservation.ok) {
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
  } else {
    req._billingPlan = null;
    if (analyzeUserId) {
      analyzePlan = getUsageSnapshotSync(analyzeUserId).plan;
    }
  }

  const url = (req.body.url || '').trim();
  const depth = req.body.depth;
  const options = req.body._options || [];
  const comparePair =
    req.body.comparePair === '1' ||
    req.body.comparePair === 'true' ||
    req.body.comparePair === true;

  let files = req.files || [];

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

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
    },
  });
  if (planGateWarnings.length) {
    send({ type: 'plan_notice', plan: analyzePlan, messages: planGateWarnings });
  }

  void recordProductEvent(analyzeUserId, isBillingEnabled() ? analyzePlan : null, 'run_started', {
    depth: req.body.depth,
    ip: clientIp(req),
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

    if (canCrawl) {
      const mp = maxPagesForDepth(depth);
      if (mp <= 1) {
        const u0 = normalizeUrlKey(url.startsWith('http') ? url : `https://${url}`);
        crawledPages = u0 ? [{ url: u0, html: rawHtml }] : [];
      } else {
        crawledPages = await crawlFromSeed(url, rawHtml, {
          maxPages: mp,
          fetchConcurrency: CRAWL_FETCH_CONCURRENCY,
          htmlTimeoutMs: HTML_FETCH_TIMEOUT_MS,
          maxHtmlBytes: MAX_HTML_BYTES,
          maxContentLength: HTML_FETCH_MAX_CONTENT_LENGTH,
          maxRedirects: MAX_REDIRECTS,
        });
      }
    } else if (url && rawHtml.length > 200) {
      const u0 = normalizeUrlKey(url.startsWith('http') ? url : `https://${url}`);
      crawledPages = u0 ? [{ url: u0, html: rawHtml }] : [];
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
        const baseCap = maxPagesForDepth(depth);
        const maxCrawlTotal = Math.min(400, baseCap + INTERACTION_EXTRA_URL_CAP);
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

    scraperMeta.crawlPageCount = crawledPages.length;
    scraperMeta.crawlMaxPagesRequested = maxPagesForDepth(depth);

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
        for (const p of crawledPages) {
          for (const u of collectImageUrls(p.html, p.url)) {
            if (!imgSeen.has(u)) {
              imgSeen.add(u);
              allImageUrls.push(u);
            }
          }
        }
        const fetched = await fetchHarvestedImages(allImageUrls, {
          maxImages: IMAGE_HARVEST_MAX,
          maxBytesPerImage: IMAGE_HARVEST_MAX_BYTES,
          maxTotalBytes: IMAGE_HARVEST_ZIP_CAP,
          concurrency: IMAGE_HARVEST_CONCURRENCY,
        });
        const zipBuf = await zipImageEntries(fetched.entries, snapshotEntries);
        if (zipBuf?.length) {
          const token = randomBytes(24).toString('hex');
          siteAssetDownloads.set(token, {
            buffer: zipBuf,
            expires: Date.now() + SITE_ASSET_TTL_MS,
          });
          if (fetched.entries.length > 0) {
            harvestedImageManifest = buildImageManifestForPrompt(fetched.entries);
          }
          assetsPayload.imageCount = fetched.entries.length;
          assetsPayload.snapshotCount = snapshotEntries.length;
          assetsPayload.count = fetched.entries.length + snapshotEntries.length;
          assetsPayload.token = token;
          assetsPayload.skipped = fetched.skipped;
          logEvent('info', 'asset_bundle_ok', {
            ip: clientIp(req),
            images: fetched.entries.length,
            snapshots: snapshotEntries.length,
            crawlPages: crawledPages.length,
          });
        }
      } catch (e) {
        logEvent('warn', 'image_harvest_failed', { detail: String(e?.message || e) });
      }
    }

    send({ type: 'stage', index: 0, phase: 'done' });
    const billingMeta =
      isBillingEnabled() && req._billingPlan
        ? { planTier: req._billingPlan, priorityQueue: req._billingPlan === PLANS.PRO }
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

    send({ type: 'stage', index: 7, phase: 'running', label: 'Brief Writer' });

    const optimized = [];
    for (const f of files) {
      const { buffer, mime } = await optimizeImageForModel(f.buffer, f.mimetype);
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
    });

    const body = {
      model: OPENAI_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT_BASE },
        { role: 'user', content: userContent },
      ],
    };

    const streamBudgetMs = Math.min(900000, OPENAI_STREAM_MS + crawledPages.length * 25000);
    const ac = new AbortController();
    const streamTimer = setTimeout(() => ac.abort(), streamBudgetMs);

    let response;
    try {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ac.signal,
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
        bodySnippet: errText.slice(0, 400),
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

    send({ type: 'stage', index: 7, phase: 'done' });
    send({ type: 'done' });

    const ms = Date.now() - (req._analyzeStartedAt || Date.now());
    logEvent('info', 'analyze_success', { ip: clientIp(req), ms });
    if (analyzeUserId) {
      void recordProductEvent(
        analyzeUserId,
        isBillingEnabled() ? analyzePlan : null,
        'run_completed',
        { ms }
      );
    }
    res.end();
  } catch (err) {
    await abortBillingIfNeeded(req);
    logEvent('error', 'analyze_failure', {
      ip: clientIp(req),
      detail: String(err?.stack || err?.message || err),
    });
    console.error(err);
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

const httpServer = app.listen(listenPort, onListen);

function onListen() {
  console.log(`CloneAI backend listening on http://localhost:${listenPort}`);
  const corsLog =
    isProd && corsOrigins.length === 0
      ? '(none — set CORS_ORIGINS)'
      : !isProd && !process.env.CORS_ORIGINS?.trim()
        ? 'any http://localhost or http://127.0.0.1 (any port)'
        : corsOrigins.join(', ');
  console.log(`CORS allowlist: ${corsLog}`);
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
    `Crawl: max pages ${CRAWL_MAX_PAGES}, HTML concurrency ${CRAWL_FETCH_CONCURRENCY}, screenshot concurrency ${CRAWL_SCREENSHOT_CONCURRENCY}`
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
}

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && listenPort < basePort + LISTEN_PORT_TRIES) {
    console.warn(`Port ${listenPort} is in use, trying ${listenPort + 1}…`);
    listenPort += 1;
    httpServer.listen(listenPort, onListen);
    return;
  }
  throw err;
});
LING_ENABLED=true to enforce usage + Stripe)');
  }
}

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && listenPort < basePort + LISTEN_PORT_TRIES) {
    console.warn(`Port ${listenPort} is in use, trying ${listenPort + 1}…`);
    listenPort += 1;
    httpServer.listen(listenPort, onListen);
    return;
  }
  throw err;
});
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && listenPort < basePort + LISTEN_PORT_TRIES) {
    console.warn(`Port ${listenPort} is in use, trying ${listenPort + 1}…`);
    listenPort += 1;
    httpServer.listen(listenPort, onListen);
    return;
  }
  throw err;
});
EADDRINUSE' && listenPort < basePort + LISTEN_PORT_TRIES) {
    console.warn(`Port ${listenPort} is in use, trying ${listenPort + 1}…`);
    listenPort += 1;
    httpServer.listen(listenPort, onListen);
    return;
  }
  throw err;
});
