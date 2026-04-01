/**
 * GET / resolution: redirect browsers to the SPA when DNS points the marketing host at the API.
 */

export function normalizeHostLabel(h) {
  return String(h || '')
    .split(':')[0]
    .toLowerCase()
    .replace(/\.$/, '');
}

/** @param {import('express').Request} req */
export function requestPublicOrigin(req) {
  const rawProto = String(req.protocol || '').replace(/:$/, '');
  const proto = rawProto === 'https' || rawProto === 'http' ? rawProto : 'https';
  const host = normalizeHostLabel(req.hostname || req.get('host'));
  if (!host) return null;
  return `${proto}://${host}`;
}

/**
 * @param {import('express').Request} req
 * @param {string} frontRaw
 * @returns {string | null}
 */
export function browserSafeFrontendRedirectTarget(req, frontRaw) {
  const trimmed = String(frontRaw || '').trim().replace(/\/$/, '');
  if (!trimmed) return null;
  let u;
  try {
    u = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const targetOrigin = u.origin;
  const incomingOrigin = requestPublicOrigin(req);
  if (incomingOrigin && incomingOrigin === targetOrigin) return null;

  const targetHost = normalizeHostLabel(u.hostname);
  const fromHostname = normalizeHostLabel(req.hostname);
  const fromHostHeader = normalizeHostLabel(req.get('host'));
  if (
    targetHost &&
    ((fromHostname && fromHostname === targetHost) || (fromHostHeader && fromHostHeader === targetHost))
  ) {
    return null;
  }
  return `${targetOrigin}/`;
}

export function normalizePublicAppBase(raw) {
  const s = String(raw || '').trim().replace(/\/$/, '');
  if (!s) return '';
  try {
    const u = new URL(s.includes('://') ? s : `https://${s}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

/** Built-in SPA origin when apex hits the API but Render env vars were never synced (override with CLONEAI_SITECLONER_STATIC_URL). */
const SITECLONER_STATIC_DEFAULT = 'https://cloneai-web.onrender.com';
const SITECLONER_MARKETING_HOST_TO_STATIC = {
  'siteclonerpro.com': SITECLONER_STATIC_DEFAULT,
  'www.siteclonerpro.com': SITECLONER_STATIC_DEFAULT,
};

/**
 * Fill STATIC_APP_URL / APEX fallbacks when the dashboard omitted them but the request host is a known marketing domain.
 * @param {string | undefined} reqHost
 * @param {string} staticRaw
 * @param {string} apexRaw
 * @returns {{ staticAppUrl: string, apexStaticFallbackUrl: string }}
 */
export function mergeStaticEnvWithSiteDefaults(reqHost, staticRaw, apexRaw) {
  let s = String(staticRaw || '').trim();
  let a = String(apexRaw || '').trim();
  const h = normalizeHostLabel(reqHost || '');
  const envDefault = (process.env.CLONEAI_DEFAULT_STATIC_APP_URL || '').trim();
  if (!s && envDefault) s = envDefault;
  if (!a && envDefault) a = envDefault;

  const custom = (process.env.CLONEAI_SITECLONER_STATIC_URL || '').trim();
  const hostFallback = custom || SITECLONER_MARKETING_HOST_TO_STATIC[h] || '';
  if (!s && hostFallback) s = hostFallback;
  if (!a && hostFallback) a = hostFallback;

  return { staticAppUrl: s, apexStaticFallbackUrl: a };
}

/**
 * Redirect browsers on known Site Cloner Pro marketing hosts to the static SPA when a static base is known
 * (even if FRONTEND_URL is unset — common Render dashboard drift).
 */
export function redirectKnownMarketingApexToStatic(req, staticAppRaw) {
  const staticBase = normalizePublicAppBase(staticAppRaw);
  if (!staticBase) return null;
  const reqHost = normalizeHostLabel(req.hostname || req.get('host'));
  if (!SITECLONER_MARKETING_HOST_TO_STATIC[reqHost]) return null;
  const incoming = requestPublicOrigin(req);
  if (incoming && staticBase === incoming) return null;
  return `${staticBase}/`;
}

export function frontendHostnameFromEnv(frontRaw) {
  const trimmed = String(frontRaw || '').trim().replace(/\/$/, '');
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return normalizeHostLabel(u.hostname);
  } catch {
    return '';
  }
}

/**
 * True when the request host is the FRONTEND_URL host or its www / bare apex pair
 * (e.g. FRONTEND_URL=https://www.example.com and request Host is example.com).
 */
export function frontendMarketingHostMatches(reqHost, frontRaw) {
  const frontHost = frontendHostnameFromEnv(frontRaw);
  if (!frontHost || !reqHost) return false;
  if (reqHost === frontHost) return true;
  if (frontHost.startsWith('www.')) {
    const bare = frontHost.slice(4);
    return reqHost === bare;
  }
  return reqHost === `www.${frontHost}`;
}

/**
 * @param {import('express').Request} req
 * @param {string} frontRaw
 * @param {string} staticAppRaw STATIC_APP_URL or WEB_APP_PUBLIC_URL
 */
export function redirectTargetWhenFrontendHostHitsApi(req, frontRaw, staticAppRaw) {
  const staticBase = normalizePublicAppBase(staticAppRaw);
  if (!staticBase) return null;
  const reqHost = normalizeHostLabel(req.hostname || req.get('host'));
  if (!frontendMarketingHostMatches(reqHost, frontRaw)) return null;
  const incoming = requestPublicOrigin(req);
  if (incoming && staticBase === incoming) return null;
  return `${staticBase}/`;
}

/**
 * True when `reqHost` matches any origin in CORS_ORIGINS (comma-separated URLs or hostnames).
 * Used so GET / can redirect custom domains listed for browser API access even if FRONTEND_URL is wrong or unset.
 */
export function hostInCorsOriginsList(reqHost, corsOriginsRaw) {
  const h = normalizeHostLabel(reqHost);
  if (!h || !corsOriginsRaw) return false;
  for (const part of String(corsOriginsRaw).split(',')) {
    const t = part.trim();
    if (!t) continue;
    try {
      const u = new URL(t.includes('://') ? t : `https://${t}`);
      if (normalizeHostLabel(u.hostname) === h) return true;
    } catch {
      /* skip invalid entry */
    }
  }
  return false;
}

/**
 * Redirect browsers to STATIC_APP_URL when the request Host is an allowed CORS browser origin
 * but not already the static app host (covers production if FRONTEND_URL does not match the apex).
 */
export function redirectTargetWhenCorsHostHitsStatic(req, staticAppRaw, corsOriginsRaw) {
  const staticBase = normalizePublicAppBase(staticAppRaw);
  if (!staticBase) return null;
  let staticHost = '';
  try {
    staticHost = normalizeHostLabel(new URL(staticBase).hostname);
  } catch {
    return null;
  }
  const reqHost = normalizeHostLabel(req.hostname || req.get('host'));
  if (!reqHost || reqHost === staticHost) return null;
  if (!hostInCorsOriginsList(reqHost, corsOriginsRaw)) return null;
  const incoming = requestPublicOrigin(req);
  if (incoming && staticBase === incoming) return null;
  return `${staticBase}/`;
}

/**
 * When apex DNS points at the API but `www` (or another host) points at the static SPA, redirect there.
 * Set APEX_STATIC_FALLBACK_URL e.g. to https://www.siteclonerpro.com on the API service.
 */
export function apexMismatchRedirectTarget(req, frontRaw, apexFallbackRaw) {
  const apexBase = normalizePublicAppBase(apexFallbackRaw);
  if (!apexBase) return null;
  const reqHost = normalizeHostLabel(req.hostname || req.get('host'));
  if (!frontendMarketingHostMatches(reqHost, frontRaw)) return null;
  let fallbackHost;
  try {
    fallbackHost = normalizeHostLabel(new URL(apexBase).hostname);
  } catch {
    return null;
  }
  if (!fallbackHost || fallbackHost === reqHost) return null;
  const incoming = requestPublicOrigin(req);
  if (incoming && apexBase === incoming) return null;
  return `${apexBase}/`;
}

export function acceptLooksLikeBrowserNavigation(accept) {
  const a = String(accept || '').toLowerCase();
  if (!a) return true;
  if (a.includes('text/html')) return true;
  if (a.includes('*/*')) return true;
  if (a.startsWith('application/json')) return false;
  return true;
}

const JSON_HINT =
  'This hostname matches FRONTEND_URL, but this response is from the API (no embedded web app here). Set STATIC_APP_URL on this service, move DNS, or use the monolith Dockerfile — see steps below.';

/** Bare apex like `example.com` → `https://www.example.com/` (not `www.` or multi-label hosts like `app.example.com`). */
export function bareApexWwwTryUrl(reqHost) {
  const h = normalizeHostLabel(reqHost || '');
  if (!h || h.startsWith('www.')) return '';
  if (h.split('.').length !== 2) return '';
  try {
    return new URL(`https://www.${h}/`).href;
  } catch {
    return '';
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Browser-friendly page when GET / hits the API (avoids raw JSON for humans at a misconfigured apex).
 * @param {{ hint?: string, frontendUrl?: string | null, staticAppUrl?: string | null, apexStaticFallbackUrl?: string | null, requestHost?: string | null }} opts
 */
export function formatRootLandingHtml({
  hint,
  frontendUrl,
  staticAppUrl,
  apexStaticFallbackUrl,
  requestHost,
}) {
  const frontRaw = String(frontendUrl || '').trim().replace(/\/$/, '');
  const frontOrigin = normalizePublicAppBase(frontRaw);
  let frontHost = '';
  if (frontOrigin) {
    try {
      frontHost = normalizeHostLabel(new URL(frontOrigin).hostname);
    } catch {
      frontHost = '';
    }
  }
  const reqH = normalizeHostLabel(requestHost || '');
  const staticBase = normalizePublicAppBase(String(staticAppUrl || '').trim());
  const apexBase = normalizePublicAppBase(String(apexStaticFallbackUrl || '').trim());
  let apexHost = '';
  if (apexBase) {
    try {
      apexHost = normalizeHostLabel(new URL(apexBase).hostname);
    } catch {
      apexHost = '';
    }
  }

  const staticBtn = staticBase
    ? `<p><a class="btn" rel="noopener noreferrer" href="${escapeHtml(staticBase)}/">Open the CloneAI web app (${escapeHtml(staticBase.replace(/^https?:\/\//, ''))})</a></p>`
    : '';
  const apexBtn =
    apexBase && apexHost && reqH && apexHost !== reqH
      ? `<p><a class="btn" rel="noopener noreferrer" href="${escapeHtml(apexBase)}/">Open the CloneAI web app (${escapeHtml(apexBase.replace(/^https?:\/\//, ''))})</a></p>`
      : '';
  const marketingBtn =
    frontOrigin && frontHost && reqH && frontHost !== reqH
      ? `<p><a class="btn" rel="noopener noreferrer" href="${escapeHtml(frontOrigin)}/">Open the CloneAI web app (${escapeHtml(frontOrigin.replace(/^https?:\/\//, ''))})</a></p>`
      : '';
  const wwwTryUrl = hint && reqH ? bareApexWwwTryUrl(reqH) : '';
  const wwwTryBlock = wwwTryUrl
    ? `<p class="www-try">If the app is on <strong>www</strong>, use <a class="btn btn-outline" rel="noopener noreferrer" href="${escapeHtml(wwwTryUrl)}">https://www.${escapeHtml(reqH)}/</a></p>`
    : '';
  const deployHelp =
    hint && !staticBase
      ? `<div class="deploy-help">
  <p class="hint">${escapeHtml(hint)}</p>
  <p class="fix-lead"><strong>Do one of the following:</strong></p>
  <ol class="fix-steps">
    <li><strong>Render (fastest):</strong> Dashboard → <code>cloneai-api</code> → Environment → set <code>STATIC_APP_URL</code> to your static site (e.g. <code>https://cloneai-web.onrender.com</code>) → Save → <strong>Manual Deploy</strong>. Reloading this URL should redirect to the app.</li>
    <li><strong>DNS:</strong> Point the apex (or this hostname) at your <strong>static</strong> service (<code>cloneai-web</code>) instead of the API, if visitors should load the SPA directly.</li>
    <li><strong>Monolith:</strong> Deploy the repo-root <code>Dockerfile</code> so the image includes <code>public/index.html</code>; one service can serve both API and SPA.</li>
  </ol>
</div>`
      : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CloneAI API</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.55; color: #111; }
    .hint { background: #f4f4f5; padding: 1rem; border-radius: 8px; font-size: 0.95rem; margin: 0 0 1rem; }
    .deploy-help { margin: 1rem 0 1.25rem; }
    .fix-lead { margin: 0 0 0.35rem; font-size: 0.95rem; }
    .fix-steps { margin: 0; padding-left: 1.25rem; font-size: 0.92rem; }
    .fix-steps li { margin: 0.5rem 0; }
    .btn { display: inline-block; margin-top: 0.5rem; padding: 0.6rem 1.2rem; background: #111; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; }
    .btn-outline { background: #fff; color: #111; border: 2px solid #111; }
    .www-try { font-size: 0.95rem; }
    .json-links { font-size: 0.92rem; margin-top: 1rem; }
    .json-links a { color: #1d4ed8; font-weight: 600; }
    code { font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>CloneAI</h1>
  <p>This URL is the <strong>API</strong>. The web app is usually on Render <code>cloneai-web</code>, bundled with the API (monolith image), or another static host.</p>
  ${staticBtn}
  ${apexBtn}
  ${marketingBtn}
  ${wwwTryBlock}
  ${deployHelp}
  <p>API health: <a href="/api/health"><code>/api/health</code></a> returns JSON (<code>status</code>, <code>openaiConfigured</code>).</p>
  <p class="json-links">For JSON for <strong>this page</strong> (<code>GET /</code>) instead of HTML: <a href="/?format=json">Open <code>/?format=json</code></a> or send header <code>Accept: application/json</code>.</p>
</body>
</html>`;
}

/**
 * @param {import('express').Request} req
 * @param {{ frontendUrl?: string, staticAppUrl?: string, apexStaticFallbackUrl?: string, corsOrigins?: string }} opts
 * @returns {{ kind: 'redirect'; status: number; location: string } | { kind: 'json'; hint?: string }}
 */
export function resolveRootGet(req, opts = {}) {
  const front = String(opts.frontendUrl || '').trim();
  const staticRaw = String(opts.staticAppUrl || '').trim();
  const apexFallbackRaw = String(opts.apexStaticFallbackUrl || '').trim();
  const corsOrigins = String(opts.corsOrigins || '').trim();
  const accept = String(req.get('accept') || '');
  const formatJson = String(req.query?.format || '').toLowerCase() === 'json';
  const wantsBrowserDoc = !formatJson && acceptLooksLikeBrowserNavigation(accept);

  const knownApex = redirectKnownMarketingApexToStatic(req, staticRaw);
  if (knownApex && wantsBrowserDoc) {
    return { kind: 'redirect', status: 302, location: knownApex };
  }

  const staticFallback = redirectTargetWhenFrontendHostHitsApi(req, front, staticRaw);
  if (staticFallback && wantsBrowserDoc) {
    return { kind: 'redirect', status: 302, location: staticFallback };
  }

  const corsStaticFallback = redirectTargetWhenCorsHostHitsStatic(req, staticRaw, corsOrigins);
  if (corsStaticFallback && wantsBrowserDoc) {
    return { kind: 'redirect', status: 302, location: corsStaticFallback };
  }

  const apexRedir = apexMismatchRedirectTarget(req, front, apexFallbackRaw);
  if (apexRedir && wantsBrowserDoc) {
    return { kind: 'redirect', status: 302, location: apexRedir };
  }

  const target = browserSafeFrontendRedirectTarget(req, front);
  if (target && wantsBrowserDoc) {
    return { kind: 'redirect', status: 301, location: target };
  }

  const hint =
    !knownApex &&
    !staticFallback &&
    !corsStaticFallback &&
    !target &&
    front &&
    wantsBrowserDoc &&
    !normalizePublicAppBase(staticRaw)
      ? JSON_HINT
      : undefined;

  return { kind: 'json', hint };
}
