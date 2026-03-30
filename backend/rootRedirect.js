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

/**
 * @param {import('express').Request} req
 * @param {{ frontendUrl?: string, staticAppUrl?: string }} opts
 * @returns {{ kind: 'redirect'; status: number; location: string } | { kind: 'json'; hint?: string }}
 */
export function resolveRootGet(req, opts = {}) {
  const front = String(opts.frontendUrl || '').trim();
  const staticRaw = String(opts.staticAppUrl || '').trim();
  const accept = String(req.get('accept') || '');
  const wantsBrowserDoc = acceptLooksLikeBrowserNavigation(accept);

  const staticFallback = redirectTargetWhenFrontendHostHitsApi(req, front, staticRaw);
  if (staticFallback && wantsBrowserDoc) {
    return { kind: 'redirect', status: 302, location: staticFallback };
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
