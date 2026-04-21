const isProd = import.meta.env.PROD;
const envBase = import.meta.env.VITE_API_URL?.trim();
const sameOriginApi = import.meta.env.VITE_SAME_ORIGIN_API === 'true';
/** Always call the API on this origin in production builds (avoids /api hitting a static host on www or mis-routed DNS). */
const BAKED_API_ORIGIN = (import.meta.env.VITE_API_URL || '').trim().replace(/\/$/, '') || '';

function readMetaApiOrigin() {
  try {
    const m = document.querySelector('meta[name="cloneai-api-origin"]');
    return (m?.getAttribute('content') || '').trim().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function localBrowserOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(String(origin || '').trim());
}

const API_BASE = (() => {
  try {
    const winO =
      typeof window !== 'undefined' ? String(window.__CLONEAI_API_BASE__ || '').trim().replace(/\/$/, '') : '';
    const meta = readMetaApiOrigin();
    const pageOrigin =
      typeof window !== 'undefined' ? window.location.origin.replace(/\/$/, '') : '';
    let raw = winO || meta || envBase;
    if (isProd && sameOriginApi && pageOrigin && (localBrowserOrigin(pageOrigin) || !raw)) {
      raw = pageOrigin;
    }
    if (isProd && !raw) return '';
    if (!raw && !isProd) return '';
    return raw.replace(/\/$/, '');
  } catch {
    return '';
  }
})();

/** Dev with no explicit API host: same-origin `/api/...` so Vite proxies to the backend (see vite.config.js). */
function apiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  if (isProd && BAKED_API_ORIGIN) {
    return `${BAKED_API_ORIGIN}${p}`;
  }
  const configured = (API_BASE || '').replace(/\/$/, '');
  if (typeof window !== 'undefined' && isProd) {
    const pageOrigin = window.location.origin.replace(/\/$/, '');
    if (!configured || pageOrigin === configured) {
      return p;
    }
    return `${configured}${p}`;
  }
  if (configured) return `${configured}${p}`;
  if (isProd) return '';
  return p;
}

const API_ANALYZE = apiUrl('/api/analyze');
const API_EXTRACTION_JOBS = apiUrl('/api/extraction-jobs');
const API_ANALYZE_REVISE = apiUrl('/api/analyze-revise');
const API_BILLING_STATUS = apiUrl('/api/billing/status');
const API_BILLING_CHECKOUT = apiUrl('/api/billing/checkout');
const API_BILLING_CLAIM = apiUrl('/api/billing/claim-account');
const API_AUTH_LOGIN = apiUrl('/api/auth/login');
const API_ANALYTICS_TRACK = apiUrl('/api/analytics/track');
const API_LEADS_DFY = apiUrl('/api/leads/dfy');
const API_ASSET_PIPELINE_ENHANCE = apiUrl('/api/asset-pipeline/enhance');
const API_HEALTH = apiUrl('/api/health');
const PUBLIC_APP_FALLBACK = (import.meta.env.VITE_PUBLIC_APP_URL || '').trim().replace(/\/$/, '');
const INGRESS_KEY = import.meta.env.VITE_CLONEAI_KEY?.trim();
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim();
const LS_BRIEF_OK = 'cloneai_brief_ok';
const LS_PREF_STRIP_WM = 'cloneai_pref_strip_wm';
const LS_PREF_TRIM_IMG_BG = 'cloneai_pref_trim_img_bg';
const LS_PREF_ASSET_HARVEST = 'cloneai_pref_asset_harvest';
const LS_PREF_CLIENT_DELIVERY = 'cloneai_pref_client_delivery';
const LS_PREF_SERVICE_PKG = 'cloneai_pref_service_pkg';
const LS_PROMO_CODE = 'cloneai_promo_code';
const LS_PREF_SCAN_MODE = 'cloneai_pref_scan_mode';
const LS_PREF_EXTRACTION_PROFILE = 'cloneai_pref_extraction_profile';
const LS_ACTIVE_JOB_ID = 'cloneai_active_job_id';
const WATERMARK_FOOTER =
  '\n\n---\n\n*Generated with SiteCloner PRO — upgrade to remove watermark.*';

/** @type {string | null} */
let turnstileWidgetId = null;
let turnstileToken = '';

/** @type {{ plan: string | null, billingEnabled: boolean, isFreePlan: boolean, appOrigin: string | null } | null} */
let lastStreamBilling = null;

const billingCache = {
  enabled: false,
  plan: 'free',
  used: 0,
  limit: 1,
  remaining: 1,
  /** Server confirms `X-CloneAI-Promo-Code` matches (GET /api/billing/status). */
  promoUnlocked: false,
};

let billingStatusRequestId = 0;
let planNoticeAutoHideTimer = null;

/** Throttle repeated “fix your config” toasts so the header can stay minimal. */
const CONFIG_TOAST_THROTTLE_MS = 22000;
let lastConfigToastAt = 0;

function showConfigToastOnce(text, duration = 4000) {
  const now = Date.now();
  if (now - lastConfigToastAt < CONFIG_TOAST_THROTTLE_MS) return;
  lastConfigToastAt = now;
  showToast(text, { variant: 'warning', duration });
}

const EXAMPLE_URLS = [
  'https://stripe.com',
  'https://vercel.com',
  'https://linear.app',
];

