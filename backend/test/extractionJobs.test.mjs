import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createExtractionJob,
  claimNextExtractionJob,
  heartbeatExtractionJob,
  loadExtractionJob,
  updateExtractionJob,
} from '../extractionJobs.js';

function tempBaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cloneai-extraction-jobs-'));
}

function sampleInput() {
  return {
    headers: { promoCode: '' },
    body: {
      url: 'https://example.com',
      depth: 'deep',
      scanMode: 'images',
      extractionProfile: 'quality_first',
    },
    derived: {
      scanMode: 'images',
      extractionProfile: 'quality_first',
      assetHarvestMode: true,
      clientDelivery: true,
    },
    files: [],
  };
}

test('claimNextExtractionJob claims oldest queued job and marks runner metadata', async () => {
  const baseDir = tempBaseDir();
  const first = await createExtractionJob({
    baseDir,
    userId: 'user-a',
    input: sampleInput(),
    sourceIp: '127.0.0.1',
  });
  await new Promise((r) => setTimeout(r, 5));
  await createExtractionJob({
    baseDir,
    userId: 'user-b',
    input: sampleInput(),
    sourceIp: '127.0.0.1',
  });

  const claimed = await claimNextExtractionJob(baseDir, {
    runnerId: 'runner-1',
    staleAfterMs: 60_000,
  });

  assert.equal(claimed?.id, first.id);
  assert.equal(claimed?.status, 'running');
  assert.equal(claimed?.runner?.id, 'runner-1');
  assert.equal(claimed?.progress?.phase, 'starting');
  assert.equal(claimed?.progress?.stageStatuses?.crawl, 'pending');
});

test('heartbeatExtractionJob refreshes runner heartbeat timestamp', async () => {
  const baseDir = tempBaseDir();
  const job = await createExtractionJob({
    baseDir,
    userId: 'user-a',
    input: sampleInput(),
    sourceIp: '127.0.0.1',
  });
  const claimed = await claimNextExtractionJob(baseDir, {
    runnerId: 'runner-2',
    staleAfterMs: 60_000,
  });
  const before = claimed.runner.heartbeatAt;

  await new Promise((r) => setTimeout(r, 5));
  await heartbeatExtractionJob(baseDir, job.id, 'runner-2');

  const refreshed = loadExtractionJob(baseDir, job.id);
  assert.equal(refreshed?.runner?.id, 'runner-2');
  assert.notEqual(refreshed?.runner?.heartbeatAt, before);
});

test('claimNextExtractionJob can recover a stale running job', async () => {
  const baseDir = tempBaseDir();
  const job = await createExtractionJob({
    baseDir,
    userId: 'user-a',
    input: sampleInput(),
    sourceIp: '127.0.0.1',
  });

  await updateExtractionJob(baseDir, job.id, (current) => {
    current.status = 'running';
    current.runner = {
      id: 'dead-runner',
      claimedAt: '2026-01-01T00:00:00.000Z',
      heartbeatAt: '2026-01-01T00:00:00.000Z',
      staleAfterMs: 1000,
    };
    current.startedAt = '2026-01-01T00:00:00.000Z';
    return current;
  });

  const claimed = await claimNextExtractionJob(baseDir, {
    runnerId: 'runner-3',
    staleAfterMs: 1000,
  });

  assert.equal(claimed?.id, job.id);
  assert.equal(claimed?.runner?.id, 'runner-3');
  assert.equal(claimed?.status, 'running');
});

test('claimNextExtractionJob prefers queued work over stale recovery', async () => {
  const baseDir = tempBaseDir();
  const stale = await createExtractionJob({
    baseDir,
    userId: 'user-a',
    input: sampleInput(),
    sourceIp: '127.0.0.1',
  });
  await updateExtractionJob(baseDir, stale.id, (current) => {
    current.status = 'running';
    current.runner = {
      id: 'dead-runner',
      claimedAt: '2026-01-01T00:00:00.000Z',
      heartbeatAt: '2026-01-01T00:00:00.000Z',
      staleAfterMs: 1000,
    };
    return current;
  });
  await new Promise((r) => setTimeout(r, 5));
  const fresh = await createExtractionJob({
    baseDir,
    userId: 'user-b',
    input: sampleInput(),
    sourceIp: '127.0.0.1',
  });

  const claimed = await claimNextExtractionJob(baseDir, {
    runnerId: 'runner-4',
    staleAfterMs: 1000,
  });

  assert.equal(claimed?.id, fresh.id);
});
