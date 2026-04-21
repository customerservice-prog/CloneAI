/**
 * Run health summary, brief grounding helpers, lightweight post-checks.
 */

/**
 * @param {{
 *   imageHarvestCoveragePct?: number | null,
 *   imageHarvestCoverageLabel?: string,
 *   crawlPageCount?: number,
 *   pagesCrawled?: number,
 *   imagesArchived?: number,
 *   imagesDiscovered?: number,
 *   imagesFailed?: number,
 *   partialExtraction?: boolean,
 *   partialExtractionMessage?: string,
 *   browserPassError?: string | null,
 *   briefValidation?: { ok: boolean, issues: string[] },
 * }} p
 */
export function buildRunHealthMarkdown(p) {
  const lines = [];
  lines.push('## Run health (self-audit)');
  lines.push('');
  const cov =
    p.imageHarvestCoverageLabel ||
    (p.imageHarvestCoveragePct != null && Number.isFinite(p.imageHarvestCoveragePct)
      ? `${p.imageHarvestCoveragePct.toFixed(1)}% (estimated vs live DOM signals)`
      : '—');
  lines.push(`- **Image harvest coverage:** ${cov}`);
  const pages = p.pagesCrawled ?? p.crawlPageCount ?? '—';
  lines.push(`- **Pages crawled:** ${pages}`);
  lines.push(
    `- **Assets:** ${p.imagesArchived ?? '—'} archived / ${p.imagesDiscovered ?? '—'} discovered URLs; failed fetches: ${p.imagesFailed ?? '—'}`
  );
  if (p.browserPassError) {
    lines.push(`- **Browser extraction pass:** ${p.browserPassError} (static + CSS harvest still applied)`);
  }
  if (p.partialExtraction) {
    lines.push(
      `> **Partial extraction — retry recommended.** ${p.partialExtractionMessage || 'Coverage or crawl completeness is below the quality bar.'}`
    );
  }
  if (p.briefValidation && !p.briefValidation.ok && (p.briefValidation.issues || []).length) {
    lines.push('- **Report claim audit:** issues detected vs manifests:');
    for (const iss of (p.briefValidation.issues || []).slice(0, 12)) {
      lines.push(`  - ${iss}`);
    }
  }
  lines.push('');
  lines.push(
    '**Grounding rule for this brief:** Every factual statement must be traceable to the crawl, `content.json` text blocks, manifests (`images.json` / `pages.json`), or computed-style tokens included in the run. If it is not in those artifacts, do not state it.'
  );
  lines.push('');
  return lines.join('\n');
}

/**
 * Cheap numeric cross-checks: page counts and "N items" style claims vs manifests.
 * @param {string} briefText
 * @param {{ crawlPageCount?: number, navLinkCountEstimate?: number }} manifestHints
 */
export function validateBriefAgainstManifestHints(briefText, manifestHints = {}) {
  const issues = [];
  const t = String(briefText || '');
  const crawl = manifestHints.crawlPageCount;
  if (typeof crawl === 'number' && crawl > 0) {
    const re = /(\d+)\s*(?:pages?|URLs? crawled|crawl pages)/i;
    const m = t.match(re);
    if (m) {
      const claimed = Number(m[1]);
      if (Number.isFinite(claimed) && claimed !== crawl && Math.abs(claimed - crawl) > 0) {
        issues.push(`Brief cites ${claimed} page(s) but manifest crawl count is ${crawl}.`);
      }
    }
  }
  const nav = manifestHints.navLinkCountEstimate;
  if (typeof nav === 'number' && nav >= 0) {
    const m = t.match(/(\d+)\s*(?:nav|navigation)\s*(?:items?|links?)/i);
    if (m) {
      const claimed = Number(m[1]);
      if (Number.isFinite(claimed) && claimed > nav + 2) {
        issues.push(`Brief claims ${claimed} nav items but HTML-derived estimate is ${nav}.`);
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

/** Count <a href> in same-host nav/header/footer regions (rough). */
export function estimateNavLinkCount(html) {
  if (!html) return 0;
  const slice = String(html).slice(0, 350_000);
  const navBlocks = [];
  const re = /<(nav|header|footer)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(slice)) !== null) {
    navBlocks.push(m[2] || '');
  }
  const hay = navBlocks.length ? navBlocks.join('\n') : slice;
  let c = 0;
  const a = /<a\s[^>]*\bhref\s*=\s*["'][^"'#]+["'][^>]*>/gi;
  while (a.exec(hay) !== null) c += 1;
  return c;
}
