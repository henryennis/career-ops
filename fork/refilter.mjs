#!/usr/bin/env node
/**
 * refilter.mjs (fork, layer 2): re-apply the current targeting rules to the
 * rows already sitting in the inbox.
 *
 * scan.mjs applies portals.yml and data/blacklist.md at discovery time. When
 * you tighten or loosen a rule afterwards, the rows already in Pending are
 * judged by the old rules: rows the new rules would drop still wait for an
 * evaluation, and rows the old rules dropped stay dropped. This script judges
 * the existing rows again without a rescan and without reading a single job
 * description.
 *
 * It reuses scan's own filter functions, in scan's order, so its verdict for a
 * row is the verdict scan would reach for the same offer today (posting age is
 * the one exception, judged at day precision and only ever in the row's
 * favour; see postedDateToEpoch):
 *
 *   1. company blacklist          loadBlacklist + normalizeCompany
 *   2. title keywords             buildTitleFilter (title-keywords.mjs)
 *   3. skip_tiers                 classifyTier (classify-tier.mjs)
 *   4. location_filter            buildLocationFilter (scan.mjs)
 *   5. max_posting_age_days       buildPostingAgeFilter (scan.mjs)
 *
 * The filters after those in scan (posted-date CLI window, salary, content,
 * country eligibility, visa, trust, dedup) need the job description, the
 * structured salary or scan-time flags. A pipeline row carries none of them, so
 * they are not re-applied, and the report says so.
 *
 * Rows the current rules reject move from Pending into a section this script
 * owns, `## Refiltered` (`## Refiltradas` in a Spanish-headed file), as
 *
 *   - [x] {original body} | note: refiltered {YYYY-MM-DD} {reason}
 *
 * `- [x]` because every pending reader keys on `- [ ]`, while scan's seen-URL
 * reader accepts both boxes, so a rescan does not put the same URL back. The
 * body is kept byte for byte so the row can return: when a later run finds the
 * current rules accept a parked row, it goes back to Pending as `- [ ] {body}`.
 *
 * Usage:
 *   node fork/refilter.mjs                 # dry run: report only, nothing written
 *   node fork/refilter.mjs --apply         # write the inbox (backup first), append the discard log
 *   node fork/refilter.mjs --json          # one JSON object on stdout, nothing else
 *   node fork/refilter.mjs --pipeline <path> --portals <path>
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';

import {
  PIPELINE_PATH,
  PORTALS_PATH,
  atomicWriteFile,
  buildLocationFilter,
  buildPostingAgeFilter,
  loadBlacklist,
} from '../scan.mjs';
import { buildTitleFilter } from '../title-keywords.mjs';
import { classifyTier } from '../classify-tier.mjs';
import { normalizeCompany } from '../tracker-utils.mjs';
import { LockTimeoutError, withPipelineLock } from '../pipeline-lock.mjs';
import { flagValue, hasFlag, validateFlags } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { localToday } from '../lib/local-today.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

const DATA_ROOT = getCareerOpsRoot();

// scan.mjs keeps its blacklist path private, so the same resolution is repeated
// here: the user layer under the data root. The discard log is the one
// modes/pipeline.md describes for the pre-screen gate; discard-analytics.mjs
// reads it with the same three-field parser.
export const DEFAULT_BLACKLIST_PATH = path.join(DATA_ROOT, 'data/blacklist.md');
export const DEFAULT_DISCARD_LOG_PATH = path.join(DATA_ROOT, 'data/discard.log');

// Section headers, in the two spellings scan.mjs and reconcile-pipeline.mjs
// already accept. The Refiltered section is this script's own.
export const SECTION_HEADER_RE = /^##\s+/;
export const PENDING_HEADER_RE = /^##\s+(?:Pending|Pendientes)\s*$/i;
export const REFILTERED_HEADER_RE = /^##\s+(?:Refiltered|Refiltradas)\s*$/i;
export const PROCESSED_HEADER_RE = /^##\s+(?:Processed|Procesadas)\s*$/i;

const PENDING_ROW_RE = /^- \[ \] (.*)$/;
const INDENTED_ROW_RE = /^\s+- \[/;
const PARKED_ROW_RE = /^- \[x\] (.*)$/;
const ERROR_ROW_RE = /^- \[!\]/;
const ANY_ROW_RE = /^- \[/;

// The labeled-segment allow-list is scan's (PIPELINE_LABELED_SEGMENT_RE): a
// cell after the title is labeled when it starts with one of these four
// labels, and positional (location, then compensation) otherwise.
const LABELED_SEGMENT_RE = /^(?:posted|trust|note|rank):\s/iu;
const NOTE_LABEL_RE = /^note:\s/iu;
const RANK_LABEL_RE = /^rank:\s/iu;
const POSTED_VALUE_RE = /^posted:\s+(\d{4}-\d{2}-\d{2})/iu;

// The annotation this script writes into a note segment, and the separator that
// keeps a note the row already carried. The reason token never contains
// whitespace, so `refiltered {date} {reason}` parses back without ambiguity.
const ANNOTATION_SEPARATOR = '; ';
const ANNOTATION_RE = /^refiltered (\d{4}-\d{2}-\d{2}) (\S+)(?:; ([\s\S]*))?$/;
const ANNOTATION_PREFIX_RE = /^(\s*note:\s)refiltered \d{4}-\d{2}-\d{2} \S+; /iu;

// Reason vocabulary mirrors scan's run-summary columns (SCAN_RUNS_HEADER), so
// discard-analytics.mjs groups refilter discards beside scan's own counts.
export const REASONS = Object.freeze({
  blacklist: 'filtered_blacklist',
  title: 'filtered_title',
  tier: 'filtered_tier',
  location: 'filtered_location',
  postingAge: 'filtered_posting_age',
});

export const NOT_REAPPLIED = Object.freeze([
  'posted-date window (--since, --posted-after, --posted-before)',
  'salary',
  'content',
  'country eligibility',
  'visa',
  'trust',
  'dedup',
]);

const SAMPLE_LIMIT = 8;

export class RefilterError extends Error {}

// ── Rows ────────────────────────────────────────────────────────────

/**
 * A `posted: YYYY-MM-DD` value as epoch milliseconds at the END of that UTC
 * day. scan wrote the UTC day of the offer's exact postedAt instant, and the
 * instant itself is gone, so the row is judged as the newest moment it could
 * have been posted: the refilter parks a row for age only when scan would have
 * rejected the offer whatever its time of day. Midnight, the other choice,
 * parked live postings up to a day early.
 */