const LS_USER_ID = 'cloneai_user_id';
const USER_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (isProd && API_BASE && !/^https:\/\//i.test(API_BASE)) {
  console.warn('[CloneAI] Use HTTPS for the API URL in production.');
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

function setCloneAiUserId(id) {
  const s = String(id || '').trim().toLowerCase();
  if (!USER_UUID_RE.test(s)) return false;
  try {
    localStorage.setItem(LS_USER_ID, s);
    return true;
  } catch {
    return false;
  }
}

function analyzeFetchHeaders() {
  const headers = { 'X-CloneAI-User-Id': getCloneAiUserId() };
  if (INGRESS_KEY) headers['X-CloneAI-Key'] = INGRESS_KEY;
  const pc = getPromoCodeValue();
  if (pc) headers['X-CloneAI-Promo-Code'] = pc;
  return headers;
}

function billingJsonHeaders() {
  return {
    'Content-Type': 'application/json',
    ...analyzeFetchHeaders(),
  };
}

function extractionJobUrl(jobId, suffix = '') {
  if (!jobId) return '';
  return apiUrl(`/api/extraction-jobs/${encodeURIComponent(jobId)}${suffix}`);
}

function setProgressRunChromeVisible(show) {
  const el = $('#progress-run-toolbar');
  if (!el) return;
  el.classList.toggle('hidden', !show);
}

function syncJobHistoryPolling(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const needsPoll = list.some((j) => j?.status === 'queued' || j?.status === 'running');
  if (needsPoll && !jobHistoryPollTimer) {
    jobHistoryPollTimer = setInterval(() => {
      void refreshExtractionJobHistory();
    }, 9000);
  } else if (!needsPoll && jobHistoryPollTimer) {
    clearInterval(jobHistoryPollTimer);
    jobHistoryPollTimer = null;
  }
}

async function stopActiveRun() {
  userInitiatedStop = true;
  const jid = currentRunJobId;
  if (jid && API_EXTRACTION_JOBS && extractionJobsSupported) {
    try {
      await fetch(extractionJobUrl(jid, '/cancel'), {
        method: 'POST',
        headers: analyzeFetchHeaders(),
      });
    } catch {
      /* ignore */
    }
    void refreshExtractionJobHistory();
  }
  currentRunJobId = '';
  persistActiveExtractionJob('');
  analyzeAbort?.abort();
}

function persistActiveExtractionJob(jobId = '') {
  activeExtractionJobId = String(jobId || '').trim();
  try {
    if (activeExtractionJobId) localStorage.setItem(LS_ACTIVE_JOB_ID, activeExtractionJobId);
    else localStorage.removeItem(LS_ACTIVE_JOB_ID);
  } catch {
    /* ignore */
  }
}

function artifactDownloadUrl(jobId, artifactName) {
  return extractionJobUrl(jobId, `/artifacts/${encodeURIComponent(artifactName || '')}`);
}

function resetRunSidePanels() {
  const planBanner = $('#mid-flow-plan-notice');
  if (planBanner) {
    planBanner.hidden = true;
    planBanner.textContent = '';
  }
  const analysisHint = $('#analysis-hint');
  if (analysisHint) {
    analysisHint.hidden = true;
    analysisHint.textContent = '';
  }
  const harvestStats = $('#harvest-live-stats');
  if (harvestStats) {
    harvestStats.hidden = true;
    harvestStats.textContent = '';
  }
  renderArtifactPanel('', []);
  renderExtractionResults(null);
}

function loadPersistedActiveExtractionJob() {
  try {
    const jobId = (localStorage.getItem(LS_ACTIVE_JOB_ID) || '').trim();
    activeExtractionJobId = jobId;
    return jobId;
  } catch {
    activeExtractionJobId = '';
    return '';
  }
}

function planIsProOrPower(plan) {
  return plan === 'pro' || plan === 'power';
}

/** Stripe Pro/Power or verified promo code (billing status). */
function planOrPromoProOrPower() {
  return planIsProOrPower(billingCache.plan) || Boolean(billingCache.promoUnlocked);
}

/** Normalize plan strings from the API (defensive casing). */
function normalizeBillingPlan(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return s || 'free';
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

function needsTurnstileUi() {
  try {
    return Boolean(TURNSTILE_SITE_KEY) && localStorage.getItem(LS_BRIEF_OK) === '1';
  } catch {
    return false;
  }
}

function loadTurnstileScript() {
  return new Promise((resolve, reject) => {
    if (window.turnstile) return resolve();
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Turnstile load failed'));
    document.head.appendChild(s);
  });
}

async function ensureTurnstileMounted() {
  if (!TURNSTILE_SITE_KEY) return;
  if (!needsTurnstileUi()) {
    $('#turnstile-wrap')?.setAttribute('hidden', '');
    $('#turnstile-hint')?.setAttribute('hidden', '');
    return;
  }
  const wrap = $('#turnstile-wrap');
  const hint = $('#turnstile-hint');
  if (!wrap) return;
  wrap.removeAttribute('hidden');
  hint?.removeAttribute('hidden');
  try {
    await loadTurnstileScript();
  } catch {
    return;
  }
  if (!window.turnstile) return;
  if (turnstileWidgetId != null) {
    try {
      window.turnstile.remove(turnstileWidgetId);
    } catch {
      /* ignore */
    }
    turnstileWidgetId = null;
  }
  turnstileToken = '';
  turnstileWidgetId = window.turnstile.render(wrap, {
    sitekey: TURNSTILE_SITE_KEY,
    callback: (token) => {
      turnstileToken = token;
    },
    'expired-callback': () => {
      turnstileToken = '';
    },
    'error-callback': () => {
      turnstileToken = '';
    },
  });
}

function resetTurnstileAfterRun() {
  turnstileToken = '';
  if (window.turnstile?.reset && turnstileWidgetId != null) {
    try {
      window.turnstile.reset(turnstileWidgetId);
    } catch {
      /* ignore */
    }
  }
}

function clearBillingModalOpen() {
  const p = $('#modal-pricing');
  const w = $('#modal-paywall');
  if (p?.hasAttribute('hidden') && w?.hasAttribute('hidden')) {
    document.body.classList.remove('paywall-open');
  }
}

function updatePricingCheckoutHint() {
  if (!API_BILLING_CHECKOUT) {
    showConfigToastOnce(
      'Live checkout needs an API URL: set VITE_API_URL (or VITE_SAME_ORIGIN_API / cloneai-api-origin meta / __CLONEAI_API_BASE__).',
      4500
    );
  }
}

function openPricingModal(source = 'modal') {
  trackClientEvent('upgrade_clicked', { source });
  $('#modal-paywall')?.setAttribute('hidden', '');
  $('#modal-pricing')?.removeAttribute('hidden');
  document.body.classList.add('paywall-open');
  updatePricingCheckoutHint();
}

function closePricingModal() {
  $('#modal-pricing')?.setAttribute('hidden', '');
  clearBillingModalOpen();
}

function getPromoCodeValue() {
  return ($('#promo-code-input')?.value || '').trim();
}

function persistPromoCodeToStorage(value) {
  const v = String(value || '').trim().slice(0, 128);
  try {
    if (v) localStorage.setItem(LS_PROMO_CODE, v);
    else localStorage.removeItem(LS_PROMO_CODE);
  } catch {
    /* ignore */
  }
}

function loadPersistedPromoCode() {
  try {
    const v = (localStorage.getItem(LS_PROMO_CODE) || '').trim().slice(0, 128);
    const main = $('#promo-code-input');
    if (main && v && !String(main.value || '').trim()) main.value = v;
  } catch {
    /* ignore */
  }
}

function syncPaywallPromoFieldFromMain() {
  const pay = $('#paywall-promo-input');
  if (pay) pay.value = getPromoCodeValue();
}

function openPaywallModal(limitBody) {
  const reason =
    isLimitReachedPayload(limitBody) ? 'limit' : limitBody?.feature || limitBody?.code || 'upgrade';
  trackClientEvent('upgrade_modal_opened', { reason });
  const modal = $('#modal-paywall');
  const detail = $('#paywall-detail');
  const titleEl = $('#modal-paywall-title');
  if (!modal || !detail) return;
  $('#modal-pricing')?.setAttribute('hidden', '');
  if (isLimitReachedPayload(limitBody)) {
    if (titleEl) titleEl.textContent = 'You’ve reached your limit';
    showToast('Run limit reached — pick a plan or an extra run to continue.', { variant: 'warning', duration: 3600 });
    const plan = (limitBody.plan || 'current').toString();
    detail.textContent = `You’ve used ${limitBody.used} of ${limitBody.limit} analyses on your ${plan} plan. Upgrade or buy one extra run ($3) to continue.`;
  } else {
    if (titleEl) titleEl.textContent = 'Upgrade or authorized code';
    const msg =
      (limitBody && limitBody.message) ||
      'Choose a plan (secure checkout via Stripe), enter an authorized promo code below, or use the code field under analysis options — then run again.';
    detail.textContent = msg;
    showToast('Pay with Stripe or enter an authorized code to unlock this scan.', { variant: 'warning', duration: 3800 });
  }
  syncPaywallPromoFieldFromMain();
  modal.removeAttribute('hidden');
  document.body.classList.add('paywall-open');
  requestAnimationFrame(() => {
    if (!isLimitReachedPayload(limitBody)) $('#paywall-promo-input')?.focus();
  });
}

function closePaywallModal() {
  $('#modal-paywall')?.setAttribute('hidden', '');
  clearBillingModalOpen();
}

function loadScanModeFromStorage() {
  try {
    const v = (localStorage.getItem(LS_PREF_SCAN_MODE) || '').trim().toLowerCase();
    if (v === 'images' || v === 'elite' || v === 'screenshots') scanMode = v;
    else scanMode = 'elite';
  } catch {
    scanMode = 'elite';
  }
}

function persistScanMode() {
  try {
    const persist = scanMode === 'images' || scanMode === 'screenshots' ? scanMode : 'elite';
    localStorage.setItem(LS_PREF_SCAN_MODE, persist);
  } catch {
    /* ignore */
  }
}

function updateScanModePills() {
  $$('.scan-mode-pill').forEach((p) => {
    const m = p.getAttribute('data-scan-mode');
    p.classList.toggle('active', m === scanMode);
  });
}

function updateScreenshotSweepHint() {
  $('#screenshot-sweep-hint')?.classList.toggle('hidden', scanMode !== 'screenshots');
}

function setScanMode(mode) {
  let next = 'elite';
  if (mode === 'images') next = 'images';
  else if (mode === 'screenshots') next = 'screenshots';
  scanMode = next;
  persistScanMode();
  updateScanModePills();
  updateScreenshotSweepHint();
  const ah = $('#asset-harvest-toggle');
  if (next === 'images' && ah && !ah.checked) {
    ah.checked = true;
    persistOutputPrefs();
  }
  if (next === 'screenshots' && ah && ah.checked) {
    ah.checked = false;
    persistOutputPrefs();
  }
  trackClientEvent('scan_mode_changed', { scanMode: next });
}

function updateScanPromoHint() {
  const el = $('#scan-promo-hint');
  if (!el) return;
  el.classList.toggle('hidden', !billingCache.promoUnlocked);
}

/** Hide the URL-tab notice when GET /api/health reports openaiConfigured (key lives on the server only). */
async function refreshOpenAiServerNotice() {
  const wrap = $('#openai-server-notice');
  const titleEl = $('#openai-server-notice-title');
  const detailEl = $('#openai-server-notice-detail');
  if (!wrap || !titleEl || !detailEl) return;
  if (!API_HEALTH) {
    wrap.classList.add('hidden');
    return;
  }
  try {
    const res = await fetch(API_HEALTH);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      titleEl.textContent = 'Could not reach the API';
      const proxyHint =
        res.status === 502 || res.status === 504
          ? ` (HTTP ${res.status}: dev proxy could not connect — start the API or match VITE_DEV_API_PROXY to the backend port.)`
          : res.status ? ` (HTTP ${res.status})` : '';
      detailEl.textContent =
        `From the repo root run npm run dev (starts API + this app). Frontend-only npm run dev needs the backend on the proxy port (default 127.0.0.1:3001).${proxyHint} OpenAI key: backend/.env only — not browser settings.`;
      wrap.classList.remove('hidden');
      return;
    }
    if (data.openaiConfigured) {
      wrap.classList.add('hidden');
      titleEl.textContent = '';
      detailEl.textContent = '';
      return;
    }
    if (data.offlineMode) {
      if (isProd) {
        wrap.classList.add('hidden');
        titleEl.textContent = '';
        detailEl.textContent = '';
        return;
      }
      titleEl.textContent = 'Offline / dev API (no OpenAI key on server)';
      detailEl.textContent =
        'Scans still run without cloud AI. For AI-written analysis, set OPENAI_API_KEY in backend/.env and restart.';
      wrap.classList.remove('hidden');
      return;
    }
    titleEl.textContent = 'OpenAI is not configured on the API server yet';
    detailEl.textContent =
      'Set OPENAI_API_KEY in backend/.env on the machine running the API, save the file, then restart the server. This page has no OpenAI “settings” field — analysis always uses the server key.';
    wrap.classList.remove('hidden');
  } catch {
    titleEl.textContent = 'Could not reach the API';
    detailEl.textContent =
      'Network error reaching /api/health. From repo root: npm run dev. If you use frontend-only dev, start the backend and ensure VITE_DEV_API_PROXY (or VITE_API_URL) points at it. Keys: backend/.env only.';
    wrap.classList.remove('hidden');
  }
}

async function refreshBillingStatus() {
  const usageWrap = $('#header-usage-wrap');
  const usageEl = $('#header-usage');
  const urgentEl = $('#header-usage-urgent');
  const upBtn = $('#header-upgrade-btn');
  const loginBtn = $('#header-login-btn');
  const ownerPill = $('#owner-unlock-pill');
  const syncLoginBtn = (visible) => {
    if (loginBtn) loginBtn.classList.toggle('hidden', !visible);
  };
  const syncOwnerPill = (visible, text = 'Owner / operator mode') => {
    if (!ownerPill) return;
    ownerPill.textContent = text;
    ownerPill.classList.toggle('hidden', !visible);
  };
  if (!usageEl || !upBtn || !usageWrap) {
    updateScanPromoHint();
    return;
  }
  const reqId = ++billingStatusRequestId;
  try {
    if (!API_BILLING_STATUS) {
      billingCache.enabled = false;
      billingCache.plan = 'guest';
      billingCache.promoUnlocked = false;
      usageWrap.classList.remove('hidden');
      usageEl.textContent = 'Runs: not synced';
      showConfigToastOnce(
        'Connect the API (VITE_API_URL or same-origin / meta) to show live run limits and checkout.',
        4200
      );
      urgentEl?.classList.add('hidden');
      upBtn.classList.remove('hidden');
      upBtn.textContent = 'Plans';
      syncLoginBtn(false);
      syncOwnerPill(false);
      updatePlanGatedControls();
      updateExportGatedControls();
      return;
    }
    const res = await fetch(API_BILLING_STATUS, { headers: analyzeFetchHeaders() });
    if (reqId !== billingStatusRequestId) return;
    const data = await res.json().catch(() => ({}));
    if (reqId !== billingStatusRequestId) return;
    if (res.status === 403 && data.code === 'INGRESS_FORBIDDEN') {
      billingCache.enabled = false;
      billingCache.plan = 'guest';
      billingCache.promoUnlocked = false;
      usageWrap.classList.remove('hidden');
      usageEl.textContent = 'Runs: API key required';
      showConfigToastOnce(
        'Server expects X-CloneAI-Key — set VITE_CLONEAI_KEY in the frontend build to match CLONEAI_INGRESS_KEY on the API.',
        5200
      );
      urgentEl?.classList.add('hidden');
      upBtn.classList.remove('hidden');
      upBtn.textContent = 'Plans';
      syncLoginBtn(false);
      syncOwnerPill(false);
      updatePlanGatedControls();
      updateExportGatedControls();
      return;
    }
    if (!res.ok || typeof data.enabled !== 'boolean') {
      billingCache.enabled = false;
      billingCache.plan = 'guest';
      billingCache.promoUnlocked = false;
      usageWrap.classList.remove('hidden');
      usageEl.textContent = 'Runs: not synced';
      showConfigToastOnce(
        'Could not load run balance — check API URL (same host as this page when possible), VITE_CLONEAI_KEY, and CORS_ORIGINS.',
        4200
      );
      urgentEl?.classList.add('hidden');
      upBtn.classList.remove('hidden');
      upBtn.textContent = 'Plans';
      syncLoginBtn(false);
      syncOwnerPill(false);
      updatePlanGatedControls();
      updateExportGatedControls();
      return;
    }
    if (!data.enabled) {
      billingCache.enabled = false;
      billingCache.plan = 'guest';
      billingCache.promoUnlocked = false;
      urgentEl?.classList.add('hidden');
      syncOwnerPill(false);
      if (isProd) {
        usageWrap.classList.add('hidden');
        usageEl.textContent = '';
      } else {
        usageWrap.classList.remove('hidden');
        usageEl.textContent = 'Runs: unlimited (billing off on server)';
      }
      upBtn.classList.remove('hidden');
      upBtn.textContent = 'Plans';
      syncLoginBtn(false);
      updatePlanGatedControls();
      updateExportGatedControls();
      return;
    }
    billingCache.enabled = true;
    billingCache.plan = normalizeBillingPlan(data.plan);
    billingCache.used = Number(data.used) || 0;
    billingCache.limit = Number(data.limit) || 1;
    billingCache.remaining = Number(data.remaining) ?? Math.max(0, billingCache.limit - billingCache.used);
    billingCache.promoUnlocked = Boolean(data.promoUnlocked);

    usageWrap.classList.remove('hidden');
    upBtn.classList.remove('hidden');
    syncLoginBtn(true);
    const planLabel =
      data.plan === 'free'
        ? 'Free'
        : data.plan === 'starter'
          ? 'Starter'
          : data.plan === 'pro'
            ? 'Pro'
            : data.plan === 'power'
              ? 'Power'
              : data.plan;
    const used = Number(data.used) || 0;
    const lim = Number(data.limit) || 1;
    let suffix = data.plan === 'free' ? 'lifetime' : 'this month';
    if (data.bonusRuns > 0) suffix += ` · +${data.bonusRuns} bonus`;
    if (data.promoUnlocked) suffix += ' · authorized code';
    if (data.clientIdUnset) suffix += ' · allow storage for accurate count';
    usageEl.innerHTML = `<strong>${used} / ${lim}</strong> runs used · ${escapeHtml(planLabel)} <span style="opacity:.85">(${suffix})</span>`;

    const ratio = lim > 0 ? used / lim : 0;
    if (urgentEl) {
      const near = ratio >= 0.8 && (data.remaining === undefined || Number(data.remaining) <= Math.ceil(lim * 0.25));
      urgentEl.classList.toggle('hidden', !near);
    }

    upBtn.textContent = data.plan === 'pro' ? 'Plans' : 'Upgrade';
    syncOwnerPill(Boolean(data.promoUnlocked), data.promoUnlocked ? 'Owner / quality-first unlocked' : '');
    enforceDepthForPlan();
    updatePlanGatedControls();
    updateExportGatedControls();
  } catch {
    if (reqId !== billingStatusRequestId) return;
    billingCache.enabled = false;
    billingCache.plan = 'guest';
    billingCache.promoUnlocked = false;
    usageWrap.classList.remove('hidden');
    usageEl.textContent = 'Runs: not synced';
    showConfigToastOnce(
      'Could not load run balance — check API URL, VITE_CLONEAI_KEY, and CORS.',
      4200
    );
    urgentEl?.classList.add('hidden');
    upBtn.classList.remove('hidden');
    upBtn.textContent = 'Plans';
    syncLoginBtn(false);
    syncOwnerPill(false);
    updatePlanGatedControls();
    updateExportGatedControls();
  } finally {
    updateScanPromoHint();
  }
}

function enforceDepthForPlan() {
  if (!billingCache.enabled || billingCache.promoUnlocked) return;
  // Free users may keep shallow/deep selected in the UI; Generate opens paywall or uses promo — do not snap to homepage here.
  if (billingCache.plan === 'starter' && depth === 'deep') {
    depth = 'shallow';
    $$('.depth-pill').forEach((x) => x.classList.toggle('active', x.dataset.depth === depth));
  }
}

function depthPillLocked(pillDepth) {
  if (!billingCache.enabled || billingCache.promoUnlocked) return false;
  if (billingCache.plan === 'free' && pillDepth !== 'homepage') return true;
  if (billingCache.plan === 'starter' && pillDepth === 'deep') return true;
  return false;
}

function notifyDepthPillLocked(pillDepth) {
  trackClientEvent('depth_gate_clicked', { depth: pillDepth, plan: billingCache.plan });
  let message =
    'That scan depth is not on your plan. Subscribe below (Stripe checkout) or enter an authorized promo code in this window — then tap Generate.';
  let feature = 'scan_depth';
  if (billingCache.plan === 'free' && pillDepth !== 'homepage') {
    message =
      'Multi-page crawls need Starter or higher — or an authorized promo code. Use Stripe below or enter your code, save it, then run analysis.';
    feature = 'multi_page_scan';
  } else if (billingCache.plan === 'starter' && pillDepth === 'deep') {
    message =
      'Full-site depth (~300+ pages) needs Pro or Power — or an authorized promo. Checkout below or enter a code, save, then Generate.';
    feature = 'deep_crawl';
  }
  openPaywallModal({ code: 'FEATURE_LOCKED', message, feature });
}

function updatePlanGatedControls() {
  const hintDepth = $('#plan-gate-depth-hint');
  $$('.depth-pill').forEach((pill) => {
    const d = pill.dataset.depth;
    const locked = depthPillLocked(d);
    pill.classList.toggle('pill-locked', locked);
    pill.setAttribute('aria-disabled', locked ? 'true' : 'false');
    pill.removeAttribute('disabled');
  });

  if (hintDepth) {
    if (!billingCache.enabled || billingCache.plan === 'guest') {
      hintDepth.textContent = '';
      hintDepth.classList.add('hidden');
    } else if (billingCache.promoUnlocked) {
      hintDepth.textContent =
        'Authorized code: Pro-class scans and exports are unlocked — your plan below still shows Stripe tier.';
      hintDepth.classList.remove('hidden');
    } else if (billingCache.plan === 'free') {
      hintDepth.textContent =
        'Free: one homepage scan. Upgrade for multi-page crawls and more runs.';
      hintDepth.classList.remove('hidden');
    } else if (billingCache.plan === 'starter') {
      hintDepth.textContent =
        'Starter: up to ~25 pages. Deep crawl and URL+images combo need Pro or Power.';
      hintDepth.classList.remove('hidden');
    } else {
      hintDepth.textContent = '';
      hintDepth.classList.add('hidden');
    }
  }

  const bothTab = $('.tab[data-tab="both"]');
  const bothBadge = $('#tab-both-badge');
  if (bothTab) {
    const lockBoth =
      billingCache.enabled &&
      !billingCache.promoUnlocked &&
      (billingCache.plan === 'free' || billingCache.plan === 'starter');
    bothTab.classList.toggle('tab-locked', lockBoth);
    bothTab.setAttribute('aria-disabled', lockBoth ? 'true' : 'false');
    bothTab.removeAttribute('disabled');
    if (lockBoth && activeTab === 'both' && !getPromoCodeValue()) setTab('url');
    if (bothBadge) bothBadge.hidden = !lockBoth;
  }
}

function updateStickyUpgradeVisibility() {
  const su = $('#sticky-upgrade-btn');
  if (!su) return;
  const show =
    billingCache.enabled &&
    billingCache.plan !== 'guest' &&
    !planOrPromoProOrPower();
  su.hidden = !show;
}

function updateExportGatedControls() {
  const setLocked = (el, locked, title) => {
    if (!el) return;
    el.disabled = locked;
    el.classList.toggle('btn-export-locked', locked);
    el.title = locked ? title || 'Upgrade to unlock' : '';
  };

  setLocked($('#download-txt-btn'), false, '');
  setLocked($('#download-pdf-btn'), false, '');
  setLocked($('#copy-cursor-prompt-btn'), false, '');
  updateStickyUpgradeVisibility();
}

function updateProgressUpsell() {
  const el = $('#progress-upsell');
  if (!el) return;
  const inProgress = $('#progress-section') && !$('#progress-section').hidden;
  const show =
    inProgress &&
    billingCache.enabled &&
    !billingCache.promoUnlocked &&
    (billingCache.plan === 'free' || billingCache.plan === 'starter');
  el.hidden = !show;
}

function updatePostResultUpsell() {
  const el = $('#post-result-upsell');
  if (!el) return;
  const visible = $('#results-section') && !$('#results-section').hidden;
  const show =
    visible &&
    billingCache.enabled &&
    !planOrPromoProOrPower() &&
    fullBriefText.trim().length > 0;
  el.hidden = !show;
}

function loadOutputPrefs() {
  try {
    const sw = localStorage.getItem(LS_PREF_STRIP_WM) === '1';
    const tg = localStorage.getItem(LS_PREF_TRIM_IMG_BG) === '1';
    const cd = localStorage.getItem(LS_PREF_CLIENT_DELIVERY) === '1';
    const ah = localStorage.getItem(LS_PREF_ASSET_HARVEST) === '1';
    const pkg = localStorage.getItem(LS_PREF_SERVICE_PKG) || '';
    const elSw = $('#pref-strip-watermarks');
    const elTg = $('#pref-remove-image-bg');
    const elAh = $('#asset-harvest-toggle');
    const elCd = $('#pref-client-delivery');
    const elPkg = $('#service-package-select');
    if (elSw) elSw.checked = sw;
    if (elTg) elTg.checked = tg;
    if (elAh) elAh.checked = ah;
    if (elCd) elCd.checked = cd;
    if (elPkg && ['', 'basic', 'standard', 'premium'].includes(pkg)) elPkg.value = pkg;
    loadScanModeFromStorage();
    updateScanModePills();
    updateScreenshotSweepHint();
    const ep = localStorage.getItem(LS_PREF_EXTRACTION_PROFILE) || 'standard';
    const allowedEp = new Set(['quick_brief', 'standard', 'full_harvest', 'quality_first']);
    extractionProfile = allowedEp.has(ep) ? ep : 'standard';
    syncExtractionProfilePills();
  } catch {
    /* ignore */
  }
}

function persistOutputPrefs() {
  try {
    if ($('#pref-strip-watermarks')?.checked) localStorage.setItem(LS_PREF_STRIP_WM, '1');
    else localStorage.removeItem(LS_PREF_STRIP_WM);
    if ($('#pref-remove-image-bg')?.checked) localStorage.setItem(LS_PREF_TRIM_IMG_BG, '1');
    else localStorage.removeItem(LS_PREF_TRIM_IMG_BG);
    if ($('#asset-harvest-toggle')?.checked) localStorage.setItem(LS_PREF_ASSET_HARVEST, '1');
    else localStorage.removeItem(LS_PREF_ASSET_HARVEST);
    if ($('#pref-client-delivery')?.checked) localStorage.setItem(LS_PREF_CLIENT_DELIVERY, '1');
    else localStorage.removeItem(LS_PREF_CLIENT_DELIVERY);
    const pv = ($('#service-package-select')?.value || '').trim();
    if (pv && ['basic', 'standard', 'premium'].includes(pv)) localStorage.setItem(LS_PREF_SERVICE_PKG, pv);
    else localStorage.removeItem(LS_PREF_SERVICE_PKG);
    try {
      localStorage.setItem(LS_PREF_EXTRACTION_PROFILE, extractionProfile);
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

function isLocalDevHostname(hostname) {
  const h = String(hostname || '').toLowerCase();
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '[::1]' ||
    h.endsWith('.local') ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

/** Shareable app URL for footer / share — never show raw localhost unless explicitly configured. */
function getShareableAppUrl() {
  if (PUBLIC_APP_FALLBACK) return `${PUBLIC_APP_FALLBACK.replace(/\/$/, '')}/`;
  try {
    const { hostname, origin, pathname } = window.location;
    if (isLocalDevHostname(hostname)) return '';
    return `${origin}${pathname || '/'}`;
  } catch {
    return '';
  }
}

function applyStripWatermarkPreferenceToBrief() {
  if (!$('#pref-strip-watermarks')?.checked || !fullBriefText.trim()) return;
  if (fullBriefText.endsWith(WATERMARK_FOOTER)) {
    fullBriefText = fullBriefText.slice(0, -WATERMARK_FOOTER.length);
  } else {
    fullBriefText = fullBriefText.replace(
      /\r?\n\r?\n---\r?\n\r?\n\*Generated with (?:CloneAI|SiteCloner PRO) — upgrade to remove watermark\.\*\s*$/m,
      ''
    );
  }
  if ($('#results-section') && !$('#results-section').hidden) {
    $('#summary-content').innerHTML = renderMarkdown(fullBriefText);
  }
}

function updateReportChrome() {
  const wm = $('#report-watermark');
  const box = $('#summary-box');
  const stripWm = $('#pref-strip-watermarks')?.checked;
  const freeFmt =
    billingCache.enabled && billingCache.plan === 'free' && !billingCache.promoUnlocked && !stripWm;
  if (wm) wm.hidden = !freeFmt;
  if (box) {
    box.classList.toggle('summary-box-free', freeFmt);
    box.classList.toggle('summary-box-pro', billingCache.enabled && planOrPromoProOrPower());
  }
  const linkInput = $('#report-app-link');
  const linkActions = $('#report-brand-actions');
  const linkDevHint = $('#report-link-dev-hint');
  const shareUrl = getShareableAppUrl();
  if (linkInput) linkInput.value = shareUrl;
  if (linkActions && linkDevHint) {
    if (shareUrl) {
      linkActions.hidden = false;
      linkDevHint.hidden = true;
    } else {
      linkActions.hidden = true;
      linkDevHint.hidden = isProd;
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
    updatePricingCheckoutHint();
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
      const errText =
        data.error ||
        (res.status === 403 ? 'Access denied (check VITE_CLONEAI_KEY vs CLONEAI_INGRESS_KEY).' : null) ||
        'Could not start checkout. Try again.';
      showToast(String(errText), { variant: 'error', duration: 5200 });
      return;
    }
    if (data.url) {
      window.location.href = data.url;
      return;
    }
    showToast('Checkout did not return a redirect URL.', { variant: 'error', duration: 4800 });
  } catch (e) {
    showToast(e.message || 'Checkout failed — check API URL and CORS_ORIGINS.', {
      variant: 'error',
      duration: 5200,
    });
  }
}

function stripCheckoutQueryParams(url) {
  url.searchParams.delete('checkout');
  url.searchParams.delete('kind');
  url.searchParams.delete('plan');
  url.searchParams.delete('session_id');
}

function openCredentialsModal(login, password) {
  const modal = $('#modal-credentials');
  const loginEl = $('#credentials-login-field');
  const passEl = $('#credentials-password-field');
  if (!modal || !loginEl || !passEl) return;
  loginEl.value = login || '';
  passEl.value = password || '';
  modal.removeAttribute('hidden');
  document.body.classList.add('paywall-open');
}

function closeCredentialsModal() {
  $('#modal-credentials')?.setAttribute('hidden', '');
  const p = $('#credentials-password-field');
  if (p) p.value = '';
  clearBillingModalOpen();
}

function openLoginModal() {
  const modal = $('#modal-login');
  if (!modal) return;
  modal.removeAttribute('hidden');
  document.body.classList.add('paywall-open');
  $('#login-form')?.querySelector('input[name="email"]')?.focus();
}

function closeLoginModal() {
  $('#modal-login')?.setAttribute('hidden', '');
  clearBillingModalOpen();
}

async function tryClaimCheckoutAccount(sessionId) {
  if (!API_BILLING_CLAIM) {
    showToast('Account setup needs API URL — your plan will sync when the server is reachable.');
    await refreshBillingStatus();
    return;
  }
  try {
    const res = await fetch(API_BILLING_CLAIM, {
      method: 'POST',
      headers: billingJsonHeaders(),
      body: JSON.stringify({ sessionId: String(sessionId || '').trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 409) {
        showToast(String(data.error || 'Plan still updating — retry in a moment.'));
      } else {
        showToast(String(data.error || 'Could not finish account setup.'));
      }
      await refreshBillingStatus();
      return;
    }
    if (data.alreadyDelivered) {
      showToast('Login was already created for this browser — use Log in with your email.');
      await refreshBillingStatus();
      return;
    }
    if (data.login && data.password) {
      openCredentialsModal(data.login, data.password);
    }
    await refreshBillingStatus();
  } catch {
    showToast('Network error finishing account setup.');
    await refreshBillingStatus();
  }
}

function handleCheckoutReturnQuery() {
  void (async () => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('checkout') === 'success') {
        trackClientEvent('payment_completed', {
          plan: params.get('plan') || '',
          kind: params.get('kind') || '',
        });
        const sessionId = params.get('session_id');
        const plan = (params.get('plan') || '').toLowerCase();
        if (sessionId && (plan === 'starter' || plan === 'pro' || plan === 'power')) {
          await tryClaimCheckoutAccount(sessionId);
        } else {
          showToast('Payment received — refreshing your plan…');
          await refreshBillingStatus();
        }
        const url = new URL(window.location.href);
        stripCheckoutQueryParams(url);
        window.history.replaceState({}, '', url.pathname + url.search);
      }
      if (params.get('checkout') === 'cancel') {
        showToast('Checkout canceled');
        const url = new URL(window.location.href);
        stripCheckoutQueryParams(url);
        window.history.replaceState({}, '', url.pathname + url.search);
      }
    } catch {
      /* ignore */
    }
  })();
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
    desc: 'Placement, alt text; ZIP harvests images from every crawled page (use multi-page depth for large catalogs)',
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
    name: 'Multi-page crawl & asset crew',
    desc: 'BFS crawl, full-page PNGs, image harvest, ZIP — then optional Asset lab (HD + URL-grounded names)',
    doneLine: '✓ Site crawled & assets captured',
  },
  {
    icon: '🧭',
    name: 'DOM & landmark mapper',
    desc: 'Header, main, sections, footer, landmarks',
    doneLine: '✓ DOM landmarks mapped',
  },
  {
    icon: '⬜',
    name: 'Layout grid & spacing analyst',
    desc: 'Grid/flex, gutters, rhythm, breakpoints',
    doneLine: '✓ Layout lattice decoded',
  },
  {
    icon: '𝐓',
    name: 'Typography & scale systems',
    desc: 'Families, sizes, weights, line-height',
    doneLine: '✓ Type scale mapped',
  },
  {
    icon: '📎',
    name: 'Font faces & loading',
    desc: 'Webfonts, fallbacks, FOUT/FOIT hints',
    doneLine: '✓ Fonts & weights indexed',
  },
  {
    icon: '🎨',
    name: 'Color tokens & gradients',
    desc: 'Hex/RGB, semantic roles, gradients',
    doneLine: '✓ Palette & gradients locked',
  },
  {
    icon: '🌓',
    name: 'Theme mode scout',
    desc: 'Light/dark, prefers-color-scheme, tokens',
    doneLine: '✓ Theme variants spotted',
  },
  {
    icon: '⬡',
    name: 'Component & pattern library',
    desc: 'Buttons, cards, nav, forms, modals',
    doneLine: '✓ UI patterns catalogued',
  },
  {
    icon: '✨',
    name: 'States & micro-interactions',
    desc: 'Hover, focus, active, disabled, motion',
    doneLine: '✓ States & hovers noted',
  },
  {
    icon: '📄',
    name: 'Content, CTAs & meta copy',
    desc: 'Headings, body, buttons, SEO snippets',
    doneLine: '✓ Copy & CTAs extracted',
  },
  {
    icon: '🛒',
    name: 'Catalog / cards / pricing',
    desc: 'Product grids, tiers, inventory surfaces',
    doneLine: '✓ Inventory surface scanned',
  },
  {
    icon: '🏆',
    name: 'Hidden media hunter',
    desc: 'Lazy attrs, CSS backgrounds, srcset, JSON URLs',
    doneLine: '🏆 Hidden assets flagged (CSS, lazy, srcset)',
  },
  {
    icon: '📸',
    name: 'Full-viewport theme pass',
    desc: 'Align PNG snapshots to page regions',
    doneLine: '🏆 Full-view theme capture aligned',
  },
  {
    icon: '🔗',
    name: 'Cross-block consistency',
    desc: 'Repeated patterns across sections',
    doneLine: '✓ Cross-block consistency checked',
  },
  {
    icon: '♿',
    name: 'A11y & SEO surface pass',
    desc: 'Landmarks, labels, titles, social meta',
    doneLine: '✓ A11y/SEO signals noted',
  },
  {
    icon: '🎖',
    name: 'Chief architect (governor)',
    desc: 'Every specialist reports here; weak lanes go back for another pass before the final brief',
    doneLine: '✓ Cross-agent review complete — approved for report writer',
  },
  {
    icon: '✍',
    name: 'Report writer (AI)',
    desc: 'Synthesizing full markdown specification',
    doneLine: '✓ Master specification drafted',
  },
];

const REPORT_WRITER_AGENT_INDEX = AGENTS.length - 1;
const ANALYSIS_STAGE_TOTAL = AGENTS.length;

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
/** @type {'elite' | 'images'} */
let scanMode = 'elite';
let depth = 'homepage';
/** @type {'quick_brief' | 'standard' | 'full_harvest' | 'quality_first'} */
let extractionProfile = 'standard';
let filesImages = [];
let filesBoth = [];
let fullBriefText = '';
/** @type {{ token?: string, artifactUrl?: string, artifactName?: string, count?: number, imageCount?: number, image_count?: number, snapshotCount?: number, manifests?: Record<string, { name?: string, url?: string }>, images?: Array<object>, pages?: Array<object> } | null} */
let lastAssetsSnapshot = null;
let assetZipDownloadName = 'site-assets.zip';
let displayIndex = 0;
let streamActive = false;
let typewriterRaf = 0;
let analyzeAbort = null;
/** Extraction job id for the live SSE run (empty for legacy /analyze or revise). */
let currentRunJobId = '';
/** True when the user clicked Stop run (vs programmatic abort). */
let userInitiatedStop = false;
let jobHistoryPollTimer = null;
let activeExtractionJobId = '';
let lastCompletedJobArtifacts = [];
let lastCompletedJobId = '';
let extractionJobsSupported = Boolean(API_EXTRACTION_JOBS);
const selectedOptions = new Set(
  OPTION_DEFS.filter((o) => o.defaultOn).map((o) => o.id)
);

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function showDownloadAppPage(open) {
  const banner = $('#download-app-banner');
  const page = $('#download-app-page');
  const main = $('#main-app-content');
  if (banner) banner.classList.toggle('hidden', Boolean(open));
  if (page) page.classList.toggle('hidden', !open);
  if (main) main.classList.toggle('hidden', Boolean(open));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function formatHarvestBytes(b) {
  const n = Number(b) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatCount(n) {
  return (Number(n) || 0).toLocaleString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function humanizePipelineStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (!value) return 'Unknown';
  if (value === 'completed') return 'Completed';
  if (value === 'partial') return 'Partial';
  if (value === 'failed') return 'Failed';
  if (value === 'locked') return 'Locked';
  if (value === 'pending') return 'Pending';
  if (value === 'skipped') return 'Skipped';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function hasExtractionPayload(assets) {
  if (!assets || typeof assets !== 'object') return false;
  return Boolean(
    assets.token ||
      assets.artifactUrl ||
      assets.zipUrl ||
      assets.zip_url ||
      Number(assets.count) > 0 ||
      Number(assets.imageCount) > 0 ||
      Number(assets.image_count) > 0 ||
      Number(assets.discoveredUrlCount) > 0 ||
      Number(assets.pagesCrawled) > 0 ||
      Number(assets.snapshotCount) > 0 ||
      (Array.isArray(assets.images) && assets.images.length > 0) ||
      (Array.isArray(assets.pages) && assets.pages.length > 0) ||
      Object.keys(assets.manifests || {}).length > 0
  );
}

function assetManifestName(kind, assets = lastAssetsSnapshot) {
  const explicit = assets?.manifests?.[kind]?.name;
  if (explicit) return explicit;
  const fallback =
    kind === 'manifest' ? 'manifest.json' : kind === 'images' ? 'images.json' : kind === 'pages' ? 'pages.json' : '';
  return lastCompletedJobArtifacts.some((item) => item?.name === fallback) ? fallback : '';
}

function scrollToExtractionResults() {
  const section = $('#extraction-results');
  if (!section || section.hidden) return;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function syncExtractionProfilePills() {
  $$('.extraction-profile-pill').forEach((x) =>
    x.classList.toggle('active', (x.dataset.extractionProfile || '') === extractionProfile)
  );
}

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

/** @returns {{ markdown: string } | null} */
function extractReportSection12(md) {
  const s = String(md || '');
  const start = s.search(/^##\s*12\./m);
  if (start === -1) return null;
  const tail = s.slice(start);
  const endRel = tail.search(/^##\s*13\./m);
  const block = (endRel === -1 ? tail : tail.slice(0, endRel)).trim();
  return block ? { markdown: block } : null;
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
  const lab = $('#enhance-assets-btn');
  const labSticky = $('#sticky-enhance-assets-btn');
  const label = (summary) => `Download site assets (ZIP · ${summary})`;
  if ((!assets?.token && !assets?.artifactUrl && !assets?.zipUrl && !assets?.zip_url) || !assets.count) {
    if (btn) {
      btn.hidden = true;
      btn.dataset.token = '';
      btn.dataset.artifactUrl = '';
      btn.textContent = 'Download site assets (ZIP)';
    }
    if (sticky) {
      sticky.hidden = true;
      sticky.dataset.token = '';
      sticky.dataset.artifactUrl = '';
      sticky.textContent = 'ZIP';
    }
    for (const el of [lab, labSticky]) {
      if (!el) continue;
      el.hidden = true;
      el.dataset.token = '';
      el.disabled = false;
    }
    return;
  }
  const bits = [];
  const disc = Number(assets.discoveredUrlCount) || 0;
  const ic = Number(assets.imageCount ?? assets.image_count) || 0;
  if (disc > 0 && disc > ic) {
    bits.push(`${ic}/${disc} imgs`);
  } else if (ic > 0) {
    bits.push(`${ic} imgs`);
  } else if (disc > 0) {
    bits.push(`URLs list · ${disc}`);
  }
  if (assets.snapshotCount) bits.push(`${assets.snapshotCount} snapshots`);
  const summary = bits.length ? bits.join(' · ') : `${assets.count} files`;
  const artifactUrl = assets.artifactUrl || assets.zipUrl || assets.zip_url || '';
  if (btn) {
    btn.dataset.token = assets.token || '';
    btn.dataset.artifactUrl = artifactUrl;
    btn.hidden = false;
    btn.textContent = label(summary);
  }
  if (sticky) {
    sticky.dataset.token = assets.token || '';
    sticky.dataset.artifactUrl = artifactUrl;
    sticky.hidden = false;
    sticky.textContent = `ZIP · ${summary}`;
    sticky.title = label(summary);
  }
  const canLab = Boolean(API_ASSET_PIPELINE_ENHANCE);
  for (const el of [lab, labSticky]) {
    if (!el) continue;
    el.hidden = !canLab || !assets.token;
    el.dataset.token = canLab && assets.token ? assets.token : '';
    el.disabled = false;
    if (labSticky && canLab) {
      labSticky.title = 'HD Lanczos pass + URL-grounded filenames (server-side; see docs)';
    }
  }
}

function renderExtractionResults(assets) {
  const wrap = $('#extraction-results');
  const sub = $('#extraction-results-sub');
  const stats = $('#extraction-stats-grid');
  const note = $('#extraction-results-note');
  const preview = $('#extraction-preview-grid');
  const viewBtn = $('#view-extraction-results-btn');
  const manifestBtn = $('#download-manifest-btn');
  const imagesBtn = $('#download-images-json-btn');
  const pagesBtn = $('#download-pages-json-btn');
  if (!wrap || !stats || !note || !preview) return;

  if (!hasExtractionPayload(assets)) {
    wrap.hidden = true;
    stats.innerHTML = '';
    preview.innerHTML = '';
    note.hidden = true;
    note.textContent = '';
    if (sub) {
      sub.textContent = 'Real extracted assets, manifests, and page-to-image mappings from this run.';
    }
    if (viewBtn) viewBtn.hidden = true;
    for (const btn of [manifestBtn, imagesBtn, pagesBtn]) {
      if (!btn) continue;
      btn.hidden = true;
      btn.disabled = false;
    }
    return;
  }

  const imageCount = Number(assets?.imagesDownloaded ?? assets?.imageCount ?? assets?.image_count) || 0;
  const discoveredCount =
    Number(assets?.imageCandidatesFound ?? assets?.image_candidates_found ?? assets?.discoveredUrlCount) ||
    imageCount;
  const pagesDiscovered = Number(assets?.pagesDiscovered ?? assets?.pages_discovered) || 0;
  const pagesCrawled = Number(assets?.pagesCrawled ?? assets?.pages_crawled) || 0;
  const duplicatesSkipped =
    Number(assets?.imageDuplicatesSkipped ?? assets?.image_duplicates_skipped ?? assets?.duplicatesSkipped) || 0;
  const failedCount = Number(assets?.assetFailures ?? assets?.asset_failures ?? assets?.failed) || 0;
  const archiveBytes = Number(assets?.archiveSizeBytes ?? assets?.archive_size_bytes ?? assets?.archiveBytes) || 0;
  const archiveFileCount = Number(assets?.archiveFileCount ?? assets?.archive_file_count ?? assets?.count) || 0;
  const manifestCount = Number(assets?.manifestCount ?? assets?.manifest_count) || 0;
  const crawlStatus = humanizePipelineStatus(assets?.crawlStatus ?? assets?.crawl_status);
  const screenshotStatus = humanizePipelineStatus(assets?.screenshotStatus ?? assets?.screenshot_status);
  const downloadStatus = humanizePipelineStatus(assets?.downloadStatus ?? assets?.download_status);
  const archiveStatus = humanizePipelineStatus(assets?.archiveStatus ?? assets?.archive_status);
  const manifestStatus = humanizePipelineStatus(assets?.manifestStatus ?? assets?.manifest_status);
  const reportStatus = humanizePipelineStatus(assets?.reportStatus ?? assets?.report_status);

  const statCards = [
    ['Pages discovered', formatCount(pagesDiscovered)],
    ['Images found', formatCount(discoveredCount)],
    ['Pages crawled', formatCount(pagesCrawled)],
    ['Images downloaded', formatCount(imageCount)],
    ['Duplicates skipped', formatCount(duplicatesSkipped)],
    ['Failed downloads', formatCount(failedCount)],
    ['Archive files', formatCount(archiveFileCount)],
    ['Archive size', archiveBytes > 0 ? formatHarvestBytes(archiveBytes) : '0 B'],
    ['Manifests', formatCount(manifestCount)],
  ];
  stats.innerHTML = statCards
    .map(
      ([label, value]) =>
        `<div class="extraction-stat-card"><span class="extraction-stat-label">${escapeHtml(label)}</span><span class="extraction-stat-value">${escapeHtml(value)}</span></div>`
    )
    .join('');

  if (sub) {
    const bits = [];
    bits.push(`Crawl ${crawlStatus}`);
    bits.push(`Screenshots ${screenshotStatus}`);
    bits.push(`Downloads ${downloadStatus}`);
    bits.push(`Archive ${archiveStatus}`);
    bits.push(`Manifests ${manifestStatus}`);
    bits.push(`Report ${reportStatus}`);
    if (archiveBytes > 0) bits.push(`ZIP ~${formatHarvestBytes(archiveBytes)}`);
    if (Number(assets?.snapshotCount) > 0) bits.push(`${formatCount(assets.snapshotCount)} snapshots`);
    sub.textContent = bits.length
      ? `Real extracted assets, manifests, and page-to-image mappings from this run. ${bits.join(' · ')}.`
      : 'Real extracted assets, manifests, and page-to-image mappings from this run.';
  }

  const notes = [];
  if (pagesDiscovered > pagesCrawled) {
    notes.push(
      `${formatCount(pagesDiscovered - pagesCrawled)} page(s) were discovered but not crawled before the run ended.`
    );
  }
  if (discoveredCount > imageCount) {
    notes.push(
      `${formatCount(discoveredCount - imageCount)} discovered image URL(s) were not archived. Check fetch notes, plan limits, or blocked/non-image responses in the manifests.`
    );
  }
  if (assets?.archiveLocked) {
    notes.push('Archive download is locked for this run, but extraction counts and manifests were still captured.');
  }
  note.hidden = notes.length === 0;
  note.textContent = notes.join(' ');

  const previewItems = Array.isArray(assets?.previewAssets)
    ? assets.previewAssets
    : Array.isArray(assets?.preview_assets)
      ? assets.preview_assets
      : Array.isArray(assets?.images)
        ? assets.images.slice(0, 24)
        : [];
  if (previewItems.length > 0) {
    preview.innerHTML = previewItems
      .map((item) => {
        const sourcePages = Array.isArray(item?.sourcePages) ? item.sourcePages : [];
        const pageSummary =
          sourcePages.length > 1
            ? `${sourcePages[0]} (+${sourcePages.length - 1} more)`
            : sourcePages[0] || item?.sourcePage || 'Unmapped page';
        const sourceUrl = String(item?.sourceUrl || '').trim();
        const file = String(item?.file || '').trim() || 'archived-image';
        return `<article class="extraction-preview-card">
          ${
            sourceUrl
              ? `<img class="extraction-preview-thumb" src="${escapeHtml(sourceUrl)}" alt="${escapeHtml(file)}" loading="lazy" referrerpolicy="no-referrer" />`
              : `<div class="extraction-preview-thumb" aria-hidden="true"></div>`
          }
          <div class="extraction-preview-file">${escapeHtml(file)}</div>
          <div class="extraction-preview-meta">
            <span>Source page: ${escapeHtml(pageSummary)}</span>
            <span>Mapped pages: ${escapeHtml(formatCount(sourcePages.length || (item?.sourcePage ? 1 : 0)))}</span>
            <span class="extraction-preview-url">${escapeHtml(sourceUrl || 'No source URL recorded')}</span>
          </div>
        </article>`;
      })
      .join('');
  } else {
    preview.innerHTML = `<article class="extraction-preview-card"><div class="extraction-preview-meta"><span>${
      imageCount > 0
        ? `${escapeHtml(formatCount(imageCount))} archived image(s) recorded. Open the JSON manifests or ZIP for the full asset set.`
        : 'No archived images were recorded for this run yet.'
    }</span></div></article>`;
  }

  const manifestButtons = [
    ['manifest', manifestBtn],
    ['images', imagesBtn],
    ['pages', pagesBtn],
  ];
  for (const [kind, btn] of manifestButtons) {
    if (!btn) continue;
    btn.hidden = !(lastCompletedJobId && assetManifestName(kind, assets));
  }

  wrap.hidden = false;
  if (viewBtn) viewBtn.hidden = false;
}

function applyAssetsMeta(assets) {
  lastAssetsSnapshot = hasExtractionPayload(assets) ? { ...assets } : null;
  assetZipDownloadName = assets?.filename || assets?.artifactName || 'site-assets.zip';
  syncZipButtons(assets);
  renderExtractionResults(lastAssetsSnapshot);
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
    parts.push(
      'HTML was truncated for the AI context window; image harvesting still uses the full crawled HTML per page (not the shortened model view).'
    );
  }
  if (scraper?.runFocus === 'images') {
    parts.push(
      'Run focus: **Image extract** — Deep Asset Harvest is on for URL crawls; the model prioritizes Section 9 and image manifests.'
    );
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
  if (scraper?.crawlPartialMessage) {
    parts.push(scraper.crawlPartialMessage);
  }
  if (scraper?.archiveLockedMessage) {
    parts.push(scraper.archiveLockedMessage);
  }
  if (scraper?.assetHarvestMode) {
    parts.push('Deep Asset Harvest was on: crawl prioritized media discovery; the AI saw a trimmed HTML slice per page.');
  }
  const cssSheets = Number(scraper?.cssSheetsProcessed) || 0;
  if (cssSheets > 0) {
    parts.push(
      `Linked stylesheets scanned for images: ${cssSheets} CSS file(s) (see ZIP extract/_discovered_image_urls.txt for every URL found).`
    );
  }
  const remaining = Number(scraper?.crawlQueueRemaining) || 0;
  if (remaining > 0) {
    parts.push(`${remaining} page(s) remained in the crawl queue when extraction stopped.`);
  }
  const failCount = Number(scraper?.imagesFailedCount) || 0;
  if (failCount > 0) {
    parts.push(`${failCount} asset fetch attempt(s) failed or were rejected by technical guards.`);
  }
  const dup = Number(scraper?.harvestContentDuplicatesSkipped) || 0;
  if (dup > 0) {
    parts.push(`${dup} duplicate image file(s) skipped (same bytes as an earlier URL).`);
  }
  const archiveBytes = Number(scraper?.archiveBytes) || 0;
  if (archiveBytes > 0) {
    parts.push(`Archive payload before ZIP compression: ~${formatHarvestBytes(archiveBytes)}.`);
  }
  if (parts.length) {
    el.textContent = parts.join(' ');
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }

  const hEl = $('#harvest-live-stats');
  if (hEl && (scraper?.crawlPageCount != null || scraper?.imagesDiscoveredCount != null)) {
    const p = scraper.crawlPageCount != null ? scraper.crawlPageCount : '—';
    const im = scraper.imagesDiscoveredCount != null ? scraper.imagesDiscoveredCount : null;
    const failText = failCount > 0 ? ` · ${failCount} fetch notes` : '';
    const dupText = dup > 0 ? ` · ${dup} dupes skipped` : '';
    hEl.hidden = false;
    hEl.textContent =
      im != null
        ? `Crawl: ${p} page(s) · ${im} unique image URL(s) discovered${failText}${dupText} (ZIP count may be lower after plan/server caps).`
        : `Crawl: ${p} page(s).`;
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
  if (status === 503) {
    if (body?.code === 'OFFLINE_NO_AI') {
      return 'Brief revision needs an OpenAI API key on the server. Offline mode still runs full scans from the main button.';
    }
    return msg || body?.error || 'Service unavailable. Try again shortly.';
  }
  if (status === 500) {
    if (/misconfiguration|OPENAI_API_KEY|not set/i.test(msg)) {
      return 'The analysis service is not configured (API key). Contact the site administrator.';
    }
    return (
      msg ||
      'Server error. Please retry in a moment. If this keeps happening, upgrading can include higher limits and deeper crawls for more reliable runs.'
    );
  }
  if (msg) return msg;
  if (body?.error) return String(body.error);
  return `Something went wrong (${status || 'network'}). Try again, or upgrade for deeper scans and higher limits if you hit caps often.`;
}

const CTA_IDLE = 'Generate Developer Blueprint';

function setAnalyzeLoading(on) {
  const btn = $('#analyze-btn');
  const label = $('#analyze-btn-label');
  if (!btn || !label) return;
  btn.classList.toggle('is-loading', on);
  btn.disabled = on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
  label.textContent = on ? 'Crawling, harvesting assets & writing your blueprint…' : CTA_IDLE;
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
    sub = 'lighter report, faster to read';
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
      <span class="agent-status waiting" data-status>⬜ Waiting</span>
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
    badge.innerHTML = '<span class="spin">⏳</span> Running…';
    if (descEl && agent) descEl.textContent = agent.desc;
  } else if (status === 'done') {
    badge.textContent = agent?.doneLine || '✔ Completed';
    if (descEl && agent) descEl.textContent = agent.desc;
  } else if (status === 'error') {
    badge.textContent = '✗ Error';
  } else {
    badge.textContent = '⬜ Waiting';
    if (descEl && agent) descEl.textContent = agent.desc;
  }
}

function markAllAgentRowsDone() {
  for (let i = 0; i < AGENTS.length; i += 1) {
    setAgentStatus(i, 'done');
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
    if (index === REPORT_WRITER_AGENT_INDEX) {
      stageEl.textContent = `Current: ${name} · streaming response…`;
    } else {
      stageEl.textContent = `Current: ${name}`;
    }
  } else if (phase === 'done' && index === REPORT_WRITER_AGENT_INDEX) {
    stageEl.textContent = 'Report writer complete';
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
    setProgress((index / ANALYSIS_STAGE_TOTAL) * 68);
  } else if (phase === 'done') {
    setAgentStatus(index, 'done');
    setStageLabel(index, phase, label);
    setProgress(((index + 1) / ANALYSIS_STAGE_TOTAL) * 68);
  } else if (phase === 'error') {
    setAgentStatus(index, 'error');
    setStageLabel(index, phase, label);
  }
}

function updateAnalysisRewardLine() {
  const el = $('#progress-reward');
  if (!el) return;
  const n = fullBriefText.length;
  let msg = '';
  if (n > 400) msg = '⭐ Theme structure emerging…';
  if (n > 2500) msg = '⭐⭐ Sections & inventory deepening…';
  if (n > 8000) msg = '⭐⭐⭐ Hidden media & layout rewards unlocked';
  if (n > 16000) msg = '🏆 Near-complete specification stream';
  el.textContent = msg;
}

function bumpStreamProgress() {
  const base = 68;
  const extra = Math.min(30, Math.floor(fullBriefText.length / 420));
  setProgress(Math.min(99, base + extra));
  updateAnalysisRewardLine();
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

function bothTabPlanLocked() {
  return (
    billingCache.enabled &&
    !billingCache.promoUnlocked &&
    (billingCache.plan === 'free' || billingCache.plan === 'starter')
  );
}

function setTab(tab) {
  if (tab === 'both' && bothTabPlanLocked()) {
    if (!getPromoCodeValue()) {
      openPaywallModal({
        code: 'FEATURE_LOCKED',
        message:
          'URL + screenshots in one run needs Pro or Power — or an authorized promo code. Pay with Stripe below or enter a code, save, then switch tab again.',
        feature: 'combo',
      });
      return;
    }
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

function showToast(text = 'Copied to clipboard', opts = {}) {
  const toast = $('#toast');
  if (!toast) return;
  const v = opts.variant;
  const variant = v === 'error' ? 'error' : v === 'warning' ? 'warning' : 'default';
  const defaultDur = variant === 'error' ? 5200 : variant === 'warning' ? 3200 : 2200;
  const duration = typeof opts.duration === 'number' ? opts.duration : defaultDur;
  toast.textContent = text;
  toast.hidden = false;
  toast.classList.toggle('toast-error', variant === 'error');
  toast.classList.toggle('toast-warn', variant === 'warning');
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      toast.hidden = true;
      toast.classList.remove('toast-error', 'toast-warn');
    }, 280);
  }, duration);
}

async function downloadSiteImagesZip() {
  const main = $('#download-images-btn');
  const sticky = $('#sticky-download-zip-btn');
  const token = main?.dataset?.token || sticky?.dataset?.token;
  const artifactUrl = main?.dataset?.artifactUrl || sticky?.dataset?.artifactUrl || lastAssetsSnapshot?.artifactUrl || lastAssetsSnapshot?.zipUrl || lastAssetsSnapshot?.zip_url || '';
  const url = artifactUrl || (token ? apiUrl(`/api/site-images/${token}`) : '');
  if (!url) {
    showToast('No asset bundle for this run');
    return;
  }
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
    a.download = assetZipDownloadName || 'site-assets.zip';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    showToast(`Saved ${assetZipDownloadName || 'site-assets.zip'}`);
  } catch (e) {
    showToast(e.message || 'Download failed', { variant: 'error', duration: 4000 });
  } finally {
    if (main) main.disabled = false;
    if (sticky) sticky.disabled = false;
  }
}

async function downloadJobArtifact(jobId, artifactName) {
  const url = extractionJobUrl(jobId, `/artifacts/${encodeURIComponent(artifactName || '')}`);
  if (!url) {
    showToast('Artifact is not available', { variant: 'warning' });
    return;
  }
  try {
    const res = await fetch(url, { headers: analyzeFetchHeaders() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Download failed (${res.status})`);
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = artifactName || 'download.bin';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  } catch (err) {
    showToast(err.message || 'Download failed', { variant: 'error', duration: 3600 });
  }
}

function downloadExtractionManifest(kind) {
  const name = assetManifestName(kind);
  if (!lastCompletedJobId || !name) {
    showToast('Manifest is not ready yet', { variant: 'warning' });
    return;
  }
  void downloadJobArtifact(lastCompletedJobId, name);
}

async function enhanceSiteAssetsZip() {
  const lab = $('#enhance-assets-btn');
  const labSticky = $('#sticky-enhance-assets-btn');
  const token =
    lab?.dataset?.token ||
    labSticky?.dataset?.token ||
    lastAssetsSnapshot?.token ||
    '';
  if (!token || !API_ASSET_PIPELINE_ENHANCE) {
    showToast('Asset lab is not available', { variant: 'warning' });
    return;
  }
  const headers = { 'Content-Type': 'application/json', ...analyzeFetchHeaders() };
  for (const el of [lab, labSticky]) {
    if (el) el.disabled = true;
  }
  try {
    const res = await fetch(API_ASSET_PIPELINE_ENHANCE, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Enhance failed (${res.status})`);
    }
    const nextTok = (data.token || '').trim();
    if (!/^[a-f0-9]{48}$/i.test(nextTok)) {
      throw new Error('Invalid response from asset pipeline');
    }
    const base = lastAssetsSnapshot || {
      token,
      count: 1,
      imageCount: 0,
      snapshotCount: 0,
    };
    lastAssetsSnapshot = { ...base, token: nextTok };
    assetZipDownloadName = (data.filename || 'site-assets-ready.zip').replace(/[^\w.-]+/g, '_') || 'site-assets-ready.zip';
    syncZipButtons(lastAssetsSnapshot);
    const st = data.stats;
    const bits = [];
    if (st?.rasterProcessed != null) bits.push(`${st.rasterProcessed} images processed`);
    if (st?.hd) bits.push('HD on');
    if (st?.aiNaming) bits.push('AI name pick');
    showToast(bits.length ? `Asset lab done — ${bits.join(' · ')}` : 'Asset lab done — download the new ZIP', {
      duration: 3800,
    });
  } catch (e) {
    showToast(e.message || 'Asset lab failed', { variant: 'error', duration: 4500 });
  } finally {
    for (const el of [lab, labSticky]) {
      if (el) el.disabled = false;
    }
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
  return `You are a senior front-end engineer. Rebuild or refactor a website using the following site analysis specification as the single source of truth. Follow structure, sections, and issue list; only ask questions if the spec is ambiguous.

---
SITE ANALYSIS (Markdown)
---

${brief}

---
End of specification. Start with a short implementation plan, then proceed step by step.`;
}

async function copyBrief() {
  trackClientEvent('copy_report_clicked');
  const text = fullBriefText;
  if (!text) {
    showToast('Nothing to copy yet');
    return;
  }
  const ok = await writeClipboard(text);
  showToast(ok ? 'Copied to clipboard' : 'Copy failed — select text manually');
}

async function shareReport() {
  const text = fullBriefText.trim();
  if (!text) {
    showToast('Nothing to share yet');
    return;
  }
  trackClientEvent('share_report_clicked');
  const url = getShareableAppUrl();
  const title = 'Website blueprint — SiteCloner PRO';
  try {
    if (navigator.share) {
      await navigator.share({
        title,
        text: 'Generated with SiteCloner PRO — developer-ready site blueprint.',
        ...(url ? { url } : {}),
      });
      return;
    }
  } catch {
    /* user cancelled or share failed */
  }
  const chunk = text.length > 12000 ? `${text.slice(0, 12000)}\n\n…(truncated)` : text;
  const head = url
    ? `${title}\n${url}\n\n---\n\n`
    : `${title}\n${isProd ? '(Open this page on the live site to include a public link.)\n\n' : '(Set VITE_PUBLIC_APP_URL for a stable share link in dev.)\n\n'}---\n\n`;
  const ok = await writeClipboard(`${head}${chunk}`);
  showToast(
    ok
      ? url
        ? 'Copied link + report text for sharing'
        : isProd
          ? 'Copied report text (open the live app in a browser to add a share link)'
          : 'Copied report text — set VITE_PUBLIC_APP_URL for a production link'
      : 'Copy failed — try Copy instead'
  );
}

async function copyCursorPrompt() {
  trackClientEvent('export_clicked', { format: 'cursor_prompt' });
  const text = buildCursorPrompt();
  if (!fullBriefText.trim()) {
    showToast('Nothing to copy yet');
    return;
  }
  const ok = await writeClipboard(text);
  showToast(ok ? 'Cursor / VS Code prompt copied' : 'Copy failed — select text manually');
}

function downloadBriefTxt() {
  trackClientEvent('export_clicked', { format: 'txt' });
  const text = fullBriefText.trim();
  if (!text) {
    showToast('Nothing to download yet');
    return;
  }
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'site-analysis-report.txt';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
  showToast('Saved site-analysis-report.txt');
}

function printBriefPdf() {
  trackClientEvent('export_clicked', { format: 'pdf' });
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
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Site analysis report</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;padding:1.75rem;max-width:52rem;margin:0 auto;color:#111;line-height:1.5;font-size:11pt;}
pre{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,monospace;font-size:9.5pt;}
h1{font-size:1.1rem;margin:0 0 1rem;}
@media print{body{padding:0.5in}}
</style></head><body><h1>SiteCloner PRO — Site analysis</h1><pre>${safe}</pre>
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

async function parseSseStream(response, { onText, signal, fastStages = false } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;

  const processEventPayload = async (data) => {
    if (data.type === 'plan_notice' && Array.isArray(data.messages) && data.messages.length) {
      const banner = $('#mid-flow-plan-notice');
      if (banner) {
        banner.textContent = data.messages.join(' ');
        banner.hidden = false;
        clearTimeout(planNoticeAutoHideTimer);
        planNoticeAutoHideTimer = setTimeout(() => {
          planNoticeAutoHideTimer = null;
          banner.hidden = true;
          banner.textContent = '';
        }, 4200);
      }
    }
    if (data.type === 'harvest_progress') {
      const hEl = $('#harvest-live-stats');
      if (hEl) {
        hEl.hidden = false;
        const phase = String(data.phase || 'crawl');
        const phaseLabel = String(data.phaseLabel || '').trim();
        const pc = Number(data.pagesCrawled) || 0;
        const ql = Number(data.queueLength) || 0;
        const disc = Number(data.pagesDiscovered) || pc + ql;
        const imgF = Number(data.imagesFound);
        const imgD = Number(data.imagesDownloaded);
        const imgFail = Number(data.imagesFailed);
        const dup = Number(data.duplicatesSkipped);
        const zipB = Number(data.zipBytesSoFar);
        const elaps = Number(data.elapsedMs);
        const parts = [];
        if (phaseLabel) parts.push(phaseLabel);
        if (phase === 'crawl' || phase === 'discover_images') {
          parts.push(`${disc} pages discovered`);
          parts.push(`${pc} crawled`);
          if (ql) parts.push(`${ql} queued`);
        }
        if (Number.isFinite(imgF) && imgF > 0) parts.push(`${imgF} images found`);
        if (Number.isFinite(imgD) && imgD > 0) parts.push(`${imgD} downloaded`);
        if (Number.isFinite(imgFail) && imgFail > 0) parts.push(`${imgFail} fetch notes`);
        if (Number.isFinite(dup) && dup > 0) parts.push(`${dup} dupes skipped`);
        if (Number.isFinite(zipB) && zipB > 0) parts.push(`~${formatHarvestBytes(zipB)} in archive`);
        if (Number.isFinite(elaps) && elaps > 400) parts.push(`${Math.round(elaps / 1000)}s`);
        if (phase === 'download_images' || phase === 'images_done' || phase === 'package') {
          parts.push(
            phase === 'package' ? 'building package' : phase === 'images_done' ? 'packing ZIP' : 'downloading images'
          );
        }
        hEl.textContent = parts.length ? `Live · ${parts.join(' · ')}` : `Live · ${pc} crawled · ${ql} queued`;
      }
    }
    if (data.type === 'stage') {
      applyStageEvent(data);
      if (
        !fastStages &&
        data.phase === 'done' &&
        typeof data.index === 'number' &&
        data.index < REPORT_WRITER_AGENT_INDEX
      ) {
        const slow = billingCache.enabled && planOrPromoProOrPower() ? 1 : 1.45;
        const ms = Math.floor((320 + Math.random() * 220) * slow);
        await new Promise((r) => setTimeout(r, ms));
      }
    }
    if (data.type === 'meta') {
      if (data.billing && typeof data.billing === 'object') {
        lastStreamBilling = {
          plan: data.billing.plan ?? null,
          billingEnabled: Boolean(data.billing.billingEnabled),
          isFreePlan: Boolean(data.billing.isFreePlan),
          appOrigin: data.billing.appOrigin ? String(data.billing.appOrigin).trim() : null,
        };
      }
      if (data.scraper) {
        const sc =
          data.runFocus && typeof data.scraper === 'object'
            ? { ...data.scraper, runFocus: data.runFocus }
            : data.scraper;
        applyMetaScraper(sc);
      }
      if (data.assets) applyAssetsMeta(data.assets);
      const pp = $('#priority-processing-pill');
      if (pp) pp.classList.toggle('hidden', !data.priorityQueue);
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
      return true;
    }
    return false;
  };

  const processSseBlock = async (block) => {
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
      if (await processEventPayload(data)) return true;
    }
    return false;
  };

  const drainBuffer = async () => {
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (await processSseBlock(block)) return true;
    }
    return false;
  };

  while (true) {
    if (signal?.aborted) {
      throw new Error('Request cancelled.');
    }
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    if (done) {
      buffer += decoder.decode();
      break;
    }
    if (await drainBuffer()) return;
  }

  if (await drainBuffer()) return;
  const tail = buffer.trim();
  if (tail && (await processSseBlock(tail))) return;

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

function openIssuesModal() {
  const overlay = $('#modal-issues');
  const body = $('#issues-modal-content');
  if (!overlay || !body) return;
  const sec = extractReportSection12(fullBriefText);
  if (!sec) {
    body.innerHTML =
      '<p>No <strong>section 12</strong> block was found in this report. Scroll the full report below or re-run analysis.</p>';
  } else {
    body.innerHTML = renderMarkdown(sec.markdown);
  }
  overlay.removeAttribute('hidden');
}

function closeIssuesModal() {
  $('#modal-issues')?.setAttribute('hidden', '');
}

function downloadIssuesListTxt() {
  const sec = extractReportSection12(fullBriefText);
  if (!sec?.markdown?.trim()) {
    showToast('No issues section to download', { variant: 'warning', duration: 2800 });
    return;
  }
  const blob = new Blob([`${sec.markdown}\n`], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cloneai-section-12-issues.txt';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
  showToast('Saved cloneai-section-12-issues.txt');
}

async function runReviseBrief() {
  if (!API_ANALYZE_REVISE) {
    showConfigToastOnce('Set VITE_API_URL to your API base URL in the host env and redeploy.', 4500);
    return;
  }
  const backup = fullBriefText.trim();
  if (backup.length < 80) {
    showToast('Report is too short to revise.', { variant: 'warning', duration: 2800 });
    return;
  }
  if (TURNSTILE_SITE_KEY && needsTurnstileUi()) {
    await ensureTurnstileMounted();
    if (!turnstileToken) {
      showToast('Complete the verification below, then try again.', { variant: 'warning', duration: 3200 });
      return;
    }
  }

  const fixNote = ($('#issues-fix-note')?.value || '').trim();
  closeIssuesModal();

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
  $('#analysis-hint').hidden = true;
  $('#analysis-hint').textContent = '';
  fullBriefText = '';
  displayIndex = 0;
  streamActive = true;
  $('#summary-content').innerHTML = '';
  $('#type-cursor').classList.remove('hidden');
  $('#progress-stage').textContent = 'Revising report…';
  buildAgentList();
  setProgress(4);
  setAnalyzeLoading(true);
  currentRunJobId = '';
  setProgressRunChromeVisible(true);

  trackClientEvent('revise_started', { tab: activeTab });

  try {
    const res = await fetch(API_ANALYZE_REVISE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...analyzeFetchHeaders(),
      },
      body: JSON.stringify({
        priorBrief: backup,
        fixNote,
        hp: '',
        cf_turnstile_response: turnstileToken || '',
        promoCode: getPromoCodeValue(),
      }),
      signal,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 403 && isLimitReachedPayload(body)) {
        streamActive = false;
        stopTypewriter();
        $('#progress-section').hidden = true;
        openPaywallModal(body);
        fullBriefText = backup;
        return;
      }
      if (res.status === 403 && isFeatureLockedPayload(body)) {
        streamActive = false;
        stopTypewriter();
        $('#progress-section').hidden = true;
        openPaywallModal(body);
        fullBriefText = backup;
        return;
      }
      if (res.status === 400 && body.error === 'MISSING_USER_ID') {
        streamActive = false;
        stopTypewriter();
        $('#progress-section').hidden = true;
        showToast('Session issue — refresh the page and try again.', { variant: 'warning', duration: 3800 });
        fullBriefText = backup;
        return;
      }
      if (
        res.status === 400 &&
        /verification|Human verification|Verification required/i.test(String(body.error || ''))
      ) {
        streamActive = false;
        stopTypewriter();
        $('#progress-section').hidden = true;
        void ensureTurnstileMounted();
        showToast(String(body.error || 'Verification required.'), { variant: 'warning', duration: 3400 });
        fullBriefText = backup;
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
        fullBriefText = backup;
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
    const stripWm = $('#pref-strip-watermarks')?.checked;
    if (billingCache.enabled && billingCache.plan === 'free' && !billingCache.promoUnlocked && !stripWm) {
      fullBriefText += WATERMARK_FOOTER;
    }
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
    resetTurnstileAfterRun();
    void ensureTurnstileMounted();
    trackClientEvent('revise_completed', { tab: activeTab });
    updatePostResultUpsell();
    updateReportChrome();
    $('#try-another-section')?.removeAttribute('hidden');
    showToast('Revised report ready — download .txt or PDF as usual.');
    setProgressRunChromeVisible(false);
  } catch (e) {
    console.error(e);
    streamActive = false;
    stopTypewriter();
    fullBriefText = backup;
    let errMsg =
      e.name === 'AbortError' && userInitiatedStop
        ? 'Revision stopped.'
        : e.name === 'AbortError'
          ? 'Revision cancelled.'
          : e.message || String(e);
    userInitiatedStop = false;
    if (/failed to fetch|networkerror|load failed/i.test(errMsg)) {
      errMsg =
        'Network error — check your connection and API URL (VITE_API_URL), then try Apply AI fixes again.';
    }
    showToast(errMsg, { variant: 'warning', duration: 4200 });
    $('#progress-section').hidden = true;
    $('#results-section').hidden = false;
    resetRunSidePanels();
    $('#summary-content').innerHTML = renderMarkdown(fullBriefText);
    $('#type-cursor').classList.add('hidden');
    trackClientEvent('revise_failed', { message: String(errMsg || '').slice(0, 120) });
    setProgressRunChromeVisible(false);
  } finally {
    setProgressRunChromeVisible(false);
    setAnalyzeLoading(false);
    updateFlowWizard();
    updateProgressUpsell();
  }
}

function prepareAnalyzeUiForStream() {
  $('#progress-section').hidden = false;
  $('#results-section').hidden = true;
  $('#results-outcome-strip')?.classList.add('hidden');
  $('#try-another-section')?.setAttribute('hidden', '');
  updateProgressUpsell();
  resetRunSidePanels();
  syncZipButtons({});
  lastAssetsSnapshot = null;
  assetZipDownloadName = 'site-assets.zip';
  fullBriefText = '';
  displayIndex = 0;
  streamActive = true;
  $('#summary-content').innerHTML = '';
  $('#type-cursor').classList.remove('hidden');
  $('#progress-stage').textContent = 'Connecting...';
  const pr = $('#progress-reward');
  if (pr) pr.textContent = '';
  buildAgentList();
  setProgress(2);
  setAnalyzeLoading(true);
  setProgressRunChromeVisible(true);
}

async function finalizeAnalyzeSuccess() {
  streamActive = false;
  const stripWm = $('#pref-strip-watermarks')?.checked;
  if (billingCache.enabled && billingCache.plan === 'free' && !billingCache.promoUnlocked && !stripWm) {
    fullBriefText += WATERMARK_FOOTER;
  }
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

  const zipSnap = lastAssetsSnapshot;
  if (zipSnap?.token && Number(zipSnap.discoveredUrlCount) > Number(zipSnap.imageCount || 0)) {
    showToast(
      `Asset ZIP: saved ${Number(zipSnap.imageCount || 0)} image file(s); ${Number(zipSnap.discoveredUrlCount)} unique URLs were found (full list in extract/_discovered_image_urls.txt). Remaining URLs may hit plan limits, blocked hosts, or non-image responses.`,
      { variant: 'warning', duration: 8200 }
    );
  }

  $('#progress-section').hidden = true;
  $('#results-section').hidden = false;
  currentRunJobId = '';
  setProgressRunChromeVisible(false);
  const outcome = $('#results-outcome-strip');
  if (outcome) {
    outcome.textContent = 'Run finished successfully';
    outcome.className = 'results-outcome-strip results-outcome-strip--ok';
    outcome.hidden = false;
  }
  try {
    await refreshBillingStatus();
    await refreshExtractionJobHistory();
  } catch {
    /* handled internally */
  }
  try {
    localStorage.setItem(LS_BRIEF_OK, '1');
  } catch {
    /* ignore */
  }
  try {
    resetTurnstileAfterRun();
    void ensureTurnstileMounted();
    trackClientEvent('run_completed', { depth, tab: activeTab });
    updatePostResultUpsell();
    updateReportChrome();
  } catch (postErr) {
    console.error(postErr);
  }
  $('#try-another-section')?.removeAttribute('hidden');
  persistActiveExtractionJob('');
}

function applyAnalyzeFailure(e) {
  console.error(e);
  streamActive = false;
  stopTypewriter();
  currentRunJobId = '';
  setProgressRunChromeVisible(false);
  const wasUserStop = userInitiatedStop;
  userInitiatedStop = false;
  let marked = false;
  for (let i = 0; i < AGENTS.length; i += 1) {
    const badge = $(`#agent-list li[data-index="${i}"] [data-status]`);
    if (badge?.classList.contains('running')) {
      setAgentStatus(i, wasUserStop ? 'waiting' : 'error');
      marked = true;
      break;
    }
  }
  if (!marked) setAgentStatus(REPORT_WRITER_AGENT_INDEX, wasUserStop ? 'waiting' : 'error');
  $('#progress-stage').textContent = wasUserStop ? 'Stopped' : 'Failed';
  setProgress(100);
  let errMsg =
    e.name === 'AbortError' && wasUserStop
      ? 'You stopped this run. It is marked stopped in Recent jobs — use Re-run on that row to restore URL and options.'
      : e.name === 'AbortError'
        ? 'Request cancelled.'
        : e.message || String(e);
  if (/failed to fetch|networkerror|load failed/i.test(errMsg)) {
    errMsg =
      'Network error — check your connection, disable VPN/ad-block for this site, and confirm the API URL (VITE_API_URL) is correct.';
  } else if (/connection closed before the brief finished/i.test(errMsg)) {
    errMsg =
      'The response stream ended early. Reconnect from the recent jobs panel or retry the extraction.';
  }
  fullBriefText = wasUserStop
    ? `## Run stopped\n\n${escapeHtml(errMsg)}\n\nUse **Re-run** on the job row (or **Generate** after restoring settings) when you are ready to try again.`
    : `## Something went wrong\n\n${escapeHtml(errMsg)}\n\n**Try again** with the same inputs. If failures repeat, **upgrade** for deeper crawls and higher limits — complex sites are often more reliable on **Pro**.\n\nTap **Re-run** or **Upgrade** in the header.`;
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
  const outcomeFail = $('#results-outcome-strip');
  if (outcomeFail) {
    outcomeFail.textContent = wasUserStop
      ? 'Run stopped — you can re-run from Recent jobs'
      : 'Run failed — check details below and retry';
    outcomeFail.className = `results-outcome-strip ${wasUserStop ? 'results-outcome-strip--stop' : 'results-outcome-strip--err'}`;
    outcomeFail.hidden = false;
  }
  resetRunSidePanels();
  updatePostResultUpsell();
  updateReportChrome();
  $('#try-another-section')?.removeAttribute('hidden');
  void refreshExtractionJobHistory();
  trackClientEvent('run_failed', {
    message: String(errMsg || '').slice(0, 120),
    detail: String(e?.message || e).slice(0, 160),
  });
}

async function connectToExtractionJob(jobId, { signal, fastStages = true } = {}) {
  const url = extractionJobUrl(jobId, '/events');
  if (!url) throw new Error('Job stream is unavailable.');
  const res = await fetch(url, { headers: analyzeFetchHeaders(), signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(humanizeError(res.status, body.error, body));
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream')) {
    throw new Error('Job stream is unavailable.');
  }
  startTypewriter();
  await parseSseStream(res, {
    signal,
    fastStages,
    onText: () => {
      bumpStreamProgress();
      scrollSummaryIfNeeded();
    },
  });
}

async function waitForTerminalExtractionJob(jobId, signal) {
  const maxWaitMs = 55 * 60 * 1000;
  const interval = 2000;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (signal?.aborted) throw new Error('Request cancelled.');
    try {
      const res = await fetch(extractionJobUrl(jobId), { headers: analyzeFetchHeaders(), signal });
      const job = await res.json().catch(() => ({}));
      if (res.ok && job?.id) {
        const st = String(job.status || '');
        if (st === 'completed' || st === 'failed' || st === 'cancelled') return job;
      }
    } catch {
      if (signal?.aborted) throw new Error('Request cancelled.');
    }
    await delay(interval);
  }
  throw new Error(
    'The live stream was interrupted and the run did not reach a final state in time. Check job history — if it finished, open the job from there.'
  );
}

async function hydrateBriefTextFromJobArtifacts(jobId) {
  const tryNames = ['report.md', 'cursor-ready.md', 'ai-handoff.md'];
  for (let attempt = 0; attempt < 36; attempt += 1) {
    for (const name of tryNames) {
      const res = await fetch(artifactDownloadUrl(jobId, name), { headers: analyzeFetchHeaders() });
      if (!res.ok) continue;
      const text = await res.text();
      if (String(text || '').trim()) {
        fullBriefText = text;
        return true;
      }
    }
    await delay(400);
  }
  return false;
}

function extractionStreamErrorShouldFallback(err) {
  if (userInitiatedStop) return false;
  if (err?.name === 'AbortError') return false;
  const msg = String(err?.message || err || '');
  if (/^Request cancelled/i.test(msg)) return false;
  return true;
}

async function connectToExtractionJobWithFallback(jobId, opts) {
  const userSignal = opts.signal;
  const sseCtrl = new AbortController();
  let preemptJob = null;
  let pollTimer = null;

  const stopPoll = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const abortSse = () => {
    if (!sseCtrl.signal.aborted) sseCtrl.abort();
  };

  if (userSignal) {
    if (userSignal.aborted) throw new Error('Request cancelled.');
    userSignal.addEventListener('abort', () => sseCtrl.abort(), { once: true });
  }

  const pollTerminalOnce = async () => {
    const res = await fetch(extractionJobUrl(jobId), {
      headers: analyzeFetchHeaders(),
      signal: userSignal,
    });
    const job = await res.json().catch(() => ({}));
    if (!res.ok || !job?.id) return null;
    const st = String(job.status || '');
    if (st === 'completed' || st === 'failed' || st === 'cancelled') return job;
    return null;
  };

  pollTimer = setInterval(() => {
    void (async () => {
      try {
        const job = await pollTerminalOnce();
        if (!job) return;
        preemptJob = job;
        stopPoll();
        abortSse();
      } catch {
        /* ignore transient poll errors */
      }
    })();
  }, 3500);

  try {
    await connectToExtractionJob(jobId, { ...opts, signal: sseCtrl.signal });
    preemptJob = null;
  } catch (err) {
    stopPoll();
    if (preemptJob) {
      const st = String(preemptJob.status || '');
      const pj = preemptJob;
      preemptJob = null;
      if (st === 'completed') {
        const gotBrief = await hydrateBriefTextFromJobArtifacts(jobId);
        if (!gotBrief) {
          throw new Error(
            'Run finished on the server but the report could not be loaded. Refresh the page and open this job from history.'
          );
        }
        markAllAgentRowsDone();
        setProgress(98);
        return;
      }
      if (st === 'failed') {
        throw new Error(String(pj.error?.message || pj.error || 'Analysis failed'));
      }
      if (st === 'cancelled') {
        throw new Error('Run stopped.');
      }
    }
    if (!extractionStreamErrorShouldFallback(err)) throw err;
    const ps = $('#progress-stage');
    if (ps) ps.textContent = 'Reconnecting — run continues on the server…';
    const job = await waitForTerminalExtractionJob(jobId, userSignal);
    const st2 = String(job.status || '');
    if (st2 === 'cancelled') {
      throw new Error('Run stopped.');
    }
    if (st2 === 'failed') {
      throw new Error(String(job.error?.message || job.error || 'Analysis failed'));
    }
    if (st2 !== 'completed') throw err;
    const gotBrief = await hydrateBriefTextFromJobArtifacts(jobId);
    if (!gotBrief) {
      throw new Error(
        'Run finished on the server but the report could not be loaded. Refresh the page and open this job from history.'
      );
    }
    markAllAgentRowsDone();
    setProgress(98);
  } finally {
    stopPoll();
  }
}

async function runAnalyzeLegacy(form, { signal, headers } = {}) {
  if (!API_ANALYZE) throw new Error('Analysis API is unavailable.');
  const res = await fetch(API_ANALYZE, {
    method: 'POST',
    headers,
    body: form,
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 403 && (body.error === 'LIMIT_REACHED' || isFeatureLockedPayload(body))) {
      streamActive = false;
      stopTypewriter();
      $('#progress-section').hidden = true;
      if (body.error === 'LIMIT_REACHED') void refreshBillingStatus();
      openPaywallModal(body);
      return true;
    }
    if (res.status === 400 && body.error === 'MISSING_USER_ID') {
      streamActive = false;
      stopTypewriter();
      $('#progress-section').hidden = true;
      showToast('Session issue — refresh the page and try again.', { variant: 'warning', duration: 3800 });
      return true;
    }
    if (res.status === 400 && /verification|Human verification|Verification required/i.test(String(body.error || ''))) {
      streamActive = false;
      stopTypewriter();
      $('#progress-section').hidden = true;
      try {
        localStorage.setItem(LS_BRIEF_OK, '1');
      } catch {
        /* ignore */
      }
      void ensureTurnstileMounted();
      showToast(String(body.error || 'Verification required.'), { variant: 'warning', duration: 3400 });
      return true;
    }
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
  await finalizeAnalyzeSuccess();
  return true;
}

function jobStatusTone(status) {
  if (status === 'completed') return 'Completed';
  if (status === 'failed') return 'Failed';
  if (status === 'cancelled') return 'Stopped';
  if (status === 'running') return 'Running';
  return 'Queued';
}

function jobStatusIndicatorMarkup(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'completed') {
    return '<span class="job-status-ic job-status-ic--ok" title="Completed" aria-label="Completed">✓</span>';
  }
  if (s === 'failed') {
    return '<span class="job-status-ic job-status-ic--err" title="Failed" aria-label="Failed">✕</span>';
  }
  if (s === 'cancelled') {
    return '<span class="job-status-ic job-status-ic--stop" title="Stopped" aria-label="Stopped">■</span>';
  }
  if (s === 'running') {
    return '<span class="job-status-ic job-status-ic--run" title="Running" aria-label="Running"><span class="job-status-pulse" aria-hidden="true"></span></span>';
  }
  return '<span class="job-status-ic job-status-ic--queue" title="Queued" aria-label="Queued">…</span>';
}

function applySummaryToAnalyzeForm(summary) {
  if (!summary || typeof summary !== 'object') return;
  const url = String(summary.url || '').trim();
  if (url) {
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const u = $('#url-input');
    const ub = $('#url-input-both');
    if (u) u.value = normalized;
    if (ub) ub.value = normalized;
  }
  const d = String(summary.depth || '').trim();
  if (d && ['homepage', 'shallow', 'deep'].includes(d) && !depthPillLocked(d)) {
    depth = d;
    $$('.depth-pill').forEach((x) => x.classList.toggle('active', x.dataset.depth === depth));
  }
  const sm = String(summary.scanMode || '').trim();
  if (sm && ['elite', 'images', 'screenshots'].includes(sm)) {
    scanMode = sm;
    updateScanModePills();
    updateScreenshotSweepHint();
  }
  const allowedEp = new Set(['quick_brief', 'standard', 'full_harvest', 'quality_first']);
  const ep = String(summary.extractionProfile || '').trim();
  if (allowedEp.has(ep)) {
    extractionProfile = ep;
    syncExtractionProfilePills();
  }
  const ah = $('#asset-harvest-toggle');
  if (ah) ah.checked = Boolean(summary.assetHarvestMode);
  const cp = $('#compare-pair');
  if (cp) cp.checked = Boolean(summary.comparePair);
  const cd = $('#pref-client-delivery');
  if (cd) cd.checked = Boolean(summary.clientDelivery);
  const rmb = $('#pref-remove-image-bg');
  if (rmb) rmb.checked = Boolean(summary.removeImageBackground);
  const pkg = String(summary.servicePackage || '').trim();
  const sel = $('#service-package-select');
  if (sel && ['basic', 'standard', 'premium'].includes(pkg)) sel.value = pkg;
  updateFlowWizard();
  updateDepthEstimate();
}

async function rerunFromJobRow(jobId) {
  if (!jobId || !API_EXTRACTION_JOBS) return;
  try {
    const res = await fetch(extractionJobUrl(jobId), { headers: analyzeFetchHeaders() });
    const job = await res.json().catch(() => ({}));
    if (!res.ok || !job?.summary) {
      showToast(job.error || 'Could not load that job.', { variant: 'warning', duration: 3200 });
      return;
    }
    if (!String(job.summary.url || '').trim() && Number(job.summary.fileCount) > 0) {
      showToast('This job used image uploads — add images again, then tap Generate.', { variant: 'warning', duration: 4200 });
      return;
    }
    applySummaryToAnalyzeForm(job.summary);
    $('#main-app-content')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('Settings restored from job — tap Generate to re-run.', { duration: 3600 });
  } catch {
    showToast('Could not load job details.', { variant: 'warning', duration: 2800 });
  }
}

function renderExtractionJobHistory(jobs) {
  const section = $('#job-history-section');
  const list = $('#job-history-list');
  const note = $('#job-active-note');
  if (!section || !list) return;
  if (!Array.isArray(jobs) || jobs.length === 0) {
    section.hidden = true;
    list.innerHTML = '';
    if (note) note.textContent = '';
    syncJobHistoryPolling([]);
    return;
  }
  section.hidden = false;
  list.innerHTML = jobs
    .map((job) => {
      const url = escapeHtml(job?.summary?.url || 'Image-only run');
      const status = escapeHtml(jobStatusTone(job?.status));
      const when = new Date(job?.updatedAt || job?.createdAt || Date.now()).toLocaleString();
      const zipArtifact = Array.isArray(job?.artifacts)
        ? job.artifacts.find((item) => /\.zip$/i.test(item?.name || ''))
        : null;
      const st = String(job?.status || '').toLowerCase();
      const canStop = st === 'running' || st === 'queued';
      const canRerun = st === 'failed' || st === 'cancelled' || st === 'completed';
      const indicator = jobStatusIndicatorMarkup(st);
      return `
        <li class="job-history-item">
          <div class="job-history-main">
            ${indicator}
            <div class="job-history-copy">
              <strong>${status}</strong>
              <span>${url}</span>
              <span>${escapeHtml(when)}</span>
            </div>
          </div>
          <div class="job-history-actions">
            ${
              canStop
                ? `<button type="button" class="btn-outline btn-sm job-history-stop" data-job-stop="${escapeHtml(job.id)}">Stop</button>`
                : ''
            }
            <button type="button" class="btn-outline btn-sm" data-job-open="${escapeHtml(job.id)}">Open</button>
            ${
              canRerun
                ? `<button type="button" class="btn-outline btn-sm job-history-rerun" data-job-rerun="${escapeHtml(job.id)}">Re-run</button>`
                : ''
            }
            ${
              zipArtifact
                ? `<button type="button" class="btn-outline btn-sm" data-job-zip="${escapeHtml(job.id)}" data-zip-name="${escapeHtml(zipArtifact.name)}">ZIP</button>`
                : ''
            }
          </div>
        </li>
      `;
    })
    .join('');
  if (note) {
    note.textContent = activeExtractionJobId ? `Watching: ${activeExtractionJobId}` : '';
  }
  syncJobHistoryPolling(jobs);
}

async function refreshExtractionJobHistory() {
  const section = $('#job-history-section');
  if (!section || !API_EXTRACTION_JOBS || !extractionJobsSupported) return;
  try {
    const res = await fetch(`${API_EXTRACTION_JOBS}?limit=12`, { headers: analyzeFetchHeaders() });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) {
      extractionJobsSupported = false;
      renderExtractionJobHistory([]);
      return;
    }
    if (!res.ok) throw new Error(data.error || `Jobs failed (${res.status})`);
    renderExtractionJobHistory(Array.isArray(data.jobs) ? data.jobs : []);
  } catch (err) {
    console.error(err);
  }
}

function renderArtifactPanel(jobId, artifacts) {
  const wrap = $('#artifact-panel');
  const list = $('#artifact-panel-list');
  if (!wrap || !list) return;
  if (!jobId || !Array.isArray(artifacts) || artifacts.length === 0) {
    wrap.hidden = true;
    list.innerHTML = '';
    lastCompletedJobArtifacts = [];
    lastCompletedJobId = '';
    return;
  }
  lastCompletedJobId = jobId;
  lastCompletedJobArtifacts = [...artifacts];
  const preferredOrder = [
    'site-assets.zip',
    'manifest.json',
    'manifest.csv',
    'pages.json',
    'pages.csv',
    'images.json',
    'images.csv',
    'site-map.txt',
    'report.md',
    'cursor-ready.md',
    'ai-handoff.md',
  ];
  const orderIndex = (name) => {
    const idx = preferredOrder.indexOf(name);
    return idx === -1 ? preferredOrder.length + name.localeCompare('') : idx;
  };
  const sorted = [...artifacts].sort((a, b) => {
    const ai = orderIndex(a?.name || '');
    const bi = orderIndex(b?.name || '');
    if (ai !== bi) return ai - bi;
    return String(a?.name || '').localeCompare(String(b?.name || ''));
  });
  list.innerHTML = sorted
    .map((artifact) => {
      const name = String(artifact?.name || '').trim();
      return `<button type="button" class="btn-outline btn-sm" data-artifact-download="${escapeHtml(name)}">${escapeHtml(name)}</button>`;
    })
    .join('');
  wrap.hidden = false;
}

async function hydrateCompletedJobArtifacts(jobId) {
  if (!jobId) {
    renderArtifactPanel('', []);
    return;
  }
  try {
    let res = null;
    let job = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      res = await fetch(extractionJobUrl(jobId), { headers: analyzeFetchHeaders() });
      job = await res.json().catch(() => ({}));
      if (!res.ok || !job?.id) throw new Error(job.error || `Job lookup failed (${res.status})`);
      const hasArtifacts = Array.isArray(job.artifacts) && job.artifacts.length > 0;
      const hasAssets = hasExtractionPayload(job.assets);
      const terminal = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
      if (terminal || hasArtifacts || hasAssets) break;
      await delay(350);
    }
    renderArtifactPanel(job.id, Array.isArray(job.artifacts) ? job.artifacts : []);
    if (job.assets) applyAssetsMeta(job.assets);
  } catch (err) {
    console.error(err);
    renderArtifactPanel('', []);
  }
}

async function openExtractionJob(jobId) {
  if (!jobId) return;
  if (analyzeAbort) analyzeAbort.abort();
  analyzeAbort = new AbortController();
  userInitiatedStop = false;
  currentRunJobId = jobId;
  persistActiveExtractionJob(jobId);
  prepareAnalyzeUiForStream();
  try {
    await connectToExtractionJobWithFallback(jobId, {
      signal: analyzeAbort.signal,
      fastStages: true,
    });
    await hydrateCompletedJobArtifacts(jobId);
    await finalizeAnalyzeSuccess();
  } catch (err) {
    applyAnalyzeFailure(err);
  } finally {
    setAnalyzeLoading(false);
    updateFlowWizard();
    updateProgressUpsell();
  }
}

async function resumePersistedExtractionJob() {
  const jobId = loadPersistedActiveExtractionJob();
  if (!jobId) return;
  try {
    const res = await fetch(extractionJobUrl(jobId), { headers: analyzeFetchHeaders() });
    const job = await res.json().catch(() => ({}));
    if (!res.ok || !job?.id) {
      persistActiveExtractionJob('');
      return;
    }
    if (job.status === 'queued' || job.status === 'running') {
      showToast('Reconnected to your extraction job.', { duration: 2600 });
      await openExtractionJob(jobId);
    }
  } catch (err) {
    console.error(err);
  }
}

async function runAnalyze() {
  if (!API_EXTRACTION_JOBS && !API_ANALYZE) {
    showConfigToastOnce('Set VITE_API_URL to your API base URL in the host env and redeploy.', 4500);
    return;
  }

  trackClientEvent('run_started', { depth, tab: activeTab, scanMode });

  const url = getUrlValue();
  const files = getFilesForRequest();
  if (!url && !files.length) {
    showToast('Enter a URL and/or upload at least one image.', { variant: 'warning', duration: 2800 });
    return;
  }
  if (selectedOptions.size === 0) {
    showToast('Select at least one analysis option (or turn toggles back on).', { variant: 'warning', duration: 2800 });
    return;
  }
  if (url && !clientUrlShapeOk(url)) {
    showToast('Enter a valid URL (http/https or a domain like example.com).', { variant: 'warning', duration: 3000 });
    return;
  }

  if (scanMode === 'screenshots') {
    if (!url) {
      showToast(
        'Screenshot sweep needs a URL. Use the URL tab and paste a site address (pick scan depth for how many pages).',
        { variant: 'warning', duration: 3800 }
      );
      return;
    }
    if (activeTab !== 'url') {
      showToast('Screenshot sweep runs from the URL tab only. Switch tabs or choose Elite / Image extract.', {
        variant: 'warning',
        duration: 3600,
      });
      return;
    }
    if (files.length > 0) {
      showToast('Screenshot sweep cannot include uploads. Clear images or switch to Elite / Image extract.', {
        variant: 'warning',
        duration: 3600,
      });
      return;
    }
  }

  if (billingCache.enabled && depthPillLocked(depth) && !getPromoCodeValue()) {
    notifyDepthPillLocked(depth);
    return;
  }

  if (billingCache.enabled && activeTab === 'both' && bothTabPlanLocked() && !getPromoCodeValue()) {
    openPaywallModal({
      code: 'FEATURE_LOCKED',
      message:
        'URL + screenshots together needs Pro or Power — or an authorized promo. Subscribe via Stripe or enter your code in the paywall, save, then Generate.',
      feature: 'combo',
    });
    return;
  }

  if (TURNSTILE_SITE_KEY && needsTurnstileUi()) {
    await ensureTurnstileMounted();
    if (!turnstileToken) {
      showToast('Complete the verification below, then tap Generate again.', { variant: 'warning', duration: 3200 });
      return;
    }
  }

  if (analyzeAbort) analyzeAbort.abort();
  analyzeAbort = new AbortController();
  const { signal } = analyzeAbort;
  prepareAnalyzeUiForStream();

  const opts = OPTION_DEFS.filter((o) => selectedOptions.has(o.id)).map((o) => o.label);
  const form = new FormData();
  form.append('url', url);
  form.append('depth', depth);
  form.append('scanMode', scanMode);
  form.append('extractionProfile', extractionProfile);
  form.append('options', JSON.stringify(opts));
  form.append('comparePair', $('#compare-pair')?.checked ? '1' : '0');
  form.append('removeImageBackground', $('#pref-remove-image-bg')?.checked ? '1' : '0');
  form.append('assetHarvest', $('#asset-harvest-toggle')?.checked ? '1' : '0');
  form.append('clientDelivery', $('#pref-client-delivery')?.checked ? '1' : '0');
  const svcPkg = ($('#service-package-select')?.value || '').trim();
  if (svcPkg && ['basic', 'standard', 'premium'].includes(svcPkg)) {
    form.append('servicePackage', svcPkg);
  }
  form.append('hp', ($('#form-hp')?.value || '').trim());
  const promoVal = getPromoCodeValue();
  if (promoVal) form.append('promoCode', promoVal);
  files.forEach((f) => form.append('images', f));

  const headers = analyzeFetchHeaders();

  try {
    if (!extractionJobsSupported) {
      await runAnalyzeLegacy(form, { signal, headers });
      return;
    }
    const res = await fetch(API_EXTRACTION_JOBS, { method: 'POST', headers, body: form, signal });
    const body = await res.json().catch(() => ({}));
    if (res.status === 404) {
      extractionJobsSupported = false;
      await runAnalyzeLegacy(form, { signal, headers });
      return;
    }
    if (!res.ok) {
      if (res.status === 403 && (body.error === 'LIMIT_REACHED' || isFeatureLockedPayload(body))) {
        streamActive = false;
        stopTypewriter();
        $('#progress-section').hidden = true;
        if (body.error === 'LIMIT_REACHED') void refreshBillingStatus();
        openPaywallModal(body);
        return;
      }
      if (res.status === 400 && body.error === 'MISSING_USER_ID') {
        streamActive = false;
        stopTypewriter();
        $('#progress-section').hidden = true;
        showToast('Session issue — refresh the page and try again.', { variant: 'warning', duration: 3800 });
        return;
      }
      if (res.status === 400 && /verification|Human verification|Verification required/i.test(String(body.error || ''))) {
        streamActive = false;
        stopTypewriter();
        $('#progress-section').hidden = true;
        try {
          localStorage.setItem(LS_BRIEF_OK, '1');
        } catch {
          /* ignore */
        }
        void ensureTurnstileMounted();
        showToast(String(body.error || 'Verification required.'), { variant: 'warning', duration: 3400 });
        return;
      }
      throw new Error(humanizeError(res.status, body.error, body));
    }

    const jobId = String(body.jobId || '').trim();
    if (!jobId) throw new Error('Server did not return a job id.');
    userInitiatedStop = false;
    currentRunJobId = jobId;
    persistActiveExtractionJob(jobId);
    await refreshExtractionJobHistory();
    await connectToExtractionJobWithFallback(jobId, { signal, fastStages: true });
    await hydrateCompletedJobArtifacts(jobId);
    await finalizeAnalyzeSuccess();
  } catch (e) {
    applyAnalyzeFailure(e);
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
  void ensureTurnstileMounted();

  $$('.tab').forEach((t) => {
    t.addEventListener('click', () => setTab(t.dataset.tab));
  });

  $$('.depth-pill').forEach((p) => {
    p.addEventListener('click', () => {
      const d = p.dataset.depth;
      if (depthPillLocked(d)) {
        depth = d;
        $$('.depth-pill').forEach((x) => x.classList.toggle('active', x.dataset.depth === depth));
        updateFlowWizard();
        notifyDepthPillLocked(d);
        return;
      }
      depth = d;
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

  loadOutputPrefs();
  $$('.scan-mode-pill').forEach((p) => {
    p.addEventListener('click', () => {
      if (p.classList.contains('extraction-profile-pill')) return;
      const m = p.getAttribute('data-scan-mode');
      if (m === 'images' || m === 'elite' || m === 'screenshots') setScanMode(m);
    });
  });
  $$('.extraction-profile-pill').forEach((p) => {
    p.addEventListener('click', () => {
      const v = p.getAttribute('data-extraction-profile');
      const allowed = new Set(['quick_brief', 'standard', 'full_harvest', 'quality_first']);
      if (!v || !allowed.has(v)) return;
      extractionProfile = v;
      syncExtractionProfilePills();
      persistOutputPrefs();
      updateFlowWizard();
    });
  });
  $('#pref-strip-watermarks')?.addEventListener('change', () => {
    persistOutputPrefs();
    applyStripWatermarkPreferenceToBrief();
    updateReportChrome();
  });
  $('#pref-remove-image-bg')?.addEventListener('change', persistOutputPrefs);
  $('#asset-harvest-toggle')?.addEventListener('change', persistOutputPrefs);
  $('#pref-client-delivery')?.addEventListener('change', persistOutputPrefs);
  $('#service-package-select')?.addEventListener('change', persistOutputPrefs);

  $('#analyze-btn').addEventListener('click', () => runAnalyze());
  $('#progress-stop-btn')?.addEventListener('click', () => void stopActiveRun());
  const rerun = () => {
    $('#results-section').hidden = true;
    runAnalyze();
  };
  $('#rerun-btn').addEventListener('click', rerun);
  $('#sticky-rerun-btn')?.addEventListener('click', rerun);
  $('#view-extraction-results-btn')?.addEventListener('click', () => scrollToExtractionResults());
  $('#copy-brief-btn').addEventListener('click', () => copyBrief());
  $('#copy-toolbar-btn').addEventListener('click', () => copyBrief());
  $('#sticky-copy-btn')?.addEventListener('click', () => copyBrief());
  $('#sticky-share-btn')?.addEventListener('click', () => void shareReport());
  $('#post-result-share-btn')?.addEventListener('click', () => void shareReport());
  $('#job-history-refresh-btn')?.addEventListener('click', () => void refreshExtractionJobHistory());
  $('#sticky-upgrade-btn')?.addEventListener('click', () => startBillingCheckout('pro', 'sticky_bar'));
  $('#download-app-banner-btn')?.addEventListener('click', () => {
    showToast('The mobile app is not published yet. Check back here when we announce it.', {
      variant: 'info',
      duration: 3600,
    });
  });
  $('#download-app-back-btn')?.addEventListener('click', () => showDownloadAppPage(false));
  $('#download-images-btn')?.addEventListener('click', () => downloadSiteImagesZip());
  $('#download-manifest-btn')?.addEventListener('click', () => downloadExtractionManifest('manifest'));
  $('#download-images-json-btn')?.addEventListener('click', () => downloadExtractionManifest('images'));
  $('#download-pages-json-btn')?.addEventListener('click', () => downloadExtractionManifest('pages'));
  $('#sticky-download-zip-btn')?.addEventListener('click', () => downloadSiteImagesZip());
  $('#enhance-assets-btn')?.addEventListener('click', () => enhanceSiteAssetsZip());
  $('#sticky-enhance-assets-btn')?.addEventListener('click', () => enhanceSiteAssetsZip());
  $('#download-txt-btn')?.addEventListener('click', () => downloadBriefTxt());
  $('#download-pdf-btn')?.addEventListener('click', () => printBriefPdf());
  $('#copy-cursor-prompt-btn')?.addEventListener('click', () => copyCursorPrompt());

  $('#issues-metric-btn')?.addEventListener('click', () => openIssuesModal());
  $('#modal-issues-close')?.addEventListener('click', () => closeIssuesModal());
  $('#modal-issues')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-issues') closeIssuesModal();
  });
  $('#issues-download-txt-btn')?.addEventListener('click', () => downloadIssuesListTxt());
  $('#issues-apply-fixes-btn')?.addEventListener('click', () => void runReviseBrief());

  $('#url-input')?.addEventListener('input', () => updateFlowWizard());
  $('#url-input-both')?.addEventListener('input', () => updateFlowWizard());

  $('#header-upgrade-btn')?.addEventListener('click', () => openPricingModal('header'));
  $('#header-login-btn')?.addEventListener('click', () => {
    closePricingModal();
    closePaywallModal();
    openLoginModal();
  });
  $('#report-copy-link-btn')?.addEventListener('click', async () => {
    const v = ($('#report-app-link')?.value || '').trim() || getShareableAppUrl();
    if (!v) {
      showToast(
        isProd
          ? 'Public link is not available in this preview. Open the live SiteCloner PRO site to copy a share link.'
          : 'Set VITE_PUBLIC_APP_URL in your build for a production link (localhost is hidden).',
        { variant: 'warning', duration: 4200 }
      );
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
    syncZipButtons({});
    lastAssetsSnapshot = null;
    assetZipDownloadName = 'site-assets.zip';
    fullBriefText = '';
    resetRunSidePanels();
    persistActiveExtractionJob('');
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
    openPricingModal('paywall_see_plans');
  });
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-checkout]');
    if (!t) return;
    e.preventDefault();
    const product = t.getAttribute('data-checkout');
    const explicit = t.getAttribute('data-billing-source');
    const host = t.closest('#modal-paywall');
    const source =
      explicit || (host ? 'paywall_checkout' : 'pricing_checkout');
    if (product) void startBillingCheckout(product, source);
  });
  document.addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-job-open]');
    if (openBtn) {
      e.preventDefault();
      void openExtractionJob(openBtn.getAttribute('data-job-open'));
      return;
    }
    const artifactBtn = e.target.closest('[data-artifact-download]');
    if (artifactBtn) {
      e.preventDefault();
      const artifactName = artifactBtn.getAttribute('data-artifact-download');
      void downloadJobArtifact(lastCompletedJobId, artifactName);
      return;
    }
    const zipBtn = e.target.closest('[data-job-zip]');
    if (!zipBtn) return;
    e.preventDefault();
    const jobId = zipBtn.getAttribute('data-job-zip');
    const zipName = zipBtn.getAttribute('data-zip-name');
    void downloadJobArtifact(jobId, zipName);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#modal-credentials')?.hasAttribute('hidden')) {
      closeCredentialsModal();
      return;
    }
    if (!$('#modal-login')?.hasAttribute('hidden')) {
      closeLoginModal();
      return;
    }
    if (!$('#modal-issues')?.hasAttribute('hidden')) {
      closeIssuesModal();
      return;
    }
    if (!$('#modal-paywall')?.hasAttribute('hidden')) closePaywallModal();
    else if (!$('#modal-pricing')?.hasAttribute('hidden')) closePricingModal();
  });

  loadPersistedPromoCode();
  $('#promo-code-input')?.addEventListener('change', () => {
    persistPromoCodeToStorage(getPromoCodeValue());
    void refreshBillingStatus();
  });
  $('#promo-code-input')?.addEventListener('blur', () => {
    persistPromoCodeToStorage(getPromoCodeValue());
    void refreshBillingStatus();
  });
  $('#paywall-promo-save-btn')?.addEventListener('click', () => {
    const v = ($('#paywall-promo-input')?.value || '').trim().slice(0, 128);
    const main = $('#promo-code-input');
    if (main) main.value = v;
    persistPromoCodeToStorage(v);
    closePaywallModal();
    const det = $('#promo-details');
    if (det && v) det.open = true;
    showToast(
      v ? 'Code saved — tap Generate. For URL + images, select that tab again.' : 'Code cleared from this browser.',
      { variant: 'default', duration: 3400 }
    );
    void refreshBillingStatus();
  });

  handleCheckoutReturnQuery();
  buildTryAnotherChips();
  updatePlanGatedControls();
  void refreshOpenAiServerNotice();
  void refreshBillingStatus();
  void refreshExtractionJobHistory();
  void resumePersistedExtractionJob();
  updateExportGatedControls();
  updateReportChrome();
  trackClientEvent('landing_page_view');

  $('#dfy-open-btn')?.addEventListener('click', () => {
    trackClientEvent('lead_form_opened');
    $('#modal-dfy')?.removeAttribute('hidden');
    document.body.classList.add('paywall-open');
  });
  $('#modal-dfy-close')?.addEventListener('click', () => {
    $('#modal-dfy')?.setAttribute('hidden', '');
    document.body.classList.remove('paywall-open');
  });
  $('#modal-dfy')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-dfy') {
      $('#modal-dfy')?.setAttribute('hidden', '');
      document.body.classList.remove('paywall-open');
    }
  });
  $('#modal-credentials-close')?.addEventListener('click', () => closeCredentialsModal());
  $('#credentials-done-btn')?.addEventListener('click', () => closeCredentialsModal());
  $('#modal-credentials')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-credentials') closeCredentialsModal();
  });
  $('#credentials-copy-email')?.addEventListener('click', async () => {
    const v = ($('#credentials-login-field')?.value || '').trim();
    const ok = await writeClipboard(v);
    showToast(ok ? 'Email copied' : 'Copy failed');
  });
  $('#credentials-copy-password')?.addEventListener('click', async () => {
    const v = ($('#credentials-password-field')?.value || '').trim();
    const ok = await writeClipboard(v);
    showToast(ok ? 'Password copied' : 'Copy failed');
  });

  $('#modal-login-close')?.addEventListener('click', () => closeLoginModal());
  $('#modal-login')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-login') closeLoginModal();
  });
  $('#login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!API_AUTH_LOGIN) {
      showToast('Log in requires API URL and key (same as checkout).');
      return;
    }
    const fd = new FormData(e.target);
    const email = String(fd.get('email') || '').trim();
    const password = String(fd.get('password') || '');
    try {
      const res = await fetch(API_AUTH_LOGIN, {
        method: 'POST',
        headers: billingJsonHeaders(),
        body: JSON.stringify({ login: email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(String(data.error || 'Sign in failed'));
        return;
      }
      if (data.userId && setCloneAiUserId(data.userId)) {
        closeLoginModal();
        e.target.reset();
        showToast('Signed in — your plan limits apply on this device.');
        await refreshBillingStatus();
        return;
      }
      showToast('Invalid response from server');
    } catch {
      showToast('Network error — try again');
    }
  });

  $('#dfy-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!API_LEADS_DFY) {
      showToast('API not configured');
      return;
    }
    const fd = new FormData(e.target);
    const payload = {
      name: String(fd.get('name') || '').trim(),
      email: String(fd.get('email') || '').trim(),
      website: String(fd.get('website') || '').trim(),
      budget: String(fd.get('budget') || '').trim(),
      notes: String(fd.get('notes') || '').trim(),
    };
    try {
      const res = await fetch(API_LEADS_DFY, {
        method: 'POST',
        headers: billingJsonHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'Could not send — try again');
        return;
      }
      showToast('Thanks — we will follow up shortly.');
      e.target.reset();
      $('#modal-dfy')?.setAttribute('hidden', '');
      document.body.classList.remove('paywall-open');
    } catch {
      showToast('Network error — try again');
    }
  });

  showDownloadAppPage(false);
  setTab('url');
  updateDepthEstimate();
  updateFlowWizard();
}

init();
