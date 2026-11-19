// tests/fork-job-search.test.mjs: the fork's browser job search hands postings
// an agent read on Indeed, LinkedIn or Jora to upstream's own gate and writers.
//
// Fork-only and additive, kept under tests/ so the sync loop's test step runs
// it: an upstream change to createLocalGate, to appendToPipeline /
// appendToScanHistory, or to the `local:jds/` capture convention shows up on the
// next fork/sync-upstream.sh rather than on the next real search.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, run, lastRunFailure, ROOT, NODE } from './helpers.mjs';

console.log('\nfork/ browser job search: posting URLs, record checks, ingestion');

const check = (label, condition, detail = '') => (condition ? pass(label) : fail(detail ? `${label} (${detail})` : label));

// ── Pure half: one stable URL per posting, and record validation ────────────

const { canonicalJobUrl, boardOf, parsePosting, parsePostings } = await import(
  pathToFileURL(join(ROOT, 'fork', 'job-search', 'job-posting.mts')).href
);

{
  const cases = [
    ['https://au.indeed.com/rc/clk?jk=0123456789ABCDEF&from=vj&pos=top&xkcb=SoA', 'https://au.indeed.com/viewjob?jk=0123456789abcdef'],
    ['https://au.indeed.com/jobs?q=support&l=Melbourne&vjk=0123456789abcdef', 'https://au.indeed.com/viewjob?jk=0123456789abcdef'],
    ['https://au.linkedin.com/jobs/view/peer-support-worker-at-acme-health-4012345678?position=3&trk=public_jobs', 'https://www.linkedin.com/jobs/view/4012345678'],
    ['https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=bioinformatics', 'https://www.linkedin.com/jobs/view/4012345678'],
    ['https://au.jora.com/job/Peer-Support-Worker-0a1b2c3d4e5f?abstract_type=extended&sp=serp&sr=4', 'https://au.jora.com/job/Peer-Support-Worker-0a1b2c3d4e5f'],
    ['https://www.seek.com.au/job/94855310?type=standard&ref=search-standalone#sol=abc', 'https://www.seek.com.au/job/94855310'],
    ['https://careers.example.org/roles/42?utm_source=jora&team=data#apply', 'https://careers.example.org/roles/42?team=data'],
  ];
  const wrong = cases.filter(([raw, expected]) => canonicalJobUrl(raw) !== expected).map(([raw]) => `${raw} -> ${canonicalJobUrl(raw)}`);
  check('one posting has one URL however the board linked it', wrong.length === 0, wrong.join(' ; '));

  const refused = [
    'https://au.indeed.com/pagead/clk?mo=r&ad=-6NYlbfkN0',
    'https://www.linkedin.com/jobs/search/?keywords=bioinformatics',
    'https://au.jora.com/j?q=support+worker',
    'not a url',
  ].filter((raw) => {
    try {
      canonicalJobUrl(raw);
      return true;
    } catch {
      return false;
    }
  });
  check('a board link with no posting identifier is refused, not recorded', refused.length === 0, refused.join(' ; '));

  check('the board label comes from the host', boardOf('https://au.indeed.com/viewjob?jk=0123456789abcdef') === 'indeed'
    && boardOf('https://au.jora.com/job/x-1') === 'jora' && boardOf('https://www.linkedin.com/jobs/view/4012345678') === 'linkedin');
}

