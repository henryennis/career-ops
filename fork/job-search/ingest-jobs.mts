#!/usr/bin/env node
// fork/job-search/ingest-jobs.mts: put postings an agent read in a browser into
// career-ops, through the same gate and the same writers the scanners use.
//
// scan.mjs covers the boards that answer a plain HTTP request. Indeed, LinkedIn
// and Jora do not: they need a real browser, and an agent driving one (see
// SKILL.md beside this file) is the reader. This tool is the write half of that
// arrangement. The agent sends structured records; this decides which are new,
// saves each posting body under jds/, and appends to data/pipeline.md and
// data/scan-history.tsv. From there `pipeline`, `triage` and `apply` treat the
// postings like any scanned ones.
//
// What it reuses, so a browser-read posting cannot drift from a scanned one:
//   createLocalGate (scan-local-lib.mjs)  seen URL, blacklist, title_filter,
//                                         location_filter, same company+role
//   appendToPipeline / appendToScanHistory (scan.mjs)  locked, deduplicating
//   the plugins/apify jds/ capture shape  `local:jds/{slug}-{sha1(url)[0:10]}.md`
//
// Both writers accept only an http(s) posting URL (upstream #7591), so every
// posting is appended under its board URL, and scan-history keys on that URL.
// A posting whose body was captured then has its pipeline row pointed at the
// capture (`- [ ] local:jds/...`, the row modes/scan.md writes for a saved
// posting), under the same pipeline lock, so evaluation reads the saved body
// instead of fetching a board that needs a browser.
//
// Usage:
//   node fork/job-search/ingest-jobs.mts <jobs.json> [flags]
//   node fork/job-search/ingest-jobs.mts --stdin [flags]
//
// Flags:
//   --dry-run              judge every record, write nothing
//   --no-title-filter      admit titles portals.yml's title_filter would drop
//   --no-location-filter   admit locations portals.yml's location_filter would drop
//   --queries N            searches run to produce this batch (for scan-runs.tsv)
//
// Output: one JSON receipt on stdout. Exit 0 when the payload was readable, even
// if some records were refused (they are listed under `invalid`); exit 1 when
// the payload itself could not be read.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import {
  appendToPipeline,
  appendToScanHistory,
  atomicWriteFile,
  DATA_ROOT,
  formatPipelineOffer,
  PIPELINE_PATH,
  PORTALS_PATH,
} from '../../scan.mjs';
import { withPipelineLock } from '../../pipeline-lock.mjs';
import { createLocalGate, slugify, writeRunLog } from '../../scan-local-lib.mjs';
import { loadYaml } from '../../lib/yaml-document.mjs';
import { localToday } from '../../lib/local-today.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { parsePostings, type InvalidPosting, type Offer, type ParsedPosting } from './job-posting.mts';

const JDS_DIRECTORY = 'jds';
// Shorter than this is a search-result teaser, not a posting body. Saving it as
// the JD would make evaluation score the role against two sentences.
const MINIMUM_DESCRIPTION_CHARACTERS = 200;

const USAGE = `Usage:
  node fork/job-search/ingest-jobs.mts <jobs.json> [--dry-run] [--no-title-filter] [--no-location-filter] [--queries N]
  node fork/job-search/ingest-jobs.mts --stdin [flags]

The payload is a JSON array of job records, or {"jobs": [...]}. Record fields
are documented on JobPostingInput in fork/job-search/job-posting.mts.`;

interface Receipt {
  dryRun: boolean;
  received: number;
  added: Array<{ url: string; boardUrl: string; company: string; title: string; jd: string | null }>;
  skipped: Array<{ boardUrl: string; company: string; title: string; reason: string }>;
  invalid: InvalidPosting[];
  dataRoot: string;
}

interface Options {
  payloadPath: string | null;
  fromStdin: boolean;
  dryRun: boolean;
  titleFilter: boolean;
  locationFilter: boolean;
  queries: number;
}

