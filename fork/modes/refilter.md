# Mode: refilter (Inbox Refilter)

Re-apply the current targeting rules to the entries already sitting in the inbox (`data/pipeline.md` under the data root), after you or a sync changed a rule. Runs `fork/refilter.mjs`, a fork-only script (see `fork/README.md`, layer 2). No job description is read, no token is spent, nothing is evaluated.

## The model

`scan.mjs` filters an offer once, at discovery, with the rules in `portals.yml` and `data/blacklist.md` as they were that day. Entries that pass land in the Pending section and wait for `/career-ops pipeline`. When the rules change later, those entries are not judged again: a title keyword added this morning does not reach the row scanned last week, and a company added to the blacklist stays in the queue until an evaluation is spent on it. The reverse holds too. An offer that yesterday's rules dropped is gone, and a rule loosened today does not bring it back without a rescan.

The refilter closes that gap for the rules a pipeline row can answer from its own cells. It judges every entry in Pending with the same five filters scan applies, in scan's order, through scan's own functions, so its verdict is the one scan would reach for the same offer today, with one softening on posting age described below the table:

| Order | Rule | Source | Reason written |
|---|---|---|---|
| 1 | Company blacklist | `data/blacklist.md` | `filtered_blacklist` |
| 2 | Title keywords (`title_filter`) | `portals.yml` | `filtered_title` |
| 3 | Seniority tiers (`skip_tiers`) | `portals.yml` | `filtered_tier:<tier>` |
| 4 | Location (`location_filter`) | `portals.yml` | `filtered_location` |
| 5 | Posting age (`max_posting_age_days`) | `portals.yml` | `filtered_posting_age` |

The first failing rule is the verdict, which is why a senior title that also hits a negative keyword reports the keyword. The dry run shows the detail beside each reason (which negative keyword hit, which location string, which posting date) so you can tell a rule that works from a rule that overreaches.

Posting age is the one rule judged less strictly than scan judges it. The row keeps the posting date to the day, and scan compared the exact instant, so the refilter treats the entry as posted at the end of that day and parks it for age only when scan would have rejected it at any time of day. An entry kept that scan would now drop costs one evaluation at most; an entry parked that scan would keep is a live posting lost, which is the error this leans away from.

Scan applies more filters after those five: the posted-date window given on the command line, salary, content keywords, country eligibility, visa, trust, and dedup against scan history. Each needs the job description, the structured salary, or a flag that existed only during that scan. A pipeline row carries none of them, so the refilter leaves them alone and says so in its last lines. An entry the refilter keeps has passed the metadata rules and nothing more; the evaluation still decides.

Rows that are missing the metadata are not judged: a bare pasted URL, an expired `~~...~~` entry, a `- [!]` error row, an indented row. Each is counted under "left untouched" so the report adds up to the section. Nothing in Processed is ever read.

## Where a moved entry goes, and how it comes back

Entries the current rules reject move out of Pending into a section the script owns, `## Refiltered` (`## Refiltradas` when the file uses the Spanish headers), placed after Pending and before Processed, created on first use and removed again once it is empty. The row keeps its whole original body; only the checkbox and one annotation change:

```markdown
## Refiltered

- [x] https://jobs.example.com/acme/123 | Acme | Senior Product Manager | note: refiltered 2026-09-12 filtered_tier:senior
- [x] https://jobs.example.com/acme/456 | Acme | Staff Engineer | Remote | note: refiltered 2026-09-12 filtered_tier:senior; curated shortlist
```

Two choices in that shape carry the design:

- `- [x]`, because every reader that hands out pending work keys on `- [ ]` (`modes/pipeline.md`, `rank-pipeline.mjs`, `openrouter-runner.mjs`, `archive-posting.mjs`, `reconcile-pipeline.mjs`), while scan's seen-URL reader and the plugin engine's dedup accept both boxes anywhere in the file. A parked entry is invisible to evaluation and still counts as known, so the next scan does not put the same URL back into Pending.
- The annotation rides in a `note:` segment, one of the four labels the row format allows. A note the row already carried stays behind the annotation, after `; `, as the second example shows. A `rank:` segment stays last.

Every run also judges the parked entries again. One the current rules now accept goes back to the end of Pending, below the entries that never left, as `- [ ]` with the annotation removed and any earlier note restored, byte for byte. One still rejected stays; if the reason changed, the reason is rewritten and the parking date kept. That second pass is what makes "I loosened a rule" work without a rescan, and it is why the section should be left to the script: a row you edit by hand there is left alone and reported as unrecognized.

A second apply under unchanged rules changes nothing, writes no backup, and appends nothing to the log.

## Workflow

1. Run the dry run and show the result:

   ```bash
   node fork/refilter.mjs
   ```

   The report names the inbox and the rules files, then counts: entries inspected, kept in Pending, moved out by reason, restored, still refiltered, left untouched with why. Up to eight sample rows per direction follow as `company | title -> reason (detail)`. Read the samples with the user before anything is written: a keyword that catches "Technical Recruiter" and "Recruiting Platform Engineer" alike is a keyword to narrow (a `word:` prefix, say) before applying.

2. Apply only when the user asks to apply, in words or with the flag:

   ```bash
   node fork/refilter.mjs --apply
   ```

   The script takes the same pipeline lock scan and reconcile take, copies the inbox to `data/pipeline.md.pre-refilter.bak` (overwritten by the next apply that changes something), writes through scan's atomic writer, and appends one line per entry newly moved out of Pending to `data/discard.log` in the three-field form `{ISO8601 timestamp}\t{url}\trefilter: {reason}`. `node discard-analytics.mjs` groups those lines beside the pre-screen gate's. Restored entries are not logged.

3. Report what was written, using the paths the script printed, and the count of entries now in Pending.

`--json` prints one object with the same counts and a per-row verdict list, and nothing else, for tooling. `--pipeline <path>` and `--portals <path>` retarget the two inputs; the environment variables `CAREER_OPS_PIPELINE` and `CAREER_OPS_PORTALS` do the same, as they do for scan. The blacklist and the discard log always follow the data root.

## When to run it

- After editing `portals.yml`: a title keyword added or removed, `skip_tiers`, a `location_filter` entry, `max_posting_age_days`.
- After adding or removing a company in `data/blacklist.md`.
- After `fork/sync-upstream.sh` brought a change to a matcher (`title-keywords.mjs`, `classify-tier.mjs`, the location or posting-age builders in `scan.mjs`): the rules are the same, the verdicts may not be.
- Before a long `/career-ops pipeline` or batch run over an inbox that has been accumulating for weeks.

## What this mode never does

It never opens a posting, extracts a job description, evaluates, writes a report or a PDF, edits the tracker, or submits anything. It never rescans; new offers still come from `/career-ops scan`. It never touches Processed, error rows, expired entries, or bare URLs. When the user disagrees with a verdict, the fix is the rule (edit `portals.yml` or the blacklist and run again). Moving the one row back to Pending by hand as `- [ ]` also works, annotation or not: the next run clears a stale annotation from a row the rules accept, and parks the row again, with a single fresh annotation, if they still reject it.
