const isProd = import.meta.env.PROD;
const envBase = import.meta.env.VITE_API_URL?.trim();
const API_BASE = (() => {
  if (isProd && !envBase) return '';
  return (envBase || 'http://localhost:3001').replace(/\/$/, '');
})();
const API_ANALYZE = API_BASE ? `${API_BASE}/api/analyze` : '';
const INGRESS_KEY = import.meta.env.VITE_CLONEAI_KEY?.trim();

if (isProd && envBase && !/^https:\/\//i.test(envBase)) {
  console.warn('[CloneAI] Use HTTPS for VITE_API_URL in production.');
}

function clientUrlShapeOk(raw) {
  const s = (raw || '').trim();
  if (!s) return true;
  try {
    const withProto = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(s) ? s : `https://${s}`;
    const u = new URL(withProto);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const OPTION_DEFS = [
  { id: 'layout', label: 'Layout & Structure', desc: 'Grid, flexbox, spacing, containers', defaultOn: true },
  { id: 'typography', label: 'Typography', desc: 'Fonts, sizes, weights, line-height', defaultOn: true },
  { id: 'colors', label: 'Colors & Theme', desc: 'Palette, backgrounds, borders', defaultOn: true },
  { id: 'navigation', label: 'Navigation', desc: 'Menus, links, breadcrumbs', defaultOn: true },
  { id: 'components', label: 'Components', desc: 'Buttons, cards, forms, badges', defaultOn: true },
  { id: 'content', label: 'Content & Copy', desc: 'Headings, text blocks, CTAs', defaultOn: true },
  { id: 'media', label: 'Images & Media', desc: 'Dimensions, placement, alt text', defaultOn: true },
  { id: 'responsive', label: 'Responsiveness', desc: 'Breakpoints, mobile layout', defaultOn: true },
  { id: 'animations', label: 'Animations', desc: 'Transitions, hover states', defaultOn: false },
];

const AGENTS = [
  { icon: '🔍', name: 'URL Scanner', desc: 'Fetching page structure and DOM tree' },
  { icon: '⬜', name: 'Layout Analyst', desc: 'Analyzing grid, flex, spacing patterns' },
  { icon: '𝐓', name: 'Typography Extractor', desc: 'Extracting font stack, sizes, weights' },
  { icon: '🎨', name: 'Color Extractor', desc: 'Building exact color palette' },
  { icon: '⬡', name: 'Component Mapper', desc: 'Cataloguing UI components' },
  { icon: '📄', name: 'Content Indexer', desc: 'Mapping headings, copy, CTAs' },
  { icon: '⚖', name: 'Diff Analyzer', desc: 'Comparing original vs clone' },
  { icon: '✍', name: 'Brief Writer', desc: 'Generating developer report (Claude)' },
];

const COVERAGE_MARKERS = [
  /EXECUTIVE OVERVIEW/i,
  /GLOBAL LAYOUT/i,
  /NAVIGATION\s*\/\s*HEADER/i,
  /COLOR PALETTE/i,
  /TYPOGRAPHY/i,
  /HERO/i,
  /SECTION-BY-SECTION/i,
  /COMPONENTS CATALOG/i,
  /IMAGES\s*&\s*MEDIA|IMAGES AND MEDIA/i,
  /\bFOOTER\b/i,
  /RESPONSIVENESS/i,
  /CRITICAL ISSUES/i,
  /PRIORITY FIX/i,
];

let activeTab = 'url';
let depth = 'homepage';
let filesImages = [];
let filesBoth = [];
let fullBriefText = '';
let displayIndex = 0;
let streamActive = false;
let typewriterRaf = 0;
let analyzeAbort = null;
const selectedOptions = new Set(
  OPTION_DEFS.filter((o) => o.defaultOn).map((o) => o.id)
);

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderInline(text) {
  let s = escapeHtml(text);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

function renderMarkdown(md) {
  if (!md) return '';
  const lines = md.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (t === '---') {
      blocks.push('<hr />');
      i += 1;
      continue;
    }
    if (t.startsWith('# ') && !t.startsWith('## ')) {
      blocks.push(`<h1>${renderInline(t.slice(2))}</h1>`);
      i += 1;
      continue;
    }
    if (t.startsWith('## ')) {
      blocks.push(`<h2>${renderInline(t.slice(3))}</h2>`);
      i += 1;
      continue;
    }
    if (/^[-*]\s+/.test(t)) {
      const items = [];
      while (i < lines.length) {
        const L = lines[i].trim();
        if (!/^[-*]\s+/.test(L)) break;
        items.push(`<li>${renderInline(L.replace(/^[-*]\s+/, ''))}</li>`);
        i += 1;
      }
      blocks.push(`<ul class="md-list">${items.join('')}</ul>`);
      continue;
    }
    if (/^\d+\.\s+/.test(t)) {
      const items = [];
      while (i < lines.length) {
        const L = lines[i].trim();
        if (!/^\d+\.\s+/.test(L)) break;
        items.push(`<li>${renderInline(L.replace(/^\d+\.\s+/, ''))}</li>`);
        i += 1;
      }
      blocks.push(`<ul class="md-list">${items.join('')}</ul>`);
      continue;
    }
    if (t === '') {
      i += 1;
      continue;
    }
    blocks.push(`<p>${renderInline(line)}</p>`);
    i += 1;
  }
  return blocks.join('');
}

function extractMetrics(md) {
  const words = md.trim() ? md.trim().split(/\s+/).length : 0;
  let issues = 0;
  const parts = md.split(/##\s*12\./);
  if (parts.length > 1) {
    const rest = parts[1];
    const before13 = rest.split(/##\s*13\./)[0];
    const num = before13.match(/^\d+\.\s/gm);
    if (num) issues = num.length;
    else {
      const bullets = before13.match(/\n[-*]\s/g);
      if (bullets) issues = bullets.length;
    }
  }
  const sections = (md.match(/^##\s/gm) || []).length;
  return { issues, sections, words };
}

function computeCoverage(md) {
  if (!md.trim()) return 0;
  let hit = 0;
  for (const re of COVERAGE_MARKERS) {
    if (re.test(md)) hit += 1;
  }
  return Math.min(100, Math.round((hit / 13) * 100));
}

function formatWordCount(n) {
  if (n > 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function issueClass(n) {
  if (n > 10) return 'issue-high';
  if (n > 3) return 'issue-mid';
  return 'issue-low';
}

function scraperHintText(scraper) {
  if (!scraper) return '';
  const map = {
    challenge_or_waf:
      'This site may block automated HTML fetches (bot protection or WAF). Use clear full-page screenshots — original first, clone second if comparing.',
    body_too_small:
      'Very little HTML was returned (possible block page). Treat DOM detail as uncertain unless screenshots confirm it.',
    network_or_tls:
      'The server could not reach that URL (network, DNS, or TLS). Check the address or rely on screenshots.',
    http_error: `The URL returned HTTP ${scraper.statusCode ?? 'error'}. Try screenshots or another URL.`,
    fetch_timeout: 'Fetching HTML timed out. Try again, use a lighter page, or upload screenshots instead.',
    redirect_blocked:
      'The site redirected in a way we block for security. Try the final URL directly or use screenshots.',
  };
  if (scraper.hint === 'ok' || scraper.hint === 'homepage_only' || scraper.hint === 'no_url') return '';
  return map[scraper.hint] || 'HTML context was limited; prioritize uploaded images where possible.';
}

function shouldShowScraperHint(scraper) {
  if (!scraper) return false;
  if (scraper.ok && scraper.hint === 'ok') return false;
  if (scraper.hint === 'homepage_only' || scraper.hint === 'no_url') return false;
  return Boolean(scraper.blocked || scraperHintText(scraper));
}

function applyMetaScraper(scraper) {
  const el = $('#analysis-hint');
  if (!el) return;
  const parts = [];
  if (shouldShowScraperHint(scraper)) parts.push(scraperHintText(scraper));
  if (scraper?.truncated) {
    parts.push('Large HTML was truncated server-side for speed — visual detail may still be incomplete.');
  }
  if (scraper?.deepWarning) parts.push(scraper.deepWarning);
  if (parts.length) {
    el.textContent = parts.join(' ');
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

function humanizeError(status, rawMessage, body) {
  const msg = (rawMessage || '').trim();
  if (status === 429) return 'Too many requests. Wait a minute and try again.';
  if (status === 403) return msg || 'Access denied. Check API protection settings.';
  if (status === 413) return 'Upload too large. Each image must be under 20MB (max 10 files).';
  if (status === 400) return msg || 'Invalid request. Check your URL and images.';
  if (status === 500) return msg || 'Server error. Please retry in a moment.';
  if (msg) return msg;
  if (body?.error) return String(body.error);
  return `Something went wrong (${status || 'network'}). Tap Re-run to retry.`;
}

function setAnalyzeLoading(on) {
  const btn = $('#analyze-btn');
  const label = $('#analyze-btn-label');
  if (!btn || !label) return;
  btn.classList.toggle('is-loading', on);
  btn.disabled = on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
  label.textContent = on ? 'Running analysis…' : 'Run AI Clone Analysis';
}

function autoScrollEnabled() {
  return $('#autoscroll-toggle')?.checked !== false;
}

function scrollSummaryIfNeeded() {
  if (!autoScrollEnabled()) return;
  const body = $('#summary-body');
  if (!body) return;
  requestAnimationFrame(() => {
    body.scrollTop = body.scrollHeight;
  });
}

function buildOptionsGrid() {
  const grid = $('#options-grid');
  grid.innerHTML = '';
  OPTION_DEFS.forEach((opt) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `option-card${selectedOptions.has(opt.id) ? ' selected' : ''}`;
    card.dataset.id = opt.id;
    card.innerHTML = `<span class="option-label">${escapeHtml(opt.label)}</span><p class="option-desc">${escapeHtml(opt.desc)}</p>`;
    card.addEventListener('click', () => {
      if (selectedOptions.has(opt.id)) selectedOptions.delete(opt.id);
      else selectedOptions.add(opt.id);
      card.classList.toggle('selected', selectedOptions.has(opt.id));
    });
    grid.appendChild(card);
  });
}

function buildAgentList() {
  const list = $('#agent-list');
  list.innerHTML = '';
  AGENTS.forEach((a, idx) => {
    const li = document.createElement('li');
    li.className = 'agent-row';
    li.dataset.index = String(idx);
    li.innerHTML = `
      <div class="agent-icon">${a.icon}</div>
      <div class="agent-text">
        <span class="agent-name">${escapeHtml(a.name)}</span>
        <span class="agent-desc">${escapeHtml(a.desc)}</span>
      </div>
      <span class="agent-status waiting" data-status>waiting</span>
    `;
    list.appendChild(li);
  });
}

function setAgentStatus(index, status) {
  const row = $(`#agent-list li[data-index="${index}"]`);
  if (!row) return;
  const badge = row.querySelector('[data-status]');
  badge.className = `agent-status ${status}`;
  if (status === 'running') {
    badge.innerHTML = '<span class="spin">⟳</span> running';
  } else if (status === 'done') {
    badge.textContent = '✓ done';
  } else if (status === 'error') {
    badge.textContent = '✗ error';
  } else {
    badge.textContent = 'waiting';
  }
}

function setProgress(pct) {
  const n = Math.min(100, Math.max(0, pct));
  $('#progress-pct').textContent = `${Math.round(n)}%`;
  $('#progress-bar-fill').style.width = `${n}%`;
}

function setStageLabel(index, phase, label) {
  const stageEl = $('#progress-stage');
  if (!stageEl) return;
  if (phase === 'running') {
    const name = label || AGENTS[index]?.name || `Step ${index + 1}`;
    if (index === 7) {
      stageEl.textContent = `Current: ${name} · streaming response…`;
    } else {
      stageEl.textContent = `Current: ${name}`;
    }
  } else if (phase === 'done' && index === 7) {
    stageEl.textContent = 'Brief Writer complete';
  } else if (phase === 'done') {
    stageEl.textContent = `Completed: ${label || AGENTS[index]?.name || `Step ${index + 1}`}`;
  } else if (phase === 'error') {
    stageEl.textContent = 'Pipeline error — see report below';
  }
}

function applyStageEvent(data) {
  const { index, phase, label } = data;
  if (typeof index !== 'number') return;
  if (phase === 'running') {
    setAgentStatus(index, 'running');
    setStageLabel(index, phase, label);
    setProgress((index / 8) * 68);
  } else if (phase === 'done') {
    setAgentStatus(index, 'done');
    setStageLabel(index, phase, label);
    setProgress(((index + 1) / 8) * 68);
  } else if (phase === 'error') {
    setAgentStatus(index, 'error');
    setStageLabel(index, phase, label);
  }
}

function bumpStreamProgress() {
  const base = 68;
  const extra = Math.min(30, Math.floor(fullBriefText.length / 420));
  setProgress(Math.min(99, base + extra));
}

function getUrlValue() {
  if (activeTab === 'url') return ($('#url-input')?.value || '').trim();
  if (activeTab === 'both') return ($('#url-input-both')?.value || '').trim();
  return '';
}

function getFilesForRequest() {
  if (activeTab === 'images') return [...filesImages];
  if (activeTab === 'both') return [...filesBoth];
  return [];
}

function syncThumbnails(gridEl, files) {
  const grid = $(gridEl);
  if (!files.length) {
    grid.hidden = true;
    grid.innerHTML = '';
    return;
  }
  grid.hidden = false;
  grid.innerHTML = '';
  files.forEach((file, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'thumb-item';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.alt = file.name;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'thumb-remove';
    rm.setAttribute('aria-label', 'Remove');
    rm.textContent = '✕';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      URL.revokeObjectURL(img.src);
      if (gridEl === '#thumb-grid-images') {
        filesImages = filesImages.filter((_, j) => j !== i);
        syncThumbnails('#thumb-grid-images', filesImages);
      } else {
        filesBoth = filesBoth.filter((_, j) => j !== i);
        syncThumbnails('#thumb-grid-both', filesBoth);
      }
    });
    wrap.appendChild(img);
    wrap.appendChild(rm);
    grid.appendChild(wrap);
  });
}

function addFiles(list, incoming) {
  const next = [...list];
  for (const f of incoming) {
    if (!f.type.startsWith('image/')) continue;
    if (next.length >= 10) break;
    next.push(f);
  }
  return next;
}

function setupDropzone(zoneId, fileInputId, thumbGridId, getList, setList) {
  const zone = $(zoneId);
  const input = $(fileInputId);
  if (!zone || !input) return;

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    const files = [...input.files];
    setList(addFiles(getList(), files));
    input.value = '';
    syncThumbnails(thumbGridId, getList());
  });
  ['dragenter', 'dragover'].forEach((ev) => {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
    });
  });
  zone.addEventListener('drop', (e) => {
    const files = [...e.dataTransfer.files];
    setList(addFiles(getList(), files));
    syncThumbnails(thumbGridId, getList());
  });
}

function setTab(tab) {
  activeTab = tab;
  $$('.tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const panels = {
    url: $('#panel-url'),
    images: $('#panel-images'),
    both: $('#panel-both'),
  };
  Object.entries(panels).forEach(([key, el]) => {
    if (!el) return;
    if (key === tab) {
      el.hidden = false;
      el.classList.add('active');
    } else {
      el.hidden = true;
      el.classList.remove('active');
    }
  });
}

function showToast(text = 'Copied to clipboard') {
  const toast = $('#toast');
  toast.textContent = text;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      toast.hidden = true;
    }, 280);
  }, 2200);
}

