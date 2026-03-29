const isProd = import.meta.env.PROD;
const envBase = import.meta.env.VITE_API_URL?.trim();
const API_BASE = (() => {
  if (isProd && !envBase) return '';
  return (envBase || 'http://localhost:3001').replace(/\/$/, '');
})();
const API_ANALYZE = API_BASE ? `${API_BASE}/api/analyze` : '';
const API_BILLING_STATUS = API_BASE ? `${API_BASE}/api/billing/status` : '';
const API_BILLING_CHECKOUT = API_BASE ? `${API_BASE}/api/billing/checkout` : '';
const API_ANALYTICS_TRACK = API_BASE ? `${API_BASE}/api/analytics/track` : '';
const PUBLIC_APP_FALLBACK = (import.meta.env.VITE_PUBLIC_APP_URL || '').trim().replace(/\/$/, '');
const INGRESS_KEY = import.meta.env.VITE_CLONEAI_KEY?.trim();

/** @type {{ plan: string | null, billingEnabled: boolean, isFreePlan: boolean, appOrigin: string | null } | null} */
let lastStreamBilling = null;

const billingCache = {
  enabled: false,
  plan: 'free',
  used: 0,
  limit: 1,
  remaining: 1,
};

const EXAMPLE_URLS = [
  'https://stripe.com',
  'https://vercel.com',
  'https://linear.app',
];

const LS_USER_ID = 'cloneai_user_id';
const USER_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (isProd && envBase && !/^https:\/\//i.test(envBase)) {
  console.warn('[CloneAI] Use HTTPS for VITE_API_URL in production.');
}