function postedDateToEpoch(posted) {
  if (!posted) return undefined;
  const epoch = Date.parse(`${posted}T23:59:59.999Z`);
  return Number.isFinite(epoch) ? epoch : undefined;
}

/**
 * Split a pipeline entry body (everything after the checkbox) into the cells
 * the filters need. Raw cells are kept so a row can be rewritten byte for byte.
 *
 * @param {string} body
 * @returns {{
 *   body: string, expired: boolean, url: string, company: string, title: string,
 *   location: string, compensation: string, posted: string|null, postedAt: number|undefined,
 *   rawCells: string[], noteCellIndex: number, rankCellIndex: number, hasMetadata: boolean
 * }}
 */
export function parsePipelineRow(body) {
  const expired = body.startsWith('~~');
  const rawCells = body.split('|');
  const cells = rawCells.map((cell) => cell.trim());
  const [url = '', company = '', title = ''] = cells;
  let location = '';
  let compensation = '';
  let posted = null;
  let noteCellIndex = -1;
  let rankCellIndex = -1;
  let positionalSeen = 0;
  for (let index = 3; index < cells.length; index++) {
    const cell = cells[index];
    if (LABELED_SEGMENT_RE.test(cell)) {
      if (noteCellIndex === -1 && NOTE_LABEL_RE.test(cell)) noteCellIndex = index;
      if (rankCellIndex === -1 && RANK_LABEL_RE.test(cell)) rankCellIndex = index;
      const postedMatch = posted === null ? cell.match(POSTED_VALUE_RE) : null;
      if (postedMatch) posted = postedMatch[1];
      continue;
    }
    if (positionalSeen === 0) location = cell;
    else if (positionalSeen === 1) compensation = cell;
    positionalSeen++;
  }
  return {
    body,
    expired,
    url,
    company,
    title,
    location,
    compensation,
    posted,
    postedAt: postedDateToEpoch(posted),
    rawCells,
    noteCellIndex,
    rankCellIndex,
    hasMetadata: !expired && title !== '',
  };
}

