// tests/fork-refilter.test.mjs: the fork's inbox refilter re-applies the current
// portals.yml and blacklist rules to the entries already in Pending, through
// upstream's own filter functions, parks the rejected ones in a section it
// owns, and brings them back byte for byte when the rules loosen.
//
// Fork-only and additive, kept under tests/ so the sync loop's test step runs
// it: an upstream change to a filter builder's signature, to the pipeline row
// contract, or to the seen-URL reader shows up on the next fork/sync-upstream.sh
// rather than on the next real inbox.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, run, lastRunFailure, utcDay, ROOT, NODE } from './helpers.mjs';

console.log('\nfork/ inbox refilter: dry run, apply, round trip, readers');

const dataRoot = mkdtempSync(join(tmpdir(), 'refilter-'));
process.on('exit', () => {
  try {
    rmSync(dataRoot, { recursive: true, force: true });
  } catch {
    // A fixture that cannot be removed must not change the suite's verdict.
  }
});
mkdirSync(join(dataRoot, 'data'), { recursive: true });

const env = { ...process.env, CAREER_OPS_DATA_DIR: dataRoot };
for (const name of ['CAREER_OPS_ROOT', 'CAREER_OPS_PROFILE', 'CAREER_OPS_PIPELINE', 'CAREER_OPS_PORTALS', 'CAREER_OPS_SCAN_HISTORY', 'CAREER_OPS_TRACKER']) {
  delete env[name];
}

const SCRIPT = join(ROOT, 'fork', 'refilter.mjs');
const pipelinePath = join(dataRoot, 'data', 'pipeline.md');
const portalsPath = join(dataRoot, 'portals.yml');
const blacklistPath = join(dataRoot, 'data', 'blacklist.md');
const discardLogPath = join(dataRoot, 'data', 'discard.log');
const backupPath = `${pipelinePath}.pre-refilter.bak`;

const refilter = (args = []) => run(NODE, [SCRIPT, ...args], { env });
const refilterJson = (args = []) => {
  const out = refilter(['--json', ...args]);
  if (out === null) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
};
const stderrTail = () => (lastRunFailure()?.stderr || '').trim().split('\n').pop() || '';
const check = (label, condition, detail = '') => (condition ? pass(label) : fail(detail ? `${label} (${detail})` : label));
const readInbox = () => readFileSync(pipelinePath, 'utf-8');
const removeIfPresent = (file) => { if (existsSync(file)) unlinkSync(file); };

/** The `- [` rows between a `## ` header and the next one, in file order. */
function sectionRows(text, headerRe) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => headerRe.test(line));
  if (start === -1) return null;
  const rows = [];
  for (let index = start + 1; index < lines.length; index++) {
    if (/^##\s/.test(lines[index])) break;
    if (lines[index].startsWith('- [')) rows.push(lines[index]);
  }
  return rows;
}
const headerIndex = (text, headerRe) => text.split('\n').findIndex((line) => headerRe.test(line));

const RECENT = utcDay(new Date(Date.now() - 3 * 86_400_000));
const OLD = utcDay(new Date(Date.now() - 100 * 86_400_000));
const ANNOTATION = String.raw`refiltered \d{4}-\d{2}-\d{2}`;

const STRICT_RULES = [
  'title_filter:',
  '  negative:',
  '    - recruiter',
  '    - sales',
  'skip_tiers: [senior]',
  'location_filter:',
  '  block: [india]',
  'max_posting_age_days: 30',
  '',
].join('\n');
const LOOSE_RULES = 'title_filter:\n  negative: []\n';
const BLACKLIST = '| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Blocked Co | 2026-01-01 | all | layoffs |\n';

