// tests/fork-cv-template-kit.test.mjs: the fork's template kit scaffolds a
// pack into a data root, installs the example pack, and previews it through
// the real builder with every guard still satisfied.
//
// Fork-only (fork/ is not upstream's), additive, and kept under tests/ so the
// sync loop's test step runs it: a change upstream makes to the builder, the
// resolver or the section-order guard that breaks the kit or the example pack
// shows up on the next fork/sync-upstream.sh rather than at design time.

import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail, run, lastRunFailure, ROOT, NODE } from './helpers.mjs';

console.log('\nfork/ CV template kit: scaffold, install the example pack, preview');

const dataRoot = mkdtempSync(join(tmpdir(), 'cv-kit-'));
process.on('exit', () => {
  try {
    rmSync(dataRoot, { recursive: true, force: true });
  } catch {
    // A fixture that cannot be removed must not change the suite's verdict.
  }
});

const env = { ...process.env, CAREER_OPS_DATA_DIR: dataRoot };
delete env.CAREER_OPS_ROOT;
delete env.CAREER_OPS_PROFILE;

const kit = (script, args, extraEnv = {}) => run(NODE, [join(ROOT, 'fork', script), ...args], { env: { ...env, ...extraEnv } });
const stderrTail = () => (lastRunFailure()?.stderr || '').trim().split('\n').pop() || '';
const previewDirectory = join(dataRoot, 'output', 'cv-template-preview');
const EXAMPLE_PACK = join(ROOT, 'fork', 'cv-template-kit', 'packs', 'evidence-sidebar');
const MARKERS = ['HEADER', 'PROFESSIONAL SUMMARY', 'CORE COMPETENCIES', 'WORK EXPERIENCE', 'PROJECTS', 'EDUCATION', 'CERTIFICATIONS', 'AWARDS', 'INTERESTS', 'SKILLS', 'END'];

// ── Scaffold from a shipped template ────────────────────────────────────────

{
  const out = kit('new-cv-template.mjs', ['kit-plain']);
  const pack = join(dataRoot, 'templates', 'kit-plain');
  const template = join(pack, 'cv-template.kit-plain.html');
  if (out !== null && existsSync(template) && existsSync(join(pack, 'sections', 'experience.html')) && existsSync(join(pack, 'README.md')) && !existsSync(join(pack, 'render.mjs'))) {
    pass('scaffolds a pack with the template, the shared partials and a README, and no renderer unless asked');
  } else {
    fail(`scaffold from modern: ${out === null ? stderrTail() : 'files missing'}`);
  }

  if (existsSync(template) && /name: Kit Plain/.test(readFileSync(template, 'utf-8'))) pass('the template header carries the new display name');
  else fail('the copied template still carries the source display name');

  const resolved = run(NODE, ['cv-templates.mjs', 'resolve', 'cv', 'kit-plain'], { env });
  if (resolved === template) pass('the scaffolded pack resolves by name with no registration step');
  else fail(`resolve gave ${resolved} ${stderrTail()}`);

  if (out && out.includes('preview-cv-template.mjs kit-plain') && out.includes('cv.template: kit-plain')) pass('the scaffold prints the preview command and the profile line');
  else fail('the scaffold output lacks the next steps');
}

// ── --renderer adds the stub, and the stub renders ──────────────────────────

{
  const out = kit('new-cv-template.mjs', ['kit-stub', '--renderer']);
  const stub = join(dataRoot, 'templates', 'kit-stub', 'render.mjs');
  if (out !== null && existsSync(stub) && readFileSync(stub, 'utf-8').includes('export function render(')) pass('--renderer writes a render.mjs stub that states the contract');
  else fail(`--renderer: ${out === null ? stderrTail() : 'no stub'}`);

  const previewed = kit('preview-cv-template.mjs', ['kit-stub']);
  const html = join(previewDirectory, 'kit-stub.html');
  if (previewed !== null && existsSync(html) && previewed.includes('renderer:') && previewed.includes('ats:')) {
    pass('the preview builds through the stub renderer and reports the ATS audit');
  } else {
    fail(`preview through the stub: ${previewed === null ? stderrTail() : 'missing output or report lines'}`);
  }
}

// ── Refusals ────────────────────────────────────────────────────────────────

{
  const cases = [
    [['kit-plain'], 'already exists', 'a name already taken by a pack'],
    [['modern'], 'already exists', 'a name already taken by a shipped template'],
    [['Kit Plain'], 'not a valid template name', 'a name that is not kebab-case'],
    [['--from', 'no-such-template', 'kit-nope'], 'not found', 'a source template that does not exist'],
  ];
  for (const [args, expected, label] of cases) {
    const out = kit('new-cv-template.mjs', args);
    if (out === null && (lastRunFailure()?.stderr || '').includes(expected)) pass(`refuses ${label}`);
    else fail(`did not refuse ${label}: out=${out} stderr=${stderrTail()}`);
  }

  const inCheckout = kit('new-cv-template.mjs', ['kit-nope'], { CAREER_OPS_DATA_DIR: ROOT });
  if (inCheckout === null && (lastRunFailure()?.stderr || '').includes('data root is this checkout')) pass('refuses to scaffold into the code tree when the data root is the checkout');
  else fail(`scaffolded into the checkout: ${inCheckout} ${stderrTail()}`);
  if (!existsSync(join(ROOT, 'templates', 'kit-nope'))) pass('and left nothing behind in templates/');
  else fail('templates/kit-nope was created in the code tree');
}

