#!/usr/bin/env node

/**
 * check-placeholders.mjs — refuse to ship a CV that still contains a gap marker.
 *
 * `cv.md` and `article-digest.md` track their own unknowns with `[NEEDS USER
 * INPUT]` markers, which is the right place for them: the fact base should say
 * what it does not know. The risk is the copy step. A payload is written by
 * hand or by a batch worker from those files, and a marker that rides along is
 * printed into the PDF and sent to a stranger.
 *
 * Neither existing gate catches it. `verify-cv-facts.mjs` checks whether claims
 * trace to a source and a marker is not a claim; `verify-ats.mjs` checks whether
 * a parser can read the page and a marker parses fine. So this is the third
 * gate, and it is deliberately dumb: it looks for the markers and nothing else.
 *
 * Usage:
 *   node fork/check-placeholders.mjs <file> [<file>...]
 *   node fork/check-placeholders.mjs --json <file>
 *   node fork/check-placeholders.mjs --self-test
 *
 * Exit code: 0 when no file contains a marker, 1 otherwise. Read-only.
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * Each pattern is a shape that means "a human still has to fill this in".
 * Case-insensitive, because the markers are hand-typed and drift in case.
 *
 * TODO/FIXME are deliberately absent: they appear in legitimate CV prose about
 * software work often enough that flagging them would train the reader to skip
 * the output, and a gate nobody reads is worse than no gate.
 */
const PLACEHOLDER_PATTERNS = [
  { name: 'needs-user-input', regex: /\[\s*NEEDS\s+USER\s+INPUT[^\]]*\]/gi },
  { name: 'bracketed-directive', regex: /\[\s*(?:PERSONALISE|PERSONALIZE|INSERT|ADD|FILL IN)\b[^\]]*\]/gi },
  { name: 'template-slot', regex: /\[\s*(?:ROLE|COMPANY|HIRING MANAGER|NAME|SOURCE|LINK|TIME WINDOW|VALUE|DATE)\s*\]/gi },
  { name: 'lorem', regex: /\blorem ipsum\b/gi },
  { name: 'tbd', regex: /\bTB[DA]\b/g },
  { name: 'xxx-filler', regex: /\bXXX+\b/g },
];

/** Where in the file a hit landed, so the reader can go straight to it. */
function locate(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = text.indexOf('\n', index);
  const context = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
  return { line, context: context.length > 160 ? `${context.slice(0, 157)}...` : context };
}

export function findPlaceholders(text) {
  const found = [];
  for (const { name, regex } of PLACEHOLDER_PATTERNS) {
    // Fresh lastIndex per call: the patterns are module-level and /g is stateful.
    const pattern = new RegExp(regex.source, regex.flags);
    let match;
    while ((match = pattern.exec(text)) !== null) {
      found.push({ pattern: name, match: match[0], ...locate(text, match.index) });
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

function checkFile(path) {
  if (!existsSync(path)) return { path, error: 'not found', findings: [] };
  return { path, findings: findPlaceholders(readFileSync(path, 'utf-8')) };
}

function selfTest() {
  const cases = [
    ['[NEEDS USER INPUT]: which workflows', 1, 'the marker as cv.md writes it'],
    ['[NEEDS USER INPUT — months unknown]', 1, 'marker with a trailing note'],
    ['Dear [HIRING MANAGER], I am writing', 1, 'an unfilled letter template slot'],
    ['Built a pipeline for 150+ products', 0, 'an ordinary bullet'],
    ['Reduced TBD by TBD percent', 2, 'two TBDs'],
    ['Worked on [PERSONALISE — a product]', 1, 'a directive left in place'],
    ['Skills: C++, XML, REST', 0, 'capitals that are not filler'],
    ['Wrote the [ROLE] handler class', 1, 'a template slot, even in prose'],
  ];
  let failures = 0;
  for (const [text, expected, description] of cases) {
    const actual = findPlaceholders(text).length;
    const ok = actual === expected;
    if (!ok) failures += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${description} (expected ${expected}, got ${actual})`);
  }
  console.log(failures === 0 ? '\nself-test passed' : `\nself-test failed: ${failures}`);
  return failures === 0 ? 0 : 1;
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--self-test')) return selfTest();

  const asJson = args.includes('--json');
  const paths = args.filter((a) => !a.startsWith('--'));
  if (paths.length === 0) {
    console.error('Usage: node fork/check-placeholders.mjs <file> [<file>...] [--json]');
    return 1;
  }

  const results = paths.map(checkFile);
  const total = results.reduce((sum, r) => sum + r.findings.length, 0);
  const missing = results.filter((r) => r.error);

  if (asJson) {
    console.log(JSON.stringify({ ok: total === 0 && missing.length === 0, total, results }, null, 2));
    return total === 0 && missing.length === 0 ? 0 : 1;
  }

  for (const result of results) {
    if (result.error) {
      console.error(`${basename(result.path)}: ${result.error}`);
      continue;
    }
    if (result.findings.length === 0) {
      console.log(`${basename(result.path)}: clean`);
      continue;
    }
    console.log(`${basename(result.path)}: ${result.findings.length} placeholder(s)`);
    for (const f of result.findings) {
      console.log(`  line ${f.line}  ${f.match}`);
      console.log(`    ${f.context}`);
    }
  }

  if (total > 0) {
    console.error(`\nRefusing: ${total} placeholder(s) would be printed into a document someone reads.`);
    console.error('Resolve the fact or drop the bullet. Do not delete the marker from cv.md.');
  }
  return total === 0 && missing.length === 0 ? 0 : 1;
}

process.exit(main(process.argv));