export function formatAnnotation(date, reason) {
  return `refiltered ${date} ${reason}`;
}

/** The annotation inside a note's text, or null when the note is not this script's. */
export function readAnnotation(noteText) {
  const match = String(noteText ?? '').match(ANNOTATION_RE);
  if (!match) return null;
  return { date: match[1], reason: match[2], originalNote: match[3] ?? null };
}

/**
 * The parked form of a body: the annotation goes into the existing note segment
 * (in front of the note the row already had), or into a new note segment placed
 * before a `rank:` segment, or at the end. Every other byte is kept.
 */
export function parkBody(body, date, reason) {
  const row = parsePipelineRow(body);
  const annotation = formatAnnotation(date, reason);
  const rawCells = [...row.rawCells];
  if (row.noteCellIndex >= 0) {
    rawCells[row.noteCellIndex] = rawCells[row.noteCellIndex]
      .replace(/^(\s*note:\s)/iu, `$1${annotation}${ANNOTATION_SEPARATOR}`);
    return rawCells.join('|');
  }
  if (row.rankCellIndex >= 0) {
    rawCells.splice(row.rankCellIndex, 0, ` note: ${annotation} `);
    return rawCells.join('|');
  }
  rawCells[rawCells.length - 1] = `${rawCells[rawCells.length - 1]} `;
  rawCells.push(` note: ${annotation}`);
  return rawCells.join('|');
}

/**
 * The inverse of parkBody: the original body and the annotation it carried, or
 * null when the body carries no annotation this script wrote.
 */
export function unparkBody(body) {
  const row = parsePipelineRow(body);
  if (row.noteCellIndex < 0) return null;
  const rawCells = [...row.rawCells];
  const noteCell = rawCells[row.noteCellIndex];
  const annotation = readAnnotation(noteCell.trim().replace(NOTE_LABEL_RE, ''));
  if (!annotation) return null;
  if (annotation.originalNote !== null) {
    rawCells[row.noteCellIndex] = noteCell.replace(ANNOTATION_PREFIX_RE, '$1');
  } else if (row.noteCellIndex === rawCells.length - 1) {
    rawCells.pop();
    rawCells[rawCells.length - 1] = rawCells[rawCells.length - 1].replace(/ $/, '');
  } else {
    rawCells.splice(row.noteCellIndex, 1);
  }
  return { body: rawCells.join('|'), annotation };
}

// ── Rules ───────────────────────────────────────────────────────────

/**
 * Build the five metadata filters from a parsed portals.yml, with the same
 * upstream builders and the same normalization scan.mjs applies.
 *
 * `titleDetail` exists for the human report only: it names the negative
 * keyword that vetoed a title, by asking upstream's own builder about one
 * keyword at a time, so no second matcher lives here.
 */
export function buildRefilterRules(config = {}, { blacklist = new Map(), now = Date.now() } = {}) {
  const settings = config && typeof config === 'object' ? config : {};
  const titleFilterConfig = settings.title_filter && typeof settings.title_filter === 'object' ? settings.title_filter : {};
  const skipTiers = Array.isArray(settings.skip_tiers)
    ? settings.skip_tiers.filter((tier) => typeof tier === 'string').map((tier) => tier.toLowerCase())
    : [];
  const positiveOnly = buildTitleFilter({ positive: titleFilterConfig.positive });
  const negativeVetoes = (Array.isArray(titleFilterConfig.negative) ? titleFilterConfig.negative : [])
    .filter((keyword) => typeof keyword === 'string' && keyword.trim() !== '')
    .map((keyword) => ({ keyword: keyword.trim(), vetoes: buildTitleFilter({ negative: [keyword] }) }));

  return {
    blacklist,
    titleFilter: buildTitleFilter(titleFilterConfig),
    titleDetail(title) {
      if (!positiveOnly(title)) return 'no positive title keyword matched';
      const hit = negativeVetoes.find(({ vetoes }) => !vetoes(title));
      return hit ? `negative title keyword "${hit.keyword}"` : '';
    },
    skipTiers,
    locationFilter: buildLocationFilter(settings.location_filter),
    postingAgeFilter: buildPostingAgeFilter(settings.max_posting_age_days, now),
    maxPostingAgeDays: settings.max_posting_age_days,
  };
}

