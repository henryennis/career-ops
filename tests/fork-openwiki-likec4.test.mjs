// The OpenWiki <-> LikeC4 bridge.
//
// Two things are worth testing here and they fail differently. The embed side
// rewrites files people wrote, so its failure mode is losing prose or leaving a
// diagram that quietly no longer matches the model. The export side patches a
// third-party page shell, so its failure mode is a silent no-op after an
// upgrade: the page still loads, the diagram is simply gone, and it looks like
// a LikeC4 bug rather than ours.
//
// The export fixture is written by hand rather than produced by `openwiki
// visualize --export`, because that flag needs OpenWiki 0.6 and the machine may
// have any version. The fixture copies the shape of the real page shell: the
// CSP as a meta tag, the CDN libraries, and the client module last.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const bridge = await import('../fork/openwiki-likec4.mjs');
const { embedInText, widenCsp, patchExportDir, shimSource } = bridge;

const CLOSE = '<!-- /likec4 -->';
const known = (id) => (id === 'known' ? 'graph TB\n  A --> B' : null);

// --- embedding -------------------------------------------------------------

test('fills a marked region and drops what was there', () => {
  const page = `# Title\n\n<!-- likec4: known -->\nold\n${CLOSE}\n\ntail`;
  const { text } = embedInText(page, known);
  assert.match(text, /```mermaid\ngraph TB/);
  assert.doesNotMatch(text, /^old$/m);
  assert.match(text, /^# Title$/m, 'prose before the marker survived');
  assert.match(text, /tail$/, 'prose after the marker survived');
});

test('is idempotent, so a no-op commit stays a no-op', () => {
  const page = `<!-- likec4: known -->\n${CLOSE}`;
  const once = embedInText(page, known).text;
  const twice = embedInText(once, known).text;
  assert.equal(twice, once);
});

test('emits the interactive element alongside the Mermaid', () => {
  const { text } = embedInText(`<!-- likec4: known -->\n${CLOSE}`, known);
  assert.match(text, /<likec4-view view-id="known" browser="true"><\/likec4-view>/);
});

test('a renamed view is reported, not silently blank', () => {
  const { unknown, text } = embedInText(`<!-- likec4: gone -->\n${CLOSE}`, known);
  assert.deepEqual(unknown, ['gone']);
  assert.match(text, /Missing view/, 'the page says so where a reader will see it');
});

test('an unclosed marker throws instead of eating the file', () => {
  assert.throws(
    () => embedInText('<!-- likec4: known -->\neverything after this', known),
    /never closed/,
  );
});

test('a page with no markers is returned byte for byte', () => {
  const page = '# Plain\n\nNo markers.\n';
  assert.equal(embedInText(page, known).text, page);
});

test('several regions in one page are each filled', () => {
  const page = [
    '<!-- likec4: known -->', CLOSE, '', 'between', '',
    '<!-- likec4: known -->', CLOSE,
  ].join('\n');
  const { text, claimed } = embedInText(page, known);
  assert.equal(claimed.length, 2);
  assert.equal((text.match(/```mermaid/g) || []).length, 2);
  assert.match(text, /^between$/m);
});

// --- CSP -------------------------------------------------------------------

const BASE_CSP = "default-src 'none'; script-src 'self' https://cdn.jsdelivr.net; "
  + "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; "
  + "connect-src 'self'; base-uri 'none'; form-action 'none'";

test('widening the CSP adds only what LikeC4 needs', () => {
  const widened = widenCsp(BASE_CSP);
  assert.match(widened, /script-src[^;]*'wasm-unsafe-eval'/, 'LikeC4 lays out with WebAssembly');
  assert.match(widened, /worker-src[^;]*blob:/, "default-src is 'none', so workers need saying");
  assert.match(widened, /font-src[^;]*data:/, 'the bundle inlines its fonts');
});

test('widening the CSP leaves every other directive alone', () => {
  const widened = widenCsp(BASE_CSP);
  for (const kept of ["default-src 'none'", "img-src 'self' data:", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(widened.includes(kept), `${kept} survived`);
  }
  assert.ok(widened.includes('cdn.jsdelivr.net'), 'the CDN allowance survived');
});

test('widening the CSP twice changes nothing the second time', () => {
  const once = widenCsp(BASE_CSP);
  assert.equal(widenCsp(once), once);
});

// --- export patch ----------------------------------------------------------

const SHELL = `<!doctype html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="${BASE_CSP}" />
</head><body>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.4.12/dist/purify.min.js"></script>
<script type="module" src="./client.js"></script>
</body></html>`;

function fixture(html = SHELL) {
  const dir = mkdtempSync(join(tmpdir(), 'openwiki-likec4-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
  writeFileSync(join(dir, 'client.js'), '// client');
  return dir;
}

test('the patch orders the scripts so the shim can take effect', () => {
  const dir = fixture();
  try {
    patchExportDir(dir, '// bundle');
    const html = readFileSync(join(dir, 'index.html'), 'utf-8');
    const order = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    const purify = order.findIndex((s) => s.includes('purify'));
    const shim = order.indexOf('./likec4-bridge.js');
    const client = order.indexOf('./client.js');
    assert.ok(purify < shim, 'the shim runs after DOMPurify exists');
    assert.ok(shim < client, 'the shim runs before the client sanitizes anything');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the patch writes both runtime files', () => {
  const dir = fixture();
  try {
    patchExportDir(dir, '// bundle');
    assert.equal(readFileSync(join(dir, 'likec4-views.js'), 'utf-8'), '// bundle');
    assert.match(readFileSync(join(dir, 'likec4-bridge.js'), 'utf-8'), /DOMPurify\.setConfig/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the patch is idempotent', () => {
  const dir = fixture();
  try {
    patchExportDir(dir, '// bundle');
    const after = readFileSync(join(dir, 'index.html'), 'utf-8');
    const second = patchExportDir(dir, '// bundle');
    assert.equal(second.alreadyPatched, true);
    assert.equal(readFileSync(join(dir, 'index.html'), 'utf-8'), after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// This is the test that matters most. When OpenWiki changes its page shell, the
// patch must stop rather than produce a page that loads and renders nothing.
test('the patch refuses a shell it does not recognise', () => {
  const dir = fixture('<html><body>no client module here</body></html>');
  try {
    assert.throws(() => patchExportDir(dir, '// bundle'), /page shell changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the patch refuses a directory with no index.html', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openwiki-likec4-empty-'));
  try {
    assert.throws(() => patchExportDir(dir, '// bundle'), /no index\.html/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shim names the element and its attributes', () => {
  const shim = shimSource();
  assert.match(shim, /ADD_TAGS/);
  assert.match(shim, /likec4-view/);
  assert.match(shim, /view-id/);
  assert.match(shim, /typeof DOMPurify === 'undefined'/, 'it says so when the shell changed');
});
