/**
 * Strip noisy / high-token HTML before sending to the model.
 * Regex-based (not a full DOM); tuned for safety vs size reduction.
 */

/**
 * @param {string} html
 * @param {{ maxChars?: number }} [opts]
 * @returns {string}
 */
export function cleanHtmlForModel(html, opts = {}) {
  const maxChars = Math.min(
    200_000,
    Math.max(5000, Number(opts.maxChars) || 100_000)
  );
  if (!html || typeof html !== 'string') return '';

  let s = html;

  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  s = s.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '');
  s = s.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ');

  s = s.replace(/<!--([\s\S]*?)-->/g, ' ');

  for (let i = 0; i < 4; i += 1) {
    const next = s
      .replace(/\sdata-(?!src\b|srcset\b)[a-z0-9_.:-]+\s*=\s*(["'])(?:\\\1|.)*?\1/gi, ' ')
      .replace(/\sdata-(?!src\b|srcset\b)[a-z0-9_.:-]+\s*=\s*[^\s>]+/gi, ' ')
      .replace(/\saria-[a-z0-9_.:-]+\s*=\s*(["'])(?:\\\1|.)*?\1/gi, ' ')
      .replace(/\saria-[a-z0-9_.:-]+\s*=\s*[^\s>]+/gi, ' ');
    if (next === s) break;
    s = next;
  }

  s = s.replace(/\snonce\s*=\s*(["'])(?:\\\1|.)*?\1/gi, ' ');
  s = s.replace(/\sintegrity\s*=\s*(["'])(?:\\\1|.)*?\1/gi, ' ');
  s = s.replace(/\sreferrerpolicy\s*=\s*(["'])(?:\\\1|.)*?\1/gi, ' ');

  s = s.replace(/\son\w+\s*=\s*(["'])(?:\\\1|.)*?\1/gi, ' ');
  s = s.replace(/\son\w+\s*=\s*[^\s>]*/gi, ' ');

  s = s.replace(/<input\b[^>]*\btype\s*=\s*["']?hidden["']?[^>]*>/gi, ' ');

  s = s.replace(/\s+/g, ' ');
  s = s.trim();

  if (s.length > maxChars) {
    s = s.slice(0, maxChars);
  }
  return s;
}
