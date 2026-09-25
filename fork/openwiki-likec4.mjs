#!/usr/bin/env node

/**
 * openwiki-likec4.mjs — put LikeC4 views inside an OpenWiki wiki.
 *
 * OpenWiki (langchain-ai/openwiki) writes a Markdown wiki under `openwiki/` and
 * browses it with `openwiki visualize`. LikeC4 (likec4.dev) holds the
 * architecture as `.c4` source under `fork/likec4/src`. This script is the join
 * between them, and it exists because the join is not a one-liner.
 *
 * ## Why two lanes and not one
 *
 * The visualizer renders a page body as
 * `DOMPurify.sanitize(marked.parse(stripFrontmatter(body)))`, served under
 * `default-src 'none'; script-src 'self' https://cdn.jsdelivr.net` from a
 * closed route table. Three gates sit between a wiki page and an interactive
 * `<likec4-view>`, and each one is enough on its own:
 *
 *   1. DOMPurify drops elements it does not know, and it does not know
 *      `likec4-view`. The `<script>` that would define it goes the same way.
 *   2. The CSP admits scripts from the server's own origin and jsDelivr. A
 *      bundle on disk somewhere else is not loadable.
 *   3. The server answers `/`, `/index.html`, `/client.js`, `/client-lib.js`,
 *      `/events` and `/c`, and 404s everything else, so there is nowhere to put
 *      the bundle for gate 2 to admit.
 *
 * What the visualizer *does* already carry is Mermaid 11: it loads the library
 * and calls `mermaid.run()` over fenced code blocks. LikeC4 renders any view to
 * Mermaid. So:
 *
 *   Lane A (`gen` + `embed`) writes a fenced ```mermaid block into the page.
 *   It renders in the visualizer, on GitHub, in VS Code, and in any Markdown
 *   viewer, at any OpenWiki version, with nothing patched. This is the default
 *   and the one to rely on.
 *
 *   Lane B (`export`) takes the static site `openwiki visualize --export`
 *   produces and adds the interactive component to that copy. It is our own
 *   output directory, so all three gates are ours to move: the bundle lands
 *   beside `index.html` (gate 3), `'self'` already admits it (gate 2), and a
 *   shim calls `DOMPurify.setConfig` before the client module runs so the
 *   client's own bare `sanitize()` calls inherit permission for the element
 *   (gate 1). Nothing under `node_modules` is edited.
 *
 * `DOMPurify.setConfig` is the load-bearing detail. It sets persistent config
 * for every later `sanitize()` call, which is what lets us widen the filter
 * without touching the code that calls it. A patched `client.js` would work
 * once and break on the next `npm i -g openwiki`.
 *
 * Usage:
 *   node fork/openwiki-likec4.mjs doctor          # what is installed, which lane is available
 *   node fork/openwiki-likec4.mjs gen             # validate the model, render Mermaid + the bundle
 *   node fork/openwiki-likec4.mjs embed           # fill the marked regions in openwiki/
 *   node fork/openwiki-likec4.mjs embed --check   # fail if any region is stale (for CI)
 *   node fork/openwiki-likec4.mjs export <dir>    # patch an exported visualizer for lane B
 *   node fork/openwiki-likec4.mjs --self-test
 *
 * Exit code: 0 on success, 1 on any failure. `gen` and `export` write; `embed`
 * writes unless `--check`; `doctor` is read-only.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, statSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../lib/is-main-module.mjs';
import { listTree } from '../lib/walk-tree.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LIKEC4_DIR = join(REPO_ROOT, 'fork', 'likec4');
const LIKEC4_SRC = join(LIKEC4_DIR, 'src');
const GENERATED = join(LIKEC4_DIR, 'generated');
const MERMAID_DIR = join(GENERATED, 'mermaid');
const BUNDLE = join(GENERATED, 'likec4-views.js');
const WIKI_DIR = join(REPO_ROOT, 'openwiki');

/** The element the generated bundle registers, and the attributes it reads. */
const ELEMENT = 'likec4-view';
const ELEMENT_ATTRS = ['view-id', 'browser', 'color-scheme', 'dynamic-variant'];

