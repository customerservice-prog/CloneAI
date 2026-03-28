import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import axios from 'axios';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const PORT = 3001;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
});

app.use(cors({ origin: '*' }));
app.use(express.json());

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

const SYSTEM_PROMPT = `You are an elite web development consultant. Your job is to produce an extremely detailed, actionable developer brief for cloning a website. Be precise about layout, spacing, colors (hex), typography, components, and responsiveness. When screenshots are provided, analyze them visually in depth. When HTML is provided, cross-reference structure and classes. Output must follow the user's requested markdown structure exactly, with rich content under each section. Use today's date in the header where indicated.`;

function buildUserContentBlocks({ url, depth, options, htmlContext, files }) {
  const parts = [];

  let text = `Analyze the following and produce the complete developer brief using EXACTLY this output structure (fill all sections thoroughly):\n\n${OUTPUT_STRUCTURE}\n\nReplace "[site name/URL]" with the actual site name or URL. Replace "[today's date]" with: ${todayISO()}\n\n---\nINPUT CONTEXT:\n`;
  text += `- URL provided: ${url || '(none)'}\n`;
  text += `- Scan depth: ${depth}\n`;
  text += `- Analysis options selected: ${JSON.stringify(options)}\n`;

  if (htmlContext) {
    text += `\n---\nRAW HTML (truncated if very long; use for structure/classes):\n\n${htmlContext.slice(0, 120000)}\n`;
  } else if (url && depth !== 'homepage') {
    text += `\n(HTML fetch was unavailable or empty. Rely on URL, depth, options, and any images.)\n`;
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

async function fetchHtmlIfNeeded(url, depth) {
  if (!url || depth === 'homepage') return '';
  try {
    const u = url.startsWith('http') ? url : `https://${url}`;
    const res = await axios.get(u, {
      timeout: 20000,
      maxContentLength: 2_000_000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; CloneAI/1.0; +https://cloneai.local)',
        Accept: 'text/html,application/xhtml+xml',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    if (typeof res.data === 'string') return res.data;
    return String(res.data ?? '');
  } catch (e) {
    console.error('HTML fetch error:', e.message);
    return '';
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

app.post('/api/analyze', upload.array('images', 10), async (req, res) => {
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

  const send = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  let htmlContext = '';
  try {
    htmlContext = await fetchHtmlIfNeeded(url, depth);
  } catch (e) {
    console.error(e);
  }

  const userContent = buildUserContentBlocks({
    url,
    depth,
    options,
    htmlContext,
    files,
  });

  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    stream: true,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: userContent,
      },
    ],
  };

  try {
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
      send({ type: 'error', message: errText || `Anthropic API ${response.status}` });
      res.end();
      return;
    }

    if (!response.body) {
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

    send({ type: 'done' });
    res.end();
  } catch (err) {
    console.error(err);
    send({ type: 'error', message: err.message || 'Server error' });
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`CloneAI backend listening on http://localhost:${PORT}`);
});
