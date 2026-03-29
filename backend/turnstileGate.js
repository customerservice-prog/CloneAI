/**
 * Optional Cloudflare Turnstile: after the first successful analyze per client IP,
 * subsequent runs require a valid token when TURNSTILE_SECRET_KEY is set.
 */

const successCountByIp = new Map();
const MAX_TRACKED_IPS = 25000;

export function getSuccessfulAnalyzeCountForIp(ip) {
  if (!ip || ip === 'unknown') return 0;
  return successCountByIp.get(ip) || 0;
}

export function noteSuccessfulAnalyzeForCaptcha(ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret || !ip || ip === 'unknown') return;
  const n = (successCountByIp.get(ip) || 0) + 1;
  successCountByIp.set(ip, Math.min(n, 10_000));
  while (successCountByIp.size > MAX_TRACKED_IPS) {
    const first = successCountByIp.keys().next().value;
    successCountByIp.delete(first);
  }
}

export function captchaRequiredForAnalyze(ip) {
  if (!process.env.TURNSTILE_SECRET_KEY?.trim()) return false;
  return getSuccessfulAnalyzeCountForIp(ip) >= 1;
}

export async function verifyTurnstileIfConfigured(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return { ok: true, skipped: true };

  const t = String(token || '').trim();
  if (!t) {
    return { ok: false, error: 'Human verification required. Refresh and complete the check, then try again.' };
  }

  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', t);
  if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: ac.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (data.success === true) return { ok: true };
    return { ok: false, error: 'Human verification failed. Try again.' };
  } catch {
    return { ok: false, error: 'Verification service unavailable. Try again shortly.' };
  } finally {
    clearTimeout(timer);
  }
}
