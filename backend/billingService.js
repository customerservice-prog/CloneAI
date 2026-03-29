import { withBillingLock, loadState, saveState, defaultAnalytics } from './billingStore.js';

export const PLANS = {
  FREE: 'free',
  STARTER: 'starter',
  PRO: 'pro',
};

/** @typedef {{ plan: string, freeRunsUsed: number, monthKey: string, runsThisMonth: number, bonusRuns: number, stripeCustomerId?: string, stripeSubscriptionId?: string, stripePriceId?: string, createdAt?: string, updatedAt?: string }} UserRow */

const FREE_LIFETIME_MAX = 1;
const STARTER_MONTHLY = 10;
const PRO_MONTHLY = 50;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isBillingEnabled() {
  return String(process.env.BILLING_ENABLED || '').toLowerCase() === 'true';
}

export function normalizeUserId(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 64) return null;
  if (!UUID_RE.test(s)) return null;
  return s.toLowerCase();
}

function monthKeyUtc(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

function rollMonth(u) {
  const key = monthKeyUtc();
  if (u.monthKey !== key) {
    u.monthKey = key;
    u.runsThisMonth = 0;
  }
}

/** @returns {UserRow} */
function defaultUser() {
  const now = new Date().toISOString();
  return {
    plan: PLANS.FREE,
    freeRunsUsed: 0,
    monthKey: monthKeyUtc(),
    runsThisMonth: 0,
    bonusRuns: 0,
    createdAt: now,
  };
}

function ensureUser(state, userId) {
  if (!state.users[userId]) {
    state.users[userId] = defaultUser();
  } else if (!state.users[userId].createdAt) {
    state.users[userId].createdAt =
      state.users[userId].updatedAt || new Date().toISOString();
  }
  return state.users[userId];
}

/**
 * Server-side feature gate for /api/analyze (plan is authoritative; never trust the client).
 * @param {string} plan
 * @param {{ hasUrl: boolean, imageCount: number, depth: string }} input
 * @returns {{ ok: true } | { ok: false, code: 'FEATURE_LOCKED', message: string, feature: string }}
 */
export function evaluateAnalyzeFeatureGate(plan, input) {
  const p = plan || PLANS.FREE;
  const hasUrl = Boolean(input?.hasUrl);
  const imageCount = Math.max(0, Number(input?.imageCount) || 0);
  const depth = String(input?.depth || 'homepage').trim();
  const combo = hasUrl && imageCount > 0;

  if (p === PLANS.FREE) {
    if (combo) {
      return {
        ok: false,
        code: 'FEATURE_LOCKED',
        feature: 'combo',
        message:
          'Combining a URL with screenshots requires Starter or Pro. Use URL only or images only on Free, or upgrade.',
        upgradeHint: true,
      };
    }
    return { ok: true };
  }

  if (p === PLANS.STARTER) {
    if (depth === 'deep') {
      return {
        ok: false,
        code: 'FEATURE_LOCKED',
        feature: 'full_crawl',
        message:
          'Full-site crawl (100+ pages) is a Pro feature. Starter includes balanced multi-page scans (~25 pages).',
        upgradeHint: true,
      };
    }
    return { ok: true };
  }

  return { ok: true };
}

function monthlyLimit(plan) {
  if (plan === PLANS.STARTER) return STARTER_MONTHLY;
  if (plan === PLANS.PRO) return PRO_MONTHLY;
  return FREE_LIFETIME_MAX;
}

/** First instant of the calendar month after `monthKey` (YYYY-MM), UTC. */
export function nextResetIsoFromMonthKey(monthKey) {
  const parts = String(monthKey || '').split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    return null;
  }
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString();
}

function bumpRunAnalytics(state, plan) {
  if (!state.analytics) return;
  state.analytics.runsTotal = (state.analytics.runsTotal || 0) + 1;
  const key = plan === PLANS.STARTER ? 'starter' : plan === PLANS.PRO ? 'pro' : 'free';
  if (!state.analytics.runsByPlan) state.analytics.runsByPlan = {};
  state.analytics.runsByPlan[key] = (state.analytics.runsByPlan[key] || 0) + 1;
}

export function recordCheckoutStartedSync(product) {
  const state = loadState();
  if (!state.analytics) return;
  if (!state.analytics.checkoutsStarted) state.analytics.checkoutsStarted = {};
  const k = product === 'starter' || product === 'pro' || product === 'extra' ? product : 'extra';
  state.analytics.checkoutsStarted[k] = (state.analytics.checkoutsStarted[k] || 0) + 1;
  saveState(state);
}

