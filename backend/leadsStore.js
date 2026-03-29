import fs from 'node:fs';
import path from 'node:path';

function leadsPath() {
  return process.env.LEADS_DATA_PATH
    ? path.resolve(process.env.LEADS_DATA_PATH)
    : path.join(process.cwd(), 'data', 'leads.jsonl');
}

/**
 * Append one JSON line (newline-delimited) for DFY / CRM export.
 * @param {Record<string, unknown>} record
 */
export function appendLeadRecord(record) {
  const p = leadsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, `${JSON.stringify(record)}\n`, 'utf8');
}
