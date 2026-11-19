// fork/job-search/job-posting.mts: the record an agent hands over after reading
// a job board in a browser, and the pure steps that turn it into the offer shape
// scan.mjs writes (providers/_types.js `Job`, plus `source`).
//
// The agent does the reading: it opens Indeed, LinkedIn or Jora in a browser
// session, reads the result cards and the posting pages, and reports what it
// saw as JobPostingInput records. Nothing here fetches anything. This module
// only checks the record, gives the posting one stable URL, and maps the fields.
//
// One stable URL matters because scan-history.tsv dedups on it. A board hands
// out a different link to the same posting on every search (tracking
// parameters, click redirects, the search page with the posting selected), so
// each known board is reduced to its posting identifier.

export type WorkplaceType = 'remote' | 'hybrid' | 'onsite';

/** Annual pay as the posting states it. Never inferred from an hourly rate. */
export interface AnnualSalary {
  min?: number;
  max?: number;
  currency?: string;
}

/** One posting as the agent read it on a job board. */
export interface JobPostingInput {
  /** The posting's page on the board, in any form the board linked it. */
  url: string;
  title: string;
  company: string;
  location?: string;
  workplaceType?: WorkplaceType;
  /** `YYYY-MM-DD` or a full ISO timestamp. */
  postedAt?: string;
  /** `YYYY-MM-DD`, when the posting states a closing date. */
  closesAt?: string;
  salary?: AnnualSalary;
  /** Pay as advertised when it is not an annual figure, e.g. "$45-$52 per hour". */
  payText?: string;
  /** The posting body as plain text. Saved under jds/ so evaluation needs no refetch. */
  description?: string;
  /** The employer's application page, when the board links out to one. */
  applyUrl?: string;
  /** True when the board takes the application itself (Indeed Apply, LinkedIn Easy Apply). */
  easyApply?: boolean;
  /** Overrides the scan-history `portal` label derived from the URL. */
  source?: string;
  note?: string;
}

/** The offer scan.mjs's appendToPipeline / appendToScanHistory accept. */
export interface Offer {
  title: string;
  url: string;
  company: string;
  location: string;
  source: string;
  workplaceType?: WorkplaceType;
  description?: string;
  postedAt?: number;
  salary?: AnnualSalary;
  note?: string;
}

export interface ParsedPosting {
  offer: Offer;
  /** The canonical board URL. `offer.url` becomes a `local:` path once the JD is saved. */
  boardUrl: string;
  applyUrl: string;
  closesAt: string;
  payText: string;
  easyApply: boolean;
}

export interface InvalidPosting {
  index: number;
  errors: string[];
}

