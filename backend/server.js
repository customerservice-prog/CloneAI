import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import axios from 'axios';
import net from 'node:net';
import rateLimit from 'express-rate-limit';
import { optimizeImageForModel } from './imageOptimize.js';
import { assertUrlSafeForServerFetch, isUnsafeIpLiteral } from './ssrf.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3001;
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
    allowedHeaders: ['Content-Type', 'X-CloneAI-Key'],
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
const MAX_HTML_BYTES = 450_000;
const MAX_REDIRECTS = Math.min(5, Math.max(0, Number(process.env.HTML_FETCH_MAX_REDIRECTS) || 2));

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => sleep(a + Math.floor(Math.random() * (b - a + 1)));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
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
## 3. NAVIGATION / HEADER
## 4. COLOR PALETTE (every color with exact hex and usage)
## 5. TYPOGRAPHY (every font, weight, size for every element)
## 6. HERO / ABOVE-THE-FOLD SECTION
## 7. SECTION-BY-SECTION BREAKDOWN (every section top to bottom)
## 8. COMPONENTS CATALOG (every button, card, badge, form)
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

const SYSTEM_PROMPT_BASE = `You are an elite web development consultant. Produce an extremely detailed, developer-ready brief. Use exact hex colors, font families/sizes/weights, spacing, and component names when visible or inferable. Never use vague filler — prefer concrete values and bullet lists. Output must use the exact 13-section markdown structure requested. If data is missing, say what is unknown instead of guessing.`;

function buildUserContentBlocks({
  url,
  depth,
  options,
  htmlContext,
  files,
  scraperMeta,
  comparePair,
}) {
  const parts = [];

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

  if (scraperMeta?.blocked || scraperMeta?.hint === 'http_error') {
    text += `\n---\nSCRAPER STATUS: HTML could not be retrieved reliably. Do NOT invent DOM/CSS. Use URL + screenshots; label uncertainty.\n`;
  }

  if (htmlContext) {
    text += `\n---\nRAW HTML (truncated):\n\n${htmlContext}\n`;
  } else if (url && depth !== 'homepage') {
    text += `\n(No usable HTML body. Prioritize screenshots; otherwise best-effort from URL only.)\n`;
  }

  parts.push({ type: 'text', text });

  for (const file of files) {
    const mime = file.mimetype || 'image/png';
    if (!mime.startsWith('image/')) continue;
    const base64 = file.buffer.toString('base64');
    parts.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mime,
        data: base64,
      },
    });
  }

  return parts;
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
  if (depth === 'homepage') {
    meta.hint = 'homepage_only';
    return { html: '', meta };
  }

  const initial = new URL(url);
  const allowedHost = hostKey(initial.hostname);

  try {
    const u = url.startsWith('http') ? url : `https://${url}`;
    const res = await axios.get(u, {
      timeout: HTML_FETCH_TIMEOUT_MS,
      maxContentLength: 2_000_000,
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

function extractTextDeltas(event) {
  const deltas = [];
  if (!event || typeof event !== 'object') return deltas;
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    if (event.delta.text) deltas.push(event.delta.text);
  }
  return deltas;
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const MAX_OUTPUT_TOKENS = Math.min(
  8192,
  Math.max(4096, Number(process.env.CLAUDE_MAX_TOKENS) || 8000)
);

const CLAUDE_STREAM_MS = Math.min(
  300000,
  Math.max(60000, Number(process.env.CLAUDE_STREAM_TIMEOUT_MS) || 180000)
);

function ssePublicError() {
  return 'We could not complete this analysis. Please try again.';
}

function mapClaudeFailureStatus(status) {
  if (status === 401) return 'Analysis service is misconfigured.';
  if (status === 429) return 'Analysis service is busy. Try again later.';
  return 'The analysis service returned an error. Try again later.';
}

async function runAnalyzePipeline(req, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your_key_here') {
    res.status(500).json({
      error: isProd ? 'Service temporarily unavailable.' : 'Server misconfiguration: ANTHROPIC_API_KEY is not set.',
    });
    return;
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

  try {
    send({ type: 'stage', index: 0, phase: 'running', label: 'URL Scanner' });
    const { html: rawHtml, meta: scraperMeta } = await fetchHtmlDetailed(url, depth);
    let htmlContext = rawHtml;
    if (depth === 'deep' && htmlContext.length > 0) {
      scraperMeta.deepWarning =
        'Full crawl depth can return very large HTML; content was truncated server-side for safety.';
    }
    send({ type: 'stage', index: 0, phase: 'done' });
    send({ type: 'meta', scraper: scraperMeta });

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
      await jitter(90, 200);
      send({ type: 'stage', index: s.index, phase: 'done' });
    }

    send({ type: 'stage', index: 7, phase: 'running', label: 'Brief Writer' });

    const optimized = [];
    for (const f of files) {
      const { buffer, mime } = await optimizeImageForModel(f.buffer, f.mimetype);
      optimized.push(Object.assign({}, f, { buffer, mimetype: mime }));
    }
    files = optimized;

    const userContent = buildUserContentBlocks({
      url,
      depth,
      options,
      htmlContext,
      files,
      scraperMeta,
      comparePair,
    });

    const body = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: MAX_OUTPUT_TOKENS,
      stream: true,
      system: SYSTEM_PROMPT_BASE,
      messages: [
        {
          role: 'user',
          content: userContent,
        },
      ],
    };

    const ac = new AbortController();
    const streamTimer = setTimeout(() => ac.abort(), CLAUDE_STREAM_MS);

    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
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
            : 'Claude request timed out.',
        });
        logEvent('error', 'analyze_claude_timeout', { ip: clientIp(req) });
        res.end();
        return;
      }
      throw e;
    }
    clearTimeout(streamTimer);

    if (!response.ok) {
      const errText = await response.text();
      logEvent('error', 'analyze_claude_http', {
        ip: clientIp(req),
        status: response.status,
        bodySnippet: errText.slice(0, 400),
      });
      send({ type: 'stage', index: 7, phase: 'error' });
      send({
        type: 'error',
        message: isProd ? mapClaudeFailureStatus(response.status) : errText.slice(0, 2000),
      });
      res.end();
      return;
    }

    if (!response.body) {
      send({ type: 'stage', index: 7, phase: 'error' });
      send({ type: 'error', message: ssePublicError() });
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
        if (!payload || payload === '[DONE]') continue;
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
          streamStopReason = ev.delta.stop_reason;
        }
        if (ev.type === 'message_stop' && ev.stop_reason) {
          streamStopReason = ev.stop_reason;
        }
        for (const text of extractTextDeltas(ev)) {
          send({ type: 'text', content: text });
        }
        if (ev.type === 'error') {
          send({
            type: 'error',
            message: isProd ? ssePublicError() : ev.error?.message || JSON.stringify(ev.error),
          });
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

    if (streamStopReason === 'max_tokens') {
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
    res.end();
  } catch (err) {
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

app.listen(PORT, () => {
  console.log(`CloneAI backend listening on port ${PORT}`);
  console.log(
    `CORS allowlist: ${corsOrigins.length ? corsOrigins.join(', ') : isProd ? '(none — set CORS_ORIGINS)' : DEFAULT_DEV_ORIGINS.join(', ')}`
  );
  console.log(`Rate limits: ${RATE_PER_MINUTE}/minute and ${DAILY_MAX}/day per IP on /api/analyze`);
  console.log(`Claude max_tokens: ${MAX_OUTPUT_TOKENS}, stream timeout: ${CLAUDE_STREAM_MS}ms`);
});