/**
 * Judge one parsed row in scan's order. The first failing filter is the
 * verdict; null means every re-applied filter accepts the row.
 *
 * @returns {{reason: string, detail: string}|null}
 */
export function judgeRow(row, rules) {
  if (rules.blacklist.size > 0) {
    const entry = rules.blacklist.get(normalizeCompany(row.company || ''));
    if (entry) return { reason: REASONS.blacklist, detail: entry.reason ? `blacklisted: ${entry.reason}` : 'blacklisted' };
  }
  if (!rules.titleFilter(row.title)) {
    return { reason: REASONS.title, detail: rules.titleDetail(row.title) };
  }
  if (rules.skipTiers.length > 0) {
    const tier = classifyTier(row.title);
    if (rules.skipTiers.includes(tier)) return { reason: `${REASONS.tier}:${tier}`, detail: `tier ${tier} is in skip_tiers` };
  }
  if (!rules.locationFilter(row.location, row.url, row.title)) {
    return { reason: REASONS.location, detail: row.location ? `location "${row.location}"` : 'location hint in the URL' };
  }
  if (!rules.postingAgeFilter(row.postedAt)) {
    return { reason: REASONS.postingAge, detail: `posted ${row.posted}, cap ${rules.maxPostingAgeDays} days` };
  }
  return null;
}

/** portals.yml plus the blacklist, as rules. Throws RefilterError on a missing or unreadable file. */
export function loadRules({ portalsPath = PORTALS_PATH, blacklistPath = DEFAULT_BLACKLIST_PATH, now = Date.now() } = {}) {
  if (!existsSync(portalsPath)) throw new RefilterError(`portals.yml not found at ${portalsPath}`);
  let config;
  try {
    config = yaml.load(readFileSync(portalsPath, 'utf-8'));
  } catch (error) {
    throw new RefilterError(`failed to parse ${portalsPath}: ${error.message}`);
  }
  return buildRefilterRules(config, { blacklist: loadBlacklist(blacklistPath), now });
}

// ── Document ────────────────────────────────────────────────────────

function locateSections(lines) {
  const sections = { pending: null, refiltered: null, processed: null };
  let open = null;
  const close = (end) => { if (open) open.section.end = end; open = null; };
  lines.forEach((line, index) => {
    if (!SECTION_HEADER_RE.test(line)) return;
    close(index);
    const section = { start: index, end: lines.length, header: line };
    if (sections.pending === null && PENDING_HEADER_RE.test(line)) sections.pending = section;
    else if (sections.refiltered === null && REFILTERED_HEADER_RE.test(line)) sections.refiltered = section;
    else if (sections.processed === null && PROCESSED_HEADER_RE.test(line)) sections.processed = section;
    open = { section };
  });
  close(lines.length);
  return sections;
}

/** Where new rows go in a section: after its last non-blank line, or after the header when it has none. */
function sectionAnchor(lines, section) {
  for (let index = section.end - 1; index > section.start; index--) {
    if (lines[index].trim() !== '') return { index, isHeader: false };
  }
  return { index: section.start, isHeader: true };
}

export function refilteredHeaderFor(pendingHeader) {
  return /Pendientes/i.test(pendingHeader) ? '## Refiltradas' : '## Refiltered';
}

function emptyCounts() {
  return {
    inspected: 0,
    pendingInspected: 0,
    refilteredInspected: 0,
    keptInPending: 0,
    movedOut: 0,
    movedOutByReason: {},
    restored: 0,
    stillRefiltered: 0,
    stillRefilteredByReason: {},
    reasonRefreshed: 0,
    annotationsCleared: 0,
    untouched: { noMetadata: 0, expired: 0, errorRows: 0, indented: 0, unrecognizedInRefiltered: 0 },
  };
}