{
  const good = parsePosting({
    url: 'https://au.indeed.com/viewjob?jk=0123456789abcdef',
    title: ' Support Engineer ',
    company: 'Acme Health',
    location: 'Melbourne VIC',
    workplaceType: 'remote',
    postedAt: '2026-11-12',
    closesAt: '2026-11-30',
    salary: { min: 80000, max: 95000, currency: 'aud' },
    applyUrl: 'https://careers.acmehealth.example/jobs/77',
  });
  const offer = good.posting?.offer;
  check('a full record maps to the offer shape scan.mjs writes',
    offer?.title === 'Support Engineer' && offer?.source === 'browser-indeed' && offer?.workplaceType === 'remote'
    && offer?.postedAt === Date.parse('2026-11-12T00:00:00Z') && offer?.salary?.currency === 'AUD'
    && offer?.note === 'closes 2026-11-30; apply at careers.acmehealth.example',
    JSON.stringify(good));

  const errorsFor = (record) => parsePosting(record).errors || [];
  const base = { url: 'https://au.jora.com/job/x-1', title: 'Support Worker', company: 'Acme' };
  check('an hourly rate in the annual salary field is refused', errorsFor({ ...base, salary: { min: 45 } }).some((error) => error.includes('payText')));
  check('a relative posting date is refused', errorsFor({ ...base, postedAt: '3 days ago' }).some((error) => error.includes('postedAt')));
  check('a misspelt field is refused instead of dropped', errorsFor({ ...base, salery: {} }).some((error) => error.includes('"salery"')));
  check('a record with no company is refused', errorsFor({ ...base, company: '' }).some((error) => error.includes('company')));

  const batch = parsePostings({ jobs: [base, { ...base, url: 'https://au.jora.com/job/x-1?sp=serp' }, { title: 'No URL', company: 'Acme' }] });
  check('a batch keeps one copy of a repeated posting and lists the bad record by position',
    batch.postings.length === 1 && batch.invalid.length === 1 && batch.invalid[0].index === 2);
}

// ── Write half: the CLI against a sandbox data root ─────────────────────────

const dataRoot = mkdtempSync(join(tmpdir(), 'job-search-'));
process.on('exit', () => {
  try {
    rmSync(dataRoot, { recursive: true, force: true });
  } catch {
    // A fixture that cannot be removed must not change the suite's verdict.
  }
});
mkdirSync(join(dataRoot, 'data'), { recursive: true });
writeFileSync(join(dataRoot, 'portals.yml'), 'title_filter:\n  positive: [Engineer, Support]\n  negative: [Recruiter]\n');

const env = { ...process.env, CAREER_OPS_DATA_DIR: dataRoot };
for (const name of ['CAREER_OPS_ROOT', 'CAREER_OPS_PROFILE', 'CAREER_OPS_PIPELINE', 'CAREER_OPS_PORTALS', 'CAREER_OPS_SCAN_HISTORY', 'CAREER_OPS_TRACKER']) {
  delete env[name];
}

const SCRIPT = join(ROOT, 'fork', 'job-search', 'ingest-jobs.mts');
const pipelinePath = join(dataRoot, 'data', 'pipeline.md');
const historyPath = join(dataRoot, 'data', 'scan-history.tsv');
const payloadPath = join(dataRoot, 'jobs.json');
const stderrTail = () => (lastRunFailure()?.stderr || '').trim().split('\n').pop() || '';

