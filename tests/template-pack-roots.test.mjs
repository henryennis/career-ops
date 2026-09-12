// tests/template-pack-roots.test.mjs — a template pack kept in the data root
// is discovered, resolves by name, can be the profile default, and renders end
// to end with its own partials and fonts.
//
// The data root (path-resolver.mjs) is where a user's personal files live when
// the checkout must stay clean: a public fork, an install upgraded by
// update-system.mjs. A template is as personal as a CV, and until now the only
// place discovery looked was the code tree's templates/, so a user's pack had
// to sit inside the system layer. cv-templates.mjs now scans
// <data root>/templates as a second root, on the same rules and the same
// collision check, and reads the `cv.template` default from the data root's
// profile the way generate-pdf.mjs already reads `style:` from it.
//
// Fonts are the part that is easy to get wrong from the outside: the shipped
// templates reference url('./fonts/<file>') and generate-pdf.mjs inlines those
// from the code tree's fonts/ at render time. A pack's own fonts/ is out of
// that directory's reach, so build-cv-html.mjs inlines them while it still
// knows the template path. Asserted here against a real build.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail, run, lastRunFailure, ROOT, NODE } from './helpers.mjs';
import { listTemplates, resolveTemplate, templateRoots } from '../cv-templates.mjs';

console.log('\nCV template packs in the data root — discovery, resolution, profile default, fonts');

const CV_BODY = '{{NAME}}{{EXPERIENCE}}{{EDUCATION}}';

// A complete template for the end-to-end build: section markers, the contact
// row the builder rebuilds, and two font references — one the pack ships, one
// it does not, so the test can tell "inlined what exists" from "rewrote
// everything".
const PACK_TEMPLATE = `<!DOCTYPE html>
<html lang="{{LANG}}"><head><meta charset="UTF-8"><title>{{NAME}}</title>
<style>
  @font-face { font-family: "PackFont"; src: url('./fonts/pack-font.woff2') format('woff2'); }
  @font-face { font-family: "Absent"; src: url('./fonts/missing.woff2') format('woff2'); }
  .page { max-width: {{PAGE_WIDTH}}; }
</style></head>
<body><div class="page">
  <!-- HEADER -->
  <h1>{{NAME}}</h1>
  <div class="contact-row"><a href="mailto:{{EMAIL}}">{{EMAIL}}</a><span class="separator">|</span><span>{{LOCATION}}</span></div>
  <!-- WORK EXPERIENCE -->
  <div class="section"><div class="section-title">{{SECTION_EXPERIENCE}}</div>{{EXPERIENCE}}</div>
  <!-- EDUCATION -->
  <div class="section"><div class="section-title">{{SECTION_EDUCATION}}</div>{{EDUCATION}}</div>
  <!-- SKILLS -->
  <div class="section"><div class="section-title">{{SECTION_SKILLS}}</div>{{SKILLS}}</div>
  <!-- END -->
</div></body></html>
`;

const PAYLOAD = {
  lang: 'en',
  page_format: 'a4',
  candidate: { name: 'Pack Fixture', email: 'pack@example.com', location: 'Nowhere' },
  experience: [{ company: 'Fixture Works', role: 'Engineer', dates: '2024', bullets: ['Built a thing.'] }],
  education: [{ title: 'BSc', org: 'Fixture University', year: '2020' }],
  skills: [{ category: 'Languages', items: ['JavaScript'] }],
};

// ── Fixture data root ───────────────────────────────────────────────────────

const dataRoot = mkdtempSync(join(tmpdir(), 'pack-roots-'));
process.on('exit', () => {
  try {
    rmSync(dataRoot, { recursive: true, force: true });
  } catch {
    // A fixture that cannot be removed must not change the suite's verdict.
  }
});