function tally(byReason, reason) {
  byReason[reason] = (byReason[reason] || 0) + 1;
}

/**
 * Re-judge a whole pipeline document. Pure: returns the new text and what
 * changed, writes nothing.
 *
 * @param {string} text - The pipeline file's contents.
 * @param {ReturnType<typeof buildRefilterRules>} rules
 * @param {{today?: string}} [options] - The date written into new annotations.
 */
export function refilterDocument(text, rules, { today = localToday() } = {}) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const sections = locateSections(lines);
  const counts = emptyCounts();
  const verdicts = [];
  const movedOut = [];
  const restored = [];
  const base = { sections, counts, verdicts, movedOut, restored, eol };

  if (sections.pending === null) {
    return { ...base, text, changed: false, noPendingSection: true, refilteredHeader: null };
  }
  const refilteredHeader = sections.refiltered ? sections.refiltered.header : refilteredHeaderFor(sections.pending.header);

  const removed = new Set();
  const replaced = new Map();
  const parkedRows = [];
  const restoredRows = [];
  const describe = (row) => ({ url: row.url, company: row.company, title: row.title });

  for (let index = sections.pending.start + 1; index < sections.pending.end; index++) {
    const line = lines[index];
    if (ERROR_ROW_RE.test(line)) {
      counts.untouched.errorRows++;
      verdicts.push({ section: 'pending', line: index + 1, outcome: 'untouched', why: 'error row' });
      continue;
    }
    if (INDENTED_ROW_RE.test(line)) {
      // scan's seen-URL reader accepts an indented checkbox; the readers that
      // hand out pending work do not. Left alone, and counted so the report
      // adds up to the rows in the section.
      counts.untouched.indented++;
      verdicts.push({ section: 'pending', line: index + 1, outcome: 'untouched', why: 'indented row' });
      continue;
    }
    const match = line.match(PENDING_ROW_RE);
    if (!match) continue;
    // A row someone moved back to Pending by hand with the annotation still on
    // is judged on its original body, so it is never annotated twice: parking
    // it again replaces the annotation, and keeping it clears the stale one.
    const handRestored = unparkBody(match[1]);
    const row = parsePipelineRow(handRestored ? handRestored.body : match[1]);
    if (row.expired) {
      counts.untouched.expired++;
      verdicts.push({ section: 'pending', line: index + 1, outcome: 'untouched', why: 'expired' });
      continue;
    }
    if (!row.hasMetadata) {
      counts.untouched.noMetadata++;
      verdicts.push({ section: 'pending', line: index + 1, url: row.url, outcome: 'untouched', why: 'no metadata' });
      continue;
    }
    counts.inspected++;
    counts.pendingInspected++;
    const verdict = judgeRow(row, rules);
    if (!verdict) {
      counts.keptInPending++;
      if (handRestored) {
        replaced.set(index, `- [ ] ${row.body}`);
        counts.annotationsCleared++;
      }
      verdicts.push({ section: 'pending', line: index + 1, ...describe(row), outcome: 'kept', annotationCleared: Boolean(handRestored) });
      continue;
    }
    removed.add(index);
    parkedRows.push(`- [x] ${parkBody(row.body, today, verdict.reason)}`);
    counts.movedOut++;
    tally(counts.movedOutByReason, verdict.reason);
    const entry = { ...describe(row), reason: verdict.reason, detail: verdict.detail, date: today };
    movedOut.push(entry);
    verdicts.push({ section: 'pending', line: index + 1, ...entry, outcome: 'moved' });
  }

  if (sections.refiltered) {
    for (let index = sections.refiltered.start + 1; index < sections.refiltered.end; index++) {
      const line = lines[index];
      if (!ANY_ROW_RE.test(line)) continue;
      const match = line.match(PARKED_ROW_RE);
      const unparked = match ? unparkBody(match[1]) : null;
      if (!unparked) {
        counts.untouched.unrecognizedInRefiltered++;
        verdicts.push({ section: 'refiltered', line: index + 1, outcome: 'untouched', why: 'not a refilter row' });
        continue;
      }
      const row = parsePipelineRow(unparked.body);
      counts.inspected++;
      counts.refilteredInspected++;
      const verdict = judgeRow(row, rules);
      if (!verdict) {
        removed.add(index);
        restoredRows.push(`- [ ] ${unparked.body}`);
        counts.restored++;
        const entry = { ...describe(row), previousReason: unparked.annotation.reason, date: unparked.annotation.date };
        restored.push(entry);
        verdicts.push({ section: 'refiltered', line: index + 1, ...entry, outcome: 'restored' });
        continue;
      }
      counts.stillRefiltered++;
      tally(counts.stillRefilteredByReason, verdict.reason);
      const reparked = `- [x] ${parkBody(unparked.body, unparked.annotation.date, verdict.reason)}`;
      const refreshed = reparked !== line;
      if (refreshed) {
        replaced.set(index, reparked);
        counts.reasonRefreshed++;
      }
      verdicts.push({
        section: 'refiltered',
        line: index + 1,
        ...describe(row),
        outcome: 'still',
        reason: verdict.reason,
        detail: verdict.detail,
        previousReason: unparked.annotation.reason,
        date: unparked.annotation.date,
        refreshed,
      });
    }
  }

  // Rebuild. Insertions are keyed to the line they follow, so a removed anchor
  // still marks the position.
  const insertAfter = new Map();
  const plan = (section, rows) => {
    if (rows.length === 0) return;
    const anchor = sectionAnchor(lines, section);
    if (!anchor.isHeader) {
      insertAfter.set(anchor.index, rows);
      return;
    }
    const nextIsBlank = lines[anchor.index + 1] !== undefined && lines[anchor.index + 1].trim() === '';
    insertAfter.set(anchor.index, nextIsBlank ? ['', ...rows] : ['', ...rows, '']);
  };
  plan(sections.pending, restoredRows);
  if (sections.refiltered) {
    plan(sections.refiltered, parkedRows);
    // The section belongs to this script. Once every parked row has gone back,
    // the header goes too, so a full round trip leaves no trace in the file.
    const rowsLeft = parkedRows.length > 0 || lines.some((line, index) =>
      index > sections.refiltered.start && index < sections.refiltered.end && ANY_ROW_RE.test(line) && !removed.has(index));
    if (!rowsLeft) {
      for (let index = sections.refiltered.start; index < sections.refiltered.end; index++) removed.add(index);
    }
  }

  const createAt = !sections.refiltered && parkedRows.length > 0
    ? (sections.processed ? sections.processed.start : null)
    : undefined;
  const newSection = (output) => {
    if (output.length > 0 && output[output.length - 1].trim() !== '') output.push('');
    output.push(refilteredHeader, '', ...parkedRows, '');
  };

  const output = [];
  lines.forEach((line, index) => {
    if (createAt === index) newSection(output);
    if (!removed.has(index)) output.push(replaced.has(index) ? replaced.get(index) : line);
    if (insertAfter.has(index)) output.push(...insertAfter.get(index));
  });
  if (createAt === null) {
    const trailingNewline = output.length > 0 && output[output.length - 1] === '';
    if (trailingNewline) output.pop();
    newSection(output);
    output.pop();
    if (trailingNewline) output.push('');
  }

  const newText = output.join(eol);
  return { ...base, text: newText, changed: newText !== text, noPendingSection: false, refilteredHeader };
}

