import Stripe from 'stripe';
import {
  isBillingEnabled,
  normalizeUserId,
  getUsageSnapshot,
  PLANS,
  applyStripeEvent,
  nextResetIsoFromMonthKey,
  recordCheckoutStarted,
  recordWebhookFailure,
  getAnalyticsSnapshotSync,
  recordProductEvent,
} from './billingService.js';
import { claimSubscriptionAccount, loginWithEmailPassword } from './billingAccounts.js';

const isProdBilling = process.env.NODE_ENV === 'production';

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  return new Stripe(key);
}

function frontendBaseUrl() {
  const u = process.env.FRONTEND_URL?.trim();
  if (u) return u.replace(/\/$/, '');
  return 'http://localhost:5173';
}

/**
 * POST /api/billing/checkout
 * body: { product: 'starter' | 'pro' | 'extra' }
 */
export async function postBillingCheckout(req, res) {
  if (!isBillingEnabled()) {
    res.status(503).json({ error: 'Billing is not enabled on this server.' });
    return;
  }

  const stripe = getStripe();
  if (!stripe) {
    res.status(503).json({ error: 'Stripe is not configured (STRIPE_SECRET_KEY).' });
    return;
  }

  const userId = normalizeUserId(req.get('x-cloneai-user-id'));
  if (!userId) {
    res.status(400).json({ success: false, code: 'MISSING_USER_ID', error: 'MISSING_USER_ID' });
    return;
  }

  const product = String(req.body?.product || '').trim();
  const source = String(req.body?.source || '').trim().slice(0, 120);
  const starterPrice = process.env.STRIPE_PRICE_STARTER?.trim();
  const proPrice = process.env.STRIPE_PRICE_PRO?.trim();
  const powerPrice = process.env.STRIPE_PRICE_POWER?.trim();
  const extraPrice = process.env.STRIPE_PRICE_EXTRA_RUN?.trim();
  const deepExtractPrice = process.env.STRIPE_PRICE_DEEP_EXTRACT?.trim();

  const base = frontendBaseUrl();

  try {
    if (product === 'extra') {
      if (!extraPrice) {
        res.status(503).json({ error: 'Extra-run price is not configured.' });
        return;
      }
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{ price: extraPrice, quantity: 1 }],
        success_url: `${base}/?checkout=success&kind=extra`,
        cancel_url: `${base}/?checkout=cancel`,
        client_reference_id: userId,
        metadata: {
          cloneaiUserId: userId,
          kind: 'extra_run',
        },
        payment_intent_data: {
          metadata: {
            cloneaiUserId: userId,
            kind: 'extra_run',
          },
        },
      });
      await recordCheckoutStarted('extra');
      {
        const snap = await getUsageSnapshot(userId);
        await recordProductEvent(userId, snap.plan, 'extra_run_clicked', { source });
      }
      res.json({ url: session.url });
      return;
    }

    if (product === 'deep_extract') {
      if (!deepExtractPrice) {
        res.status(503).json({ error: 'Deep extraction price is not configured (STRIPE_PRICE_DEEP_EXTRACT).' });
        return;
      }
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{ price: deepExtractPrice, quantity: 1 }],
        success_url: `${base}/?checkout=success&kind=deep_extract`,
        cancel_url: `${base}/?checkout=cancel`,
        client_reference_id: userId,
        metadata: {
          cloneaiUserId: userId,
          kind: 'deep_extract',
        },
        payment_intent_data: {
          metadata: {
            cloneaiUserId: userId,
            kind: 'deep_extract',
          },
        },
      });
      await recordCheckoutStarted('deep_extract');
      {
        const snap = await getUsageSnapshot(userId);
        await recordProductEvent(userId, snap.plan, 'deep_extract_checkout_clicked', { source });
      }
      res.json({ url: session.url });
      return;
    }

    if (product === 'starter' || product === 'pro' || product === 'power') {
      const priceId =
        product === 'starter' ? starterPrice : product === 'pro' ? proPrice : powerPrice;
      if (!priceId) {
        res.status(503).json({ error: `Missing Stripe price for ${product}.` });
        return;
      }
      const plan =
        product === 'starter' ? PLANS.STARTER : product === 'pro' ? PLANS.PRO : PLANS.POWER;
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${base}/?checkout=success&plan=${plan}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/?checkout=cancel`,
        client_reference_id: userId,
        metadata: {
          cloneaiUserId: userId,
          plan,
          priceId,
        },
        subscription_data: {
          metadata: {
            cloneaiUserId: userId,
            plan,
          },
        },
      });
      await recordCheckoutStarted(product);
      {
        const snap = await getUsageSnapshot(userId);
        const evt =
          product === 'starter'
            ? 'starter_checkout_clicked'
            : product === 'pro'
              ? 'pro_checkout_clicked'
              : 'power_checkout_clicked';
        await recordProductEvent(userId, snap.plan, evt, { source });
      }
      res.json({ url: session.url });
      return;
    }

    res.status(400).json({ error: 'Invalid product.' });
  } catch (e) {
    console.error('[billing] checkout error', e?.message || e);
    res.status(502).json({ error: 'Checkout could not be started. Try again.' });
  }
}

/**
 * POST /api/billing/claim-account
 * body: { sessionId } — Stripe Checkout Session id from success URL (subscription only).
 */
export async function postBillingClaimAccount(req, res) {
  if (!isBillingEnabled()) {
    res.status(503).json({ error: 'Billing is not enabled on this server.' });
    return;
  }

  const stripe = getStripe();
  if (!stripe) {
    res.status(503).json({ error: 'Stripe is not configured (STRIPE_SECRET_KEY).' });
    return;
  }

  const userId = normalizeUserId(req.get('x-cloneai-user-id'));
  if (!userId) {
    res.status(400).json({ success: false, code: 'MISSING_USER_ID', error: 'MISSING_USER_ID' });
    return;
  }

  const sessionId = String(req.body?.sessionId || '').trim();
  try {
    const out = await claimSubscriptionAccount(stripe, sessionId, userId);
    if (!out.ok) {
      const code = out.code || 'CLAIM_FAILED';
      const status =
        code === 'SESSION_USER_MISMATCH' || code === 'NOT_SUBSCRIPTION' || code === 'EMAIL_MISMATCH'
          ? 403
          : code === 'PLAN_PENDING'
            ? 409
            : 400;
      res.status(status).json({ success: false, code, error: out.error });
      return;
    }
    if (out.alreadyDelivered) {
      res.json({ success: true, alreadyDelivered: true, login: out.login });
      return;
    }
    res.json({ success: true, login: out.login, password: out.password });
  } catch (e) {
    console.error('[billing] claim-account error', e?.message || e);
    res.status(500).json({ success: false, error: 'Could not complete account setup.' });
  }
}

/**
 * POST /api/auth/login
 * body: { login or email, password }
 */
export async function postAuthLogin(req, res) {
  if (!isBillingEnabled()) {
    res.status(503).json({ error: 'Billing is not enabled on this server.' });
    return;
  }

  const login = String(req.body?.login || req.body?.email || '').trim();
  const password = String(req.body?.password || '');

  try {
    const out = await loginWithEmailPassword(login, password);
    if (!out.ok) {
      res.status(401).json({ success: false, code: out.code, error: out.error });
      return;
    }
    res.json({ success: true, userId: out.userId });
  } catch (e) {
    console.error('[auth] login error', e?.message || e);
    res.status(500).json({ success: false, error: 'Login failed.' });
  }
}

export async function getBillingStatus(req, res) {
  if (!isBillingEnabled()) {
    res.json({
      enabled: false,
      plan: null,
      limit: null,
      used: null,
      remaining: null,
      bonusRuns: null,
    });
    return;
  }

  const userId = normalizeUserId(req.get('x-cloneai-user-id'));
  if (!userId) {
    res.status(400).json({ success: false, code: 'MISSING_USER_ID', error: 'MISSING_USER_ID' });
    return;
  }

  const snap = await getUsageSnapshot(userId);
  const nextResetAt =
    snap.plan === PLANS.FREE ? null : nextResetIsoFromMonthKey(snap.monthKey);
  res.json({
    enabled: true,
    plan: snap.plan,
    limit: snap.limit,
    used: snap.used,
    usedThisPeriod: snap.runsThisMonth,
    remaining: snap.remaining,
    bonusRuns: snap.bonusRuns,
    usageResetAt: nextResetAt,
    stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY?.trim()),
  });
}

export function getBillingAnalytics(req, res) {
  if (!isBillingEnabled()) {
    res.status(503).json({ error: 'Billing is not enabled.' });
    return;
  }
  res.json(getAnalyticsSnapshotSync());
}

/**
 * Express handler: raw body required.
 */
export async function postStripeWebhook(req, res) {
  if (!isBillingEnabled()) {
    res.status(503).send('billing disabled');
    return;
  }

  const stripe = getStripe();
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!stripe || !whSecret) {
    console.error('[billing] webhook misconfigured');
    res.status(503).send('misconfigured');
    return;
  }

  const sig = req.get('stripe-signature');
  if (!sig) {
    res.status(400).send('missing signature');
    return;
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
  } catch (err) {
    console.warn('[billing] webhook signature failed', err.message);
    res.status(400).send(isProdBilling ? 'Invalid webhook signature.' : `Webhook Error: ${err.message}`);
    return;
  }

  try {
    const out = await applyStripeEvent(event);
    if (out.duplicate) {
      res.json({ received: true, duplicate: true });
      return;
    }
    res.json({ received: true, ...out });
  } catch (e) {
    console.error('[billing] webhook handler error', e);
    logEvent('error', 'stripe_webhook_handler_failed', {
      detail: String(e?.message || e),
    });
    await recordWebhookFailure();
    res.status(500).send('handler error');
  }
}

function logEvent(level, msg, extra = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...extra,
    })
  );
}
