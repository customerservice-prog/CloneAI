export const DEFAULT_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://[::1]:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://[::1]:4173',
];

export function isLocalDevBrowserOrigin(origin) {
  try {
    const u = new URL(origin);
    return (
      u.protocol === 'http:' &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1')
    );
  } catch {
    return false;
  }
}

export function isServedFromSameOrigin(reqLike, origin) {
  try {
    const incoming = new URL(String(origin || '').trim());
    const forwardedProto = String(reqLike?.get?.('x-forwarded-proto') || '')
      .trim()
      .split(',')[0];
    const proto = (forwardedProto ||
      reqLike?.protocol ||
      incoming.protocol.replace(':', '') ||
      'http'
    ).replace(/:$/, '');
    const host = String(reqLike?.get?.('x-forwarded-host') || reqLike?.get?.('host') || '')
      .trim()
      .split(',')[0];
    if (!host) return false;
    return incoming.host === host && incoming.protocol === `${proto}:`;
  } catch {
    return false;
  }
}

export function parseCorsOrigins(rawValue, { isProd = false } = {}) {
  const raw = String(rawValue || '').trim();
  if (!raw) return isProd ? [] : DEFAULT_DEV_ORIGINS;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((origin) => origin !== '*');
}

/**
 * If CORS_ORIGINS is empty in production, build an allowlist from canonical URL env (Stripe / Vite bake).
 * Adds apex + www for each host so dashboard drift on CORS alone does not break browsers.
 * @returns {string[]}
 */
export function deriveProductionCorsOriginsFromEnv() {
  const keys = [
    'FRONTEND_URL',
    'PUBLIC_APP_URL',
    'VITE_PUBLIC_APP_URL',
    'VITE_API_URL',
    'RENDER_EXTERNAL_URL',
  ];
  const origins = new Set();
  for (const k of keys) {
    const raw = String(process.env[k] || '').trim();
    if (!raw) continue;
    try {
      const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
      const proto = u.protocol;
      const host = u.hostname.toLowerCase();
      if (!host) continue;
      origins.add(`${proto}//${host}`);
      if (host.startsWith('www.')) {
        const bare = host.slice(4);
        if (bare) origins.add(`${proto}//${bare}`);
      } else {
        origins.add(`${proto}//www.${host}`);
      }
    } catch {
      /* skip */
    }
  }
  return [...origins].sort();
}

export function shouldAllowBrowserOrigin({
  isProd = false,
  relaxOriginCheck = false,
  serveSpa = false,
  origin = '',
  corsOrigins = [],
  reqLike = null,
} = {}) {
  if (!isProd || relaxOriginCheck) return true;
  if (serveSpa && origin && isServedFromSameOrigin(reqLike, origin)) return true;
  if (!origin) return false;
  return Array.isArray(corsOrigins) && corsOrigins.includes(origin);
}
