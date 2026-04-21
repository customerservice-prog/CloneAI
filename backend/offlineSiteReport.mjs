/**
 * Heuristic site report when no LLM API is configured — crawl + DOM stats only.
 */

function pickTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function pickMetaDescription(html) {
  const og = html.match(
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["'][^>]*>/i
  );
  if (og?.[1]) return og[1].trim();
  const d = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i);
  if (d?.[1]) return d[1].trim();
  const d2 = html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
  return d2?.[1]?.trim() || '';
}

function countTag(html, tag) {
  const re = new RegExp(`<${tag}\\b`, 'gi');
  return (html.match(re) || []).length;
}

function stripTagsForWords(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countExternalScripts(html, baseHost) {
  const re = /<script[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let n = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = m[1] || '';
    if (/^(https?:)?\/\//i.test(src) || src.startsWith('//')) {
      try {
        const u = new URL(src.startsWith('//') ? `https:${src}` : src);
        if (baseHost && u.hostname === baseHost) continue;
        n += 1;
      } catch {
        n += 1;
      }
    }
  }
  return n;
}

function hostFromUrl(url) {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
  } catch {
    return '';
  }
}

/**
 * @param {{
 *   url: string,
 *   depth: string,
 *   scraperMeta: object,
 *   rawHtml: string,
 *   crawledPages: Array<{ url: string, html: string }>,
 *   screenshotSweep: boolean,
 *   options?: string[],
 * }} p
 */
export function buildOfflineMarkdownReport(p) {
  const url = (p.url || '').trim() || '(no URL)';
  const depth = String(p.depth || 'homepage');
  const meta = p.scraperMeta || {};
  const screenshotSweep = Boolean(p.screenshotSweep);
  const options = Array.isArray(p.options) ? p.options : [];
  const pages = Array.isArray(p.crawledPages) ? p.crawledPages : [];
  const first = (p.rawHtml && p.rawHtml.length > 50 ? p.rawHtml : pages[0]?.html) || '';
  const combined = pages.map((x) => x.html || '').join('\n') || first;

  const title = pickTitle(first) || pickTitle(combined) || '(no <title> found)';
  const description = pickMetaDescription(first) || pickMetaDescription(combined);
  const host = hostFromUrl(url);

  const h1 = countTag(combined, 'h1');
  const h2 = countTag(combined, 'h2');
  const h3 = countTag(combined, 'h3');
  const imgs = countTag(combined, 'img');
  const links = countTag(combined, 'a');
  const forms = countTag(combined, 'form');
  const scriptsInline = (combined.match(/<script\b/gi) || []).length;
  const extScripts = countExternalScripts(combined, host);

  const textSample = stripTagsForWords(first.slice(0, 120_000));
  const words = textSample ? textSample.split(/\s+/).filter(Boolean).length : 0;

  const lines = [];
  lines.push('# Developer blueprint (offline mode)');
  lines.push('');
  lines.push(
    '> **No LLM configured** — this report is generated from your crawl, HTML structure, and text statistics only. Add `OPENAI_API_KEY` on the server for AI-written analysis.'
  );
  lines.push('');
  lines.push('## Target');
  lines.push(`- **URL:** ${url}`);
  lines.push(`- **Scan depth:** ${depth}`);
  if (options.length) lines.push(`- **Options:** ${options.join(', ')}`);
  lines.push(`- **Pages in crawl (same host):** ${meta.crawlPageCount ?? pages.length ?? 0}`);
  if (meta.crawlStopReason || meta.hint) {
    lines.push(`- **Crawl notes:** ${[meta.crawlStopReason, meta.hint].filter(Boolean).join(' · ')}`);
  }
  if (screenshotSweep) lines.push('- **Mode:** screenshot sweep (HTML may be omitted from model context; see ZIP for PNGs).');
  lines.push('');
  lines.push('## Page signals (first page / merged crawl)');
  lines.push(`- **Document title:** ${title}`);
  if (description) lines.push(`- **Meta description:** ${description.slice(0, 500)}${description.length > 500 ? '…' : ''}`);
  lines.push(`- **Approx. visible word count (first page):** ${words.toLocaleString()}`);
  lines.push(`- **Headings:** ${h1}× h1, ${h2}× h2, ${h3}× h3`);
  lines.push(`- **Links & media:** ${links} anchor tags, ${imgs} img, ${forms} form(s)`);
  lines.push(`- **Scripts:** ~${scriptsInline} script tag(s) (including ~${extScripts} with off-host or absolute src)`);
  lines.push('');
  if (pages.length > 0) {
    lines.push('## Crawled URLs');
    const show = pages.slice(0, 80);
    for (let i = 0; i < show.length; i += 1) {
      lines.push(`${i + 1}. ${show[i].url}`);
    }
    if (pages.length > 80) lines.push(`- … and ${pages.length - 80} more`);
    lines.push('');
  }
  lines.push('## What to do next');
  lines.push(
    '- Use the downloadable asset ZIP (when available) for images, screenshots, and manifests.'
  );
  lines.push('- Re-run with `OPENAI_API_KEY` set for narrative architecture, typography, and component analysis.');
  lines.push('');
  return lines.join('\n');
}