const INPUT_KEYS = new Set([
  'url', 'title', 'company', 'location', 'workplaceType', 'postedAt', 'closesAt',
  'salary', 'payText', 'description', 'applyUrl', 'easyApply', 'source', 'note',
]);
const WORKPLACE_TYPES = new Set(['remote', 'hybrid', 'onsite']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TRACKING_PARAMETER_RE = /^(utm_.+|gclid|fbclid|msclkid|ref|refid|trk|trackingid|src|source|from|position|pagenum|ebp|sni|abstract_type|sp|sponsored|sl|sol_srt|sr|tk|xpse|xfps|xkcb|vjs|advn|adid|mclk|bb|fccid|cmp|ti|iaal)$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseHttpUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

const hostIs = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/**
 * The board a posting URL belongs to, as a short label. It prefixes the
 * scan-history `portal` value (`browser-indeed`) so a later reader can tell a
 * browser-read posting from one a provider fetched over an API.
 */
export function boardOf(rawUrl: string): string {
  const url = parseHttpUrl(rawUrl);
  if (!url) return 'unknown';
  const host = url.hostname.toLowerCase();
  if (hostIs(host, 'indeed.com')) return 'indeed';
  if (hostIs(host, 'linkedin.com')) return 'linkedin';
  if (hostIs(host, 'jora.com')) return 'jora';
  if (hostIs(host, 'seek.com.au')) return 'seek';
  return host.replace(/^www\./, '');
}

/**
 * Reduce a posting link to the one URL that identifies the posting.
 *
 * Throws when a known board's link carries no posting identifier (an Indeed
 * sponsored-click redirect without `jk`, a LinkedIn search page with nothing
 * selected): recording such a link would dedup against nothing and open the
 * wrong page later.
 */
export function canonicalJobUrl(rawUrl: string): string {
  const url = parseHttpUrl(rawUrl);
  if (!url) throw new Error(`not an absolute http(s) URL: ${String(rawUrl)}`);
  const host = url.hostname.toLowerCase();

  if (hostIs(host, 'indeed.com')) {
    const jobKey = url.searchParams.get('jk') || url.searchParams.get('vjk');
    if (!jobKey || !/^[0-9a-f]{16}$/i.test(jobKey)) {
      throw new Error('Indeed link has no job key (jk); open the posting and use its viewjob URL');
    }
    return `https://${host}/viewjob?jk=${jobKey.toLowerCase()}`;
  }

  if (hostIs(host, 'linkedin.com')) {
    const fromPath = url.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d{6,})\/?$/);
    const jobId = fromPath?.[1] || url.searchParams.get('currentJobId');
    if (!jobId || !/^\d{6,}$/.test(jobId)) {
      throw new Error('LinkedIn link has no job id; use the posting\'s /jobs/view/<id> URL');
    }
    return `https://www.linkedin.com/jobs/view/${jobId}`;
  }

  if (hostIs(host, 'jora.com')) {
    const match = url.pathname.match(/^\/job\/([^/]+)\/?$/);
    if (!match) throw new Error('Jora link is not a posting page (/job/<slug>)');
    return `https://${host}/job/${match[1]}`;
  }

  if (hostIs(host, 'seek.com.au')) {
    const match = url.pathname.match(/\/job\/(\d+)/);
    if (!match) throw new Error('SEEK link is not a posting page (/job/<id>)');
    return `https://www.seek.com.au/job/${match[1]}`;
  }

  url.hash = '';
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETER_RE.test(name)) url.searchParams.delete(name);
  }
  return url.toString();
}

function parsePostedAt(value: string): number | null {
  const text = value.trim();
  const ms = Date.parse(ISO_DATE_RE.test(text) ? `${text}T00:00:00Z` : text);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function optionalString(record: Record<string, unknown>, key: string, errors: string[]): string {
  const value = record[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    errors.push(`${key} must be a string`);
    return '';
  }
  return value.trim();
}

function parseSalary(value: unknown, errors: string[]): AnnualSalary | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    errors.push('salary must be an object {min?, max?, currency?}');
    return undefined;
  }
  const salary: AnnualSalary = {};
  for (const bound of ['min', 'max'] as const) {
    const amount = value[bound];
    if (amount === undefined || amount === null) continue;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      errors.push(`salary.${bound} must be a positive number`);
      continue;
    }
    // An annual figure under 1000 is an hourly or daily rate written into the
    // wrong field. Annualizing it here would invent the hours.
    if (amount < 1000) {
      errors.push(`salary.${bound} (${amount}) is not an annual figure; put hourly or daily pay in payText`);
      continue;
    }
    salary[bound] = amount;
  }
  if (salary.min === undefined && salary.max === undefined) {
    if (!errors.some((error) => error.startsWith('salary.'))) errors.push('salary needs min or max');
    return undefined;
  }
  if (salary.min !== undefined && salary.max !== undefined && salary.min > salary.max) {
    errors.push('salary.min is greater than salary.max');
  }
  if (typeof value.currency === 'string' && value.currency.trim()) salary.currency = value.currency.trim().toUpperCase();
  return salary;
}

/** The pipeline row's `note:` segment: what the row's fixed columns cannot hold. */
function composeNote(parts: { payText: string; closesAt: string; easyApply: boolean; applyUrl: string; note: string }): string {
  const segments: string[] = [];
  if (parts.payText) segments.push(`pay ${parts.payText}`);
  if (parts.closesAt) segments.push(`closes ${parts.closesAt}`);
  if (parts.easyApply) segments.push('board apply');
  else if (parts.applyUrl) segments.push(`apply at ${new URL(parts.applyUrl).hostname.replace(/^www\./, '')}`);
  if (parts.note) segments.push(parts.note);
  return segments.join('; ');
}

/**
 * Check one record and map it to an offer. Returns the list of problems
 * instead of throwing, so one bad record does not cost the rest of a batch.
 */
