import { PLANS, isBillingEnabled } from './billingService.js';

/**
 * Max images to fetch into ZIP (per plan). When billing is off, returns envCap unchanged.
 * @param {number} envCap from IMAGE_HARVEST_MAX (MAX_SAFE_INTEGER = unlimited)
 */
export function effectiveHarvestImageCap(plan, assetHarvestMode, envCap) {
  if (!isBillingEnabled()) return envCap;
  const pr = plan || PLANS.FREE;
  const caps = {
    [PLANS.FREE]: { normal: 80, harvest: 100 },
    [PLANS.STARTER]: { normal: 100, harvest: 150 },
    [PLANS.PRO]: { normal: 1200, harvest: 3500 },
    [PLANS.POWER]: { normal: 4500, harvest: 15000 },
  };
  const row = caps[pr] || caps[PLANS.FREE];
  const soft = assetHarvestMode ? row.harvest : row.normal;
  return Math.min(envCap, soft);
}

/**
 * Max total bytes for harvested image ZIP when billing is on (memory safety).
 * @param {number} envCap from IMAGE_HARVEST_ZIP_CAP
 */
export function effectiveHarvestZipCap(plan, assetHarvestMode, envCap) {
  if (!isBillingEnabled()) return envCap;
  const pr = plan || PLANS.FREE;
  const mb = {
    [PLANS.FREE]: { n: 80, h: 120 },
    [PLANS.STARTER]: { n: 200, h: 280 },
    [PLANS.PRO]: { n: 450, h: 900 },
    [PLANS.POWER]: { n: 900, h: 1800 },
  };
  const row = mb[pr] || mb[PLANS.FREE];
  const capMb = assetHarvestMode ? row.h : row.n;
  return Math.min(envCap, capMb * 1024 * 1024);
}
