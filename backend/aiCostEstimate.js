/**
 * Rough USD estimate for observability (not billing). Tune via env or when switching models.
 * @param {string} model
 * @param {number} promptTokens
 * @param {number} completionTokens
 */
export function estimateOpenAiUsd(model, promptTokens, completionTokens) {
  const m = String(model || '').toLowerCase();
  let inPerM = Number(process.env.COST_ESTIMATE_INPUT_PER_MILLION_USD);
  let outPerM = Number(process.env.COST_ESTIMATE_OUTPUT_PER_MILLION_USD);
  if (!Number.isFinite(inPerM) || inPerM < 0) {
    if (m.includes('gpt-4o-mini')) {
      inPerM = 0.15;
      outPerM = 0.6;
    } else if (m.includes('gpt-4o')) {
      inPerM = 2.5;
      outPerM = 10;
    } else {
      inPerM = 2.5;
      outPerM = 10;
    }
  }
  if (!Number.isFinite(outPerM) || outPerM < 0) {
    outPerM = 10;
  }
  const p = Math.max(0, Number(promptTokens) || 0);
  const c = Math.max(0, Number(completionTokens) || 0);
  return (p / 1e6) * inPerM + (c / 1e6) * outPerM;
}