const KEEP = [
  `- [ ] https://jobs.example.com/keep/1 | Keep Co | Product Manager | Remote (US) | posted: ${RECENT}`,
  '- [ ] https://jobs.example.com/keep/2 | Keep Co | Backend Engineer',
  '- [ ] https://jobs.example.com/keep/3 | Keep Co | Data Engineer |  | 100000-120000 USD',
  `- [ ] https://jobs.example.com/keep/4 | Keep Co | Platform Engineer | posted: ${RECENT}`,
];
// [row, reason the current rules give it]. The order is scan's precedence: a
// senior title that also hits a negative keyword reports the title.
const MOVE = [
  ['- [ ] https://jobs.example.com/bl/1 | Blocked Co | Senior Recruiter', 'filtered_blacklist'],
  ['- [ ] https://jobs.example.com/title/1 | Acme | Technical Recruiter', 'filtered_title'],
  ['- [ ] https://jobs.example.com/title/2 | Acme | Senior Sales Engineer', 'filtered_title'],
  ['- [ ] https://jobs.example.com/tier/1 | Acme | Senior Product Manager | note: curated shortlist', 'filtered_tier:senior'],
  ['- [ ] https://jobs.example.com/tier/2 | Acme | Staff Engineer | Remote | rank: 4.0/5 — strong match', 'filtered_tier:senior'],
  ['- [ ] https://jobs.example.com/loc/1 | Acme | Product Manager | Bengaluru, India', 'filtered_location'],
  [`- [ ] https://jobs.example.com/age/1 | Acme | Product Manager | Remote | posted: ${OLD}`, 'filtered_posting_age'],
];
const UNTOUCHED = [
  '- [ ] https://jobs.example.com/bare/1',
  '- [ ] ~~https://jobs.example.com/expired/1 | Acme | Senior Recruiter~~',
  '- [!] https://private.example.com/job | Error: login required',
];
const PROCESSED = [
  '- [x] #143 | https://jobs.example.com/done/1 | Acme | Senior Recruiter | 4.2/5 | PDF ✅',
  '- [x] #-- | https://jobs.example.com/done/2 | skipped (pre-screen mismatch: sales)',
  '- [x] [144](reports/144-acme.md) | https://jobs.example.com/done/3 | Acme | Senior Sales Engineer | 3.0/5 | PDF ❌',
];
const urlOf = (row) => row.replace(/^- \[.\] /, '').split('|')[0].trim();
const inboxA = ['# Pipeline', '', '## Pending', '', ...KEEP, ...MOVE.map(([row]) => row), ...UNTOUCHED, '', '## Processed', ...PROCESSED, ''].join('\n');

writeFileSync(portalsPath, STRICT_RULES);
writeFileSync(blacklistPath, BLACKLIST);
writeFileSync(pipelinePath, inboxA);

// ── 1. Dry run writes nothing ───────────────────────────────────────────────

{
  const out = refilter();
  check('the dry run exits 0 and names itself', out !== null && out.includes('Inbox refilter: dry run') && out.includes('(dry run: nothing written)'), stderrTail());
  check('the dry run leaves the inbox byte-identical', readInbox() === inboxA);
  check('the dry run writes no backup and no discard log', !existsSync(backupPath) && !existsSync(discardLogPath));
  check('the dry run names the filters it does not re-apply', out !== null && /Not re-applied.*salary.*content.*visa.*trust.*dedup/.test(out));

  const json = refilterJson();
  const counts = json?.counts;
  check('--json prints one parseable object with the counts', counts !== undefined && counts.inspected === 11 && counts.keptInPending === 4 && counts.movedOut === 7 && counts.restored === 0, JSON.stringify(counts));
  check('untouched rows are counted with their reason', counts?.untouched?.noMetadata === 1 && counts?.untouched?.expired === 1 && counts?.untouched?.errorRows === 1, JSON.stringify(counts?.untouched));
  const byUrl = new Map((json?.verdicts || []).filter((verdict) => verdict.url).map((verdict) => [verdict.url, verdict]));
  const wrong = MOVE.filter(([row, reason]) => byUrl.get(urlOf(row))?.outcome !== 'moved' || byUrl.get(urlOf(row))?.reason !== reason)
    .map(([row, reason]) => `${urlOf(row)}: expected ${reason}, got ${byUrl.get(urlOf(row))?.reason}`);
  check('every rejected row carries the reason of the first failing filter, in scan\'s order', wrong.length === 0, wrong.join('; '));
  check('a senior title that also hits a negative keyword reports the title, not the tier', byUrl.get('https://jobs.example.com/title/2')?.reason === 'filtered_title');
  check('the title verdict names the negative keyword that hit', byUrl.get('https://jobs.example.com/title/1')?.detail === 'negative title keyword "recruiter"', byUrl.get('https://jobs.example.com/title/1')?.detail);
  check('an empty location passes the location filter and a missing posted date passes the age filter', KEEP.every((row) => byUrl.get(urlOf(row))?.outcome === 'kept'));
}

