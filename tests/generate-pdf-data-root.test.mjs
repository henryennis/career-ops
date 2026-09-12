// tests/generate-pdf-data-root.test.mjs — the PDF step's workspace guard
// follows the data root, the same root every other read in that file uses.
//
// generate-pdf.mjs reads cv.md, the profile and its output directory from
// getCareerOpsRoot(), but the check that refuses input and output paths
// outside the workspace derived its root from the install directory unless
// CAREER_OPS_TRACKER was set. For a user whose personal files live outside the
// checkout (the layout the .career-ops-data marker exists for) every render
// into their own output/ was refused as escaping the workspace. Pinned here
// both in-process, through the exported output-path predicate, and through
// the CLI, whose refusal happens before any browser is needed.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { pass, fail, ROOT, NODE } from './helpers.mjs';

console.log('\ngenerate-pdf-data-root.test.mjs — the workspace guard is anchored to the data root');

const dataRoot = mkdtempSync(join(tmpdir(), 'cops-data-root-'));
process.on('exit', () => {
  try {
    rmSync(dataRoot, { recursive: true, force: true });
  } catch {
    // A fixture that cannot be removed must not change the suite's verdict.
  }
});
mkdirSync(join(dataRoot, 'output'), { recursive: true });

const saved = { CAREER_OPS_ROOT: process.env.CAREER_OPS_ROOT, CAREER_OPS_DATA_DIR: process.env.CAREER_OPS_DATA_DIR, CAREER_OPS_TRACKER: process.env.CAREER_OPS_TRACKER };
function restore() {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// ── In-process: the exported predicate re-derives its root per environment ──

try {
  delete process.env.CAREER_OPS_ROOT;
  delete process.env.CAREER_OPS_TRACKER;
  process.env.CAREER_OPS_DATA_DIR = dataRoot;
  const { isWorkspaceOutputPath } = await import('../generate-pdf.mjs');

  if (isWorkspaceOutputPath(join(dataRoot, 'output', 'cv.pdf'))) pass('an output path under the data root is inside the workspace');
  else fail('an output path under the data root was refused (#3162 anchoring to the install directory)');

  if (!isWorkspaceOutputPath(join(ROOT, 'output', 'cv.pdf'))) pass('with a data root configured, the install directory is no longer the workspace');
  else fail('the install directory still counts as the workspace beside a configured data root');

  // The cache must follow the data-root variables, not only the tracker one:
  // a sibling test that sets and restores CAREER_OPS_DATA_DIR must not leave
  // this module anchored to its fixture.
  restore();
  delete process.env.CAREER_OPS_ROOT;
  delete process.env.CAREER_OPS_DATA_DIR;
  if (isWorkspaceOutputPath(join(ROOT, 'output', 'cv.pdf'))) pass('once the data-root variable is unset, the root is re-derived and the install directory is the workspace again');
  else fail('the guard stayed anchored to a data root that is no longer configured');
} finally {
  restore();
}

// ── CLI: the refusal used to happen before the browser was needed ───────────

{
  const input = join(dataRoot, 'output', 'cv.html');
  writeFileSync(input, '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><h1>Data Root</h1><p>A CV.</p></body></html>');
  const env = { ...process.env, CAREER_OPS_DATA_DIR: dataRoot, CAREER_OPS_PDF_INDEX: join(dataRoot, 'pdf-index.tsv') };
  delete env.CAREER_OPS_ROOT;
  delete env.CAREER_OPS_TRACKER;
  const result = spawnSync(NODE, [join(ROOT, 'generate-pdf.mjs'), input, join(dataRoot, 'output', 'cv.pdf'), '--skip-fact-check'], {
    cwd: ROOT, env, encoding: 'utf-8', timeout: 120_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  if (!/Refusing to write the PDF outside the tracker workspace/.test(output) && /Input:/.test(output)) {
    pass('the CLI accepts an input and an output inside the data root');
  } else {
    fail(`the CLI refused data-root paths: ${output.trim().split('\n').slice(0, 3).join(' | ')}`);
  }
  // Whether the render then succeeds depends on a browser being installed,
  // which is a different question from the one this file asks.
}
