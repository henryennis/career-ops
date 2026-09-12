#!/usr/bin/env node
// fork/preview-cv-template.mjs: render a fictional sample CV through a
// template, to HTML and optionally to PDF, and audit the result.
//
//   node fork/preview-cv-template.mjs <name> [--pdf] [--payload <file>]
//
// Output lands in <data root>/output/cv-template-preview/<name>.html (and
// .pdf). The default payload is fork/cv-template-kit/sample-cv-payload.json, a
// made-up candidate, so the PDF step runs with the fact gate off (it would
// compare the sample's numbers against your cv.md) and the section-order
// guard downgraded to a warning. A real CV built through the pdf mode keeps
// both. The PDF manifest the generator appends to is redirected into the
// preview directory, so data/pdf-index.tsv never carries a preview row.
//
// After the build, verify-ats.mjs scores the HTML, so a layout decision is
// made with its parse cost in view.

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { isMainModule } from '../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { resolveTemplate } from '../cv-templates.mjs';

const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PAYLOAD = join(codeRoot, 'fork', 'cv-template-kit', 'sample-cv-payload.json');

function usage() {
  return [
    'Usage: node fork/preview-cv-template.mjs <name> [--pdf] [--payload <file>]',
    '',
    'Render the sample CV through template <name> into <data root>/output/cv-template-preview/.',
    '  --pdf             also render the PDF (needs the Playwright browser)',
    '  --payload <file>  a CV payload to render instead of the fictional sample',
  ].join('\n');
}

export function parseArguments(argv) {
  const options = { name: null, pdf: false, payload: DEFAULT_PAYLOAD, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--pdf') options.pdf = true;
    else if (argument === '--payload') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error('--payload needs a file');
      options.payload = value;
      index += 1;
    } else if (argument.startsWith('-')) throw new Error(`unknown flag ${argument}`);
    else if (options.name === null) options.name = argument;
    else throw new Error(`unexpected argument ${argument}`);
  }
  return options;
}

function runScript(script, args, { capture, env }) {
  const result = spawnSync(process.execPath, [join(codeRoot, script), ...args], {
    cwd: codeRoot,
    encoding: 'utf-8',
    env,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  return result;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Build, audit and optionally print. Returns the paths and the parsed reports.
 * Throws with a printable message when a step fails.
 */
export function preview({ name, pdf = false, payload = DEFAULT_PAYLOAD, log = console.log }) {
  if (!name) throw new Error(`a template name is required\n${usage()}`);
  const templatePath = resolveTemplate('cv', name);
  const payloadPath = resolve(payload);
  if (!existsSync(payloadPath)) throw new Error(`payload not found: ${payloadPath}`);

  const outputDirectory = join(getCareerOpsRoot(), 'output', 'cv-template-preview');
  mkdirSync(outputDirectory, { recursive: true });
  const htmlPath = join(outputDirectory, `${name}.html`);
  const pdfPath = join(outputDirectory, `${name}.pdf`);
  const env = { ...process.env, CAREER_OPS_PDF_INDEX: join(outputDirectory, 'pdf-index.tsv') };

  log(`template: ${templatePath}`);
  log(`payload:  ${payloadPath}`);

  const build = runScript('build-cv-html.mjs', [payloadPath, htmlPath, templatePath], { capture: true, env });
  if (build.stderr.trim()) process.stderr.write(build.stderr);
  if (build.status !== 0) throw new Error(`build-cv-html.mjs exited ${build.status}`);
  const report = parseJson(build.stdout);
  log(`html:     ${htmlPath}${report?.renderer ? `  (renderer: ${report.renderer})` : ''}`);

  // Advisory: the audit exits non-zero below its own threshold, and that is
  // information for the designer, not a failure of the preview.
  const audit = runScript('verify-ats.mjs', [htmlPath, '--json'], { capture: true, env });
  const auditReport = parseJson(audit.stdout);
  if (auditReport) {
    log(`ats:      score ${auditReport.score}/100, grade ${auditReport.grade}${auditReport.pass ? '' : ' (below verify-ats.mjs\'s default threshold)'}`);
    for (const issue of auditReport.issues || []) log(`          ${issue.severity}: ${issue.message}`);
  } else {
    log(`ats:      verify-ats.mjs exited ${audit.status}: ${(audit.stderr || audit.stdout).trim().split('\n')[0]}`);
  }

  if (pdf) {
    const pageFormat = parseJson(readFileSync(payloadPath, 'utf-8'))?.page_format === 'letter' ? 'letter' : 'a4';
    const render = runScript('generate-pdf.mjs', [htmlPath, pdfPath, `--format=${pageFormat}`, '--skip-fact-check', '--allow-reorder'], { capture: false, env });
    if (render.status !== 0) throw new Error(`generate-pdf.mjs exited ${render.status}`);
    log(`pdf:      ${pdfPath}`);
    log('          fact gate skipped (the sample candidate is fictional); section-order guard warns instead of failing');
  }

  return { templatePath, htmlPath, pdfPath: pdf ? pdfPath : null, report, audit: auditReport };
}

if (isMainModule(import.meta.url)) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`preview-cv-template: ${error.message}\n${usage()}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  try {
    preview(options);
  } catch (error) {
    console.error(`preview-cv-template: ${error.message}`);
    process.exit(1);
  }
}
