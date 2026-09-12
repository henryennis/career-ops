// tests/template-pack-renderer.test.mjs — a template pack may ship its own
// renderer, and the builder's guards hold around it.
//
// The placeholder fill gives every template the same document with different
// CSS. A pack that wants something the fill cannot express (a sidebar computed
// from the payload, skills weighted by how often the bullets back them) ships
// a render.mjs beside its template, and build-cv-html.mjs hands it the
// validated payload, the template text, the options it already resolved, and
// its own helpers. What the contract promises around that call is what this
// file pins:
//
//   - the renderer runs for a discovered pack, and only for one: the same file
//     beside a template handed over by arbitrary path is reported and ignored;
//   - validation still rejects a bad payload before the renderer sees it;
//   - the escaping helpers still hold for hostile strings, including the
//     `$&`-style patterns a string replacement would splice;
//   - the empty-section strip and the unresolved-placeholder check still run
//     on the renderer's output.
//
// The fixture pack is tests/fixtures/cv-template-packs/renderer-fixture, copied
// into a temporary data root so cv-templates.mjs discovers it there.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail, run, lastRunFailure, ROOT, NODE } from './helpers.mjs';

console.log('\nCV template pack renderers — build-cv-html.mjs runs a discovered pack\'s render.mjs');

const FIXTURE_PACK = join(ROOT, 'tests', 'fixtures', 'cv-template-packs', 'renderer-fixture');
const dataRoot = mkdtempSync(join(tmpdir(), 'pack-renderer-'));
process.on('exit', () => {
  try {
    rmSync(dataRoot, { recursive: true, force: true });
  } catch {
    // A fixture that cannot be removed must not change the suite's verdict.
  }
});

const userTemplates = join(dataRoot, 'templates');
mkdirSync(userTemplates, { recursive: true });
cpSync(FIXTURE_PACK, join(userTemplates, 'renderer-fixture'), { recursive: true });
const fixtureTemplate = join(userTemplates, 'renderer-fixture', 'cv-template.renderer-fixture.html');

// The builder reads the data root when it starts, so the environment goes to
// each spawn. CAREER_OPS_ROOT wins over CAREER_OPS_DATA_DIR when set.
const sentinel = join(dataRoot, 'renderer-ran');
const env = { ...process.env, CAREER_OPS_DATA_DIR: dataRoot, RENDERER_FIXTURE_SENTINEL: sentinel };
delete env.CAREER_OPS_ROOT;

const PAYLOAD = {
  lang: 'en',
  page_format: 'a4',
  candidate: { name: 'Renderer Fixture', email: 'fixture@example.com', location: 'Nowhere' },
  summary: 'Platform engineer.',
  competencies: ['Reliability'],
  experience: [{
    company: 'Fixture Works',
    role: 'Engineer',
    dates: '2023 - Present',
    bullets: [
      'Moved the platform onto Kubernetes.',
      'Cut Kubernetes upgrade time from a day to an hour.',
      'Wrote the Go services behind it.',
    ],
  }],
  projects: [],
  education: [{ title: 'BSc', org: 'Fixture University', year: '2020' }],
  certifications: [],
  awards: [],
  interests: ['Chess'],
  skills: [{ category: 'Platform', items: ['Kubernetes', 'Go', 'Terraform'] }],
};

/** Build `payload` through `templatePath`; returns the outcome either way. */
function build(label, payload, templatePath, extraArgs = []) {
  const input = join(dataRoot, `${label}.json`);
  const output = join(dataRoot, `${label}.html`);
  writeFileSync(input, JSON.stringify(payload));
  rmSync(sentinel, { force: true });
  const stdout = run(NODE, ['build-cv-html.mjs', ...extraArgs, input, output, templatePath], { env });
  const failure = stdout === null ? lastRunFailure() : null;
  return {
    ok: stdout !== null,
    stdout: stdout ?? failure?.stdout ?? '',
    stderr: failure?.stderr ?? '',
    status: failure?.status ?? 0,
    html: existsSync(output) ? readFileSync(output, 'utf-8') : null,
    rendererRan: existsSync(sentinel),
  };
}

// ── The renderer runs for a discovered pack ─────────────────────────────────