export function parsePosting(input: unknown): { posting: ParsedPosting } | { errors: string[] } {
  if (!isPlainObject(input)) return { errors: ['record is not an object'] };
  const errors: string[] = [];

  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key)) errors.push(`unknown field "${key}"`);
  }

  const title = optionalString(input, 'title', errors);
  const company = optionalString(input, 'company', errors);
  if (!title) errors.push('title is required');
  if (!company) errors.push('company is required (use the advertiser or recruiter name the board shows)');

  let boardUrl = '';
  try {
    boardUrl = canonicalJobUrl(String(input.url ?? ''));
  } catch (error) {
    errors.push(`url: ${(error as Error).message}`);
  }

  const location = optionalString(input, 'location', errors);
  const description = optionalString(input, 'description', errors);
  const payText = optionalString(input, 'payText', errors);
  const note = optionalString(input, 'note', errors);
  const sourceOverride = optionalString(input, 'source', errors);
  if (sourceOverride && !/^[a-z0-9][a-z0-9-]*$/.test(sourceOverride)) errors.push('source must be lowercase letters, digits and hyphens');

  let workplaceType: WorkplaceType | undefined;
  if (input.workplaceType !== undefined && input.workplaceType !== null) {
    if (typeof input.workplaceType === 'string' && WORKPLACE_TYPES.has(input.workplaceType)) {
      workplaceType = input.workplaceType as WorkplaceType;
    } else {
      errors.push('workplaceType must be "remote", "hybrid" or "onsite"');
    }
  }

  let postedAt: number | undefined;
  const postedAtText = optionalString(input, 'postedAt', errors);
  if (postedAtText) {
    const ms = parsePostedAt(postedAtText);
    if (ms === null) errors.push('postedAt must be YYYY-MM-DD or an ISO timestamp (convert "3 days ago" before sending)');
    else postedAt = ms;
  }

  const closesAt = optionalString(input, 'closesAt', errors);
  if (closesAt && !ISO_DATE_RE.test(closesAt)) errors.push('closesAt must be YYYY-MM-DD');

  let applyUrl = '';
  if (input.applyUrl !== undefined && input.applyUrl !== null && input.applyUrl !== '') {
    const parsed = parseHttpUrl(input.applyUrl);
    if (parsed) applyUrl = parsed.toString();
    else errors.push('applyUrl must be an absolute http(s) URL');
  }

  if (input.easyApply !== undefined && typeof input.easyApply !== 'boolean') errors.push('easyApply must be true or false');
  const easyApply = input.easyApply === true;

  const salary = parseSalary(input.salary, errors);

  if (errors.length > 0) return { errors };

  const offer: Offer = {
    title,
    url: boardUrl,
    company,
    location,
    source: sourceOverride || `browser-${boardOf(boardUrl)}`,
  };
  if (workplaceType) offer.workplaceType = workplaceType;
  if (description) offer.description = description;
  if (postedAt !== undefined) offer.postedAt = postedAt;
  if (salary) offer.salary = salary;
  const composedNote = composeNote({ payText, closesAt, easyApply, applyUrl, note });
  if (composedNote) offer.note = composedNote;

  return { posting: { offer, boardUrl, applyUrl, closesAt, payText, easyApply } };
}

/**
 * Accept the payload an agent sends: an array of records, or `{ "jobs": [...] }`.
 * Throws when the payload is neither, because then nothing in it can be judged
 * record by record.
 */
export function parsePostings(payload: unknown): { postings: ParsedPosting[]; invalid: InvalidPosting[] } {
  const records = Array.isArray(payload) ? payload : (isPlainObject(payload) && Array.isArray(payload.jobs) ? payload.jobs : null);
  if (records === null) throw new Error('payload must be a JSON array of job records, or an object with a "jobs" array');

  const postings: ParsedPosting[] = [];
  const invalid: InvalidPosting[] = [];
  const boardUrls = new Set<string>();
  records.forEach((record, index) => {
    const result = parsePosting(record);
    if ('errors' in result) {
      invalid.push({ index, errors: result.errors });
      return;
    }
    // The same posting twice in one batch (a sponsored card and its organic
    // twin) is one posting.
    if (boardUrls.has(result.posting.boardUrl)) return;
    boardUrls.add(result.posting.boardUrl);
    postings.push(result.posting);
  });
  return { postings, invalid };
}