function parseArguments(args: string[]): Options {
  const options: Options = { payloadPath: null, fromStdin: false, dryRun: false, titleFilter: true, locationFilter: true, queries: 1 };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (argument === '--stdin') options.fromStdin = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--no-title-filter') options.titleFilter = false;
    else if (argument === '--no-location-filter') options.locationFilter = false;
    else if (argument === '--queries') {
      const raw = args[++index];
      if (!raw || !/^[1-9]\d*$/.test(raw)) throw new Error('--queries needs a positive whole number');
      options.queries = Number(raw);
    } else if (argument.startsWith('-')) throw new Error(`unknown flag ${argument}`);
    else if (options.payloadPath === null) options.payloadPath = argument;
    else throw new Error(`unexpected argument ${argument}`);
  }
  if (options.fromStdin === (options.payloadPath !== null)) {
    throw new Error('give exactly one of <jobs.json> or --stdin');
  }
  return options;
}

function readPayload(options: Options): unknown {
  const text = options.fromStdin ? readFileSync(0, 'utf-8') : readFileSync(options.payloadPath as string, 'utf-8');
  // A file written by a Windows tool can start with a byte-order mark, which
  // JSON.parse rejects with an error that does not mention it.
  return JSON.parse(text.replace(/^﻿/, ''));
}

function loadPortals(): Record<string, unknown> {
  if (!existsSync(PORTALS_PATH)) return {};
  return (loadYaml(readFileSync(PORTALS_PATH, 'utf-8')) as Record<string, unknown>) || {};
}

const boardUrlHash = (boardUrl: string) => createHash('sha1').update(boardUrl).digest('hex').slice(0, 10);

/**
 * Where this posting's JD capture lives, relative to the data root.
 *
 * The hash of the board URL identifies the posting; the slug in front of it is
 * only for a human reading the directory. A posting captured earlier under a
 * slightly different title keeps its first file, so the pipeline reference
 * (and with it the seen-URL dedup) stays the same across runs.
 */
export function jdRelativePath(posting: ParsedPosting, dataRoot: string): string {
  const hash = boardUrlHash(posting.boardUrl);
  const directory = join(dataRoot, JDS_DIRECTORY);
  if (existsSync(directory)) {
    const existing = readdirSync(directory).find((name) => name.endsWith(`-${hash}.md`));
    if (existing) return `${JDS_DIRECTORY}/${existing}`;
  }
  const slug = slugify(`${posting.offer.company}-${posting.offer.title}`) || 'posting';
  return `${JDS_DIRECTORY}/${slug}-${hash}.md`;
}

/** The capture file: front matter a later step can read back, then the posting body verbatim. */
export function jdFileContent(posting: ParsedPosting, today: string): string {
  const { offer } = posting;
  const frontMatter: Record<string, unknown> = {
    title: offer.title,
    company: offer.company,
    url: posting.boardUrl,
    location: offer.location,
    scraped: today,
    source: offer.source,
  };
  if (posting.applyUrl) frontMatter.apply_url = posting.applyUrl;
  if (posting.easyApply) frontMatter.board_apply = true;
  if (offer.workplaceType) frontMatter.workplace_type = offer.workplaceType;
  if (offer.postedAt !== undefined) frontMatter.posted = new Date(offer.postedAt).toISOString().slice(0, 10);
  if (posting.closesAt) frontMatter.closes = posting.closesAt;
  if (offer.salary) frontMatter.salary = offer.salary;
  if (posting.payText) frontMatter.pay = posting.payText;
  return `---\n${yaml.dump(frontMatter)}---\n\n# ${offer.title} — ${offer.company}\n\n${offer.description}\n`;
}

/**
 * Point the Pending rows appendToPipeline just wrote for captured postings at
 * their capture. The row is found by the exact line formatPipelineOffer builds,
 * which is the line appendToPipeline wrote; a row it did not write (already in
 * the inbox) is left alone.
 */
