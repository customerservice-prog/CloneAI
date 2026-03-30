/**
 * Optional “third AI”: choose the best filename among **provided candidates only**.
 * Never returns a string outside the candidate list (falls back to index 0 on parse errors).
 */
import { openAiChatCompletionsRequest } from './aiChatProvider.js';

/**
 * @param {string[]} candidates non-empty stems (no extension)
 * @param {{ apiKey: string, model?: string, signal?: AbortSignal }} opts
 * @returns {Promise<number>} safe index 0..candidates.length-1
 */
export async function openAiPickCandidateIndex(candidates, opts) {
  const list = (candidates || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (list.length <= 1) return 0;
  const key = (opts && opts.apiKey) || '';
  if (!key) return 0;

  const model = (opts.model || process.env.IMAGE_PIPELINE_NAMING_MODEL || 'gpt-4o-mini').trim();
  const body = {
    model,
    temperature: 0,
    max_tokens: 32,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You must pick exactly one index for which filename stem best matches the image download URL path segment. ' +
          'Respond with JSON only: {"i": <integer>} where i is 0-based into the given candidates array. ' +
          'Do not invent new names. If unsure, use 0.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          candidates: list,
          instruction: 'Pick i for the stem that is closest to the original file basename from the URL (literal match preferred).',
        }),
      },
    ],
  };

  try {
    const res = await openAiChatCompletionsRequest({
      apiKey: key,
      body,
      signal: opts.signal || undefined,
      maxAttempts: 2,
    });
    if (!res.ok) return 0;
    const data = await res.json();
    const txt = data?.choices?.[0]?.message?.content || '{}';
    const j = JSON.parse(txt);
    const i = Number(j.i);
    if (!Number.isFinite(i) || i < 0 || i >= list.length) return 0;
    return Math.floor(i);
  } catch {
    return 0;
  }
}