export async function recordCheckoutStarted(product) {
  return withBillingLock(() => recordCheckoutStartedSync(product));
}

function bumpConversionAnalytics(state, kind) {
  if (!state.analytics) return;
  if (!state.analytics.conversions) state.analytics.conversions = {};
  const k = kind === 'starter' || kind === 'pro' || kind === 'extra' ? kind : 'extra';
  state.analytics.conversions[k] = (state.analytics.conversions[k] || 0) + 1;
}

export function recordWebhookFailureSync() {
  const state = loadState();
  if (!state.analytics) return;
  state.analytics.webhookFailures = (state.analytics.webhookFailures || 0) + 1;
  saveState(state);
}

export async function recordWebhookFailure() {
  return withBillingLock(() => recordWebhookFailureSync());
}

export function getAnalyticsSnapshotSync() {
  const state = loadState();
  const base = defaultAnalytics();
  const a = state.analytics || {};
  const pe = Array.isArray(state.productEvents) ? state.productEvents : [];
  return {
    ...base,
    ...a,
    runsByPlan: { ...base.runsByPlan, ...(a.runsByPlan || {}) },
    checkoutsStarted: { ...base.checkoutsStarted, ...(a.checkoutsStarted || {}) },
    conversions: { ...base.conversions, ...(a.conversions || {}) },
    productEventsRecent: pe.slice(-200),
  };
}

/**
 * Read-only status for API + LIMIT_REACHED payload.
 */
export function getUsageSnapshotSync(userId) {
  const state = loadState();
  const u = ensureUser(state, userId);
  const monthBefore = u.monthKey;
  rollMonth(u);
  if (u.monthKey !== monthBefore) {
    saveState(state);
  }
  const plan = u.plan || PLANS.FREE;

  if (plan === PLANS.FREE) {
    const used = u.freeRunsUsed;
    const limit = FREE_LIFETIME_MAX;
    const remaining = Math.max(0, limit - used) + (u.bonusRuns || 0);
    return {
      plan,
      limit,
      used,
      remaining,
      bonusRuns: u.bonusRuns || 0,
      runsThisMonth: u.runsThisMonth,
      monthKey: u.monthKey,
    };
  }

  const limit = monthlyLimit(plan);
  const fromSubscription = u.runsThisMonth;
  const remainingMonthly = Math.max(0, limit - fromSubscription);
  const remaining = remainingMonthly + (u.bonusRuns || 0);
  return {
    plan,
    limit,
    used: fromSubscription,
    remaining,
    bonusRuns: u.bonusRuns || 0,
    runsThisMonth: fromSubscription,
    monthKey: u.monthKey,
  };
}

/**
 * @returns {{ ok: true, kind: 'free'|'bonus'|'monthly' } | { ok: false, plan: string, used: number, limit: number, remaining: number, bonusRuns: number }}
 */
export function tryBeginRunSync(userId) {
  const state = loadState();
  const u = ensureUser(state, userId);
  const monthBefore = u.monthKey;
  rollMonth(u);
  if (u.monthKey !== monthBefore) {
    saveState(state);
  }
  const plan = u.plan || PLANS.FREE;

  if (plan === PLANS.FREE) {
    if ((u.bonusRuns || 0) > 0) {
      u.bonusRuns -= 1;
      u.updatedAt = new Date().toISOString();
      bumpRunAnalytics(state, plan);
      saveState(state);
      return { ok: true, kind: 'bonus' };
    }
    if (u.freeRunsUsed < FREE_LIFETIME_MAX) {
      u.freeRunsUsed += 1;
      u.updatedAt = new Date().toISOString();
      bumpRunAnalytics(state, plan);
      saveState(state);
      return { ok: true, kind: 'free' };
    }
    saveState(state);
    return {
      ok: false,
      plan,
      used: u.freeRunsUsed,
      limit: FREE_LIFETIME_MAX,
      remaining: 0,
      bonusRuns: u.bonusRuns || 0,
    };
  }

  const limit = monthlyLimit(plan);
  if (u.runsThisMonth < limit) {
    u.runsThisMonth += 1;
    u.updatedAt = new Date().toISOString();
    bumpRunAnalytics(state, plan);
    saveState(state);
    return { ok: true, kind: 'monthly' };
  }
  if ((u.bonusRuns || 0) > 0) {
    u.bonusRuns -= 1;
    u.updatedAt = new Date().toISOString();
    bumpRunAnalytics(state, plan);
    saveState(state);
    return { ok: true, kind: 'bonus' };
  }

  saveState(state);
  return {
    ok: false,
    plan,
    used: u.runsThisMonth,
    limit,
    remaining: 0,
    bonusRuns: u.bonusRuns || 0,
  };
}

