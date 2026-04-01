import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, 'utf8');
}

function safeUserSegment(userId) {
  const raw = String(userId || 'anonymous').trim().toLowerCase();
  return raw.replace(/[^a-z0-9_-]+/g, '_').slice(0, 80) || 'anonymous';
}

function safeArtifactName(name) {
  return String(name || '')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('_')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 160);
}

export function getExtractionJobsBaseDir() {
  const raw = (process.env.EXTRACTION_JOBS_DIR || '').trim();
  if (raw) return path.resolve(raw);
  return path.join(__dirname, 'data', 'extraction-jobs');
}

export function getJobDir(baseDir, jobId) {
  return path.join(baseDir, 'jobs', String(jobId || ''));
}

export function getJobJsonPath(baseDir, jobId) {
  return path.join(getJobDir(baseDir, jobId), 'job.json');
}

export function getJobInputPath(baseDir, jobId) {
  return path.join(getJobDir(baseDir, jobId), 'input.json');
}

export function getJobEventsPath(baseDir, jobId) {
  return path.join(getJobDir(baseDir, jobId), 'events.jsonl');
}

export function getJobArtifactsDir(baseDir, jobId) {
  return path.join(getJobDir(baseDir, jobId), 'artifacts');
}

function summarizeInput(input) {
  return {
    url: String(input?.body?.url || '').trim(),
    depth: String(input?.body?.depth || 'homepage').trim(),
    scanMode: String(input?.derived?.scanMode || input?.body?.scanMode || 'elite').trim(),
    extractionProfile: String(input?.derived?.extractionProfile || 'standard').trim(),
    assetHarvestMode: Boolean(input?.derived?.assetHarvestMode),
    comparePair:
      input?.body?.comparePair === '1' ||
      input?.body?.comparePair === 'true' ||
      input?.body?.comparePair === true,
    clientDelivery: Boolean(input?.derived?.clientDelivery),
    servicePackage: String(input?.derived?.servicePackage || '').trim(),
    removeImageBackground: Boolean(input?.derived?.removeImageBackground),
    fileCount: Array.isArray(input?.files) ? input.files.length : 0,
  };
}

let chain = Promise.resolve();

export function withExtractionJobLock(fn) {
  const run = chain.then(() => fn());
  chain = run.catch((err) => {
    console.error('[extractionJobs] lock error', err);
  });
  return run;
}