// ── Files ───────────────────────────────────────────────────────────

/**
 * Refilter the inbox on disk. Dry run reads and judges; apply takes the
 * pipeline lock, backs the file up, writes through scan's atomic writer and
 * appends one discard-log line per row newly moved out of Pending.
 */
export async function refilterPipeline(options = {}) {
  const {
    pipelinePath = PIPELINE_PATH,
    portalsPath = PORTALS_PATH,
    blacklistPath = DEFAULT_BLACKLIST_PATH,
    discardLogPath = DEFAULT_DISCARD_LOG_PATH,
    apply = false,
    today = localToday(),
    now = Date.now(),
    timestamp = () => new Date().toISOString(),
  } = options;
  const rules = loadRules({ portalsPath, blacklistPath, now });
  if (!existsSync(pipelinePath)) throw new RefilterError(`pipeline not found at ${pipelinePath}`);
  const paths = {
    pipelinePath,
    portalsPath,
    blacklistPath: existsSync(blacklistPath) ? blacklistPath : null,
    blacklistCompanies: rules.blacklist.size,
    discardLogPath,
    backupPath: `${pipelinePath}.pre-refilter.bak`,
  };

  if (!apply) {
    const result = refilterDocument(readFileSync(pipelinePath, 'utf-8'), rules, { today });
    return { ...result, apply: false, paths, written: null };
  }

  return withPipelineLock(pipelinePath, async () => {
    const result = refilterDocument(readFileSync(pipelinePath, 'utf-8'), rules, { today });
    if (!result.changed) return { ...result, apply: true, paths, written: null };
    copyFileSync(pipelinePath, paths.backupPath);
    atomicWriteFile(pipelinePath, result.text);
    let logLines = 0;
    if (result.movedOut.length > 0) {
      mkdirSync(path.dirname(discardLogPath), { recursive: true });
      const stamp = timestamp();
      const lines = result.movedOut.map((entry) => `${stamp}\t${entry.url}\trefilter: ${entry.reason}\n`).join('');
      appendFileSync(discardLogPath, lines, 'utf-8');
      logLines = result.movedOut.length;
    }
    return {
      ...result,
      apply: true,
      paths,
      written: {
        pipelinePath,
        backupPath: paths.backupPath,
        discardLogPath: logLines > 0 ? discardLogPath : null,
        logLines,
      },
    };
  });
}

