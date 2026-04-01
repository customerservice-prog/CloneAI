import { PLANS } from './billingService.js';

const STARTER_PAGE_CAP = Math.min(
  25,
  Math.max(1, Number(process.env.CRAWL_STARTER_MAX_PAGES) || 25)
);

/**
 * Pro deep crawl cap (env CRAWL_MAX_PAGES, default 300, max 500).
 */
export function crawlMaxPagesEnvCap() {
  const raw = Number(process.env.CRAWL_MAX_PAGES);
  const n = Number.isFinite(raw) && raw > 0 ? raw : 300;
  return Math.min(500, Math.max(1, Math.floor(n)));
}

/**
 * Power tier deep crawl (env CRAWL_POWER_MAX_PAGES, default max(pro,400), max 600).
 */
export function powerCrawlPageCap() {
  const raw = Number(process.env.CRAWL_POWER_MAX_PAGES);
  if (Number.isFinite(raw) && raw > 0) return Math.min(600, Math.max(1, Math.floor(raw)));
  return Math.min(600, Math.max(crawlMaxPagesEnvCap(), 400));
}

const POWER_SHALLOW_CAP = Math.min(
  200,
  Math.max(40, Number(process.env.CRAWL_POWER_SHALLOW_PAGES) || 120)
);

/**
 * Pages to fetch per billing plan + depth.
 * @param {string | null} plan
 * @param {string} depth
 */
export function maxCrawlPagesForRun(plan, depth) {
  const d = String(depth || 'homepage').trim();
  const p = plan || PLANS.FREE;
  const proCap = crawlMaxPagesEnvCap();
  const powerCap = powerCrawlPageCap();

  if (d === 'homepage') return 1;

  if (d === 'shallow') {
    if (p === PLANS.FREE) return 1;
    if (p === PLANS.STARTER) return Math.min(STARTER_PAGE_CAP, proCap);
    if (p === PLANS.PRO) return Math.min(STARTER_PAGE_CAP, proCap);
    if (p === PLANS.POWER) return Math.min(POWER_SHALLOW_CAP, powerCap);
    return Math.min(STARTER_PAGE_CAP, proCap);
  }

  if (d === 'deep') {
    if (p === PLANS.FREE) return 1;
    if (p === PLANS.STARTER) return Math.min(STARTER_PAGE_CAP, proCap);
    if (p === PLANS.PRO) return proCap;
    if (p === PLANS.POWER) return powerCap;
    return Math.min(STARTER_PAGE_CAP, proCap);
  }

  return 1;
}

/**
 * When a valid owner promo / coupon is used, crawl caps can exceed POWER (env-tunable).
 * @param {{ plan: string | null, depth: string, promoOwner: boolean }} opts
 */
export function crawlPageCapForRequest({ plan, depth, promoOwner }) {
  const d = String(depth || 'homepage').trim();
  const base = maxCrawlPagesForRun(plan, d);
  if (!promoOwner) return base;
  if (d === 'homepage') return 1;
  const raw = Number(process.env.CRAWL_PROMO_OWNER_MAX_PAGES);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(2000, Math.max(1, Math.floor(raw)));
  }
  const powerDeep = maxCrawlPagesForRun(PLANS.POWER, d);
  return Math.min(1200, Math.max(powerDeep, Math.floor(powerCrawlPageCap() * 1.2)));
}