export async function createExtractionJob({ baseDir, userId, input, sourceIp }) {
  return withExtractionJobLock(async () => {
    const id = `${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
    const now = new Date().toISOString();
    const dir = getJobDir(baseDir, id);
    ensureDir(path.join(dir, 'uploads'));
    ensureDir(getJobArtifactsDir(baseDir, id));

    const files = [];
    for (const file of input.files || []) {
      const extGuess =
        file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
      const storedName = `${files.length.toString().padStart(2, '0')}-${safeArtifactName(file.originalname || `upload.${extGuess}`) || `upload.${extGuess}`}`;
      const relPath = path.join('uploads', storedName);
      fs.writeFileSync(path.join(dir, relPath), file.buffer);
      files.push({
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: Number(file.size) || file.buffer.length || 0,
        relPath: relPath.replace(/\\/g, '/'),
      });
    }

    const persistedInput = {
      version: 1,
      createdAt: now,
      headers: {
        userId: String(userId || '').trim(),
        promoCode: String(input.headers?.promoCode || '').trim(),
      },
      sourceIp: String(sourceIp || 'unknown'),
      body: { ...(input.body || {}) },
      derived: { ...(input.derived || {}) },
      files,
    };
    writeJson(getJobInputPath(baseDir, id), persistedInput);

    const job = {
      version: 1,
      id,
      userId: String(userId || '').trim() || 'anonymous',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      status: 'queued',
      summary: summarizeInput(persistedInput),
      sourceIp: String(sourceIp || 'unknown'),
      progress: {
        phase: 'queued',
        label: 'Queued',
        pagesDiscovered: 0,
        pagesCrawled: 0,
        queueLength: 0,
        imagesFound: 0,
        imagesDownloaded: 0,
        imagesFailed: 0,
        duplicatesSkipped: 0,
        zipBytesSoFar: 0,
        elapsedMs: 0,
      },
      artifacts: [],
      billing: {
        promoUnlocked: Boolean(input.derived?.promoValid || input.derived?.privilegedAnalyze),
        privileged: Boolean(input.derived?.privilegedAnalyze),
      },
      scraper: null,
      assets: null,
      error: null,
    };
    writeJson(getJobJsonPath(baseDir, id), job);
    writeText(getJobEventsPath(baseDir, id), '');
    return job;
  });
}

export function loadExtractionJob(baseDir, jobId) {
  return readJson(getJobJsonPath(baseDir, jobId), null);
}

export function loadExtractionJobInput(baseDir, jobId) {
  const input = readJson(getJobInputPath(baseDir, jobId), null);
  if (!input) return null;
  const dir = getJobDir(baseDir, jobId);
  const files = Array.isArray(input.files)
    ? input.files.map((file) => ({
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        buffer: fs.readFileSync(path.join(dir, file.relPath)),
      }))
    : [];
  return {
    ...input,
    files,
  };
}

export async function updateExtractionJob(baseDir, jobId, mutate) {
  return withExtractionJobLock(async () => {
    const current = loadExtractionJob(baseDir, jobId);
    if (!current) return null;
    const next = mutate ? mutate(structuredClone(current)) : structuredClone(current);
    if (!next) return null;
    next.updatedAt = new Date().toISOString();
    writeJson(getJobJsonPath(baseDir, jobId), next);
    return next;
  });
}

export async function appendExtractionJobEvent(baseDir, jobId, event) {
  return withExtractionJobLock(async () => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
    });
    fs.appendFileSync(getJobEventsPath(baseDir, jobId), `${line}\n`, 'utf8');
  });
}

export function readExtractionJobEventsSlice(baseDir, jobId, offset = 0) {
  const filePath = getJobEventsPath(baseDir, jobId);
  try {
    const stats = fs.statSync(filePath);
    const start = Math.max(0, Number(offset) || 0);
    if (stats.size <= start) {
      return { nextOffset: stats.size, events: [] };
    }
    const fd = fs.openSync(filePath, 'r');
    try {
      const len = stats.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const events = [];
      for (const line of buf.toString('utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed);
          if (rec?.event) events.push(rec.event);
        } catch {
          /* ignore partial/corrupt line */
        }
      }
      return { nextOffset: stats.size, events };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { nextOffset: Number(offset) || 0, events: [] };
  }
}

export async function saveExtractionJobArtifact(baseDir, jobId, artifact) {
  return withExtractionJobLock(async () => {
    const name = safeArtifactName(artifact?.name);
    if (!name) return null;
    const filePath = path.join(getJobArtifactsDir(baseDir, jobId), name);
    ensureDir(path.dirname(filePath));
    if (Buffer.isBuffer(artifact.buffer)) {
      fs.writeFileSync(filePath, artifact.buffer);
    } else {
      writeText(filePath, String(artifact.text || ''));
    }
    const meta = {
      name,
      contentType: String(artifact.contentType || 'application/octet-stream'),
      size: fs.statSync(filePath).size,
      savedAt: new Date().toISOString(),
    };
    const job = loadExtractionJob(baseDir, jobId);
    if (!job) return meta;
    const artifacts = Array.isArray(job.artifacts) ? job.artifacts.filter((x) => x?.name !== name) : [];
    artifacts.push(meta);
    job.artifacts = artifacts.sort((a, b) => a.name.localeCompare(b.name));
    job.updatedAt = new Date().toISOString();
    writeJson(getJobJsonPath(baseDir, jobId), job);
    return meta;
  });
}

export function getExtractionJobArtifactPath(baseDir, jobId, artifactName) {
  const name = safeArtifactName(artifactName);
  if (!name) return null;
  const filePath = path.join(getJobArtifactsDir(baseDir, jobId), name);
  if (!fs.existsSync(filePath)) return null;
  return filePath;
}

export function listExtractionJobsForUser(baseDir, userId, { limit = 20 } = {}) {
  return listExtractionJobs(baseDir, {
    limit,
    userId,
  });
}

export function listExtractionJobs(baseDir, { limit = 20, userId = null, statuses = null } = {}) {
  const jobsRoot = path.join(baseDir, 'jobs');
  try {
    const items = fs.readdirSync(jobsRoot, { withFileTypes: true });
    const jobs = [];
    for (const item of items) {
      if (!item.isDirectory()) continue;
      const job = readJson(path.join(jobsRoot, item.name, 'job.json'), null);
      if (!job) continue;
      if (userId != null && safeUserSegment(job.userId) !== safeUserSegment(userId)) continue;
      if (statuses && Array.isArray(statuses) && statuses.length > 0 && !statuses.includes(job.status)) continue;
      jobs.push(job);
    }
    jobs.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
    return jobs.slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
  } catch {
    return [];
  }
}