export function abortRunSync(userId, reservation) {
  if (!reservation?.ok || !userId) return;
  const state = loadState();
  const u = state.users[userId];
  if (!u) return;

  if (reservation.kind === 'free') {
    u.freeRunsUsed = Math.max(0, (u.freeRunsUsed || 0) - 1);
  } else if (reservation.kind === 'bonus') {
    u.bonusRuns = (u.bonusRuns || 0) + 1;
  } else if (reservation.kind === 'monthly') {
    u.runsThisMonth = Math.max(0, (u.runsThisMonth || 0) - 1);
  }
  u.updatedAt = new Date().toISOString();
  saveState(state);
}

export function applySubscriptionFromCheckoutSync(userId, plan, stripeCustomerId, subscriptionId, priceId) {
  if (!userId || !plan) return;
  const state = loadState();
  const u = ensureUser(state, userId);
  u.plan = plan;
  u.stripeCustomerId = stripeCustomerId || u.stripeCustomerId;
  u.stripeSubscriptionId = subscriptionId || u.stripeSubscriptionId;
  u.stripePriceId = priceId || u.stripePriceId;
  rollMonth(u);
  u.updatedAt = new Date().toISOString();
  saveState(state);
}

export function downgradeToFreeSync(userId) {
  if (!userId) return;
  const state = loadState();
  const u = state.users[userId];
  if (!u) return;
  u.plan = PLANS.FREE;
  u.stripeSubscriptionId = undefined;
  u.stripePriceId = undefined;
  u.updatedAt = new Date().toISOString();
  saveState(state);
}

export function addBonusRunSync(userId, count = 1) {
  if (!userId) return;
  const state = loadState();
  const u = ensureUser(state, userId);
  u.bonusRuns = (u.bonusRuns || 0) + count;
  u.updatedAt = new Date().toISOString();
  saveState(state);
}

function pruneEvents(state) {
  const ids = Object.keys(state.events);
  if (ids.length <= 4000) return;
  ids.sort((a, b) => (state.events[a].at > state.events[b].at ? 1 : -1));
  for (let i = 0; i < ids.length - 4000; i += 1) delete state.events[ids[i]];
}

export function planFromStripePriceId(priceId) {
  const starter = process.env.STRIPE_PRICE_STARTER?.trim();
  const pro = process.env.STRIPE_PRICE_PRO?.trim();
  if (priceId && starter && priceId === starter) return PLANS.STARTER;
  if (priceId && pro && priceId === pro) return PLANS.PRO;
  return null;
}

export async function tryBeginRun(userId) {
  return withBillingLock(() => tryBeginRunSync(userId));
}

export async function abortRun(userId, reservation) {
  return withBillingLock(() => abortRunSync(userId, reservation));
}

export async function getUsageSnapshot(userId) {
  return withBillingLock(() => getUsageSnapshotSync(userId));
}

const MAX_PRODUCT_EVENTS = 6000;

function pruneProductEvents(state) {
  const arr = state.productEvents;
  if (!Array.isArray(arr) || arr.length <= MAX_PRODUCT_EVENTS) return;
  state.productEvents = arr.slice(-Math.floor(MAX_PRODUCT_EVENTS / 2));
}

/** Append while holding billing lock (mutates `state` only; caller saves). */
export function appendProductEventToState(state, userId, plan, event, meta = {}) {
  if (!state.productEvents) state.productEvents = [];
  const ev = String(event || '').trim().slice(0, 64);
  if (!ev) return;
  state.productEvents.push({
    at: new Date().toISOString(),
    userId: userId || null,
    plan: plan || null,
    event: ev,
    meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {},
  });
  pruneProductEvents(state);
}

/**
 * Lightweight product analytics (user_id, plan, timestamp, optional meta).
 * @param {string | null} userId
 * @param {string | null} plan
 * @param {string} event
 * @param {Record<string, unknown>} [meta]
 */
export function recordProductEventSync(userId, plan, event, meta = {}) {
  const state = loadState();
  if (!state.productEvents) state.productEvents = [];
  const ev = String(event || '').trim().slice(0, 64);
  if (!ev) return;
  state.productEvents.push({
    at: new Date().toISOString(),
    userId: userId || null,
    plan: plan || null,
    event: ev,
    meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {},
  });
  pruneProductEvents(state);
  saveState(state);
}