async function copyBrief() {
  const text = fullBriefText;
  if (!text) {
    showToast('Nothing to copy yet');
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      showToast();
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast();
  } catch {
    showToast('Copy failed — select text manually');
  }
}

function stopTypewriter() {
  if (typewriterRaf) cancelAnimationFrame(typewriterRaf);
  typewriterRaf = 0;
}

function startTypewriter() {
  const content = $('#summary-content');
  const cursor = $('#type-cursor');
  const tick = () => {
    const target = fullBriefText.length;
    if (displayIndex < target) {
      const lag = target - displayIndex;
      const chunk = lag > 120 ? 3 : lag > 40 ? 2 : 1;
      displayIndex += Math.min(chunk, lag);
    }
    content.innerHTML = renderMarkdown(fullBriefText.slice(0, displayIndex));
    scrollSummaryIfNeeded();
    const showCursor = streamActive || displayIndex < fullBriefText.length;
    cursor.classList.toggle('hidden', !showCursor);
    typewriterRaf = requestAnimationFrame(tick);
  };
  stopTypewriter();
  typewriterRaf = requestAnimationFrame(tick);
}

async function parseSseStream(response, { onText, signal } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;

  while (true) {
    if (signal?.aborted) {
      throw new Error('Request cancelled.');
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const lines = block.split('\n');
      for (const line of lines) {
        const tr = line.trim();
        if (!tr.startsWith('data:')) continue;
        const payload = tr.slice(5).trim();
        if (!payload) continue;
        let data;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }
        if (data.type === 'stage') {
          applyStageEvent(data);
        }
        if (data.type === 'meta' && data.scraper) {
          applyMetaScraper(data.scraper);
        }
        if (data.type === 'warning' && data.message) {
          fullBriefText += data.message;
          onText?.();
        }
        if (data.type === 'text' && data.content) {
          fullBriefText += data.content;
          onText?.();
        }
        if (data.type === 'error') {
          throw new Error(data.message || 'Analysis failed');
        }
        if (data.type === 'done') {
          completed = true;
          return;
        }
      }
    }
  }

  if (signal?.aborted) {
    throw new Error('Request cancelled.');
  }
  if (!completed) {
    throw new Error(
      'Connection closed before the brief finished. Check your network, VPN, or ad-blockers, then tap Re-run.'
    );
  }
}

