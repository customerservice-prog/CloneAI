/**
 * Thin provider boundary: swap URL / headers when adding Anthropic, Azure, etc.
 * @param {{ apiKey: string, body: object, signal: AbortSignal, maxAttempts?: number }} opts
 */
export async function openAiChatCompletionsRequest({ apiKey, body, signal, maxAttempts = 2 }) {
  const url = (process.env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let last;
  for (let a = 0; a < maxAttempts; a += 1) {
    const res = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok || ![502, 503, 504].includes(res.status)) return res;
    last = res;
    await sleep(450 * (a + 1));
  }
  return last;
}
