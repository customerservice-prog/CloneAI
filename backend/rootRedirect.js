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
 * @param {import('express').Request} req
 * @param {string} frontRaw
 * @param {string} staticAppRaw STATIC_APP_URL or WEB_APP_PUBLIC_URL
 */
export function redirectTargetWhenFrontendHostHitsApi(req, frontRaw, staticAppRaw) {
  const staticBase = normalizePublicAppBase(staticAppRaw);
  if (!staticBase) return null;
  const frontHost = frontendHostnameFromEnv(frontRaw);
  const reqHost = normalizeHostLabel(req.hostname || req.get('host'));
  if (!frontHost || !reqHost || frontHost !== reqHost) return null;
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
  const frontHost = frontendHostnameFromEnv(frontRaw);
  const reqHost = normalizeHostLabel(req.hostname || req.get('host'));
  if (!frontHost || !reqHost || frontHost !== reqHost) return null;
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
  'FRONTEND_URL hostname matches this request Host — point DNS apex at your static site (cloneai-web), or set STATIC_APP_URL on this service to your SPA’s public URL (e.g. https://cloneai-web.onrender.com) until DNS is fixed.';

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Browser-friendly page when GET / hits the API (avoids raw JSON for humans at a misconfigured apex).
 */
export function formatRootLandingHtml({ hint, frontendUrl }) {
  const hintHtml = hint ? `<p class="hint">${escapeHtml(hint)}</p>` : '';
  const front = String(frontendUrl || '').trim().replace(/\/$/, '');
  const tryLink =
    front && !hint
      ? `<p><a class="btn" href="${escapeHtml(front)}/">Open the CloneAI app</a></p>`
      : hint
        ? '<p><strong>Note:</strong> A link to your marketing URL would just reload this page until DNS or <code>STATIC_APP_URL</code> / <code>APEX_STATIC_FALLBACK_URL</code> is fixed.</p>'
        : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CloneAI API</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #111; }
    .hint { background: #f4f4f5; padding: 1rem; border-radius: 8px; font-size: 0.95rem; }
    .btn { display: inline-block; margin-top: 0.5rem; padding: 0.6rem 1.2rem; background: #111; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; }
    code { font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>CloneAI</h1>
  <p>This URL is the <strong>API</strong>. The web app is a separate host on Render (<code>cloneai-web</code>) or your static provider.</p>
  ${tryLink}
  ${hintHtml}
  <p>API health: <a href="/api/health"><code>/api/health</code></a> · JSON metadata: same URL with <code>Accept: application/json</code> (or add <code>?format=json</code>).</p>
</body>
</html>`;
}

/**
 * @param {import('express').Request} req
 * @param {{ frontendUrl?: string, staticAppUrl?: string, apexStaticFallbackUrl?: string }} opts
 * @returns {{ kind: 'redirect'; status: number; location: string } | { kind: 'json'; hint?: string }}
 */
export function resolveRootGet(req, opts = {}) {
  const front = String(opts.frontendUrl || '').trim();
  const staticRaw = String(opts.staticAppUrl || '').trim();
  const apexFallbackRaw = String(opts.apexStaticFallbackUrl || '').trim();
  const accept = String(req.get('accept') || '');
  const wantsBrowserDoc = acceptLooksLikeBrowserNavigation(accept);

  const staticFallback = redirectTargetWhenFrontendHostHitsApi(req, front, staticRaw);
  if (staticFallback && wantsBrowserDoc) {
    return { kind: 'redirect', status: 302, location: staticFallback };
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
    !staticFallback &&
    !target &&
    front &&
    wantsBrowserDoc &&
    !normalizePublicAppBase(staticRaw)
      ? JSON_HINT
      : undefined;

  return { kind: 'json', hint };
}