function updateScorecard(md) {
  const m = extractMetrics(md);
  const cov = computeCoverage(md);
  const issuesEl = $('#metric-issues');
  issuesEl.textContent = String(m.issues);
  issuesEl.className = `metric-value ${issueClass(m.issues)}`;
  $('#metric-sections').textContent = String(Math.max(m.sections, 0));
  $('#metric-words').textContent = formatWordCount(m.words);
  const covEl = $('#metric-coverage');
  covEl.textContent = `${cov}%`;
  covEl.className = `metric-value ${cov >= 85 ? 'metric-green' : cov >= 55 ? 'metric-accent' : 'issue-mid'}`;
}

async function runAnalyze() {
  if (!API_ANALYZE) {
    alert(
      'Production configuration error: set VITE_API_URL to your API base URL in Vercel (or .env) and redeploy.'
    );
    return;
  }

  const url = getUrlValue();
  const files = getFilesForRequest();
  if (!url && !files.length) {
    alert('Enter a URL and/or upload at least one image.');
    return;
  }
  if (url && !clientUrlShapeOk(url)) {
    alert('Enter a valid URL starting with http:// or https:// (or a domain like example.com).');
    return;
  }

  if (analyzeAbort) analyzeAbort.abort();
  analyzeAbort = new AbortController();
  const { signal } = analyzeAbort;

  $('#progress-section').hidden = false;
  $('#results-section').hidden = true;
  $('#analysis-hint').hidden = true;
  $('#analysis-hint').textContent = '';
  fullBriefText = '';
  displayIndex = 0;
  streamActive = true;
  $('#summary-content').innerHTML = '';
  $('#type-cursor').classList.remove('hidden');
  $('#progress-stage').textContent = 'Connecting…';
  buildAgentList();
  setProgress(2);
  setAnalyzeLoading(true);

  const opts = OPTION_DEFS.filter((o) => selectedOptions.has(o.id)).map((o) => o.label);
  const form = new FormData();
  form.append('url', url);
  form.append('depth', depth);
  form.append('options', JSON.stringify(opts));
  form.append('comparePair', $('#compare-pair')?.checked ? '1' : '0');
  form.append('hp', ($('#form-hp')?.value || '').trim());
  files.forEach((f) => form.append('images', f));

  const headers = {};
  if (INGRESS_KEY) headers['X-CloneAI-Key'] = INGRESS_KEY;

  try {
    const res = await fetch(API_ANALYZE, { method: 'POST', headers, body: form, signal });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(humanizeError(res.status, body.error, body));
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) {
      const body = await res.json().catch(() => ({}));
      throw new Error(humanizeError(res.status, body.error, body));
    }

    startTypewriter();

    await parseSseStream(res, {
      signal,
      onText: () => {
        bumpStreamProgress();
        scrollSummaryIfNeeded();
      },
    });

    streamActive = false;
    setProgress(100);
    $('#progress-stage').textContent = 'Complete';

    stopTypewriter();
    while (displayIndex < fullBriefText.length) {
      displayIndex = Math.min(fullBriefText.length, displayIndex + 20);
      $('#summary-content').innerHTML = renderMarkdown(fullBriefText.slice(0, displayIndex));
      scrollSummaryIfNeeded();
      await new Promise((r) => requestAnimationFrame(r));
    }
    $('#summary-content').innerHTML = renderMarkdown(fullBriefText);
    $('#type-cursor').classList.add('hidden');

    updateScorecard(fullBriefText);

    $('#results-section').hidden = false;
  } catch (e) {
    console.error(e);
    streamActive = false;
    stopTypewriter();
    let marked = false;
    for (let i = 0; i < AGENTS.length; i += 1) {
      const badge = $(`#agent-list li[data-index="${i}"] [data-status]`);
      if (badge?.classList.contains('running')) {
        setAgentStatus(i, 'error');
        marked = true;
        break;
      }
    }
    if (!marked) setAgentStatus(7, 'error');
    $('#progress-stage').textContent = 'Failed';
    setProgress(100);
    let errMsg = e.name === 'AbortError' ? 'Request cancelled.' : e.message || String(e);
    if (/failed to fetch|networkerror|load failed/i.test(errMsg)) {
      errMsg =
        'Network error — check your connection, disable VPN/ad-block for this site, and confirm the API URL (VITE_API_URL) is correct.';
    }
    fullBriefText = `## Error\n\n${escapeHtml(errMsg)}\n\nTap **Re-run** to try again without refreshing the page.`;
    $('#summary-content').innerHTML = renderMarkdown(fullBriefText);
    $('#type-cursor').classList.add('hidden');
    $('#metric-issues').textContent = '—';
    $('#metric-issues').className = 'metric-value issue-high';
    $('#metric-sections').textContent = '0';
    $('#metric-words').textContent = '0';
    $('#metric-coverage').textContent = '0%';
    $('#metric-coverage').className = 'metric-value issue-mid';
    $('#results-section').hidden = false;
  } finally {
    setAnalyzeLoading(false);
  }
}