// ── Output ──────────────────────────────────────────────────────────

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function byReasonLines(byReason) {
  return Object.entries(byReason)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([reason, count]) => `      ${reason.padEnd(28)} ${count}`);
}

function sampleLines(entries, arrow) {
  return entries.slice(0, SAMPLE_LIMIT).map((entry) => {
    const detail = entry.detail ? ` (${entry.detail})` : '';
    return `  ${entry.company || '?'} | ${entry.title || '?'} -> ${arrow(entry)}${detail}`;
  });
}

export function renderReport(result) {
  const { counts, paths } = result;
  const lines = [];
  lines.push(`Inbox refilter: ${result.apply ? 'apply' : 'dry run'}`);
  lines.push(`Inbox: ${paths.pipelinePath}`);
  lines.push(`Rules: ${paths.portalsPath}${paths.blacklistPath ? `, blacklist ${paths.blacklistPath} (${plural(paths.blacklistCompanies, 'company', 'companies')})` : ', no blacklist file'}`);
  lines.push('');
  if (result.noPendingSection) {
    lines.push('No Pending section in the inbox; nothing to refilter.');
  } else {
    const untouched = counts.untouched;
    lines.push(`Entries inspected: ${counts.inspected} (${counts.pendingInspected} in Pending, ${counts.refilteredInspected} in ${result.refilteredHeader.replace(/^##\s+/, '')})`);
    lines.push(`  kept in Pending:      ${counts.keptInPending}`);
    lines.push(`  moved out of Pending: ${counts.movedOut}`);
    lines.push(...byReasonLines(counts.movedOutByReason));
    lines.push(`  restored to Pending:  ${counts.restored}`);
    lines.push(`  still refiltered:     ${counts.stillRefiltered}${counts.reasonRefreshed ? ` (${counts.reasonRefreshed} with the reason refreshed)` : ''}`);
    lines.push(...byReasonLines(counts.stillRefilteredByReason));
    lines.push(`  left untouched:       bare URL ${untouched.noMetadata}, expired ${untouched.expired}, error rows ${untouched.errorRows}, indented ${untouched.indented}, unrecognized rows in the refiltered section ${untouched.unrecognizedInRefiltered}`);
    if (counts.annotationsCleared) lines.push(`  stale annotations cleared from kept rows: ${counts.annotationsCleared}`);
    if (result.movedOut.length > 0) {
      lines.push('', `Moved out of Pending${result.movedOut.length > SAMPLE_LIMIT ? ` (first ${SAMPLE_LIMIT} of ${result.movedOut.length})` : ''}:`);
      lines.push(...sampleLines(result.movedOut, (entry) => entry.reason));
    }
    if (result.restored.length > 0) {
      lines.push('', `Restored to Pending${result.restored.length > SAMPLE_LIMIT ? ` (first ${SAMPLE_LIMIT} of ${result.restored.length})` : ''}:`);
      lines.push(...sampleLines(result.restored, (entry) => `passes now (was ${entry.previousReason}, parked ${entry.date})`));
    }
  }
  lines.push('', `Not re-applied, because a pipeline row lacks what they read: ${NOT_REAPPLIED.join(', ')}.`);
  lines.push('');
  if (!result.apply) {
    lines.push(result.changed ? '(dry run: nothing written)' : '(dry run: nothing written; the inbox already matches the current rules)');
  } else if (!result.written) {
    lines.push('Nothing to change: the inbox already matches the current rules. No backup written, no discard log appended.');
  } else {
    lines.push(`Written: ${result.written.pipelinePath}`);
    lines.push(`Backup:  ${result.written.backupPath}`);
    lines.push(result.written.discardLogPath
      ? `Discard log: ${result.written.discardLogPath} (+${plural(result.written.logLines, 'line')})`
      : 'Discard log: nothing appended (no row left Pending)');
  }
  return lines.join('\n');
}