{
  const r = build('rendered', PAYLOAD, fixtureTemplate);
  if (!r.ok) {
    fail(`build through the fixture pack failed (exit ${r.status}): ${r.stderr.trim()}`);
  } else {
    if (r.rendererRan && r.html.includes('data-rendered-by="renderer-fixture"')) pass('a discovered pack\'s render.mjs produces the document');
    else fail('the renderer did not run for a discovered pack');

    if (r.html.includes('data-bullets="3"') && r.html.includes('data-page-format="a4"')) pass('the renderer sees the payload and the resolved options');
    else fail('payload or options did not reach the renderer as expected');

    // Kubernetes is in two bullets, Go in one, Terraform in none: a computed
    // value the placeholder fill cannot produce.
    if (r.html.includes('data-evidence="2">Kubernetes') && r.html.includes('data-evidence="1">Go') && r.html.includes('data-evidence="0">Terraform')) {
      pass('the renderer\'s own computation reaches the output');
    } else {
      fail('the evidence counts are missing or wrong');
    }

    if (r.html.includes('class="job"') && r.html.includes('Fixture Works') && r.html.includes('mailto:fixture@example.com')) pass('helpers.fillTemplate keeps the default fill for the rest of the document');
    else fail('the default fill did not apply around the renderer\'s section');

    // projects, certifications and awards are empty in the payload.
    const leftover = ['PROJECTS', 'CERTIFICATIONS', 'AWARDS'].filter((m) => r.html.includes(`<!-- ${m} -->`));
    if (leftover.length === 0 && r.html.includes('<!-- WORK EXPERIENCE -->') && r.html.includes('<!-- SKILLS -->')) {
      pass('empty sections are stripped from the renderer\'s output and populated markers stay');
    } else {
      fail(`empty-section strip on renderer output: leftover ${leftover.join(', ')}`);
    }

    if (r.html.trimEnd().endsWith('</html>')) pass('the document still closes after the strip');
    else fail('the strip swallowed the document tail');

    let report = null;
    try {
      report = JSON.parse(r.stdout);
    } catch {
      report = null;
    }
    if (report?.valid === true && typeof report.renderer === 'string' && report.renderer.endsWith('render.mjs')) pass('the JSON report names the renderer that ran');
    else fail(`report did not name the renderer: ${r.stdout.slice(0, 200)}`);
  }
}

// ── --preview goes through the same path ────────────────────────────────────

{
  const input = join(dataRoot, 'preview.json');
  writeFileSync(input, JSON.stringify(PAYLOAD));
  const stdout = run(NODE, ['build-cv-html.mjs', '--preview', input, fixtureTemplate], { env });
  const previewPath = join(dataRoot, 'output', 'cv-preview.html');
  if (stdout !== null && existsSync(previewPath) && readFileSync(previewPath, 'utf-8').includes('data-rendered-by="renderer-fixture"')) {
    pass('--preview renders through the pack renderer into the data root');
  } else {
    fail(`--preview did not use the renderer: ${lastRunFailure()?.stderr || ''}`);
  }
}

// ── Escaping holds for hostile strings ──────────────────────────────────────

{
  const hostile = {
    ...PAYLOAD,
    experience: [{
      company: '<script>alert(1)</script> & Co',
      role: 'Engineer <b>bold</b>',
      dates: '2023',
      bullets: ['Saved $& and $\' for "them" on Kubernetes'],
    }],
    skills: [{ category: 'Injected <i>', items: ['<img src=x onerror=alert(1)>', 'Kubernetes'] }],
  };
  const r = build('hostile', hostile, fixtureTemplate);
  if (!r.ok) {
    fail(`hostile build failed (exit ${r.status}): ${r.stderr.trim()}`);
  } else {
    const rawTags = /<script>|<img src=x|<b>bold<\/b>|<i>/.test(r.html);
    const escaped = r.html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co')
      && r.html.includes('&lt;img src=x onerror=alert(1)&gt;')
      && r.html.includes('Injected &lt;i&gt;');
    if (!rawTags && escaped) pass('hostile strings reach the output escaped, through the default fill and the renderer\'s own markup');
    else fail('hostile strings were not escaped in the renderer path');

    if (r.html.includes('Saved $&amp; and $&#39; for &quot;them&quot;')) pass('$-patterns survive literally (replacer functions, not replacement strings)');
    else fail('a $-pattern was spliced or lost in the renderer path');
  }
}

// ── Validation rejects a bad payload before the renderer sees it ────────────

{
  const bad = { ...PAYLOAD, education: [{ institution: 'Fixture University', degree: 'BSc', dates: '2020' }] };
  const r = build('bad', bad, fixtureTemplate);
  if (!r.ok && r.status === 1 && r.stderr.includes('Invalid CV payload') && r.html === null && !r.rendererRan) {
    pass('a payload with the wrong keys is rejected before the renderer runs, and nothing is written');
  } else {
    fail(`bad payload: ok=${r.ok} status=${r.status} rendererRan=${r.rendererRan} html=${r.html !== null}`);
  }
}

// ── The guards after the renderer still run ─────────────────────────────────

