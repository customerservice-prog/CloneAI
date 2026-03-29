import fs from 'node:fs';
import path from 'node:path';

function getBillingPath() {
  return process.env.BILLING_DATA_PATH
    ? path.resolve(process.env.BILLING_DATA_PATH)
    : path.join(process.cwd(), 'data', 'billing.json');
}

let chain = Promise.resolve();

/**
 * Serialize all billing file mutations (multi-user safe for JSON file).
 * @param {() => void | Promise<void>} fn
 */
export function withBillingLock(fn) {
  const run = chain.then(() => fn());
  chain = run.catch((err) => {
    console.error('[billing] store error', err);
  });
  return run;
}

export function defaultAnalytics() {
  return {
    runsTotal: 0,
    runsByPlan: { free: 0, starter: 0, pro: 0 },
    checkoutsStarted: { starter: 0, pro: 0, extra: 0 },
    conversions: { starter: 0, pro: 0, extra: 0 },
    webhookFailures: 0,
  };
}

function readStateSync() {
  const billingPath = getBillingPath();
  try {
    const raw = fs.readFileSync(billingPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return { users: {}, events: {}, analytics: defaultAnalytics() };
    if (!data.users) data.users = {};
    if (!data.events) data.events = {};
    if (!data.analytics) data.analytics = defaultAnalytics();
    if (!Array.isArray(data.productEvents)) data.productEvents = [];
    return data;
  } catch {
    return { users: {}, events: {}, analytics: defaultAnalytics(), productEvents: [] };
  }
}

function writeStateSync(state) {
  const billingPath = getBillingPath();
  const dir = path.dirname(billingPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(billingPath, JSON.stringify(state, null, 2), 'utf8');
}

export function loadState() {
  return readStateSync();
}

export function saveState(state) {
  writeStateSync(state);
}

export { getBillingPath as billingPath };
