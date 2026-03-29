import { timingSafeEqual } from 'node:crypto';

const MAX_LEN = 128;

export function configuredPromoCode() {
  const s = process.env.CLONEAI_PROMO_CODE?.trim();
  return s ? s.slice(0, MAX_LEN) : '';
}

/** Header values are trimmed; body `promoCode` is not trimmed (exact length for timing-safe match). */
export function submittedPromoCode(req) {
  const h = req.get('x-cloneai-promo-code');
  if (h && String(h).trim()) return String(h).trim().slice(0, MAX_LEN);
  const b = req.body?.promoCode ?? req.body?.promo_code ?? '';
  return String(b).slice(0, MAX_LEN);
}

/**
 * Constant-time compare. Only true when CLONEAI_PROMO_CODE is set and matches exactly.
 */
export function promoMatchesRequest(req) {
  const expected = configuredPromoCode();
  if (!expected) return false;
  const sent = submittedPromoCode(req);
  if (!sent) return false;
  try {
    const a = Buffer.from(sent, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
