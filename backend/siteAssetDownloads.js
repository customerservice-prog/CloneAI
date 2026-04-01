import { randomBytes } from 'node:crypto';

export const SITE_ASSET_TTL_MS = Math.min(
  2 * 60 * 60 * 1000,
  Math.max(5 * 60 * 1000, Number(process.env.SITE_ASSET_TTL_MS) || 30 * 60 * 1000)
);

/** Short-lived ZIP blobs for GET /api/site-images/:token (not logged). */
const siteAssetDownloads = new Map();
const MAX_SITE_ASSET_DOWNLOADS = Math.min(
  20_000,
  Math.max(200, Number(process.env.MAX_SITE_ASSET_DOWNLOADS) || 2500)
);

export function rememberSiteAssetDownload(token, rec) {
  while (siteAssetDownloads.size >= MAX_SITE_ASSET_DOWNLOADS) {
    let oldestKey = null;
    let oldestExp = Infinity;
    for (const [k, v] of siteAssetDownloads) {
      if (v.expires < oldestExp) {
        oldestExp = v.expires;
        oldestKey = k;
      }
    }
    if (oldestKey != null) siteAssetDownloads.delete(oldestKey);
    else break;
  }
  siteAssetDownloads.set(token, rec);
}

export function createSiteAssetDownload(buffer, filename = 'site-assets.zip') {
  const token = randomBytes(24).toString('hex');
  rememberSiteAssetDownload(token, {
    buffer,
    filename,
    expires: Date.now() + SITE_ASSET_TTL_MS,
  });
  return token;
}

export function getSiteAssetDownload(token) {
  const rec = siteAssetDownloads.get(String(token || '').trim());
  if (!rec || rec.expires < Date.now()) {
    if (rec) siteAssetDownloads.delete(String(token || '').trim());
    return null;
  }
  return rec;
}

export function pruneExpiredSiteAssetDownloads(now = Date.now()) {
  for (const [k, v] of siteAssetDownloads) {
    if (v.expires < now) siteAssetDownloads.delete(k);
  }
}

export function startSiteAssetDownloadJanitor() {
  setInterval(() => {
    pruneExpiredSiteAssetDownloads();
  }, 5 * 60 * 1000).unref?.();
}
