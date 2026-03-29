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
  const extraPrice = process.env.STRIPE_PRICE_EXTRA_RUN?.trim();

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

    if (product === 'starter' || product === 'pro') {
      const priceId = product === 'starter' ? starterPrice : proPrice;
      if (!priceId) {
        res.status(503).json({ error: `Missing Stripe price for ${product}.` });
        return;
      }
      const plan = product === 'starter' ? PLANS.STARTER : PLANS.PRO;
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${base}/?checkout=success&plan=${plan}`,
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
        const evt = product === 'starter' ? 'starter_checkout_clicked' : 'pro_checkout_clicked';
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
    monthKey: snap.monthKey,
    periodLabel: snap.monthKey,
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
    res.status(400).send(`Webhook Error: ${err.message}`);
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