async function pointRowsAtCaptures(entries: Array<{ posting: ParsedPosting; jdPath: string }>): Promise<void> {
  if (entries.length === 0 || !existsSync(PIPELINE_PATH)) return;
  await withPipelineLock(PIPELINE_PATH, async () => {
    const lines = readFileSync(PIPELINE_PATH, 'utf-8').split('\n');
    let changed = false;
    for (const { posting, jdPath } of entries) {
      const written = formatPipelineOffer(posting.offer);
      const index = written ? lines.indexOf(written) : -1;
      if (index === -1) continue;
      const firstCellEnd = written.indexOf(' | ');
      lines[index] = `- [ ] local:${jdPath}${firstCellEnd === -1 ? '' : written.slice(firstCellEnd)}`;
      changed = true;
    }
    if (changed) atomicWriteFile(PIPELINE_PATH, lines.join('\n'));
  });
}

const hasPostingBody = (offer: Offer) => typeof offer.description === 'string' && offer.description.length >= MINIMUM_DESCRIPTION_CHARACTERS;

export async function ingest(payload: unknown, options: Pick<Options, 'dryRun' | 'titleFilter' | 'locationFilter' | 'queries'>): Promise<Receipt> {
  const { postings, invalid } = parsePostings(payload);
  const today = localToday();
  const receipt: Receipt = {
    dryRun: options.dryRun,
    received: postings.length + invalid.length,
    added: [],
    skipped: [],
    invalid,
    dataRoot: DATA_ROOT,
  };

  const gateOptions: Record<string, unknown> = {};
  if (!options.titleFilter) gateOptions.titleFilter = () => true;
  if (!options.locationFilter) gateOptions.locationFilter = () => true;
  const gate = createLocalGate({ config: loadPortals(), gateOptions });

  const admitted: Array<{ posting: ParsedPosting; jdPath: string | null }> = [];
  for (const posting of postings) {
    // The seen check is asked about the board URL: that is the key both writers
    // record, whether or not the body was captured.
    const reason = gate.check(posting.offer);
    if (reason) {
      receipt.skipped.push({ boardUrl: posting.boardUrl, company: posting.offer.company, title: posting.offer.title, reason });
      continue;
    }
    const jdPath = hasPostingBody(posting.offer) ? jdRelativePath(posting, DATA_ROOT) : null;
    admitted.push({ posting, jdPath });
    receipt.added.push({
      url: jdPath ? `local:${jdPath}` : posting.offer.url,
      boardUrl: posting.boardUrl,
      company: posting.offer.company,
      title: posting.offer.title,
      jd: jdPath,
    });
  }

  if (options.dryRun) return receipt;

  for (const { posting, jdPath } of admitted) {
    if (!jdPath) continue;
    mkdirSync(join(DATA_ROOT, JDS_DIRECTORY), { recursive: true });
    try {
      // 'wx': an existing capture is the earlier, verified read of this posting.
      writeFileSync(join(DATA_ROOT, jdPath), jdFileContent(posting, today), { encoding: 'utf-8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  const offers = admitted.map(({ posting }) => posting.offer);
  if (offers.length > 0) {
    await appendToPipeline(offers);
    await pointRowsAtCaptures(admitted.filter((entry): entry is { posting: ParsedPosting; jdPath: string } => entry.jdPath !== null));
    await appendToScanHistory(offers, today, 'added');
  }
  await writeRunLog({ found: postings.length, counts: gate.counts, newAdded: offers.length, queries: options.queries, errors: invalid.length });
  return receipt;
}

async function main(args: string[]) {
  let options: Options;
  let payload: unknown;
  try {
    options = parseArguments(args);
    payload = readPayload(options);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}\n\n${USAGE}`);
    process.exit(1);
  }
  try {
    const receipt = await ingest(payload, options);
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  await main(process.argv.slice(2));
}