/** An ad-hoc pack in the data root whose renderer is `source`. */
function adHocPack(name, source) {
  const dir = join(userTemplates, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `cv-template.${name}.html`), readFileSync(fixtureTemplate, 'utf-8'));
  writeFileSync(join(dir, 'render.mjs'), source);
  return join(dir, `cv-template.${name}.html`);
}

{
  const template = adHocPack('leftover', 'export function render() { return "<html><body><!-- SKILLS -->{{NOPE}}<!-- END --></body></html>"; }\n');
  const r = build('leftover', PAYLOAD, template);
  if (!r.ok && r.stderr.includes('Unresolved placeholders: {{NOPE}}') && r.html === null) pass('a placeholder the renderer leaves behind still fails the build');
  else fail(`leftover placeholder: ok=${r.ok} stderr=${r.stderr.trim().split('\n')[0]}`);
}

{
  const template = adHocPack('notastring', 'export function render() { return 42; }\n');
  const r = build('notastring', PAYLOAD, template);
  if (!r.ok && r.stderr.includes('must return the full HTML document') && r.html === null) pass('a renderer that does not return a document fails the build with the reason');
  else fail(`non-string renderer: ok=${r.ok} stderr=${r.stderr.trim().split('\n')[0]}`);
}

{
  const template = adHocPack('noexport', 'export const render = "not a function";\n');
  const r = build('noexport', PAYLOAD, template);
  if (!r.ok && r.stderr.includes('must export a render function')) pass('a render.mjs without a render function fails the build with the reason');
  else fail(`missing export: ok=${r.ok} stderr=${r.stderr.trim().split('\n')[0]}`);
}

// ── Only a discovered pack may supply a renderer ────────────────────────────

{
  // The same files, outside every template root: the renderer beside them is
  // reported and ignored, and the placeholder fill produces the document.
  const elsewhere = join(dataRoot, 'elsewhere', 'renderer-fixture');
  cpSync(FIXTURE_PACK, elsewhere, { recursive: true });
  const r = build('undiscovered', PAYLOAD, join(elsewhere, 'cv-template.renderer-fixture.html'));
  if (r.ok && !r.rendererRan && !r.html.includes('data-rendered-by')) pass('a render.mjs beside a template that is not a discovered pack does not run');
  else fail(`undiscovered renderer: ok=${r.ok} rendererRan=${r.rendererRan}`);

  // run() returns stdout only; the warning goes to stderr, so it is read from
  // a direct spawn of the same command.
  const input = join(dataRoot, 'undiscovered.json');
  const output = join(dataRoot, 'undiscovered-again.html');
  const { spawnSync } = await import('child_process');
  const direct = spawnSync(NODE, ['build-cv-html.mjs', input, output, join(elsewhere, 'cv-template.renderer-fixture.html')], { cwd: ROOT, env, encoding: 'utf-8', timeout: 30_000 });
  if (direct.status === 0 && /render\.mjs ignored/.test(direct.stderr) && /not a discovered template pack/.test(direct.stderr)) {
    pass('the ignored renderer is reported on stderr with the reason');
  } else {
    fail(`no warning for the ignored renderer: ${direct.stderr.trim().split('\n')[0]}`);
  }

  let report = null;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    report = null;
  }
  if (report && !('renderer' in report)) pass('the report carries no renderer when none ran');
  else fail(`report unexpectedly named a renderer: ${r.stdout.slice(0, 200)}`);
}

// ── The lookup behind that boundary ─────────────────────────────────────────
//
// The builder decides "discovered pack or not" with the resolver's lookup by
// path. Pinned in-process against the same fixtures: the resolver reads the
// environment per call, so pointing it at the data root here is enough.

{
  const { findTemplateEntry } = await import('../cv-templates.mjs');
  const saved = { CAREER_OPS_ROOT: process.env.CAREER_OPS_ROOT, CAREER_OPS_DATA_DIR: process.env.CAREER_OPS_DATA_DIR };
  delete process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_DATA_DIR = dataRoot;
  try {
    const packEntry = findTemplateEntry('cv', fixtureTemplate);
    const flat = findTemplateEntry('cv', join(ROOT, 'templates', 'cv-template.html'));
    const stray = findTemplateEntry('cv', join(dataRoot, 'elsewhere', 'renderer-fixture', 'cv-template.renderer-fixture.html'));
    if (packEntry?.pack === 'renderer-fixture' && flat?.pack === null && flat?.name === 'standard' && stray === null) {
      pass('findTemplateEntry answers pack, flat and not-discovered for a template path');
    } else {
      fail(`findTemplateEntry gave ${JSON.stringify({ pack: packEntry?.pack, flat: flat?.name, stray })}`);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
