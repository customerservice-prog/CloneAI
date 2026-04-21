/**
 * Verbatim-ish text extraction from static HTML for brief grounding (per page).
 */

function decodeBasicEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Strip scripts/styles and collapse whitespace; preserve line breaks at block boundaries.
 * @param {string} html
 * @param {string} pageUrl
 * @returns {{ pageUrl: string, textBlocks: { text: string, path: string }[], mergedSample: string }}
 */
export function extractContentJsonFromHtml(html, pageUrl) {
  if (!html || !pageUrl) {
    return { pageUrl: pageUrl || '', textBlocks: [], mergedSample: '' };
  }
  let h = String(html);
  h = h.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  h = h.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  h = h.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  h = h.replace(/<!--[\s\S]*?-->/g, ' ');

  const blockRe = /<(p|li|h[1-6]|td|th|div|section|article|header|footer|nav|button|a|span|label)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const textBlocks = [];
  let m;
  while ((m = blockRe.exec(h)) !== null) {
    const tag = m[1].toLowerCase();
    const inner = m[2] || '';
    const text = decodeBasicEntities(inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (text.length >= 2 && text.length < 8000) {
      textBlocks.push({ text, path: tag });
    }
  }

  if (textBlocks.length < 8) {
    const stripped = decodeBasicEntities(h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (stripped.length > 40) {
      const chunks = stripped.match(/.{1,400}[\s，。,.!?]/g) || [stripped.slice(0, 2000)];
      for (const c of chunks.slice(0, 40)) {
        const t = c.trim();
        if (t.length >= 12) textBlocks.push({ text: t, path: 'fallback' });
      }
    }
  }

  const mergedSample = textBlocks
    .map((b) => b.text)
    .filter(Boolean)
    .slice(0, 120)
    .join('\n\n');

  return { pageUrl, textBlocks, mergedSample };
}
