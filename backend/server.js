import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import axios from 'axios';
import fetch from 'node-fetch';
import rateLimit from 'express-rate-limit';

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

function parseCorsOrigins() {
  const raw = process.env.CORS_ORIGINS?.trim();
  if (raw === '*') return '*';
  if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (isProd) return [];
  return DEFAULT_DEV_ORIGINS;
}

const corsOrigins = parseCorsOrigins();

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (corsOrigins === '*') return callback(null, true);
      if (corsOrigins.length === 0) {
        if (isProd) {
          console.warn('CORS: set CORS_ORIGINS to your frontend origin(s); browser requests will be denied until then.');
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

const analyzeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many analysis requests. Try again shortly.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
});

function requireIngressKey(req, res, next) {
  const expected = process.env.CLONEAI_INGRESS_KEY?.trim();
  if (!expected) return next();
  const sent = req.get('x-cloneai-key');
  if (sent !== expected) {
    res.status(403).json({ error: 'Forbidden: invalid or missing X-CloneAI-Key' });
    return;
  }
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

const SYSTEM_PROMPT = `You are an elite web development consultant. Your job is to produce an extremely detailed, actionable developer brief for cloning a website. Be precise about layout, spacing, colors (hex), typography, components, and responsiveness. When screenshots are provided, analyze them visually in depth. When HTML is provided, cross-reference structure and classes. Output must follow the user's requested markdown structure exactly, with rich content under each section. Use today's date in the header where indicated. If HTML could not be fetched (blocked, bot protection, or empty), state that clearly in the Executive Overview and rely on URL context and any uploaded images.`;

function buildUserContentBlocks({ url, depth, options, htmlContext, files, scraperMeta }) {
  const parts = [];

  let text = `Analyze the following and produce the complete developer brief using EXACTLY this output structure (fill all sections thoroughly):\n\n${OUTPUT_STRUCTURE}\n\nReplace "[site name/URL]" with the actual site name or URL. Replace "[today's date]" with: ${todayISO()}\n\n---\nINPUT CONTEXT:\n`;
  text += `- URL provided: ${url || '(none)'}\n`;
  text += `- Scan depth: ${depth}\n`;
  text += `- Analysis options selected: ${JSON.stringify(options)}\n`;

  if (scraperMeta?.blocked || scraperMeta?.hint === 'http_error') {
    text += `\n---\nSCRAPER STATUS: HTML could not be retrieved reliably (blocked, error page, bot challenge, or network failure). Do NOT invent DOM details. Use URL + screenshots only for visual facts; note uncertainty where needed.\n`;
  }

  if (htmlContext) {
    text += `\n---\nRAW HTML (truncated if very long; use for structure/classes):\n\n${htmlContext.slice(0, 120000)}\n`;
  } else if (url && depth !== 'homepage') {
    text += `\n(No usable HTML body was retrieved. If screenshots exist, prioritize them; otherwise provide best-effort guidance from URL and depth alone.)\n`;
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
  };

  if (!url) {
    meta.hint = 'no_url';
    return { html: '', meta };
  }
  if (depth === 'homepage') {
    meta.hint = 'homepage_only';
    return { html: '', meta };
  }

  try {
    const u = url.startsWith('http') ? url : `https://${url}`;
    const res = await axios.get(u, {
      timeout: 20000,
      maxContentLength: 2_000_000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 CloneAI/1.0',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      validateStatus: () => true,
    });

    meta.statusCode = res.status;
    const html = typeof res.data === 'string' ? res.data : String(res.data ?? '');
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

    meta.ok = true;
    meta.hint = 'ok';
    return { html, meta };
  } catch (e) {
    console.error('HTML fetch error:', e.message);
    meta.blocked = true;
    meta.hint = 'network_or_tls';
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
  16384,
  Math.max(4096, Number(process.env.CLAUDE_MAX_TOKENS) || 8192)
);

async function runAnalyzePipeline(req, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your_key_here') {
    res.status(500).json({
      error: 'Missing ANTHROPIC_API_KEY in backend/.env',
    });
    return;
  }

  const url = (req.body.url || '').trim();
  const depth = (req.body.depth || 'homepage').trim();
  let options = [];
  try {
    options = JSON.parse(req.body.options || '[]');
    if (!Array.isArray(options)) options = [];
  } catch {
    options = [];
  }

  const files = req.files || [];

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (obj) => sseWrite(res, obj);

  try {
    send({ type: 'stage', index: 0, phase: 'running', label: 'URL Scanner' });
    const { html: htmlContext, meta: scraperMeta } = await fetchHtmlDetailed(url, depth);
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
      await jitter(380, 620);
      send({ type: 'stage', index: s.index, phase: 'done' });
    }

    send({ type: 'stage', index: 7, phase: 'running', label: 'Brief Writer' });

    const userContent = buildUserContentBlocks({
      url,
      depth,
      options,
      htmlContext,
      files,
      scraperMeta,
    });

    const body = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: MAX_OUTPUT_TOKENS,
      stream: true,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: userContent,
        },
      ],
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      send({ type: 'stage', index: 7, phase: 'error' });
      send({ type: 'error', message: errText || `Anthropic API ${response.status}` });
      res.end();
      return;
    }

    if (!response.body) {
      send({ type: 'stage', index: 7, phase: 'error' });
      send({ type: 'error', message: 'No response body from Anthropic' });
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
        for (const text of extractTextDeltas(ev)) {
          send({ type: 'text', content: text });
        }
        if (ev.type === 'error') {
          send({
            type: 'error',
            message: ev.error?.message || JSON.stringify(ev.error),
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

    send({ type: 'stage', index: 7, phase: 'done' });
    send({ type: 'done' });
    res.end();
  } catch (err) {
    console.error(err);
    send({ type: 'stage', index: 7, phase: 'error' });
    send({ type: 'error', message: err.message || 'Server error' });
    res.end();
  }
}

app.post(
  '/api/analyze',
  analyzeLimiter,
  requireIngressKey,
  upload.array('images', 10),
  (req, res, next) => {
    runAnalyzePipeline(req, res).catch(next);
  }
);

app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
});

app.listen(PORT, () => {
  console.log(`CloneAI backend listening on http://localhost:${PORT}`);
  console.log(`CORS allow list: ${corsOrigins === '*' ? '*' : corsOrigins.length ? corsOrigins.join(', ') : '(none — set CORS_ORIGINS in production)'}`);
});
