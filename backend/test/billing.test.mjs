import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloneai-billing-'));
process.env.BILLING_ENABLED = 'true';
process.env.STRIPE_PRICE_STARTER = 'price_starter_test';
process.env.STRIPE_PRICE_PRO = 'price_pro_test';
process.env.BILLING_DATA_PATH = path.join(baseDir, '_bootstrap.json');
fs.writeFileSync(
  process.env.BILLING_DATA_PATH,
  JSON.stringify({
    users: {},
    events: {},
    analytics: {
      runsTotal: 0,
      runsByPlan: { free: 0, starter: 0, pro: 0 },
      checkoutsStarted: { starter: 0, pro: 0, extra: 0 },
      conversions: { starter: 0, pro: 0, extra: 0 },
      webhookFailures: 0,
    },
  })
);

const {
  tryBeginRun,
  getUsageSnapshot,
  PLANS,
  applyStripeEvent,
  nextResetIsoFromMonthKey,
  abortRunSync,
  applySubscriptionFromCheckoutSync,
  getAnalyticsSnapshotSync,
  recordWebhookFailure,
  tryBeginRunSync,
} = await import('../billingService.js');

const uid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let seq = 0;
beforeEach(() => {
  process.env.BILLING_DATA_PATH = path.join(baseDir, `case-${++seq}.json`);
  fs.writeFileSync(
    process.env.BILLING_DATA_PATH,
    JSON.stringify({
      users: {},
      events: {},
      analytics: {
        runsTotal: 0,
        runsByPlan: { free: 0, starter: 0, pro: 0 },
        checkoutsStarted: { starter: 0, pro: 0, extra: 0 },
        conversions: { starter: 0, pro: 0, extra: 0 },
        webhookFailures: 0,
      },
    })
  );
});

test('TEST 1: free user — first run OK, second blocked', async () => {
  let r = await tryBeginRun(uid);
  assert.equal(r.ok, true);
  const s = await getUsageSnapshot(uid);
  assert.equal(s.used, 1);
  assert.equal(s.remaining, 0);
  r = await tryBeginRun(uid);
  assert.equal(r.ok, false);
  assert.equal(r.limit, 1);
});

test('TEST 2: starter — 10 runs OK, 11th blocked', async () => {
  applySubscriptionFromCheckoutSync(uid, PLANS.STARTER, 'cus', 'sub', 'price_starter_test');
  for (let i = 0; i < 10; i += 1) {
    const r = await tryBeginRun(uid);
    assert.equal(r.ok, true, `run ${i + 1}`);
  }
  const r = await tryBeginRun(uid);
  assert.equal(r.ok, false);
});

test('TEST 3: pro — 50 runs OK, 51st blocked', async () => {
  applySubscriptionFromCheckoutSync(uid, PLANS.PRO, 'cus', 'sub', 'price_pro_test');
  for (let i = 0; i < 50; i += 1) {
    await tryBeginRun(uid);
  }
  const r = await tryBeginRun(uid);
  assert.equal(r.ok, false);
});

test('TEST 4: monthly reset when monthKey is in the past', async () => {
  applySubscriptionFromCheckoutSync(uid, PLANS.STARTER, 'cus', 'sub', 'price_starter_test');
  for (let i = 0; i < 5; i += 1) await tryBeginRun(uid);
  const p = process.env.BILLING_DATA_PATH;
  const state = JSON.parse(fs.readFileSync(p, 'utf8'));
  state.users[uid].monthKey = '2020-01';
  fs.writeFileSync(p, JSON.stringify(state));
  const s = await getUsageSnapshot(uid);
  const current = new Date().toISOString().slice(0, 7);
  assert.equal(s.monthKey, current);
  assert.equal(s.used, 0);
});

test('TEST 5: Stripe checkout.session.completed updates plan; duplicate event skipped', async () => {
  const e = {
    id: 'evt_checkout_sub_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        mode: 'subscription',
        metadata: { cloneaiUserId: uid, plan: PLANS.STARTER, priceId: 'price_starter_test' },
        subscription: 'sub_x',
        customer: 'cus_x',
      },
    },
  };
  let o = await applyStripeEvent(e);
  assert.equal(o.handled, true);
  let s = await getUsageSnapshot(uid);
  assert.equal(s.plan, PLANS.STARTER);
  o = await applyStripeEvent(e);
  assert.equal(o.duplicate, true);
  s = await getUsageSnapshot(uid);
  assert.equal(s.plan, PLANS.STARTER);
});

