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
