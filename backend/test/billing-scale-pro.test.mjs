/**
 * Simulates 100 distinct Pro subscribers: concurrent quota checks and full 50-run/month exhaustion.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloneai-scale-pro-'));
const billingPath = path.join(baseDir, 'billing.json');

process.env.BILLING_ENABLED = 'true';
process.env.STRIPE_PRICE_STARTER = 'price_starter_test';
process.env.STRIPE_PRICE_PRO = 'price_pro_test';
process.env.BILLING_DATA_PATH = billingPath;

const initialState = {
  users: {},
  events: {},
  analytics: {
    runsTotal: 0,
    runsByPlan: { free: 0, starter: 0, pro: 0, power: 0 },
    checkoutsStarted: { starter: 0, pro: 0, power: 0, extra: 0, deep_extract: 0 },
    conversions: { starter: 0, pro: 0, power: 0, extra: 0, deep_extract: 0 },
    webhookFailures: 0,
  },
  productEvents: [],
};

fs.writeFileSync(billingPath, JSON.stringify(initialState));

const {
  tryBeginRun,
  getUsageSnapshot,
  PLANS,
  applySubscriptionFromCheckoutSync,
  getAnalyticsSnapshotSync,
} = await import('../billingService.js');

const PRO_MONTHLY = 50;
const USER_COUNT = 100;

/** Deterministic valid UUIDs (v4-style) for users 0..USER_COUNT-1 */
function uidFor(i) {
  const tail = i.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${tail}`;
}

const userIds = Array.from({ length: USER_COUNT }, (_, i) => uidFor(i));

before(() => {
  for (const id of userIds) {
    applySubscriptionFromCheckoutSync(id, PLANS.PRO, 'cus_x', `sub_${id.slice(0, 8)}`, 'price_pro_test');
  }
});

test('100 Pro users: concurrent first run — all succeed', async () => {
  const results = await Promise.all(userIds.map((id) => tryBeginRun(id)));
  assert.equal(results.filter((r) => r.ok).length, USER_COUNT);
  for (const r of results) {
    assert.equal(r.kind, 'monthly');
  }
});

test('100 Pro users: 49 more concurrent rounds + per-user 51st blocked; analytics = 5000 pro runs', async () => {
  fs.writeFileSync(billingPath, JSON.stringify(initialState));
  for (const id of userIds) {
    applySubscriptionFromCheckoutSync(id, PLANS.PRO, 'cus_x', `sub_${id.slice(0, 8)}`, 'price_pro_test');
  }

  for (let round = 0; round < PRO_MONTHLY; round += 1) {
    const results = await Promise.all(userIds.map((id) => tryBeginRun(id)));
    const oks = results.filter((r) => r.ok);
    assert.equal(oks.length, USER_COUNT, `round ${round + 1}: expected ${USER_COUNT} ok`);
  }

  const blocked = await Promise.all(userIds.map((id) => tryBeginRun(id)));
  assert.equal(blocked.every((r) => !r.ok), true);
  assert.equal(blocked.every((r) => r.limit === PRO_MONTHLY), true);

  const a = getAnalyticsSnapshotSync();
  assert.equal(a.runsTotal, USER_COUNT * PRO_MONTHLY);
  assert.equal(a.runsByPlan.pro, USER_COUNT * PRO_MONTHLY);

  for (const id of userIds) {
    const s = await getUsageSnapshot(id);
    assert.equal(s.plan, PLANS.PRO);
    assert.equal(s.remaining, 0);
    assert.equal(s.used, PRO_MONTHLY);
  }
});

test('single Pro user: 60 parallel tryBeginRun — exactly 50 succeed (monthly cap), 10 blocked', async () => {
  fs.writeFileSync(billingPath, JSON.stringify(initialState));
  const one = uidFor(0);
  applySubscriptionFromCheckoutSync(one, PLANS.PRO, 'cus_1', 'sub_1', 'price_pro_test');

  const storm = await Promise.all(Array.from({ length: 60 }, () => tryBeginRun(one)));
  assert.equal(storm.filter((r) => r.ok).length, PRO_MONTHLY);
  assert.equal(storm.filter((r) => !r.ok).length, 10);
  const s = await getUsageSnapshot(one);
  assert.equal(s.used, PRO_MONTHLY);
  assert.equal(s.remaining, 0);
});