test('TEST 6: webhook idempotency — same event id not applied twice', async () => {
  const e = {
    id: 'evt_idem_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        mode: 'payment',
        metadata: { cloneaiUserId: uid, kind: 'extra_run' },
      },
    },
  };
  await applyStripeEvent(e);
  await applyStripeEvent(e);
  const p = process.env.BILLING_DATA_PATH;
  const state = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(state.users[uid].bonusRuns, 1);
});

test('TEST 7: direct usage — cannot exceed free lifetime via repeated tryBeginRun', async () => {
  assert.equal((await tryBeginRun(uid)).ok, true);
  assert.equal((await tryBeginRun(uid)).ok, false);
});

test('TEST 8: multi parallel requests — only one free run granted', async () => {
  const results = await Promise.all([tryBeginRun(uid), tryBeginRun(uid), tryBeginRun(uid)]);
  const oks = results.filter((r) => r.ok);
  assert.equal(oks.length, 1);
  const s = await getUsageSnapshot(uid);
  assert.equal(s.used, 1);
});

test('TEST 9: pay-as-you-go — at starter cap, extra payment grants one more run', async () => {
  applySubscriptionFromCheckoutSync(uid, PLANS.STARTER, 'cus', 'sub', 'price_starter_test');
  for (let i = 0; i < 10; i += 1) await tryBeginRun(uid);
  assert.equal((await tryBeginRun(uid)).ok, false);
  await applyStripeEvent({
    id: 'evt_extra_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        mode: 'payment',
        metadata: { cloneaiUserId: uid, kind: 'extra_run' },
      },
    },
  });
  const r = await tryBeginRun(uid);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'bonus');
});

test('free tier uses bonus runs before consuming the one lifetime slot', async () => {
  await applyStripeEvent({
    id: 'evt_bonus_first',
    type: 'checkout.session.completed',
    data: {
      object: {
        mode: 'payment',
        metadata: { cloneaiUserId: uid, kind: 'extra_run' },
      },
    },
  });
  let r = await tryBeginRun(uid);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'bonus');
  r = await tryBeginRun(uid);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'free');
  r = await tryBeginRun(uid);
  assert.equal(r.ok, false);
});

test('abortRunSync refunds a reserved monthly slot', () => {
  applySubscriptionFromCheckoutSync(uid, PLANS.STARTER, 'cus', 'sub', 'price_starter_test');
  const res = tryBeginRunSync(uid);
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'monthly');
  abortRunSync(uid, res);
  const state = JSON.parse(fs.readFileSync(process.env.BILLING_DATA_PATH, 'utf8'));
  assert.equal(state.users[uid].runsThisMonth, 0);
});

test('nextResetIsoFromMonthKey', () => {
  assert.equal(nextResetIsoFromMonthKey('2026-03'), '2026-04-01T00:00:00.000Z');
});

test('recordWebhookFailure increments analytics', async () => {
  await recordWebhookFailure();
  const a = getAnalyticsSnapshotSync();
  assert.equal(a.webhookFailures, 1);
});

test('customer.subscription.updated maps price to Pro', async () => {
  applySubscriptionFromCheckoutSync(uid, PLANS.STARTER, 'cus', 'sub_z', 'price_starter_test');
  await applyStripeEvent({
    id: 'evt_sub_updated_1',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_z',
        metadata: { cloneaiUserId: uid },
        items: { data: [{ price: { id: 'price_pro_test' } }] },
      },
    },
  });
  const s = await getUsageSnapshot(uid);
  assert.equal(s.plan, PLANS.PRO);
});

test('subscription checkout resets monthly usage counter', async () => {
  applySubscriptionFromCheckoutSync(uid, PLANS.STARTER, 'cus', 'sub', 'price_starter_test');
  for (let i = 0; i < 8; i += 1) await tryBeginRun(uid);
  await applyStripeEvent({
    id: 'evt_upgrade_pro',
    type: 'checkout.session.completed',
    data: {
      object: {
        mode: 'subscription',
        metadata: { cloneaiUserId: uid, plan: PLANS.PRO, priceId: 'price_pro_test' },
        subscription: 'sub_y',
        customer: 'cus_y',
      },
    },
  });
  const s = await getUsageSnapshot(uid);
  assert.equal(s.plan, PLANS.PRO);
  assert.equal(s.used, 0);
});