const ingest = (records, flags = []) => {
  writeFileSync(payloadPath, JSON.stringify(records));
  const out = run(NODE, [SCRIPT, payloadPath, ...flags], { env });
  if (out === null) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
};
const pendingRows = () => (existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf-8').split('\n').filter((line) => line.startsWith('- [ ]')) : []);
const historyRows = () => (existsSync(historyPath) ? readFileSync(historyPath, 'utf-8').trim().split('\n').slice(1) : []);
const captures = () => (existsSync(join(dataRoot, 'jds')) ? readdirSync(join(dataRoot, 'jds')) : []);

const BODY = 'Acme Health runs a peer-led support line. '.repeat(8).trim();
const WITH_BODY = {
  url: 'https://au.indeed.com/rc/clk?jk=0123456789abcdef&from=serp',
  title: 'Support Engineer',
  company: 'Acme Health',
  location: 'Melbourne VIC',
  postedAt: '2026-11-12',
  payText: '$45-$52 per hour',
  easyApply: true,
  description: BODY,
};
const WITHOUT_BODY = { url: 'https://au.jora.com/job/Platform-Engineer-aa11?sp=serp', title: 'Platform Engineer', company: 'Borealis', location: 'Remote' };
const OFF_TARGET = { url: 'https://www.linkedin.com/jobs/view/barista-at-cafe-4099999999', title: 'Barista', company: 'Cafe Uno', location: 'Carlton VIC' };

{
  const receipt = ingest([WITH_BODY, WITHOUT_BODY, OFF_TARGET], ['--dry-run']);
  check('dry run: reports what would be added', receipt?.dryRun === true && receipt?.added?.length === 2, stderrTail());
  check('dry run: writes nothing', pendingRows().length === 0 && historyRows().length === 0 && captures().length === 0);
}

{
  const receipt = ingest([WITH_BODY, WITHOUT_BODY, OFF_TARGET]);
  check('ingest: two postings admitted, the off-target title skipped by title_filter',
    receipt?.added?.length === 2 && receipt?.skipped?.length === 1 && receipt.skipped[0].reason === 'title', stderrTail() || JSON.stringify(receipt));

  const rows = pendingRows();
  const localRow = rows.find((row) => row.includes('Acme Health'));
  check('ingest: a posting with a body is queued as a local:jds/ reference',
    rows.length === 2 && /^- \[ \] local:jds\/acme-health-support-engineer-[0-9a-f]{10}\.md \| Acme Health \| Support Engineer \| Melbourne VIC/.test(localRow || ''), rows.join(' // '));
  check('ingest: pay text and the board-apply flag ride in the note segment', (localRow || '').includes('note: pay $45-$52 per hour; board apply'), localRow);
  check('ingest: a posting without a body is queued under its canonical board URL',
    rows.some((row) => row.startsWith('- [ ] https://au.jora.com/job/Platform-Engineer-aa11 | Borealis | Platform Engineer | Remote')), rows.join(' // '));

  const files = captures();
  const capture = files.length === 1 ? readFileSync(join(dataRoot, 'jds', files[0]), 'utf-8') : '';
  check('ingest: the capture keeps the board URL and the posting body',
    capture.includes('url: https://au.indeed.com/viewjob?jk=0123456789abcdef') && capture.includes('board_apply: true') && capture.includes(BODY), files.join(', '));

  const history = historyRows().map((row) => row.split('\t'));
  check('ingest: scan-history records both, labelled by board',
    history.length === 2 && history.some((cells) => cells[2] === 'browser-indeed' && cells[5] === 'added') && history.some((cells) => cells[2] === 'browser-jora'),
    historyRows().join(' // '));
}

{
  // The same two postings again, reached through different links and with a
  // slightly different title on the first: neither may be queued twice.
  const again = ingest([
    { ...WITH_BODY, url: 'https://au.indeed.com/jobs?q=support&vjk=0123456789abcdef', title: 'Support Engineer (Remote)' },
    { ...WITHOUT_BODY, url: 'https://au.jora.com/job/Platform-Engineer-aa11?abstract_type=extended' },
  ]);
  check('re-ingest: postings already recorded are skipped as seen',
    again?.added?.length === 0 && again?.skipped?.length === 2 && again.skipped.every((skip) => skip.reason === 'seen'), stderrTail() || JSON.stringify(again));
  check('re-ingest: nothing is queued or captured twice', pendingRows().length === 2 && captures().length === 1);
}

{
  const widened = ingest([OFF_TARGET], ['--no-title-filter']);
  check('--no-title-filter admits a title the filter drops', widened?.added?.length === 1 && pendingRows().length === 3, stderrTail() || JSON.stringify(widened));
}

{
  writeFileSync(payloadPath, '{"not": "a list"}');
  const out = run(NODE, [SCRIPT, payloadPath], { env });
  check('an unreadable payload exits non-zero and says why', out === null && stderrTail().length > 0 && pendingRows().length === 3);
  const partial = ingest([{ title: 'No URL', company: 'Acme' }]);
  check('a refused record is listed and does not fail the run', partial?.invalid?.length === 1 && partial?.added?.length === 0, stderrTail());
}