function getCloneAiUserId() {
  try {
    let id = (localStorage.getItem(LS_USER_ID) || '').trim();
    if (id && USER_UUID_RE.test(id)) return id.toLowerCase();
    id = crypto.randomUUID();
    localStorage.setItem(LS_USER_ID, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function analyzeFetchHeaders() {
  const headers = { 'X-CloneAI-User-Id': getCloneAiUserId() };
  if (INGRESS_KEY) headers['X-CloneAI-Key'] = INGRESS_KEY;
  return headers;
}

function billingJsonHeaders() {
  return {
    'Content-Type': 'application/json',
    ...analyzeFetchHeaders(),
  };
}

function isLimitReachedPayload(body) {
  return body && (body.code === 'LIMIT_REACHED' || body.error === 'LIMIT_REACHED');
}

function isFeatureLockedPayload(body) {
  return body && (body.code === 'FEATURE_LOCKED' || body.error === 'FEATURE_LOCKED');
}

function trackClientEvent(event, meta = {}) {
  if (!API_ANALYTICS_TRACK) return;
  const safe = /^[a-z][a-z0-9_]*$/.test(String(event || '').trim()) ? String(event).trim() : '';
  if (!safe) return;
  fetch(API_ANALYTICS_TRACK, {
    method: 'POST',
    headers: billingJsonHeaders(),
    body: JSON.stringify({
      event: safe,
      meta: { ...meta, page: meta.page || window.location.pathname },
    }),
  }).catch(() => {});
}

function clearBillingModalOpen() {
  const p = $('#modal-pricing');
  const w = $('#modal-paywall');
  if (p?.hasAttribute('hidden') && w?.hasAttribute('hidden')) {
    document.body.classList.remove('paywall-open');
  }
}

function openPricingModal(source = 'modal') {
  trackClientEvent('upgrade_clicked', { source });
  $('#modal-paywall')?.setAttribute('hidden', '');
  $('#modal-pricing')?.removeAttribute('hidden');
  document.body.classList.add('paywall-open');
}

function closePricingModal() {
  $('#modal-pricing')?.setAttribute('hidden', '');
  clearBillingModalOpen();
}

function openPaywallModal(limitBody) {
  trackClientEvent('upgrade_modal_opened', { reason: limitBody?.code || 'limit' });
  const modal = $('#modal-paywall');
  const detail = $('#paywall-detail');
  if (!modal || !detail) return;
  if (isLimitReachedPayload(limitBody)) {
    const plan = (limitBody.plan || 'current').toString();
    detail.textContent = `You’ve used ${limitBody.used} of ${limitBody.limit} analyses on your ${plan} plan. Upgrade or buy one extra run ($3) to continue.`;
  } else {
    detail.textContent =
      'Upgrade in one click to keep generating briefs — or grab a single extra run.';
  }
  $('#modal-pricing')?.setAttribute('hidden', '');
  modal.removeAttribute('hidden');
  document.body.classList.add('paywall-open');
}

function closePaywallModal() {
  $('#modal-paywall')?.setAttribute('hidden', '');
  clearBillingModalOpen();
}

async function refreshBillingStatus() {
  const usageWrap = $('#header-usage-wrap');
  const usageEl = $('#header-usage');
  const urgentEl = $('#header-usage-urgent');
  const upBtn = $('#header-upgrade-btn');
  if (!usageEl || !upBtn || !usageWrap) return;
  try {
    if (!API_BILLING_STATUS) {
      billingCache.enabled = false;
      billingCache.plan = 'guest';
      usageWrap.classList.remove('hidden');
      usageEl.textContent = 'Runs: not tracked (set billing on the API for limits)';
      urgentEl?.classList.add('hidden');
      upBtn.classList.add('hidden');
      updatePlanGatedControls();
      updateExportGatedControls();
      return;
    }
    const res = await fetch(API_BILLING_STATUS, { headers: analyzeFetchHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!data.enabled) {
      billingCache.enabled = false;
      billingCache.plan = 'guest';
      usageWrap.classList.remove('hidden');
      usageEl.textContent = 'Runs: unlimited (billing off on server)';
      urgentEl?.classList.add('hidden');
      upBtn.classList.add('hidden');
      updatePlanGatedControls();
      updateExportGatedControls();
      return;
    }
    billingCache.enabled = true;
    billingCache.plan = data.plan || 'free';
    billingCache.used = Number(data.used) || 0;
    billingCache.limit = Number(data.limit) || 1;
    billingCache.remaining = Number(data.remaining) ?? Math.max(0, billingCache.limit - billingCache.used);

    usageWrap.classList.remove('hidden');
    upBtn.classList.remove('hidden');
    const planLabel =
      data.plan === 'free' ? 'Free' : data.plan === 'starter' ? 'Starter' : data.plan === 'pro' ? 'Pro' : data.plan;
    let line = `${data.used} / ${data.limit} runs used`;
    line += data.plan === 'free' ? ' (lifetime)' : ' this month';
    if (data.bonusRuns > 0) line += ` · +${data.bonusRuns} extra`;
    usageEl.textContent = `${planLabel} · ${line}`;

    const lim = Number(data.limit) || 1;
    const used = Number(data.used) || 0;
    const ratio = lim > 0 ? used / lim : 0;
    if (urgentEl) {
      const near = ratio >= 0.8 && (data.remaining === undefined || Number(data.remaining) <= Math.ceil(lim * 0.25));
      urgentEl.classList.toggle('hidden', !near);
    }

    upBtn.textContent = data.plan === 'pro' ? 'Plans' : 'Upgrade';
    enforceDepthForPlan();
    updatePlanGatedControls();
    updateExportGatedControls();
  } catch {
    billingCache.enabled = false;
    usageWrap.classList.add('hidden');
    urgentEl?.classList.add('hidden');
    upBtn.classList.add('hidden');
    updateExportGatedControls();
  }
}

function enforceDepthForPlan() {
  if (!billingCache.enabled) return;
  if (billingCache.plan === 'free' && depth !== 'homepage') {
    depth = 'homepage';
    $$('.depth-pill').forEach((x) => x.classList.toggle('active', x.dataset.depth === depth));
  }
  if (billingCache.plan === 'starter' && depth === 'deep') {
    depth = 'shallow';
    $$('.depth-pill').forEach((x) => x.classList.toggle('active', x.dataset.depth === depth));
  }
}

function depthPillLocked(pillDepth) {
  if (!billingCache.enabled) return false;
  if (billingCache.plan === 'free' && pillDepth !== 'homepage') return true;
  if (billingCache.plan === 'starter' && pillDepth === 'deep') return true;
  return false;
}

function updatePlanGatedControls() {
  $$('.depth-pill').forEach((pill) => {
    const d = pill.dataset.depth;
    const locked = depthPillLocked(d);
    pill.classList.toggle('pill-locked', locked);
    pill.disabled = locked;
  });

  const bothTab = $('.tab[data-tab="both"]');
  if (bothTab) {
    const lockBoth = billingCache.enabled && billingCache.plan === 'free';
    bothTab.classList.toggle('tab-locked', lockBoth);
    bothTab.disabled = lockBoth;
    if (lockBoth && activeTab === 'both') setTab('url');
  }
}

function updateProgressUpsell() {
  const el = $('#progress-upsell');
  if (!el) return;
  const inProgress = $('#progress-section') && !$('#progress-section').hidden;
  const limited = depth !== 'deep';
  const show =
    inProgress &&
    limited &&
    (!billingCache.enabled || (billingCache.plan !== 'pro' && billingCache.plan !== 'guest'));
  el.hidden = !show;
}

function updatePostResultUpsell() {
  const el = $('#post-result-upsell');
  if (!el) return;
  const visible = $('#results-section') && !$('#results-section').hidden;
  const show =
    visible &&
    billingCache.enabled &&
    billingCache.plan !== 'pro' &&
    fullBriefText.trim().length > 0;
  el.hidden = !show;
}

function updateReportChrome() {
  const wm = $('#report-watermark');
  const box = $('#summary-box');
  const freeFmt = billingCache.enabled && billingCache.plan === 'free';
  if (wm) wm.hidden = !freeFmt;
  if (box) {
    box.classList.toggle('summary-box-free', freeFmt);
    box.classList.toggle('summary-box-pro', billingCache.enabled && billingCache.plan === 'pro');
  }
  const linkInput = $('#report-app-link');
  if (linkInput) {
    try {
      linkInput.value = `${window.location.origin}${window.location.pathname || '/'}`;
    } catch {
      linkInput.value = '';
    }
  }
}

function buildTryAnotherChips() {
  const host = $('#try-another-chips');
  if (!host) return;
  host.innerHTML = '';
  EXAMPLE_URLS.forEach((u) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'try-chip';
    b.textContent = u.replace(/^https?:\/\//, '');
    b.addEventListener('click', () => {
      const field = $('#url-input');
      const fieldBoth = $('#url-input-both');
      if (field) field.value = u;
      if (fieldBoth) fieldBoth.value = u;
      setTab('url');
      field?.focus();
      updateFlowWizard();
      showToast('URL filled — run when ready');
    });
    host.appendChild(b);
  });
}

async function startBillingCheckout(product, source = 'ui') {
  if (!API_BILLING_CHECKOUT) {
    alert('API URL is not configured.');
    return;
  }
  trackClientEvent('checkout_started', { product: String(product), source: String(source || 'ui') });
  trackClientEvent('upgrade_clicked', { product: String(product), source: `checkout:${String(source || 'ui')}` });
  try {
    const res = await fetch(API_BILLING_CHECKOUT, {
      method: 'POST',
      headers: billingJsonHeaders(),
      body: JSON.stringify({ product, source: String(source || 'ui').slice(0, 120) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(data.error || 'Could not start checkout. Try again.');
      return;
    }
    if (data.url) {
      window.location.href = data.url;
      return;
    }
    alert('Checkout did not return a redirect URL.');
  } catch (e) {
    alert(e.message || 'Checkout failed.');
  }
}

function handleCheckoutReturnQuery() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') === 'success') {
      trackClientEvent('payment_completed', {
        plan: params.get('plan') || '',
        kind: params.get('kind') || '',
      });
      showToast('Payment received — refreshing your plan…');
      refreshBillingStatus();
      const url = new URL(window.location.href);
      url.searchParams.delete('checkout');
      url.searchParams.delete('kind');
      url.searchParams.delete('plan');
      window.history.replaceState({}, '', url.pathname + url.search);
    }
    if (params.get('checkout') === 'cancel') {
      showToast('Checkout canceled');
      const url = new URL(window.location.href);
      url.searchParams.delete('checkout');
      window.history.replaceState({}, '', url.pathname + url.search);
    }
  } catch {
    /* ignore */
  }
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
  {
    id: 'layout',
    label: 'Layout & Structure',
    desc: 'Grid, flexbox, spacing, containers',
    defaultOn: true,
    depthWeight: 3,
  },
  {
    id: 'typography',
    label: 'Typography',
    desc: 'Fonts, sizes, weights, line-height',
    defaultOn: true,
    depthWeight: 2,
  },
  {
    id: 'colors',
    label: 'Colors & Theme',
    desc: 'Palette, backgrounds, borders',
    defaultOn: true,
    depthWeight: 2,
  },
  {
    id: 'navigation',
    label: 'Navigation',
    desc: 'Menus, links, breadcrumbs',
    defaultOn: true,
    depthWeight: 2,
  },
  {
    id: 'components',
    label: 'Components',
    desc: 'Buttons, cards, forms, badges',
    defaultOn: true,
    depthWeight: 3,
  },
  {
    id: 'content',
    label: 'Content & Copy',
    desc: 'Headings, text blocks, CTAs',
    defaultOn: true,
    depthWeight: 2,
  },
  {
    id: 'catalog',
    label: 'Categories & inventory',
    desc: 'Product/rental categories, item cards, prices, links',
    defaultOn: true,
    depthWeight: 3,
  },
  {
    id: 'media',
    label: 'Images & Media',
    desc: 'Dimensions, placement, alt text',
    defaultOn: true,
    depthWeight: 2,
  },
  {
    id: 'responsive',
    label: 'Responsiveness',
    desc: 'Breakpoints, mobile layout',
    defaultOn: true,
    depthWeight: 2,
  },
  {
    id: 'animations',
    label: 'Animations',
    desc: 'Transitions, hover states',
    defaultOn: false,
    depthWeight: 1,
  },
];

const AGENTS = [
  {
    icon: '🔍',
    name: 'Multi-page crawl & assets',
    desc: 'Same-host BFS crawl, Playwright snapshots, image harvest, ZIP',
    doneLine: '✓ Site crawled & assets captured',
  },
  {
    icon: '⬜',
    name: 'Layout Analyst',
    desc: 'Analyzing grid, flex, spacing patterns',
    doneLine: '✓ Layout mapped',
  },
  {
    icon: '𝐓',
    name: 'Typography Extractor',
    desc: 'Extracting font stack, sizes, weights',
    doneLine: '✓ Typography extracted',
  },
  {
    icon: '🎨',
    name: 'Color Extractor',
    desc: 'Building exact color palette',
    doneLine: '✓ Colors captured',
  },
  {
    icon: '⬡',
    name: 'Component Mapper',
    desc: 'Cataloguing UI components',
    doneLine: '✓ Components catalogued',
  },
  {
    icon: '📄',
    name: 'Content Indexer',
    desc: 'Categories, item cards, headings, copy, CTAs',
    doneLine: '✓ Content indexed',
  },
  {
    icon: '⚖',
    name: 'Diff Analyzer',
    desc: 'Comparing original vs clone',
    doneLine: '✓ Diff analyzed',
  },
  {
    icon: '✍',
    name: 'Brief Writer',
    desc: 'Generating developer report (OpenAI)',
    doneLine: '✓ Brief ready',
  },
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
  /\bSCORECARD\b/i,
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

function syncZipButtons(assets) {
  const btn = $('#download-images-btn');
  const sticky = $('#sticky-download-zip-btn');
  const label = (summary) => `Download site assets (ZIP · ${summary})`;
  if (!assets?.token || !assets.count) {
    if (btn) {
      btn.hidden = true;
      btn.dataset.token = '';
      btn.textContent = 'Download site assets (ZIP)';
    }
    if (sticky) {
      sticky.hidden = true;
      sticky.dataset.token = '';
      sticky.textContent = 'ZIP';
    }
    return;
  }
  const bits = [];
  if (assets.imageCount) bits.push(`${assets.imageCount} imgs`);
  if (assets.snapshotCount) bits.push(`${assets.snapshotCount} snapshots`);
  const summary = bits.length ? bits.join(' · ') : `${assets.count} files`;
  if (btn) {
    btn.dataset.token = assets.token;
    btn.hidden = false;
    btn.textContent = label(summary);
  }
  if (sticky) {
    sticky.dataset.token = assets.token;
    sticky.hidden = false;
    sticky.textContent = `ZIP · ${summary}`;
    sticky.title = label(summary);
  }
}

function applyAssetsMeta(assets) {
  syncZipButtons(assets);
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
  if (scraper?.modelHtmlTruncated) {
    parts.push('HTML was truncated for the AI context window; the brief still uses the full page for image harvesting where possible.');
  }
  if (scraper?.crawlPageCount > 1) {
    parts.push(
      `Same-host crawl: ${scraper.crawlPageCount} page(s). The ZIP includes full-page PNGs in snapshots/ plus harvested images (when available).`
    );
  } else if (scraper?.crawlPageCount === 1 && scraper?.snapshotCount > 0) {
    parts.push(`Captured ${scraper.snapshotCount} full-page snapshot(s) into the assets ZIP.`);
  }
  if (scraper?.interactionSnapshots > 0) {
    parts.push(
      `Playwright interaction crawl added ${scraper.interactionSnapshots} extra PNG(s) under snapshots/interaction/ (theme clicks and/or checkout steps).`
    );
  }
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
  if (status === 403) {
    return (
      msg ||
      'Access denied. If you are on the live site, ensure this origin is listed in backend CORS_ORIGINS and (in production) matches the browser tab URL exactly.'
    );
  }
  if (status === 413) return 'Upload too large. Each image must be under 20MB (max 10 files).';
  if (status === 400) return msg || 'Invalid request. Check your URL and images.';
  if (status === 500) {
    if (/misconfiguration|OPENAI_API_KEY|not set/i.test(msg)) {
      return 'The analysis service is not configured (API key). Contact the site administrator.';
    }
    return msg || 'Server error. Please retry in a moment.';
  }
  if (msg) return msg;
  if (body?.error) return String(body.error);
  return `Something went wrong (${status || 'network'}). Tap Re-run to retry.`;
}

const CTA_IDLE = 'Generate Developer Brief';

function setAnalyzeLoading(on) {
  const btn = $('#analyze-btn');
  const label = $('#analyze-btn-label');
  if (!btn || !label) return;
  btn.classList.toggle('is-loading', on);
  btn.disabled = on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
  label.textContent = on ? 'Analyzing & building your brief…' : CTA_IDLE;
}

function optionDepthScore() {
  let sum = 0;
  for (const o of OPTION_DEFS) {
    if (selectedOptions.has(o.id)) sum += o.depthWeight ?? 1;
  }
  return sum;
}

function updateDepthEstimate() {
  const el = $('#depth-estimate');
  if (!el) return;
  const n = selectedOptions.size;
  const score = optionDepthScore();
  let tier = 'Standard';
  let sub = 'balanced detail for most rebuilds';
  if (n === 0) {
    tier = 'None selected';
    sub = 'turn on at least one area';
  } else if (score <= 10) {
    tier = 'Focused';
    sub = 'lighter brief, faster to read';
  } else if (score <= 22) {
    tier = 'Standard';
    sub = 'balanced detail for most rebuilds';
  } else {
    tier = 'Maximum detail';
    sub = 'deepest sections and checklists';
  }
  el.innerHTML = `Estimated analysis depth: <strong>${tier}</strong> <span class="options-estimate-sub">(${sub})</span>`;
}

function updateFlowWizard() {
  const s1 = $('#flow-step-1');
  const s2 = $('#flow-step-2');
  const s3 = $('#flow-step-3');
  if (!s1 || !s2 || !s3) return;
  const hasInput = Boolean(getUrlValue() || getFilesForRequest().length);
  const loading = $('#analyze-btn')?.classList.contains('is-loading');
  const hasResults = $('#results-section') && !$('#results-section').hidden;

  [s1, s2, s3].forEach((el) => el.classList.remove('flow-step-active', 'flow-step-done'));

  if (hasResults) {
    s1.classList.add('flow-step-done');
    s2.classList.add('flow-step-done');
    s3.classList.add('flow-step-done');
  } else if (loading) {
    s1.classList.add('flow-step-done');
    s2.classList.add('flow-step-done');
    s3.classList.add('flow-step-active');
  } else if (hasInput) {
    s1.classList.add('flow-step-done');
    s2.classList.add('flow-step-active');
  } else {
    s1.classList.add('flow-step-active');
  }
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
      updateDepthEstimate();
      updateFlowWizard();
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
        <span class="agent-desc" data-agent-desc>${escapeHtml(a.desc)}</span>
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
  const descEl = row.querySelector('[data-agent-desc]');
  const agent = AGENTS[index];
  row.classList.toggle('agent-row-active', status === 'running');
  badge.className = `agent-status ${status}`;
  if (status === 'running') {
    badge.innerHTML = '<span class="spin">⟳</span> working…';
    if (descEl && agent) descEl.textContent = agent.desc;
  } else if (status === 'done') {
    badge.textContent = agent?.doneLine || '✓ done';
    if (descEl && agent) descEl.textContent = agent.desc;
  } else if (status === 'error') {
    badge.textContent = '✗ error';
  } else {
    badge.textContent = 'waiting';
    if (descEl && agent) descEl.textContent = agent.desc;
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
      updateFlowWizard();
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
    updateFlowWizard();
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
    updateFlowWizard();
  });
}

function setTab(tab) {
  if (tab === 'both' && billingCache.enabled && billingCache.plan === 'free') {
    showToast('URL + images together is on Starter and Pro');
    openPricingModal('tab_both_locked');
    return;
  }
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
  updateFlowWizard();
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

async function downloadSiteImagesZip() {
  const main = $('#download-images-btn');
  const sticky = $('#sticky-download-zip-btn');
  const token = main?.dataset?.token || sticky?.dataset?.token;
  if (!token || !API_BASE) {
    showToast('No asset bundle for this run');
    return;
  }
  const url = `${API_BASE}/api/site-images/${token}`;
  const headers = analyzeFetchHeaders();
  try {
    if (main) main.disabled = true;
    if (sticky) sticky.disabled = true;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `Download failed (${res.status})`);
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'site-assets.zip';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    showToast('Saved site-assets.zip');
  } catch (e) {
    alert(e.message || 'Download failed');
  } finally {
    if (main) main.disabled = false;
    if (sticky) sticky.disabled = false;
  }
}

async function writeClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
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
    return true;
  } catch {
    return false;
  }
}

function buildCursorPrompt() {
  const brief = fullBriefText.trim();
  return `You are a senior front-end engineer. Rebuild or refactor a website using the following developer brief as the single source of truth. Follow structure, sections, and issue list; only ask questions if the brief is ambiguous.

---
DEVELOPER BRIEF (Markdown)
---

${brief}

---
End of brief. Start with a short implementation plan, then proceed step by step.`;
}

async function copyBrief() {
  const text = fullBriefText;
  if (!text) {
    showToast('Nothing to copy yet');
    return;
  }
  const ok = await writeClipboard(text);
  showToast(ok ? 'Copied to clipboard' : 'Copy failed — select text manually');
}

async function copyCursorPrompt() {
  const text = buildCursorPrompt();
  if (!fullBriefText.trim()) {
    showToast('Nothing to copy yet');
    return;
  }
  const ok = await writeClipboard(text);
  showToast(ok ? 'Cursor / VS Code prompt copied' : 'Copy failed — select text manually');
}

function downloadBriefTxt() {
  const text = fullBriefText.trim();
  if (!text) {
    showToast('Nothing to download yet');
    return;
  }
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'developer-brief.txt';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
  showToast('Saved developer-brief.txt');
}

function printBriefPdf() {
  const text = fullBriefText.trim();
  if (!text) {
    showToast('Nothing to print yet');
    return;
  }
  const w = window.open('', '_blank', 'noopener,noreferrer');
  if (!w) {
    showToast('Allow pop-ups to save as PDF');
    return;
  }
  const safe = escapeHtml(text);
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Developer brief</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;padding:1.75rem;max-width:52rem;margin:0 auto;color:#111;line-height:1.5;font-size:11pt;}
pre{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,monospace;font-size:9.5pt;}
h1{font-size:1.1rem;margin:0 0 1rem;}
@media print{body{padding:0.5in}}
</style></head><body><h1>CloneAI — Developer brief</h1><pre>${safe}</pre>
<script>window.onload=function(){window.print();};<\/script></body></html>`);
  w.document.close();
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
        if (data.type === 'plan_notice' && Array.isArray(data.messages) && data.messages.length) {
          const banner = $('#mid-flow-plan-notice');
          if (banner) {
            banner.textContent = data.messages.join(' ');
            banner.hidden = false;
          }
        }
        if (data.type === 'stage') {
          applyStageEvent(data);
          if (data.phase === 'done' && typeof data.index === 'number' && data.index < 7) {
            const slow = billingCache.enabled && billingCache.plan === 'pro' ? 1 : 1.45;
            const ms = Math.floor((320 + Math.random() * 220) * slow);
            await new Promise((r) => setTimeout(r, ms));
          }
        }
        if (data.type === 'meta') {
          if (data.scraper) applyMetaScraper(data.scraper);
          if (data.assets) applyAssetsMeta(data.assets);
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

  trackClientEvent('run_started', { depth, tab: activeTab });

  const url = getUrlValue();
  const files = getFilesForRequest();
  if (!url && !files.length) {
    alert('Enter a URL and/or upload at least one image.');
    return;
  }
  if (selectedOptions.size === 0) {
    alert('Select at least one analysis option (or turn toggles back on).');
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
  const planBanner = $('#mid-flow-plan-notice');
  if (planBanner) {
    planBanner.hidden = true;
    planBanner.textContent = '';
  }
  $('#try-another-section')?.setAttribute('hidden', '');
  updateProgressUpsell();
  $('#analysis-hint').hidden = true;
  $('#analysis-hint').textContent = '';
  syncZipButtons({});
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

  const headers = analyzeFetchHeaders();

  try {
    const res = await fetch(API_ANALYZE, { method: 'POST', headers, body: form, signal });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 403 && isLimitReachedPayload(body)) {
        streamActive = false;
        stopTypewriter();
        $('#progress-section').hidden = true;
        void refreshBillingStatus();
        openPaywallModal(body);
        return;
      }
      if (res.status === 403 && isFeatureLockedPayload(body)) {
        streamActive = false;
        stopTypewriter();
        $('#progress-section').hidden = true;
        showToast(body.message || 'This input needs a paid plan');
        openPricingModal('feature_locked');
        return;
      }
      if (res.status === 400 && body.error === 'MISSING_USER_ID') {
        streamActive = false;
        stopTypewriter();
        $('#progress-section').hidden = true;
        alert('Session issue: please refresh the page and try again.');
        return;
      }
      throw new Error(humanizeError(res.status, body.error, body));
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 403 && isLimitReachedPayload(body)) {
        streamActive = false;
        stopTypewriter();
        $('#progress-section').hidden = true;
        void refreshBillingStatus();
        openPaywallModal(body);
        return;
      }
      if (res.status === 403 && isFeatureLockedPayload(body)) {
        streamActive = false;
        stopTypewriter();
        $('#progress-section').hidden = true;
        showToast(body.message || 'This input needs a paid plan');
        openPricingModal('feature_locked');
        return;
      }
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

    $('#progress-section').hidden = true;
    $('#results-section').hidden = false;
    await refreshBillingStatus();
    trackClientEvent('run_completed', { depth });
    updatePostResultUpsell();
    updateReportChrome();
    $('#try-another-section')?.removeAttribute('hidden');
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
    fullBriefText = `## Something went wrong\n\n${escapeHtml(errMsg)}\n\n**Try again** with the same inputs. If failures repeat, **upgrade** for deeper crawls and higher limits — complex sites are often more reliable on **Pro**.\n\nTap **Re-run** or **Upgrade** in the header.`;
    $('#summary-content').innerHTML = renderMarkdown(fullBriefText);
    $('#type-cursor').classList.add('hidden');
    $('#metric-issues').textContent = '—';
    $('#metric-issues').className = 'metric-value issue-high';
    $('#metric-sections').textContent = '0';
    $('#metric-words').textContent = '0';
    $('#metric-coverage').textContent = '0%';
    $('#metric-coverage').className = 'metric-value issue-mid';
    $('#progress-section').hidden = true;
    $('#results-section').hidden = false;
    updatePostResultUpsell();
    updateReportChrome();
    $('#try-another-section')?.removeAttribute('hidden');
    trackClientEvent('run_failed', { message: String(errMsg || '').slice(0, 120) });
  } finally {
    setAnalyzeLoading(false);
    updateFlowWizard();
    updateProgressUpsell();
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
      updateFlowWizard();
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
  const rerun = () => {
    $('#results-section').hidden = true;
    runAnalyze();
  };
  $('#rerun-btn').addEventListener('click', rerun);
  $('#sticky-rerun-btn')?.addEventListener('click', rerun);
  $('#copy-brief-btn').addEventListener('click', () => copyBrief());
  $('#copy-toolbar-btn').addEventListener('click', () => copyBrief());
  $('#sticky-copy-btn')?.addEventListener('click', () => copyBrief());
  $('#download-images-btn')?.addEventListener('click', () => downloadSiteImagesZip());
  $('#sticky-download-zip-btn')?.addEventListener('click', () => downloadSiteImagesZip());
  $('#download-txt-btn')?.addEventListener('click', () => downloadBriefTxt());
  $('#download-pdf-btn')?.addEventListener('click', () => printBriefPdf());
  $('#copy-cursor-prompt-btn')?.addEventListener('click', () => copyCursorPrompt());

  $('#url-input')?.addEventListener('input', () => updateFlowWizard());
  $('#url-input-both')?.addEventListener('input', () => updateFlowWizard());

  $('#header-upgrade-btn')?.addEventListener('click', () => openPricingModal('header'));
  $('#progress-upsell-btn')?.addEventListener('click', () => openPricingModal('progress_upsell'));
  $('#post-result-upgrade-btn')?.addEventListener('click', () => openPricingModal('post_result'));
  $('#report-copy-link-btn')?.addEventListener('click', async () => {
    const v = ($('#report-app-link')?.value || window.location.origin || '').trim();
    if (!v) {
      showToast('No link to copy');
      return;
    }
    const ok = await writeClipboard(v);
    showToast(ok ? 'App link copied — share your report source' : 'Copy failed');
  });
  $('#try-another-reset-btn')?.addEventListener('click', () => {
    const u = $('#url-input');
    const ub = $('#url-input-both');
    if (u) u.value = '';
    if (ub) ub.value = '';
    filesImages = [];
    filesBoth = [];
    syncThumbnails('#thumb-grid-images', filesImages);
    syncThumbnails('#thumb-grid-both', filesBoth);
    $('#results-section').hidden = true;
    fullBriefText = '';
    updateFlowWizard();
    updatePostResultUpsell();
    showToast('Cleared — enter a new site');
  });
  $('#modal-pricing-close')?.addEventListener('click', () => closePricingModal());
  $('#modal-paywall-close')?.addEventListener('click', () => closePaywallModal());
  $('#modal-pricing')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-pricing') closePricingModal();
  });
  $('#modal-paywall')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-paywall') closePaywallModal();
  });
  $('#modal-pricing')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-pricing]')) closePricingModal();
  });
  $('#paywall-see-plans')?.addEventListener('click', () => {
    closePaywallModal();
    openPricingModal();
  });
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-checkout]');
    if (!t) return;
    const host = t.closest('#modal-pricing, #modal-paywall');
    if (!host) return;
    const product = t.getAttribute('data-checkout');
    if (product) startBillingCheckout(product);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#modal-paywall')?.hasAttribute('hidden')) closePaywallModal();
    else if (!$('#modal-pricing')?.hasAttribute('hidden')) closePricingModal();
  });

  handleCheckoutReturnQuery();
  buildTryAnotherChips();
  refreshBillingStatus();

  setTab('url');
  updateDepthEstimate();
  updateFlowWizard();
}

init();
teFlowWizard();
}

init();