export async function recordProductEvent(userId, plan, event, meta) {
  return withBillingLock(() => recordProductEventSync(userId, plan, event, meta));
}

/**
 * Idempotent webhook handling under store lock (single read/write).
 * @param {import('stripe').Stripe.Event} event
 */
export async function applyStripeEvent(event) {
  return withBillingLock(() => {
    const state = loadState();
    const id = event.id;
    if (!id || state.events[id]) return { handled: true, duplicate: true };

    const type = event.type;
    const obj = event.data?.object;

    if (type === 'checkout.session.completed') {
      const session = obj;
      const userId = normalizeUserId(session?.metadata?.cloneaiUserId || session?.client_reference_id);
      if (!userId) {
        state.events[id] = { at: new Date().toISOString() };
        pruneEvents(state);
        saveState(state);
        return { handled: true, skip: 'no_user' };
      }

      if (session.mode === 'payment') {
        const kind = session.metadata?.kind;
        if (kind === 'extra_run') {
          const u = ensureUser(state, userId);
          u.bonusRuns = (u.bonusRuns || 0) + 1;
          u.updatedAt = new Date().toISOString();
          bumpConversionAnalytics(state, 'extra');
          appendProductEventToState(state, userId, u.plan, 'payment_completed', { kind: 'extra_run' });
        }
        state.events[id] = { at: new Date().toISOString() };
        pruneEvents(state);
        saveState(state);
        return { handled: true, kind: 'payment' };
      }

      if (session.mode === 'subscription') {
        const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
        const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
        let plan =
          session.metadata?.plan && [PLANS.STARTER, PLANS.PRO].includes(session.metadata.plan)
            ? session.metadata.plan
            : null;
        const priceFromMeta = session.metadata?.priceId?.trim();
        if (!plan && priceFromMeta) plan = planFromStripePriceId(priceFromMeta);
        if (plan) {
          const u = ensureUser(state, userId);
          u.plan = plan;
          u.stripeCustomerId = customerId || u.stripeCustomerId;
          u.stripeSubscriptionId = subId || u.stripeSubscriptionId;
          u.stripePriceId = priceFromMeta || u.stripePriceId;
          rollMonth(u);
          u.runsThisMonth = 0;
          u.updatedAt = new Date().toISOString();
          bumpConversionAnalytics(state, plan === PLANS.PRO ? 'pro' : 'starter');
          appendProductEventToState(state, userId, plan, 'payment_completed', { kind: 'subscription' });
        }
        state.events[id] = { at: new Date().toISOString() };
        pruneEvents(state);
        saveState(state);
        return { handled: true, kind: 'subscription', plan };
      }
    }

    if (type === 'customer.subscription.updated') {
      const sub = obj;
      const userId = normalizeUserId(sub?.metadata?.cloneaiUserId);
      const item = sub?.items?.data?.[0];
      const priceId = item?.price?.id;
      let plan = priceId ? planFromStripePriceId(String(priceId)) : null;
      if (!plan && sub?.metadata?.plan && [PLANS.STARTER, PLANS.PRO].includes(sub.metadata.plan)) {
        plan = sub.metadata.plan;
      }
      if (userId && plan && state.users[userId]) {
        const u = state.users[userId];
        u.plan = plan;
        if (priceId) u.stripePriceId = String(priceId);
        u.stripeSubscriptionId = sub.id || u.stripeSubscriptionId;
        u.updatedAt = new Date().toISOString();
      }
      state.events[id] = { at: new Date().toISOString() };
      pruneEvents(state);
      saveState(state);
      return { handled: true, kind: 'sub_updated', plan };
    }

    if (type === 'customer.subscription.deleted') {
      const sub = obj;
      const userId = normalizeUserId(sub?.metadata?.cloneaiUserId);
      if (userId && state.users[userId]) {
        const u = state.users[userId];
        u.plan = PLANS.FREE;
        u.stripeSubscriptionId = undefined;
        u.stripePriceId = undefined;
        u.updatedAt = new Date().toISOString();
      }
      state.events[id] = { at: new Date().toISOString() };
      pruneEvents(state);
      saveState(state);
      return { handled: true, kind: 'sub_deleted' };
    }

    if (type === 'invoice.payment_failed') {
      console.warn('[billing] invoice.payment_failed', obj?.id);
      state.events[id] = { at: new Date().toISOString() };
      pruneEvents(state);
      saveState(state);
      return { handled: true, kind: 'invoice_failed' };
    }

    state.events[id] = { at: new Date().toISOString() };
    pruneEvents(state);
    saveState(state);
    return { handled: false, type };
  });
}