/**
 * A page claims a view with a marker pair. Everything between the two lines
 * belongs to this script and is rewritten on every `embed`; everything outside
 * belongs to whoever wrote the page. The shape matches the markers already used
 * elsewhere in this project (`<!-- writing gate: begin -->` in `_custom.md`,
 * `<!-- HEADER -->` in the CV template), so a reader meets one convention.
 */
const OPEN_RE = /^<!-- likec4: *([A-Za-z_][\w.-]*) *-->$/;
const CLOSE = '<!-- /likec4 -->';

/** The first OpenWiki release whose `visualize` can export a static copy. */
const EXPORT_MIN_VERSION = [0, 6, 0];

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/**
 * Run the pinned LikeC4 binary. Never shells out to a global `likec4`: the
 * version is pinned in `fork/likec4/package.json` precisely so a diagram does
 * not change because a machine has a different one installed.
 */
function likec4(args, { quiet = true } = {}) {
  const bin = join(LIKEC4_DIR, 'node_modules', '.bin', 'likec4');
  if (!existsSync(bin)) {
    fail(`LikeC4 is not installed.\n  Run: npm install --prefix ${relative(REPO_ROOT, LIKEC4_DIR)}`);
  }
  const result = spawnSync(bin, args, {
    cwd: LIKEC4_DIR,
    encoding: 'utf-8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: 300_000,
  });
  // A pipeline hides a non-zero status, which is how a broken model gets
  // embedded as an empty diagram. Read the status off the child itself.
  return {
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/** Installed OpenWiki version as [major, minor, patch], or null if absent. */
function openwikiVersion() {
  const result = spawnSync('npm', ['ls', '-g', 'openwiki', '--depth=0', '--json'], {
    encoding: 'utf-8',
    timeout: 60_000,
  });
  if (result.status !== 0 && !result.stdout) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    const version = parsed?.dependencies?.openwiki?.version;
    if (typeof version !== 'string') return null;
    const parts = version.split('.').map((n) => Number.parseInt(n, 10));
    return parts.length === 3 && parts.every(Number.isInteger) ? parts : null;
  } catch {
    return null;
  }
}

function atLeast(version, minimum) {
  if (!version) return false;
  for (let i = 0; i < minimum.length; i += 1) {
    if (version[i] > minimum[i]) return true;
    if (version[i] < minimum[i]) return false;
  }
  return true;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * A path as a reader wants to see it: relative inside the repository, absolute
 * outside it. `relative()` alone turns a /tmp path into a ladder of `../`.
 */
function show(path) {
  const rel = relative(REPO_ROOT, path);
  return rel.startsWith('..') ? path : rel;
}

// ---------------------------------------------------------------------------
// Lane A: generate, then embed
// ---------------------------------------------------------------------------

/**
 * Validate the model, then render every view to Mermaid and build the web
 * component bundle. Validation runs first and stops the rest: a model with an
 * error still renders *something*, and a silently wrong diagram in a wiki is
 * worse than no diagram.
 */
function generate({ withBundle = true } = {}) {
  if (!existsSync(LIKEC4_SRC)) fail(`No LikeC4 sources at ${relative(REPO_ROOT, LIKEC4_SRC)}`);

  const validated = likec4(['validate', 'src']);
  if (!validated.ok) {
    console.error(validated.output.trim());
    fail('\nLikeC4 model is invalid. Nothing was generated.');
  }
  console.log('model: valid');

  mkdirSync(MERMAID_DIR, { recursive: true });
  const mermaid = likec4(['gen', 'mmd', 'src', '-o', MERMAID_DIR]);
  if (!mermaid.ok) {
    console.error(mermaid.output.trim());
    fail('Mermaid generation failed.');
  }
  const views = listViews();
  console.log(`mermaid: ${views.length} view(s) -> ${relative(REPO_ROOT, MERMAID_DIR)}`);

  if (withBundle) {
    const bundle = likec4(['gen', 'webcomponent', 'src', '-o', BUNDLE]);
    if (!bundle.ok) {
      console.error(bundle.output.trim());
      fail('Web component generation failed.');
    }
    const kb = Math.round(statSync(BUNDLE).size / 1024);
    console.log(`bundle:  ${relative(REPO_ROOT, BUNDLE)} (${kb} KB)`);
  }
  return views;
}

/** View ids, taken from the generated filenames so the list cannot drift. */
function listViews() {
  if (!existsSync(MERMAID_DIR)) return [];
  return readdirSync(MERMAID_DIR)
    .filter((name) => name.endsWith('.mmd'))
    .map((name) => name.slice(0, -4))
    .sort();
}

function mermaidFor(viewId) {
  const file = join(MERMAID_DIR, `${viewId}.mmd`);
  return existsSync(file) ? readFileSync(file, 'utf-8').trim() : null;
}

/** Every Markdown file under the wiki directory. */
function wikiPages(dir = WIKI_DIR) {
  if (!existsSync(dir)) return [];
  // lib/walk-tree.mjs is the repository's one recursive walker; it also keeps
  // the walk out of a nested checkout.
  return listTree(dir, {
    match: /\.md$/,
    skip: (entry) => entry.name.startsWith('.') || entry.name === 'node_modules',
  });
}

/**
 * Rewrite the marked regions of one page. Pure, so the tests can exercise it
 * without a filesystem.
 *
 * Returns the new text plus what was found: which views the page claims, and
 * which of those the model does not define. An unknown view is an error rather
 * than an empty block, because the failure it comes from is a renamed view, and
 * a silently empty diagram is how that goes unnoticed.
 */
export function embedInText(text, resolveView) {
  const lines = text.split('\n');
  const out = [];
  const claimed = [];
  const unknown = [];
  let index = 0;

  while (index < lines.length) {
    const opened = OPEN_RE.exec(lines[index].trim());
    if (!opened) {
      out.push(lines[index]);
      index += 1;
      continue;
    }
    const viewId = opened[1];
    claimed.push(viewId);

    // Find the close. An unclosed marker consumes the rest of the file if we
    // let it, so treat a missing close as an error and leave the page alone.
    let end = index + 1;
    while (end < lines.length && lines[end].trim() !== CLOSE) end += 1;
    if (end >= lines.length) {
      throw new Error(`marker for "${viewId}" is never closed with ${CLOSE}`);
    }

    const mermaid = resolveView(viewId);
    if (mermaid === null || mermaid === undefined) unknown.push(viewId);

    out.push(lines[index]);
    out.push(...renderBlock(viewId, mermaid));
    out.push(CLOSE);
    index = end + 1;
  }

  return { text: out.join('\n'), claimed, unknown };
}

/**
 * The generated body of one region: a Mermaid block that renders everywhere,
 * and the interactive element beside it.
 *
 * The element is inert in the stock visualizer, which strips it, and inert on
 * GitHub, which does the same. It is not dead weight: it is what lane B turns
 * on, and keeping both in the page means a page is not rewritten when someone
 * switches lanes. The comment says so, because a reader who finds only the
 * stripped element will otherwise assume it is broken.
 */
function renderBlock(viewId, mermaid) {
  if (mermaid === null || mermaid === undefined) {
    return [
      '',
      `> **Missing view \`${viewId}\`.** The model does not define it. Run`,
      '> `node fork/openwiki-likec4.mjs gen`, or correct the marker.',
      '',
    ];
  }
  return [
    '',
    '```mermaid',
    mermaid,
    '```',
    '',
    `<${ELEMENT} view-id="${viewId}" browser="true"></${ELEMENT}>`,
    '',
  ];
}

function embedCommand({ check }) {
  const views = new Set(listViews());
  if (views.size === 0) {
    fail('No generated views. Run: node fork/openwiki-likec4.mjs gen');
  }
  const pages = wikiPages();
  if (pages.length === 0) {
    console.log(`No Markdown under ${relative(REPO_ROOT, WIKI_DIR)}/ yet. Nothing to embed.`);
    return 0;
  }

  let changed = 0;
  let claimedTotal = 0;
  const problems = [];

  for (const page of pages) {
    const before = readFileSync(page, 'utf-8');
    let result;
    try {
      result = embedInText(before, (id) => mermaidFor(id));
    } catch (error) {
      problems.push(`${relative(REPO_ROOT, page)}: ${error.message}`);
      continue;
    }
    claimedTotal += result.claimed.length;
    for (const id of result.unknown) {
      problems.push(`${relative(REPO_ROOT, page)}: no such view "${id}"`);
    }
    if (result.text !== before) {
      changed += 1;
      if (!check) writeFileSync(page, result.text);
      console.log(`${check ? 'stale' : 'wrote'}: ${relative(REPO_ROOT, page)}`);
    }
  }

  console.log(
    `\n${pages.length} page(s), ${claimedTotal} embedded view(s), ${changed} ${check ? 'stale' : 'updated'}.`,
  );
  for (const problem of problems) console.error(`  ${problem}`);

  if (problems.length > 0) return 1;
  if (check && changed > 0) {
    console.error('\nRun `node fork/openwiki-likec4.mjs embed` and commit the result.');
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Lane B: make an exported visualizer render the component
// ---------------------------------------------------------------------------

/**
 * The shim. It runs after DOMPurify has loaded and before the client module,
 * and widens the sanitizer once for every later call.
 */
export function shimSource() {
  return `// Written by fork/openwiki-likec4.mjs. Do not edit; re-run \`export\` instead.
//
// OpenWiki's client sanitizes each page body with a bare DOMPurify.sanitize(),
// which drops elements it does not know. setConfig is DOMPurify's documented
// way to set persistent configuration for later calls, so this widens the
// filter without touching the code that calls it, and therefore without
// breaking on the next openwiki upgrade.
(function () {
  if (typeof DOMPurify === 'undefined') {
    console.error('[likec4] DOMPurify missing; the page shell changed shape.');
    return;
  }
  DOMPurify.setConfig({
    ADD_TAGS: ${JSON.stringify([ELEMENT])},
    ADD_ATTR: ${JSON.stringify(ELEMENT_ATTRS)},
  });
})();
`;
}

/**
 * Widen the CSP meta only as far as the component needs.
 *
 * The bundle itself is same-origin, which `script-src 'self'` already admits.
 * What it additionally needs is WebAssembly, which LikeC4 uses for layout, and
 * a worker to run it in. Fonts gain `data:` because the bundle inlines them.
 * Every other directive is left exactly as OpenWiki set it.
 */
export function widenCsp(csp) {
  const directives = csp.split(';').map((part) => part.trim()).filter(Boolean);
  const byName = new Map(directives.map((d) => [d.split(/\s+/)[0], d]));

  const add = (name, ...values) => {
    const existing = byName.get(name);
    const parts = existing ? existing.split(/\s+/) : [name];
    for (const value of values) if (!parts.includes(value)) parts.push(value);
    byName.set(name, parts.join(' '));
  };

  add('script-src', "'wasm-unsafe-eval'");
  add('font-src', 'data:');
  // default-src is 'none', so a worker needs saying explicitly.
  if (!byName.has('worker-src')) byName.set('worker-src', "worker-src 'self' blob:");
  else add('worker-src', "'self'", 'blob:');

  const order = directives.map((d) => d.split(/\s+/)[0]);
  if (!order.includes('worker-src')) order.push('worker-src');
  return order.map((name) => byName.get(name)).join('; ');
}

/**
 * Patch an exported visualizer in place. Pure enough to test: it takes a
 * directory of files this script owns and returns what it did.
 *
 * Deliberately conservative. If `index.html` is not the shape we expect, it
 * refuses rather than producing a page that loads but renders nothing, because
 * a silent no-op here looks exactly like a LikeC4 bug.
 */
export function patchExportDir(dir, bundleSource) {
  const indexPath = join(dir, 'index.html');
  if (!existsSync(indexPath)) throw new Error(`no index.html in ${dir}`);
  let html = readFileSync(indexPath, 'utf-8');

  if (html.includes('likec4-bridge.js')) {
    return { alreadyPatched: true, csp: null };
  }

  // The shim has to run after DOMPurify and before the client module. The
  // client is the last script in the shell, so anchoring on it puts us after
  // every CDN library and before the only consumer.
  const clientTag = /<script\s+type="module"\s+src="[^"]*client\.js"[^>]*><\/script>/;
  if (!clientTag.test(html)) {
    throw new Error(
      'index.html has no <script type="module" src=".../client.js">. The OpenWiki page '
      + 'shell changed; re-read fork/docs/openwiki-likec4.md before forcing this.',
    );
  }

  writeFileSync(join(dir, 'likec4-views.js'), bundleSource);
  writeFileSync(join(dir, 'likec4-bridge.js'), shimSource());

  html = html.replace(
    clientTag,
    (match) => `<script src="./likec4-bridge.js"></script>\n<script src="./likec4-views.js"></script>\n${match}`,
  );

  let csp = null;
  html = html.replace(
    /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/,
    (_match, head, value, tail) => {
      csp = widenCsp(value);
      return `${head}${csp}${tail}`;
    },
  );

  writeFileSync(indexPath, html);
  return { alreadyPatched: false, csp };
}

function exportCommand(dir) {
  if (!dir) fail('Usage: node fork/openwiki-likec4.mjs export <dir>');
  const target = resolve(REPO_ROOT, dir);
  if (!existsSync(BUNDLE)) fail('No web component bundle. Run: node fork/openwiki-likec4.mjs gen');

  const version = openwikiVersion();
  if (!existsSync(join(target, 'index.html'))) {
    console.error(`Nothing exported at ${show(target)}.`);
    if (!atLeast(version, EXPORT_MIN_VERSION)) {
      console.error(
        `\nInstalled OpenWiki is ${version ? version.join('.') : 'absent'}; `
        + `\`visualize --export\` arrived in ${EXPORT_MIN_VERSION.join('.')}.`
        + '\nEither upgrade (npm i -g openwiki@latest) or stay on lane A, which needs none of this.',
      );
    } else {
      console.error(`\nRun first: openwiki visualize ${relative(REPO_ROOT, WIKI_DIR)} --export ${dir}`);
    }
    return 1;
  }

  let result;
  try {
    result = patchExportDir(target, readFileSync(BUNDLE, 'utf-8'));
  } catch (error) {
    // The message says what changed and where to read about it. A stack trace
    // over the top of that helps nobody.
    console.error(`Refusing to patch ${show(target)}:\n  ${error.message}`);
    return 1;
  }
  if (result.alreadyPatched) {
    console.log(`${show(target)}: already patched, left alone.`);
    return 0;
  }
  console.log(`patched: ${show(target)}`);
  console.log('  + likec4-views.js   the component bundle');
  console.log('  + likec4-bridge.js  widens DOMPurify for <likec4-view>');
  if (result.csp) console.log(`  csp: ${result.csp}`);
  else console.log('  csp: no meta tag found, so nothing widened (a served copy sets it as a header)');
  return 0;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

function doctor() {
  const version = openwikiVersion();
  const bin = join(LIKEC4_DIR, 'node_modules', '.bin', 'likec4');
  const likec4Installed = existsSync(bin);
  const views = listViews();

  const row = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);
  console.log('OpenWiki + LikeC4 bridge\n');
  row('likec4 (pinned)', likec4Installed ? likec4(['--version']).output.trim() || 'installed' : 'NOT INSTALLED');
  row('openwiki (global)', version ? version.join('.') : 'NOT INSTALLED');
  row('model sources', existsSync(LIKEC4_SRC) ? relative(REPO_ROOT, LIKEC4_SRC) : 'missing');
  row('generated views', views.length ? views.join(', ') : 'none (run gen)');
  row('component bundle', existsSync(BUNDLE) ? `${Math.round(statSync(BUNDLE).size / 1024)} KB` : 'none (run gen)');
  row('wiki directory', existsSync(WIKI_DIR) ? `${wikiPages().length} page(s)` : 'not created yet');

  console.log('\nLanes:');
  console.log(`  A  Mermaid in the page      ${likec4Installed ? 'available' : 'needs likec4'}`);
  const laneB = atLeast(version, EXPORT_MIN_VERSION);
  console.log(
    `  B  interactive component   ${laneB ? 'available' : `needs openwiki >= ${EXPORT_MIN_VERSION.join('.')}`
      + (version ? ` (have ${version.join('.')})` : '')}`,
  );
  if (!laneB) {
    console.log('\n  Lane A is the one that matters; lane B is a convenience and');
    console.log('  nothing in the wiki depends on it.');
  }
  return 0;
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

function selfTest() {
  let failures = 0;
  const check = (label, condition) => {
    if (!condition) failures += 1;
    console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}`);
  };

  const resolver = (id) => (id === 'known' ? 'graph TB\n  A --> B' : null);

  const page = ['# Title', '', '<!-- likec4: known -->', 'stale content', CLOSE, '', 'after'].join('\n');
  const filled = embedInText(page, resolver);
  check('fills a marked region', filled.text.includes('graph TB'));
  check('drops the stale body', !filled.text.includes('stale content'));
  check('keeps text outside the markers', filled.text.includes('# Title') && filled.text.endsWith('after'));
  check('emits the interactive element', filled.text.includes(`<${ELEMENT} view-id="known"`));
  check('reports the claim', filled.claimed.length === 1 && filled.claimed[0] === 'known');

  const again = embedInText(filled.text, resolver);
  check('is idempotent', again.text === filled.text);

  const missing = embedInText(`<!-- likec4: nope -->\n${CLOSE}`, resolver);
  check('reports an unknown view', missing.unknown.length === 1 && missing.unknown[0] === 'nope');
  check('says so in the page', missing.text.includes('Missing view'));

  let threw = false;
  try { embedInText('<!-- likec4: known -->\nno close', resolver); } catch { threw = true; }
  check('refuses an unclosed marker', threw);

  const untouched = '# No markers here\n\nJust prose.';
  check('leaves an unmarked page alone', embedInText(untouched, resolver).text === untouched);

  const csp = widenCsp("default-src 'none'; script-src 'self' https://cdn.jsdelivr.net; font-src 'self'");
  check('csp keeps default-src', csp.includes("default-src 'none'"));
  check('csp adds wasm', csp.includes("'wasm-unsafe-eval'"));
  check('csp adds a worker source', csp.includes('worker-src'));
  check('csp adds data: fonts', /font-src[^;]*data:/.test(csp));
  check('csp keeps the cdn', csp.includes('cdn.jsdelivr.net'));
  check('csp does not duplicate', (csp.match(/script-src/g) || []).length === 1);
  check('csp is idempotent', widenCsp(csp) === csp);

  check('shim configures DOMPurify', shimSource().includes('DOMPurify.setConfig'));
  check('shim allows the element', shimSource().includes(ELEMENT));

  console.log(failures === 0 ? '\nself-test passed' : `\nself-test failed: ${failures}`);
  return failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------

function main(argv) {
  const args = argv.slice(2);
  const command = args.find((a) => !a.startsWith('-')) ?? 'doctor';

  if (args.includes('--self-test')) return selfTest();
  if (args.includes('-h') || args.includes('--help')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('*/')[0].split('Usage:')[1].trim());
    return 0;
  }

  switch (command) {
    case 'doctor': return doctor();
    case 'gen': generate({ withBundle: !args.includes('--no-bundle') }); return 0;
    case 'embed': return embedCommand({ check: args.includes('--check') });
    case 'export': return exportCommand(args.filter((a) => !a.startsWith('-'))[1]);
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Try: doctor | gen | embed [--check] | export <dir> | --self-test');
      return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv));
}