const userTemplates = join(dataRoot, 'templates');
const packDir = join(userTemplates, 'mine');
mkdirSync(join(packDir, 'sections'), { recursive: true });
mkdirSync(join(packDir, 'fonts'), { recursive: true });
writeFileSync(join(packDir, 'cv-template.mine.html'), PACK_TEMPLATE);
// A partial with a class no shipped partial uses, so the built output proves
// the pack's own sections/ was resolved and not the shared one.
writeFileSync(join(packDir, 'sections', 'experience.html'),
  '<!--ENTRY--><div class="mine-job">{{ROLE}} at {{COMPANY}}</div><!--/ENTRY-->');
writeFileSync(join(packDir, 'fonts', 'pack-font.woff2'), Buffer.from('wOF2-fixture-bytes'));
mkdirSync(join(userTemplates, 'letters'), { recursive: true });
writeFileSync(join(userTemplates, 'letters', 'cover-letter-template.plain.html'), '{{NAME}}{{ROLE_TITLE}}{{OPENING}}');
mkdirSync(join(dataRoot, 'config'), { recursive: true });
writeFileSync(join(dataRoot, 'config', 'profile.yml'), 'cv:\n  template: mine\n');

// The resolver reads the environment per call, so it can be pointed at the
// fixture in-process. CAREER_OPS_ROOT wins over CAREER_OPS_DATA_DIR and
// CAREER_OPS_PROFILE bypasses the data root's profile, so both are cleared for
// the duration and restored exactly afterwards.
const saved = {
  CAREER_OPS_ROOT: process.env.CAREER_OPS_ROOT,
  CAREER_OPS_DATA_DIR: process.env.CAREER_OPS_DATA_DIR,
  CAREER_OPS_PROFILE: process.env.CAREER_OPS_PROFILE,
};
function restoreEnv() {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
function pointAtFixture() {
  delete process.env.CAREER_OPS_ROOT;
  delete process.env.CAREER_OPS_PROFILE;
  process.env.CAREER_OPS_DATA_DIR = dataRoot;
}
// Spawned processes get the same view, built from the same cleared variables.
const spawnEnv = { ...process.env, CAREER_OPS_DATA_DIR: dataRoot };
delete spawnEnv.CAREER_OPS_ROOT;
delete spawnEnv.CAREER_OPS_PROFILE;

const names = (kind) => listTemplates(kind).map((t) => t.name);

try {
  pointAtFixture();

  // ── Discovery ───────────────────────────────────────────────────────────

  {
    const roots = templateRoots();
    if (roots.length === 2 && roots[0] === join(ROOT, 'templates') && roots[1] === userTemplates) {
      pass('templateRoots() lists the code tree first and the data root second');
    } else {
      fail(`templateRoots() returned ${JSON.stringify(roots)}`);
    }
  }

  {
    const found = names('cv');
    if (found.includes('mine') && found.includes('standard') && found.includes('modern')) {
      pass('a pack in the data root lists alongside the shipped templates');
    } else {
      fail(`expected mine + shipped names — got ${found.join(', ')}`);
    }

    const entry = listTemplates('cv').find((t) => t.name === 'mine');
    if (entry?.pack === 'mine' && entry?.root === userTemplates) {
      pass('the entry reports its pack directory and the root it was found under');
    } else {
      fail(`entry for mine was ${JSON.stringify(entry)}`);
    }
  }

  {
    const found = names('cover');
    if (found.includes('plain')) pass('cover-letter packs in the data root are discovered on the same rule');
    else fail(`cover pack not discovered — got ${found.join(', ')}`);
  }

  // ── Resolution ──────────────────────────────────────────────────────────

  {
    let path;
    try {
      path = resolveTemplate('cv', 'mine');
    } catch (e) {
      path = `threw: ${e.message}`;
    }
    if (path === join(packDir, 'cv-template.mine.html')) pass('a data-root pack resolves by name to its own file');
    else fail(`resolved to ${path}`);
  }

  {
    // The profile lives in the data root; a default declared there must apply.
    let path;
    try {
      path = resolveTemplate('cv', undefined);
    } catch (e) {
      path = `threw: ${e.message}`;
    }
    if (path === join(packDir, 'cv-template.mine.html')) pass('cv.template in the data root profile selects the pack when no name is given');
    else fail(`profile default resolved to ${path}`);
  }

  // ── Collisions across roots ─────────────────────────────────────────────

  {
    const shadow = join(userTemplates, 'cv-template.modern.html');
    writeFileSync(shadow, CV_BODY);
    let message = null;
    try {
      listTemplates('cv');
    } catch (e) {
      message = e.message;
    }
    unlinkSync(shadow);
    const shipped = join(ROOT, 'templates', 'cv-template.modern.html');
    if (message && message.includes('claimed by two files') && message.includes(shipped) && message.includes(shadow)) {
      pass('a data-root template claiming a shipped name throws, naming both files in full');
    } else {
      fail(`cross-root collision gave: ${message}`);
    }
  }

  // ── CLI ─────────────────────────────────────────────────────────────────

  {
    const resolved = run(NODE, ['cv-templates.mjs', 'resolve', 'cv', 'mine'], { env: spawnEnv });
    if (resolved === join(packDir, 'cv-template.mine.html')) pass('CLI: resolve cv <name> finds the data-root pack');
    else fail(`CLI resolve gave ${resolved} ${lastRunFailure()?.stderr || ''}`);

    const listed = run(NODE, ['cv-templates.mjs', 'list', 'cv'], { env: spawnEnv });
    let parsed = null;
    try {
      parsed = JSON.parse(listed || 'null');
    } catch {
      parsed = null;
    }
    if (Array.isArray(parsed) && parsed.some((t) => t.name === 'mine')) pass('CLI: list cv includes the data-root pack');
    else fail(`CLI list gave ${listed}`);
  }

  // ── End to end: partials and fonts come from the pack ───────────────────

  {
    const input = join(dataRoot, 'payload.json');
    const output = join(dataRoot, 'mine.html');
    writeFileSync(input, JSON.stringify(PAYLOAD));
    const built = run(NODE, ['build-cv-html.mjs', input, output, join(packDir, 'cv-template.mine.html')], { env: spawnEnv });
    if (built === null) {
      const f = lastRunFailure();
      fail(`build-cv-html.mjs failed against the data-root pack (exit ${f?.status}): ${(f?.stderr || '').trim()}`);
    } else {
      const html = readFileSync(output, 'utf-8');
      if (html.includes('class="mine-job">Engineer at Fixture Works')) pass('the pack\'s own sections/ partials are used');
      else fail('the pack partial was not applied');

      const inlined = `url('data:font/woff2;base64,${Buffer.from('wOF2-fixture-bytes').toString('base64')}')`;
      if (html.includes(inlined) && !html.includes("./fonts/pack-font.woff2")) pass('a font shipped in the pack\'s fonts/ is inlined as a data URL');
      else fail('the pack font was not inlined');

      if (html.includes("url('./fonts/missing.woff2')")) pass('a font reference the pack does not ship is left for generate-pdf.mjs');
      else fail('an unmatched font reference was rewritten');

      if (!/\{\{[A-Z_]+\}\}/.test(html)) pass('no placeholder is left unresolved');
      else fail('unresolved placeholders in the pack build');
    }
  }

  // ── Without a data root, nothing changes ────────────────────────────────

  {
    restoreEnv();
    // The suite runs with the code directory as data root (no marker, no
    // variable), so the second root collapses into the first. A developer's
    // own marker may add a root, but never this fixture's.
    const roots = templateRoots();
    const found = names('cv');
    if (!roots.includes(userTemplates) && !found.includes('mine')) {
      pass('with the fixture data root unset its pack is not discovered');
    } else {
      fail(`fixture leaked: roots=${JSON.stringify(roots)} names=${found.join(', ')}`);
    }
    if (roots[0] === join(ROOT, 'templates')) pass('the code tree stays the first root');
    else fail(`first root was ${roots[0]}`);
  }
} finally {
  restoreEnv();
}

if (!existsSync(join(ROOT, 'templates', 'cv-template.html'))) {
  fail('the base template is missing from the code tree — the checks above ran against the wrong root');
}
