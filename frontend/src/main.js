const API_ANALYZE = 'http://localhost:3001/api/analyze';

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
  { icon: '𝐓', name: 'Typography Agent', desc: 'Extracting font stack, sizes, weights' },
  { icon: '🎨', name: 'Color Extractor', desc: 'Building exact color palette' },
  { icon: '⬡', name: 'Component Mapper', desc: 'Cataloguing UI components' },
  { icon: '📄', name: 'Content Indexer', desc: 'Mapping headings, copy, CTAs' },
  { icon: '⚖', name: 'Diff Analyzer', desc: 'Comparing original vs clone' },
  { icon: '✍', name: 'Brief Writer', desc: 'Generating developer report' },
];

let activeTab = 'url';
let depth = 'homepage';
let filesImages = [];
let filesBoth = [];
let fullBriefText = '';
let displayIndex = 0;
let streamActive = false;
let typewriterRaf = 0;
let selectedOptions = new Set(
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

function formatWordCount(n) {
  if (n > 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function issueClass(n) {
  if (n > 10) return 'issue-high';
  if (n > 3) return 'issue-mid';
  return 'issue-low';
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

function randMs() {
  return 600 + Math.floor(Math.random() * 201);
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

function showToast() {
  const toast = $('#toast');
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
  try {
    await navigator.clipboard.writeText(fullBriefText);
    showToast();
  } catch {
    showToast();
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
      const chunk = Math.min(3, target - displayIndex);
      displayIndex += chunk;
    }
    content.innerHTML = renderMarkdown(fullBriefText.slice(0, displayIndex));
    const showCursor = streamActive || displayIndex < fullBriefText.length;
    cursor.classList.toggle('hidden', !showCursor);
    typewriterRaf = requestAnimationFrame(tick);
  };
  stopTypewriter();
  typewriterRaf = requestAnimationFrame(tick);
}

async function parseSseStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
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
        if (data.type === 'text' && data.content) {
          fullBriefText += data.content;
        }
        if (data.type === 'error') {
          throw new Error(data.message || 'Analysis failed');
        }
        if (data.type === 'done') {
          return;
        }
      }
    }
  }
}

async function runAgentSequence() {
  AGENTS.forEach((_, i) => setAgentStatus(i, 'waiting'));
  setProgress(0);
  for (let i = 0; i < 7; i += 1) {
    setAgentStatus(i, 'running');
    setProgress(10 + i * 11);
    await new Promise((r) => setTimeout(r, randMs()));
    setAgentStatus(i, 'done');
  }
  setAgentStatus(7, 'running');
  setProgress(88);
}

async function runAnalyze() {
  const url = getUrlValue();
  const files = getFilesForRequest();
  if (!url && !files.length) {
    alert('Enter a URL and/or upload at least one image.');
    return;
  }

  $('#progress-section').hidden = false;
  $('#results-section').hidden = true;
  fullBriefText = '';
  displayIndex = 0;
  streamActive = true;
  $('#summary-content').innerHTML = '';
  $('#type-cursor').classList.remove('hidden');
  buildAgentList();

  const agentPromise = runAgentSequence();

  const opts = OPTION_DEFS.filter((o) => selectedOptions.has(o.id)).map((o) => o.label);
  const form = new FormData();
  form.append('url', url);
  form.append('depth', depth);
  form.append('options', JSON.stringify(opts));
  files.forEach((f) => form.append('images', f));

  try {
    const res = await fetch(API_ANALYZE, { method: 'POST', body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Unexpected response');
    }

    startTypewriter();

    await parseSseStream(res);

    streamActive = false;
    await agentPromise;
    setAgentStatus(7, 'done');
    setProgress(100);

    stopTypewriter();
    while (displayIndex < fullBriefText.length) {
      displayIndex = Math.min(fullBriefText.length, displayIndex + 12);
      $('#summary-content').innerHTML = renderMarkdown(fullBriefText.slice(0, displayIndex));
      await new Promise((r) => requestAnimationFrame(r));
    }
    $('#summary-content').innerHTML = renderMarkdown(fullBriefText);
    $('#type-cursor').classList.add('hidden');

    const m = extractMetrics(fullBriefText);
    const issuesEl = $('#metric-issues');
    issuesEl.textContent = String(m.issues);
    issuesEl.className = `metric-value ${issueClass(m.issues)}`;
    $('#metric-sections').textContent = String(Math.max(m.sections, 0));
    $('#metric-words').textContent = formatWordCount(m.words);

    $('#results-section').hidden = false;
  } catch (e) {
    console.error(e);
    streamActive = false;
    stopTypewriter();
    AGENTS.forEach((_, i) => setAgentStatus(i, i < 7 ? 'done' : 'error'));
    setAgentStatus(7, 'error');
    fullBriefText = `## Error\n\n${escapeHtml(e.message || String(e))}`;
    $('#summary-content').innerHTML = renderMarkdown(fullBriefText);
    $('#type-cursor').classList.add('hidden');
    $('#metric-issues').textContent = '—';
    $('#metric-issues').className = 'metric-value issue-high';
    $('#metric-sections').textContent = '0';
    $('#metric-words').textContent = '0';
    $('#results-section').hidden = false;
  }
}

function init() {
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