// ── The example pack installs and renders through its renderer ──────────────

{
  const out = kit('new-cv-template.mjs', ['kit-evidence', '--pack', EXAMPLE_PACK]);
  const pack = join(dataRoot, 'templates', 'kit-evidence');
  if (out !== null && existsSync(join(pack, 'cv-template.kit-evidence.html')) && existsSync(join(pack, 'render.mjs')) && existsSync(join(pack, 'sections', 'experience.html')) && !existsSync(join(pack, 'cv-template.evidence-sidebar.html'))) {
    pass('--pack copies the example pack under the new name, renderer and partials included');
  } else {
    fail(`--pack install: ${out === null ? stderrTail() : 'unexpected files'}`);
  }

  const previewed = kit('preview-cv-template.mjs', ['kit-evidence']);
  const htmlPath = join(previewDirectory, 'kit-evidence.html');
  if (previewed === null || !existsSync(htmlPath)) {
    fail(`preview of the example pack failed: ${stderrTail()}`);
  } else {
    const html = readFileSync(htmlPath, 'utf-8');

    if (html.includes('data-rendered-by="evidence-sidebar"')) pass('the example pack renders through its renderer');
    else fail('the example renderer did not run');

    // The sample payload lists 16 skills; Kubernetes is mentioned in several
    // lines, Kafka in none.
    const kubernetes = html.match(/data-evidence="(\d+)"><span class="skill-name">Kubernetes</);
    const kafka = html.match(/data-evidence="(\d+)"><span class="skill-name">Kafka</);
    if (html.includes('data-skills-total="16"') && kubernetes && Number(kubernetes[1]) >= 3 && kafka && kafka[1] === '0') {
      pass('skills carry evidence counts computed from the payload text');
    } else {
      fail(`evidence counts: total=${/data-skills-total="(\d+)"/.exec(html)?.[1]} kubernetes=${kubernetes?.[1]} kafka=${kafka?.[1]}`);
    }

    if (html.includes('class="skill skill--unbacked" data-evidence="0"><span class="skill-name">Kafka')) pass('an unbacked skill is marked as such');
    else fail('the unbacked skill is not marked');

    if (/\d/.test(html.match(/<p class="evidence-legend">([\s\S]*?)<\/p>/)?.[1] || '')) fail('the evidence legend prints a number, which the fact gate would question');
    else pass('the evidence legend prints no number');

    const missing = MARKERS.filter((marker) => !html.includes(`<!-- ${marker} -->`));
    if (missing.length === 0 && html.includes('<!-- END MAIN -->')) pass('every section marker and both sentinels survive the render');
    else fail(`markers missing: ${missing.join(', ')}`);

    if (!/\{\{[A-Z_]+\}\}/.test(html)) pass('no placeholder is left unresolved');
    else fail('unresolved placeholders in the example render');

    if (html.includes('Staff Platform Engineer') && html.includes('class="job-location">, Melbourne') && html.includes('mailto:morgan.vale@example.com')) pass('the pack partial and the rebuilt contact row reach the output');
    else fail('pack partial or contact row missing from the output');

    if (previewed.includes('ats:      score') && !previewed.includes('critical:')) pass('the ATS audit reports no critical issue for the example pack');
    else fail(`ATS audit line: ${previewed.split('\n').filter((line) => line.startsWith('ats:') || line.includes('critical')).join(' | ')}`);
  }
}

// ── The example pack stays within the section-order tools ───────────────────

{
  const htmlPath = join(previewDirectory, 'kit-evidence.html');
  if (!existsSync(htmlPath)) {
    fail('no example render to check the section-order tools against');
  } else {
    const html = readFileSync(htmlPath, 'utf-8');
    const { validateCvSectionOrder, reorderCvSections } = await import('../generate-pdf.mjs');
    const canonicalCv = ['# Name', '## Professional Summary', '## Core Competencies', '## Work Experience', '## Projects', '## Education', '## Certifications', '## Awards', '## Interests', '## Skills'].join('\n');
    try {
      validateCvSectionOrder(html, canonicalCv, { allowReorder: false });
      pass('the rail-second document order satisfies the section-order guard against a canonical cv.md');
    } catch (error) {
      fail(`section-order guard rejected the example pack: ${error.message}`);
    }

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    let reordered;
    try {
      reordered = reorderCvSections(html, ['education', 'projects']);
    } finally {
      console.warn = originalWarn;
    }
    const educationFirst = reordered.indexOf('<!-- EDUCATION -->') < reordered.indexOf('<!-- PROJECTS -->');
    if (educationFirst && warnings.length === 0 && reordered.trimEnd().endsWith('</html>')) pass('cv.sections can permute the example pack\'s main-column sections without a warning');
    else fail(`reorder: educationFirst=${educationFirst} warnings=${warnings.join(' | ')}`);
  }
}
