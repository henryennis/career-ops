// set-status.mjs with the data root outside the code checkout.
//
// set-status resolved the tracker off its own directory, so with personal
// files in a separate data root (CAREER_OPS_ROOT, CAREER_OPS_DATA_DIR or the
// .career-ops-data marker) it reported "No tracker found" at the checkout,
// unless CAREER_OPS_TRACKER named the file directly. invite-match's data-root
// test sets CAREER_OPS_TRACKER, which is why it never saw this. These tests
// set only the root and leave the tracker to be found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const CODE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TRACKER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '| 1 | 2026-01-01 | Fabrikam | Engineer | 4.0/5 | Evaluated | ❌ | [1](../reports/001-fabrikam.md) | seeded |',
  '',
].join('\n');

function seedDataRoot() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-set-status-root-'));
  const tracker = join(dataRoot, 'data', 'applications.md');
  mkdirSync(dirname(tracker), { recursive: true });
  writeFileSync(tracker, TRACKER);
  return { dataRoot, tracker };
}

function runSetStatus(rootVariable, dataRoot, args) {
  const env = { ...process.env, [rootVariable]: dataRoot };
  for (const name of ['CAREER_OPS_ROOT', 'CAREER_OPS_DATA_DIR', 'CAREER_OPS_TRACKER']) {
    if (name !== rootVariable) delete env[name];
  }
  const result = spawnSync(process.execPath, [join(CODE_ROOT, 'set-status.mjs'), ...args], {
    cwd: CODE_ROOT,
    env,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, `set-status failed to spawn: ${result.error?.message}`);
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

for (const rootVariable of ['CAREER_OPS_ROOT', 'CAREER_OPS_DATA_DIR']) {
  test(`finds the tracker under ${rootVariable} without CAREER_OPS_TRACKER`, () => {
    const { dataRoot, tracker } = seedDataRoot();
    try {
      const result = runSetStatus(rootVariable, dataRoot, ['1', 'Applied', '--note', 'sent']);
      assert.doesNotMatch(result.output, /No tracker found/, result.output);
      assert.equal(result.status, 0, result.output);
      const row = readFileSync(tracker, 'utf-8').split('\n').find((line) => line.startsWith('| 1 |'));
      assert.match(row, /\| Applied \|/, `tracker row was not advanced:\n${row}`);
      // The transition ledger is a sibling of the tracker, so it follows it into the data root.
      assert.ok(existsSync(join(dataRoot, 'data', 'status-log.tsv')), 'status-log.tsv was not written beside the tracker');
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
}

test('still validates states against the shipped states.yml', () => {
  const { dataRoot, tracker } = seedDataRoot();
  try {
    const result = runSetStatus('CAREER_OPS_ROOT', dataRoot, ['1', 'NotAState']);
    assert.notEqual(result.status, 0, 'an unknown state was accepted');
    assert.match(readFileSync(tracker, 'utf-8'), /\| Evaluated \|/, 'the tracker changed on a rejected state');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