export function toJson(result) {
  return {
    mode: result.apply ? 'apply' : 'dry-run',
    changed: result.changed,
    noPendingSection: result.noPendingSection,
    refilteredHeader: result.refilteredHeader,
    paths: result.paths,
    counts: result.counts,
    verdicts: result.verdicts,
    notReapplied: NOT_REAPPLIED,
    written: result.written,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────

const KNOWN_FLAGS = ['--apply', '--pipeline', '--portals', '--json', '--help', '-h'];
const VALUE_FLAGS = ['--pipeline', '--portals'];
const USAGE = `Usage: node fork/refilter.mjs [--apply] [--pipeline <path>] [--portals <path>] [--json]

Re-applies the current portals.yml and data/blacklist.md rules to the rows already
in the inbox's Pending section, with scan.mjs's own filter functions, in scan's
order: blacklist, title keywords, skip_tiers, location, posting age.

Dry run by default: prints what would move and writes nothing.

  --apply            write the inbox (a .pre-refilter.bak copy is taken first),
                     park rejected rows under a Refiltered section, restore parked
                     rows the current rules accept, append data/discard.log
  --pipeline <path>  inbox to refilter (default: CAREER_OPS_PIPELINE, else <data root>/data/pipeline.md)
  --portals <path>   rules file (default: CAREER_OPS_PORTALS, else <data root>/portals.yml)
  --json             one JSON object on stdout with the counts and per-row verdicts
  --help, -h         this text

Not re-applied, because a pipeline row lacks what they read:
  ${NOT_REAPPLIED.join(', ')}.`;

async function main(argv) {
  validateFlags(argv, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
  const apply = hasFlag(argv, '--apply');
  const json = hasFlag(argv, '--json');
  const pipelineFlag = flagValue(argv, '--pipeline');
  const portalsFlag = flagValue(argv, '--portals');
  try {
    const result = await refilterPipeline({
      pipelinePath: pipelineFlag ? path.resolve(pipelineFlag) : PIPELINE_PATH,
      portalsPath: portalsFlag ? path.resolve(portalsFlag) : PORTALS_PATH,
      apply,
    });
    console.log(json ? JSON.stringify(toJson(result), null, 2) : renderReport(result));
    return 0;
  } catch (error) {
    if (error instanceof RefilterError) {
      console.error(`Error: ${error.message}`);
      return 1;
    }
    if (error instanceof LockTimeoutError) {
      console.error(`Error: another writer holds the inbox lock (${error.message}). Nothing was written; run again once the scan or reconcile has finished.`);
      return 1;
    }
    throw error;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