// ── 2. Apply moves the rejected rows into a section of its own ──────────────

let afterFirstApply = null;
{
  const out = refilter(['--apply']);
  check('--apply exits 0 and reports the written paths', out !== null && out.includes(`Written: ${pipelinePath}`) && out.includes(`Backup:  ${backupPath}`), stderrTail());
  const text = readInbox();
  afterFirstApply = text;

  const pending = sectionRows(text, /^## Pending$/);
  check('Pending keeps the accepted rows, the bare URL, the expired entry and the error row, in order', JSON.stringify(pending) === JSON.stringify([...KEEP, ...UNTOUCHED]), JSON.stringify(pending));

  const pendingAt = headerIndex(text, /^## Pending$/);
  const refilteredAt = headerIndex(text, /^## Refiltered$/);
  const processedAt = headerIndex(text, /^## Processed$/);
  check('a Refiltered section is created between Pending and Processed', pendingAt !== -1 && refilteredAt > pendingAt && processedAt > refilteredAt, `${pendingAt} ${refilteredAt} ${processedAt}`);

  const parked = sectionRows(text, /^## Refiltered$/) || [];
  const expectedParked = MOVE.map(([row, reason]) => {
    const body = row.slice('- [ ] '.length);
    if (body.includes('| note: ')) return new RegExp(`^- \\[x\\] ${body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\| note: ', `\\| note: ${ANNOTATION} ${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}; `)}$`);
    if (body.includes('| rank: ')) return new RegExp(`^- \\[x\\] ${body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\| rank: ', `\\| note: ${ANNOTATION} ${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| rank: `)}$`);
    return new RegExp(`^- \\[x\\] ${body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| note: ${ANNOTATION} ${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  });
  const mismatched = expectedParked.map((re, index) => (re.test(parked[index] || '') ? null : `${index}: ${parked[index]}`)).filter(Boolean);
  check('each moved row is checked, keeps its body, and carries one dated annotation with its reason', parked.length === MOVE.length && mismatched.length === 0, mismatched.join(' || '));
  check('a pre-existing note is kept behind the annotation', parked.some((row) => / \| note: refiltered \S+ filtered_tier:senior; curated shortlist$/.test(row)));
  check('a rank segment stays last, after the annotation', parked.some((row) => /\| note: refiltered \S+ filtered_tier:senior \| rank: 4\.0\/5 — strong match$/.test(row)));

  check('every Processed row is untouched', JSON.stringify(sectionRows(text, /^## Processed$/)) === JSON.stringify(PROCESSED));
  check('the backup is the inbox as it was before the apply', existsSync(backupPath) && readFileSync(backupPath, 'utf-8') === inboxA);
}

// ── 3. The discard log parses through upstream's own parser ────────────────

{
  const { parseDiscardLog } = await import(pathToFileURL(join(ROOT, 'discard-analytics.mjs')).href);
  const entries = existsSync(discardLogPath) ? parseDiscardLog(readFileSync(discardLogPath, 'utf-8')) : [];
  check('one discard-log line per row moved out of Pending', entries.length === MOVE.length, String(entries.length));
  const expected = new Map(MOVE.map(([row, reason]) => [urlOf(row), `refilter: ${reason}`]));
  const wrong = entries.filter((entry) => expected.get(entry.url) !== entry.reason).map((entry) => `${entry.url} ${entry.reason}`);
  check('each line carries the URL and a refilter reason discard-analytics can group', wrong.length === 0 && entries.every((entry) => !Number.isNaN(Date.parse(entry.timestamp))), wrong.join('; '));
}

// ── 4. The readers: parked rows are seen by scan and invisible to ranking ───

{
  const { loadSeenUrls, normalizeUrlForDedup, appendToPipeline } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);
  const { parsePendingEntries } = await import(pathToFileURL(join(ROOT, 'rank-pipeline.mjs')).href);
  const { seen } = loadSeenUrls({}, {
    scanHistoryPath: join(dataRoot, 'data', 'scan-history.tsv'),
    pipelinePath,
    applicationsPath: join(dataRoot, 'data', 'applications.md'),
  });
  const unseen = MOVE.map(([row]) => urlOf(row)).filter((url) => !seen.has(normalizeUrlForDedup(url)));
  check('scan still counts every moved URL as seen, so a rescan does not re-add it', unseen.length === 0, unseen.join(', '));
  const pendingUrls = parsePendingEntries(afterFirstApply).map((entry) => entry.url);
  check('rank-pipeline no longer sees the moved rows as pending, and still sees the kept ones', MOVE.every(([row]) => !pendingUrls.includes(urlOf(row))) && KEEP.every((row) => pendingUrls.includes(urlOf(row))));

  const scanCopy = join(dataRoot, 'data', 'pipeline-scan-copy.md');
  writeFileSync(scanCopy, afterFirstApply);
  await appendToPipeline([{ url: 'https://jobs.example.com/new/1', company: 'New Co', title: 'Product Manager' }], { pipelinePath: scanCopy });
  const appended = readFileSync(scanCopy, 'utf-8');
  const newRowAt = appended.split('\n').findIndex((line) => line.startsWith('- [ ] https://jobs.example.com/new/1 '));
  check('scan still appends a new offer inside Pending, above the Refiltered section', newRowAt !== -1 && newRowAt > headerIndex(appended, /^## Pending$/) && newRowAt < headerIndex(appended, /^## Refiltered$/), String(newRowAt));
}

// ── 5. A second apply under the same rules is a no-op ───────────────────────

{
  removeIfPresent(backupPath);
  const logBefore = readFileSync(discardLogPath, 'utf-8');
  const out = refilter(['--apply']);
  check('the second apply says there is nothing to change', out !== null && out.includes('Nothing to change'), stderrTail());
  check('and writes no second backup, no new log line, and no byte of the inbox', !existsSync(backupPath) && readFileSync(discardLogPath, 'utf-8') === logBefore && readInbox() === afterFirstApply);
}

// ── 6. Loosening the rules brings the rows back byte for byte ───────────────

{
  writeFileSync(portalsPath, LOOSE_RULES);
  removeIfPresent(blacklistPath);
  const out = refilter(['--apply']);
  check('the loosened apply restores rows and appends nothing to the log', out !== null && out.includes('restored to Pending:  7') && out.includes('Discard log: nothing appended'), stderrTail());
  const text = readInbox();
  const pending = sectionRows(text, /^## Pending$/) || [];
  const missing = MOVE.map(([row]) => row).filter((row) => !pending.includes(row));
  check('every restored row is byte-identical to the original, the pre-existing note included', missing.length === 0, missing.join(' || '));
  check('restored rows are appended at the end of Pending, below the rows that never left', JSON.stringify(pending) === JSON.stringify([...KEEP, ...UNTOUCHED, ...MOVE.map(([row]) => row)]), JSON.stringify(pending));
  check('the emptied Refiltered section is removed', headerIndex(text, /^## Refiltered$/) === -1);
  check('the file holds the same lines as before the first apply', text.split('\n').sort().join('\n') === inboxA.split('\n').sort().join('\n'));
  const again = refilter(['--apply']);
  check('and a further apply changes nothing', again !== null && again.includes('Nothing to change'));
}

// ── 7. Parked rows from an earlier run: restore, refresh, leave alone ───────

{
  writeFileSync(portalsPath, 'title_filter:\n  negative: [recruiter]\nskip_tiers: [senior]\nlocation_filter:\n  block: [india]\n');
  const parkedRows = [
    '- [x] https://jobs.example.com/parked/1 | Acme | Product Manager | Remote (US) | note: refiltered 2026-01-01 filtered_title',
    '- [x] https://jobs.example.com/parked/2 | Acme | Senior Product Designer | note: refiltered 2026-01-01 filtered_title; keep an eye on this one',
    '- [x] https://jobs.example.com/parked/3 | Acme | Product Manager | Bengaluru, India | note: refiltered 2026-02-02 filtered_location',
    '- [x] https://jobs.example.com/hand/1 | Acme | Product Manager | note: hand-written',
    '- [ ] https://jobs.example.com/hand/2 | Acme | Product Manager',
  ];
  const pendingRows = [
    '- [ ] https://jobs.example.com/keep/9 | Acme | Product Manager',
    '  - [ ] https://jobs.example.com/indented/1 | Acme | Senior Recruiter',
    '- [ ] https://jobs.example.com/hand/3 | Acme | Product Manager | Remote | note: refiltered 2026-03-03 filtered_title',
    '- [ ] https://jobs.example.com/hand/4 | Acme | Senior Product Manager | note: refiltered 2026-03-03 filtered_title; watch',
  ];
  const inboxB = ['# Pipeline', '', '## Pending', '', ...pendingRows, '', '## Refiltered', '', ...parkedRows, '', '## Processed', ''].join('\n');
  writeFileSync(pipelinePath, inboxB);
  const json = refilterJson(['--apply']);
  const text = readInbox();
  const pending = sectionRows(text, /^## Pending$/) || [];
  const parked = sectionRows(text, /^## Refiltered$/) || [];
  check('a parked row the rules now accept returns to the end of Pending with the annotation removed', pending[pending.length - 1] === '- [ ] https://jobs.example.com/parked/1 | Acme | Product Manager | Remote (US)', JSON.stringify(pending));
  check('a hand-restored row the rules accept keeps its place and loses the stale annotation', pending[1] === '- [ ] https://jobs.example.com/hand/3 | Acme | Product Manager | Remote', JSON.stringify(pending));
  const handParked = parked.find((row) => row.includes('/hand/4 '));
  check('a hand-restored row the rules still reject is parked once, with one fresh annotation and its note', handParked !== undefined && /^- \[x\] https:\/\/jobs\.example\.com\/hand\/4 \| Acme \| Senior Product Manager \| note: refiltered \d{4}-\d{2}-\d{2} filtered_tier:senior; watch$/.test(handParked) && !/2026-03-03/.test(handParked), handParked);
  check('an indented row is left where it is and counted', text.includes('\n  - [ ] https://jobs.example.com/indented/1 | Acme | Senior Recruiter\n') && json?.counts?.untouched?.indented === 1, JSON.stringify(json?.counts?.untouched));
  check('a parked row still rejected for a new reason gets the reason refreshed and keeps its date and its note', parked.includes('- [x] https://jobs.example.com/parked/2 | Acme | Senior Product Designer | note: refiltered 2026-01-01 filtered_tier:senior; keep an eye on this one'), JSON.stringify(parked));
  check('a parked row rejected for the same reason is left as it was', parked.includes(parkedRows[2]));
  check('rows in the section that the refilter did not write are left alone and reported', parked.includes(parkedRows[3]) && parked.includes(parkedRows[4]) && json?.counts?.untouched?.unrecognizedInRefiltered === 2, JSON.stringify(json?.counts));
  check('the counts say what happened', json?.counts?.restored === 1 && json?.counts?.stillRefiltered === 2 && json?.counts?.reasonRefreshed === 1 && json?.counts?.movedOut === 1 && json?.counts?.annotationsCleared === 1, JSON.stringify(json?.counts));
}

// ── 8. A Spanish-headed inbox gets a Spanish section ────────────────────────

{
  writeFileSync(portalsPath, 'skip_tiers: [senior]\n');
  const inboxC = ['# Pipeline', '', '## Pendientes', '', '- [ ] https://jobs.example.com/es/1 | Acme | Senior Product Manager', '- [ ] https://jobs.example.com/es/2 | Acme | Product Manager', '', '## Procesadas', '- [x] #1 | https://jobs.example.com/es/z | Acme | PM | 4/5 | PDF ❌', ''].join('\n');
  writeFileSync(pipelinePath, inboxC);
  const out = refilter(['--apply']);
  const text = readInbox();
  const parked = sectionRows(text, /^## Refiltradas$/);
  check('the section is created as Refiltradas between Pendientes and Procesadas', out !== null && parked !== null && headerIndex(text, /^## Refiltradas$/) > headerIndex(text, /^## Pendientes$/) && headerIndex(text, /^## Procesadas$/) > headerIndex(text, /^## Refiltradas$/), stderrTail());
  check('and holds the rejected row', parked !== null && parked.length === 1 && /^- \[x\] https:\/\/jobs\.example\.com\/es\/1 \| Acme \| Senior Product Manager \| note: refiltered \S+ filtered_tier:senior$/.test(parked[0]), JSON.stringify(parked));
  check('Procesadas is untouched', JSON.stringify(sectionRows(text, /^## Procesadas$/)) === JSON.stringify(['- [x] #1 | https://jobs.example.com/es/z | Acme | PM | 4/5 | PDF ❌']));
}

// ── 9. The pure functions: row shapes, precedence, line endings ─────────────

{
  const mod = await import(pathToFileURL(SCRIPT).href);
  const { parsePipelineRow, buildRefilterRules, judgeRow, refilterDocument, parkBody, unparkBody } = mod;

  const three = parsePipelineRow('https://jobs.example.com/a | Acme | Backend Engineer');
  const four = parsePipelineRow('https://jobs.example.com/b | Acme | Backend Engineer | Remote (US)');
  const five = parsePipelineRow('https://jobs.example.com/c | Acme | Backend Engineer |  | 100000-120000 USD');
  const labeledFourth = parsePipelineRow('https://jobs.example.com/d | Acme | Backend Engineer | posted: 2026-06-18');
  check('a 3-column row parses to its title with no location and no date', three.title === 'Backend Engineer' && three.location === '' && three.posted === null && three.postedAt === undefined);
  check('a 4-column row parses the location', four.location === 'Remote (US)' && four.compensation === '');
  check('a 5-column row with an empty location keeps the compensation in column 5', five.location === '' && five.compensation === '100000-120000 USD');
  check('a labeled segment in column 4 is a date, not a location', labeledFourth.location === '' && labeledFourth.posted === '2026-06-18' && labeledFourth.postedAt === Date.parse('2026-06-18T23:59:59.999Z'));
  check('a bare URL has no metadata and an expired entry is flagged', !parsePipelineRow('https://jobs.example.com/e').hasMetadata && parsePipelineRow('~~https://jobs.example.com/f | Acme | PM~~').expired);

  const { parseBlacklist, buildPostingAgeFilter } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);
  const blacklist = parseBlacklist(BLACKLIST);
  const rules = buildRefilterRules({ title_filter: { negative: ['sales'] }, skip_tiers: ['senior'], location_filter: { block: ['india'] }, max_posting_age_days: 30 }, { blacklist, now: Date.parse('2026-09-12T12:00:00Z') });
  const verdict = (body) => judgeRow(parsePipelineRow(body), rules)?.reason ?? null;
  check('blacklist wins over title, title over tier, tier over location, location over age',
    verdict('u | Blocked Co | Senior Sales Engineer | Bengaluru, India | posted: 2026-01-01') === 'filtered_blacklist'
    && verdict('u | Acme | Senior Sales Engineer | Bengaluru, India | posted: 2026-01-01') === 'filtered_title'
    && verdict('u | Acme | Senior Engineer | Bengaluru, India | posted: 2026-01-01') === 'filtered_tier:senior'
    && verdict('u | Acme | Engineer | Bengaluru, India | posted: 2026-01-01') === 'filtered_location'
    && verdict('u | Acme | Engineer | Remote | posted: 2026-01-01') === 'filtered_posting_age'
    && verdict('u | Acme | Engineer | Remote | posted: 2026-09-01') === null);

  const dayNow = Date.parse('2026-09-14T10:00:00Z');
  const dayRules = buildRefilterRules({ max_posting_age_days: 30 }, { now: dayNow });
  const scanAge = buildPostingAgeFilter(30, dayNow);
  check('posting age is judged at the end of the posted day, so the boundary row scan may still accept is kept',
    judgeRow(parsePipelineRow('u | Acme | Engineer | Remote | posted: 2026-08-15'), dayRules) === null
    && scanAge(Date.parse('2026-08-15T15:00:00Z')) === true
    && judgeRow(parsePipelineRow('u | Acme | Engineer | Remote | posted: 2026-08-14'), dayRules)?.reason === 'filtered_posting_age'
    && scanAge(Date.parse('2026-08-14T23:59:59.999Z')) === false);

  for (const body of ['u | Acme | PM', 'u | Acme | PM | Remote | posted: 2026-06-18', 'u | Acme | PM | note: keep', 'u | Acme | PM | Remote | rank: 4.0/5 x', 'u | Acme | PM | note: keep | rank: 4.0/5 x']) {
    const parked = parkBody(body, '2026-09-12', 'filtered_title');
    const back = unparkBody(parked);
    if (back?.body !== body || back.annotation.reason !== 'filtered_title') fail(`park/unpark is not the identity for "${body}": ${parked} -> ${back?.body}`);
  }
  pass('parking and unparking a body is the identity for every row shape');

  const crlf = '# Pipeline\r\n\r\n## Pending\r\n\r\n- [ ] u | Acme | Senior PM\r\n- [ ] u2 | Acme | PM\r\n\r\n## Processed\r\n';
  const result = refilterDocument(crlf, rules, { today: '2026-09-12' });
  check('a CRLF inbox keeps its line endings', result.changed && !/[^\r]\n/.test(result.text) && result.text.includes('## Refiltered\r\n'));
  const noPending = refilterDocument('# Pipeline\n\n## Processed\n', rules, { today: '2026-09-12' });
  check('an inbox without a Pending section is reported, not rewritten', noPending.noPendingSection && !noPending.changed);
}

// ── 10. The drift guard: upstream's matchers, never a copy ──────────────────

{
  const source = readFileSync(SCRIPT, 'utf-8');
  const imports = [
    [/import \{[^}]*\bbuildTitleFilter\b[^}]*\} from '\.\.\/title-keywords\.mjs'/, 'buildTitleFilter from title-keywords.mjs'],
    [/import \{[^}]*\bclassifyTier\b[^}]*\} from '\.\.\/classify-tier\.mjs'/, 'classifyTier from classify-tier.mjs'],
    [/import \{[^}]*\bbuildLocationFilter\b[^}]*\} from '\.\.\/scan\.mjs'/, 'buildLocationFilter from scan.mjs'],
    [/import \{[^}]*\bbuildPostingAgeFilter\b[^}]*\} from '\.\.\/scan\.mjs'/, 'buildPostingAgeFilter from scan.mjs'],
    [/import \{[^}]*\bloadBlacklist\b[^}]*\} from '\.\.\/scan\.mjs'/, 'loadBlacklist from scan.mjs'],
    [/import \{[^}]*\bnormalizeCompany\b[^}]*\} from '\.\.\/tracker-utils\.mjs'/, 'normalizeCompany from tracker-utils.mjs'],
  ];
  const missing = imports.filter(([re]) => !re.test(source)).map(([, label]) => label);
  check('the script imports every filter from upstream', missing.length === 0, missing.join(', '));
  check('and defines none of them itself', !/function (buildTitleFilter|classifyTier|buildLocationFilter|buildPostingAgeFilter|normalizeCompany|loadBlacklist)\b/.test(source));
  check('the CLI writes through the shared lock and the atomic writer', /\bwithPipelineLock\(/.test(source) && /\batomicWriteFile\(/.test(source) && !/\bwriteFileSync\(/.test(source));
  const scanSource = readFileSync(join(ROOT, 'scan.mjs'), 'utf-8');
  const reconcileSource = readFileSync(join(ROOT, 'reconcile-pipeline.mjs'), 'utf-8');
  check('scan still defines the labeled-segment allow-list this script copies', scanSource.includes(String.raw`PIPELINE_LABELED_SEGMENT_RE = /^(?:posted|trust|note|rank):\s/iu;`));
  check('reconcile still spells the section headers this script copies', reconcileSource.includes(String.raw`/^##\s+(Pendientes|Pending)\s*$/i`) && reconcileSource.includes(String.raw`/^##\s+(Procesadas|Processed)\s*$/i`));
}

// ── 11. Flags and failures ──────────────────────────────────────────────────

{
  const before = readInbox();
  const help = refilter(['--help']);
  check('--help exits 0 and prints usage', help !== null && help.startsWith('Usage: node fork/refilter.mjs'), stderrTail());
  const bad = refilter(['--aply']);
  check('a mistyped flag exits 1 before anything runs', bad === null && lastRunFailure()?.status === 1 && (lastRunFailure()?.stderr || '').includes('unrecognized flag'), stderrTail());
  check('and writes nothing', readInbox() === before);
  const missing = refilter(['--pipeline', join(dataRoot, 'nowhere', 'pipeline.md')]);
  check('a missing inbox exits 1 with the path on stderr', missing === null && lastRunFailure()?.status === 1 && (lastRunFailure()?.stderr || '').includes('pipeline not found'), stderrTail());
  writeFileSync(join(dataRoot, 'broken.yml'), 'title_filter: [unclosed\n');
  const broken = refilter(['--portals', join(dataRoot, 'broken.yml')]);
  check('unreadable YAML exits 1 with the parser message on stderr', broken === null && lastRunFailure()?.status === 1 && (lastRunFailure()?.stderr || '').includes('failed to parse'), stderrTail());
}

// ── 12. The discard log's directory is created when absent ─────────────────

{
  const bareRoot = mkdtempSync(join(tmpdir(), 'refilter-bare-'));
  try {
    writeFileSync(join(bareRoot, 'portals.yml'), 'skip_tiers: [senior]\n');
    const inbox = join(bareRoot, 'inbox.md');
    writeFileSync(inbox, ['## Pending', '', '- [ ] https://jobs.example.com/bare-root/1 | Acme | Senior PM', ''].join('\n'));
    const out = run(NODE, [SCRIPT, '--apply', '--pipeline', inbox], { env: { ...env, CAREER_OPS_DATA_DIR: bareRoot } });
    const log = join(bareRoot, 'data', 'discard.log');
    check('an apply against a data root with no data directory creates it and writes the log', out !== null && existsSync(log) && readFileSync(log, 'utf-8').includes('https://jobs.example.com/bare-root/1\trefilter: filtered_tier:senior'), stderrTail());
  } finally {
    rmSync(bareRoot, { recursive: true, force: true });
  }
}

// ── 13. A held inbox lock is one line on stderr, not a stack trace ─────────

{
  const { acquirePipelineLock } = await import(pathToFileURL(join(ROOT, 'pipeline-lock.mjs')).href);
  writeFileSync(portalsPath, 'skip_tiers: [senior]\n');
  writeFileSync(pipelinePath, ['# Pipeline', '', '## Pending', '', '- [ ] https://jobs.example.com/lock/1 | Acme | Senior PM', '', '## Processed', ''].join('\n'));
  const before = readInbox();
  const lock = await acquirePipelineLock(pipelinePath);
  try {
    const out = run(NODE, [SCRIPT, '--apply', '--json'], { env: { ...env, CAREER_OPS_PIPELINE_LOCK_TIMEOUT_MS: '300' } });
    const stderr = lastRunFailure()?.stderr || '';
    check('a held inbox lock exits 1 with a one-line message and no stack trace', out === null && lastRunFailure()?.status === 1 && stderr.includes('holds the inbox lock') && !stderr.includes('    at '), stderr.slice(0, 300));
    check('and leaves the inbox untouched', readInbox() === before);
  } finally {
    lock.release();
  }
}
