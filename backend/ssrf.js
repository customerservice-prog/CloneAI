import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_HOSTNAMES = new Set(
  ['metadata.google.internal', 'metadata.goog', 'instance-data.ec2.internal'].map((h) => h.toLowerCase())
);

function ipv4ToInt(ip) {
  const p = ip.split('.').map((x) => Number(x));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0);
}

export function isUnsafeIPv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  const a = n >>> 24;
  const b = (n >>> 16) & 0xff;
  const c = (n >>> 8) & 0xff;
  if (a === 0 || a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 255) return true;
  return false;
}

/** IPv6: loopback, ULA, link-local, IPv4-mapped private */
export function isUnsafeIPv6(ip) {
  const norm = ip.toLowerCase();
  if (norm === '::1') return true;
  if (norm.startsWith('fe80:')) return true;
  if (norm.startsWith('fc') || norm.startsWith('fd')) return true;
  if (norm.startsWith('::ffff:')) {
    const v4 = norm.slice(7);
    const tail = v4.includes('%') ? v4.split('%')[0] : v4;
    return isUnsafeIPv4(tail);
  }
  return false;
}

export function isUnsafeIpLiteral(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return isUnsafeIPv4(ip);
  if (fam === 6) return isUnsafeIPv6(ip);
  return true;
}

async function resolveAllAddresses(hostname) {
  const out = [];
  try {
    out.push(...(await dns.resolve4(hostname)));
  } catch (e) {
    if (e.code !== 'ENOTFOUND' && e.code !== 'ENODATA') throw e;
  }
  try {
    out.push(...(await dns.resolve6(hostname)));
  } catch (e) {
    if (e.code !== 'ENOTFOUND' && e.code !== 'ENODATA') throw e;
  }
  return out;
}

/**
 * Returns { ok: true } if URL is safe for server-side HTTP fetch (SSRF mitigation).
 * Blocks private/link-local/metadata targets and hostnames that resolve to them.
 */
export async function assertUrlSafeForServerFetch(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { ok: false, error: 'Invalid URL format.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only http and https URLs are allowed.' };
  }

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.internal')) {
    return { ok: false, error: 'That host is not allowed.' };
  }

  if (net.isIP(host)) {
    if (isUnsafeIpLiteral(host)) {
      return { ok: false, error: 'That address is not allowed.' };
    }
    return { ok: true };
  }

  let addrs;
  try {
    addrs = await resolveAllAddresses(host);
  } catch (e) {
    return { ok: false, error: 'Could not resolve that hostname.' };
  }
  if (!addrs.length) {
    return { ok: false, error: 'Could not resolve that hostname.' };
  }
  for (const ip of addrs) {
    if (isUnsafeIpLiteral(ip)) {
      return { ok: false, error: 'That hostname resolves to a blocked network range.' };
    }
  }
  return { ok: true };
}