function init() {
  if (isProd && !envBase) {
    console.error('[CloneAI] Set VITE_API_URL for production builds.');
  }

  buildOptionsGrid();
  buildAgentList();

  $$('.tab').forEach((t) => {
    t.addEventListener('click', () => setTab(t.dataset.tab));
  });

  $$('.depth-pill').forEach((p) => {
    p.addEventListener('click', () => {
      depth = p.dataset.depth;
      $$('.depth-pill').forEach((x) => x.classList.toggle('active', x.dataset.depth === depth));
    });
  });

  setupDropzone(
    '#dropzone-images',
    '#file-images',
    '#thumb-grid-images',
    () => filesImages,
    (v) => {
      filesImages = v;
    }
  );
  setupDropzone(
    '#dropzone-both',
    '#file-both',
    '#thumb-grid-both',
    () => filesBoth,
    (v) => {
      filesBoth = v;
    }
  );

  $('#analyze-btn').addEventListener('click', () => runAnalyze());
  $('#rerun-btn').addEventListener('click', () => {
    $('#results-section').hidden = true;
    runAnalyze();
  });
  $('#copy-brief-btn').addEventListener('click', () => copyBrief());
  $('#copy-toolbar-btn').addEventListener('click', () => copyBrief());

  setTab('url');
}

init();
