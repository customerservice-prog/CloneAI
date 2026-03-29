import { normalizeUserId } from './billingService.js';

const slots = new Map();

export const ANALYZE_MAX_CONCURRENT_PER_USER = Math.min(
  5,
  Math.max(1, Number(process.env.ANALYZE_MAX_CONCURRENT_PER_USER) || 1)
);

/**
 * @param {string | undefined} userIdHeader
 * @param {string} ip
 * @returns {{ ok: true, key: string } | { ok: false }}
 */
export function tryAcquireAnalyzeSlot(userIdHeader, ip) {
  const uid = normalizeUserId(userIdHeader);
  const key = uid || `ip:${String(ip || 'unknown').slice(0, 64)}`;
  const n = slots.get(key) || 0;
  if (n >= ANALYZE_MAX_CONCURRENT_PER_USER) {
    return { ok: false };
  }
  slots.set(key, n + 1);
  return { ok: true, key };
}

/** @param {string | null | undefined} key */
export function releaseAnalyzeSlot(key) {
  if (!key) return;
  const n = (slots.get(key) || 1) - 1;
  if (n <= 0) slots.delete(key);
  else slots.set(key, n);
}
