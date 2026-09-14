# Maintaining this fork

This directory is the only place the fork adds files of its own. Everything else in the checkout is either upstream's, unchanged, or a patch recorded as one commit in git history. Read this page once. After that `fork/status.sh` tells you the state and `fork/sync-upstream.sh` does the work.

Upstream: https://github.com/career-ops-hq/career-ops. Fork: https://github.com/henryennis/career-ops.

## Why the April tree could not be upgraded

The April to May 2026 hunt ran on upstream 1.6 with edits made in place. The diff against upstream (kept as `patches/career-ops-1.6-working-tree.diff` in the enclosing ai-powered-job-search folder) touched 38 tracked files, +2181/-990 lines, and the files it edited are the ones upstream rewrites most often: `scan.mjs` (169 KB today), `modes/oferta.md` (82 KB) plus five translations of it, `modes/_shared.md`, `test-all.mjs` (988 KB), `README.md`, `package.json`. Upstream shipped 26 minor releases between 1.6 and 1.32, one every two to four days. No `git merge upstream/main` could have landed on that tree, so it was abandoned and the personal files were copied out by hand.

Two causes, both structural: personal files and system files in one working tree, and features written as edits to upstream files when upstream had, or later grew, a slot for them. The setup below removes both causes.

## The layers

Every change has a cheapest layer. Put it in the lowest one that works. The cost column is what you pay on each sync.

| Layer | What goes there | Where it lives | Cost per sync |
|---|---|---|---|
| 0. Personal data | CV, profile, tracker, reports, PDFs, job descriptions, interview prep | A directory outside the checkout, named in the `.career-ops-data` marker. Upstream calls this the data root (`path-resolver.mjs`); scripts and the mode files both resolve every user file against it (`modes/_shared.md`, "User Layer" table). | None. The checkout holds no personal file. |
| 1. User-layer config | Targeting, house rules, writing style, portals, the fact gate, plugin toggles | `modes/_profile.md`, `modes/_custom.md`, `modes/_brief.md`, `config/profile.yml`, `portals.yml`, `voice-dna.md`, `config/cv-facts.json`, `config/plugins.yml`, all under the data root. Upstream gitignores every one of them. | None. `DATA_CONTRACT.md` promises they are never overwritten. |
| 2. Additive files | New scripts, fork-only modes, a scan provider, a CLI prompt pack | `fork/` for anything upstream does not discover by filename. A provider goes in `providers/<name>.mjs` because upstream loads that directory by glob. A CV template does not belong here: it is personal and goes in the data root as a pack (layer 0, `fork/docs/cv-template-packs.md`). Anything outside upstream's system directories is declared in `fork/local-paths.txt`. | Near none. A file upstream does not have cannot conflict. It can break when an upstream module it imports changes shape; the test run on every sync catches that. |
| 3. Patches to upstream files | A bug fix upstream should take, or a behaviour upstream has no slot for | One commit each on `patched`, body ending with an `Upstream-Status:` trailer | Real. Every sync replays the patch, and when upstream edits the same lines you resolve a conflict. Keep this count near zero. |

`fork/local-paths.txt` is read through the symlink `config/local-paths.txt` by `validate-system-paths-coverage.mjs`, which the test suite runs. Its rule: every tracked file must be covered by upstream's system-path list or by the user-path list. `fork/` is in neither, so it is declared. A file added inside `templates/`, `fonts/` or `providers/` is already covered by the directory prefix, and the loader refuses a declaration for it, so do not list those.

### Agent skills kept in the data root

A skill the agent should have while working in this checkout, but which is neither upstream's to ship nor the fork's to version, can live in the data root under `skills/<name>/` (any directory holding a `SKILL.md`). `fork/bootstrap.sh` links each one into `.claude/skills/<name>` and `.agents/skills/<name>`, untracked and excluded locally. Henry's writing skill does not need this: it is installed as a Claude Code plugin at user scope, so it is available in every project already.

### Where the April features land

The port plan in the enclosing folder (`../docs/fork-and-port-plan-2026-09-11.md`) has the verdict on each feature against 1.32. By layer:

| Feature | Layer | Where |
|---|---|---|
| Targeting brief, disclosure rules, "the long professional file wins" | 1 | `modes/_profile.md`, `modes/_brief.md`, `modes/_custom.md`, `config/cv-facts.json` |
| Anti-slop gate on recruiter-facing prose (Henry's writing skill, nothing else) | 1 | Done 11 September: `voice-dna.md` in the data root is the `henry-writing-style` plugin's rules copied verbatim, and a house rule in `modes/_custom.md` makes every mode run drafts through that skill (Claude Code invokes the plugin; other CLIs apply the file) |
| SEEK Australia as a scan source | 1 | Done 14 September: three `job_boards` entries in the data root's `portals.yml`, each `provider: jobstreet`, `api: https://www.seek.com.au/api/jobsearch/v5/search`, `siteKey: AU-Main`, `searchLocation: "All Melbourne VIC"`, `pageSize: 30`, `maxPages: 3`, and one `searchKeywords` phrase apiece for the three ways this market words an entry-level software role |
| STAR story bank | 0 | `interview-prep/story-bank.md` under the data root |
| Inbox refilter after a targeting change | 2 | Done 12 September: `node fork/refilter.mjs` re-applies the current rules to the entries already in Pending through upstream's own filter functions, so it cannot disagree with `scan.mjs`; `fork/modes/refilter.md` is the agent mode, invoked as `/career-ops refilter` |
| Review lane (right domain, no seniority signal, human decides) | 2 first | A second scan lane through the `CAREER_OPS_PIPELINE` and `CAREER_OPS_SCAN_HISTORY` environment variables into a review inbox, with a fork script that subtracts what the strict lane already took. Only if that proves clumsy: a `review_tiers` patch next to `skip_tiers` in `scan.mjs`, offered upstream with an issue first. |
| Work Sans monochrome CV | 0 | A pack in `<data root>/templates/worksans/` with the woff2 files in its own `fonts/`, scaffolded with `node fork/new-cv-template.mjs worksans` and selected by `cv.template: worksans` in the data root's `config/profile.yml`. Discovery of data-root packs is a layer 3 patch this fork carries (`fork/docs/cv-template-packs.md`). |
| A CV that does not look like the other six (a designed layout, a computed sidebar) | 0, on two layer 3 patches | A pack with a `render.mjs`, started from `fork/cv-template-kit/packs/evidence-sidebar` with `node fork/new-cv-template.mjs <name> --pack ...`, previewed with `node fork/preview-cv-template.mjs <name> --pdf`. `fork/docs/cv-template-packs.md` is the tour. |
| Pi prompt pack | 2 | `.pi/`, declared in `fork/local-paths.txt` |
| Graduate programs classified as internships | 3, then upstream | One rule in `classify-tier.mjs` plus a test. Bug fixes need no issue first (`CONTRIBUTING.md`), so open the PR the same day and mark the patch `Submitted`. |
| Go in the Nix shell | drop | No Nix on this machine, and `go` is installed directly. |

### CV template packs

Your templates live in `<data root>/templates/<name>/`, the checkout never sees them, and they resolve by name like the shipped ones. `node fork/new-cv-template.mjs <name>` scaffolds one, `node fork/preview-cv-template.mjs <name> --pdf` renders a fictional sample through the real builder and prints the ATS score, and a pack may carry a `render.mjs` for what the placeholder fill cannot compute. Three of the pieces are layer 3 patches offered upstream (discovery in the data root, the renderer hook, the PDF step accepting data-root paths); the kit and the example pack are layer 2 under `fork/cv-template-kit/`. Read `fork/docs/cv-template-packs.md` before designing one; it says which checks a pack has to keep satisfied and how.

### Inbox refilter

`scan.mjs` judges an offer once, at discovery, so a rule you change afterwards never reaches the entries already waiting in the inbox. `node fork/refilter.mjs` judges them again with the same five metadata rules scan applies, in scan's order and through scan's own functions: the company blacklist, title keywords, `skip_tiers`, the location filter, and the posting-age cap (judged to the day, since that is all a row keeps, and only ever in the entry's favour). The filters that need the job description or a scan-time flag (salary, content, country eligibility, visa, trust, dedup, the posted-date window) stay out, and the report says so. Rejected entries move into a `## Refiltered` section the script owns, checked so nothing evaluates them while scan still counts the URL as seen, and they return to Pending byte for byte when a later run finds the rules accept them again. The default is a dry run; `--apply` backs the inbox up and appends the discard log. `fork/modes/refilter.md` is the agent mode.

## Branches

This is the vendor-branch pattern: one branch is a pristine copy of the vendor's code, the other is that copy plus our changes.

| Branch | Role | Rule |
|---|---|---|
| `main` | Mirror of `upstream/main`. Same commits, same SHAs. | Never commit here. `fork/sync-upstream.sh` fast-forwards it and pushes it; on GitHub, `gh repo sync henryennis/career-ops` does the same. |
| `patched` | The patch stack: `main` plus layers 2 and 3. The branch you run career-ops from. | Rebased onto `main` on every sync and pushed with `--force-with-lease`. Its SHAs change; never reference them from anywhere durable. |
| `fix/*`, `feat/*` | A patch on its way upstream. | Branch from `main`, cherry-pick the commit from `patched`, open the pull request against `career-ops-hq/career-ops`. |

`git log main..patched` is the complete, ordered statement of what this fork is. That readability is why the stack is rebased rather than merged: after a few merge commits the delta is smeared across history and nobody can answer "what does this fork change" without a diff tool.

## The sync loop

`fork/sync-upstream.sh` (flags: `--no-push`, `--skip-tests`) does, in order:

1. Fetches `upstream`.
2. Fast-forwards `main` to `upstream/main`. Refuses if `main` has grown commits of its own.
3. Rebases `patched` onto `main`. rerere ("reuse recorded resolution", `git config rerere.enabled`) replays any conflict you resolved on an earlier sync, and the script continues past those on its own. A patch that comes out empty, because upstream took the same change, is dropped and named in the output.
4. Runs `npm run lint` (`node --check` on every script) and `node test-all.mjs --quick` (upstream's full suite minus the dashboard build: about 8700 checks, two and a half minutes on this machine). The data-root marker is set aside for this step and restored afterwards: upstream's suite asserts the default root resolution and expects to read user files from the checkout, and with the marker in place nine of its checks fail.
5. Pushes `main` (fast-forward) and `patched` (`--force-with-lease`) to the fork.
6. Prints `fork/status.sh`.

When a conflict needs you, the script stops and prints the patch's subject, its `Upstream-Status`, the files, and how many times that patch has conflicted on this machine (kept in `.git/fork-conflicts.log`). Resolve, `git add`, `git rebase --continue`, rerun the script. rerere records the resolution as you go.

If tests fail after the rebase, nothing is pushed. `patched` sits rebased locally; fix the offending patch with `git rebase -i main` and rerun.

Run it whenever you want upstream's changes. Weekly keeps each rebase small. Skipping a month costs one larger rebase, not a broken tree, because the mirror jumps to upstream's tip in a single step.

## Patch discipline

- One concern per commit. A commit that does two things can be neither upstreamed nor dropped on its own.
- Subject in conventional-commit form (`fix:`, `feat:`, `docs:`), the form upstream's release tooling expects, so a cherry-pick fits without rewording.
- Body ends with a trailer using the OpenEmbedded `Upstream-Status` vocabulary:
  - `Upstream-Status: Pending`, not yet offered upstream
  - `Upstream-Status: Submitted <pull request url>`
  - `Upstream-Status: Denied`, upstream said no; the patch stays only while it is worth its sync cost
  - `Upstream-Status: Inappropriate <reason>`, fork-specific by nature and never going upstream
- When the status changes, reword the commit in place (`git rebase -i main`).
- The kill rule: the third time one patch conflicts, it does not get a fourth resolution. That week you either open the upstream pull request, re-express the change in layer 1 or 2, or drop it. `fork/status.sh` prints the strike counts.
- Expect upstream's tests to pin the shape of system files. The first patch tried here was one line appended to `CLAUDE.md` to import the agent rules; the suite has a check that `CLAUDE.md` holds only the `@AGENTS.md` import and its placeholder comment (issue #1088), so the sync's test step failed. The line moved to `CLAUDE.local.md`, which upstream neither tracks nor tests. A layer 3 patch often has to carry a test change with it, which doubles its surface.
- Upstreaming: commit the fix on `patched` first so you have it, then `git checkout -b fix/<name> main && git cherry-pick <sha>`, push, `gh pr create --repo career-ops-hq/career-ops`. When it merges, the next sync drops the local copy by itself.

## The built-in updater is not for this branch

Upstream ships `update-system.mjs` (`npm run update`, and the `update` mode an agent can run). It is an installer's update path. It fetches upstream, runs `git checkout FETCH_HEAD -- <every system path>`, and commits the result. On a checkout with committed patches it finds each file that differs from the merge-base with upstream, writes a `.bak` beside it, and excludes it from the checkout, printing "Keeping your versions. They will NOT receive upstream changes." Every patched file freezes at our version while the rest jumps to upstream, and the commit it makes puts `patched` on a history that no longer rebases cleanly. It also runs `npm install` and downloads a Playwright browser.

So: never run it here. `fork/bootstrap.sh` appends an Off-Limits block to `modes/_custom.md` (which every mode reads) so an agent asked to "update" runs `fork/sync-upstream.sh` instead, and writes an untracked `CLAUDE.local.md` that imports `fork/agent-rules.md` for Claude Code. `npm run update:check` only reads and is harmless.

## A public fork holds no personal data

A GitHub fork of a public repository is public and cannot be made private. Upstream's setup guide (`docs/SETUP.md`) says not to keep personal files in one. Layer 0 is how this fork complies: the data root marker points outside the checkout, and the marker itself is excluded through `.git/info/exclude`, so `git status` never offers it. The marker holds an absolute path: upstream resolves a relative one from wherever the code sits, and its test suite copies the code into a temporary directory, which is how one test run created a stray `ai-powered-job-search/` directory inside this checkout before the path was made absolute. Upstream's suite includes a personal-data scan, one more reason the sync runs it.

The data root is a directory laid out the way upstream expects the checkout root to be: `cv.md`, `config/profile.yml`, `modes/_profile.md`, `modes/_custom.md`, `portals.yml`, `data/`, `reports/`, `output/`, `jds/`, `interview-prep/`. Step 1 of the port plan fills it from `../source-of-truth/`. `node doctor.mjs` reports which of those files it finds.

## Setting up a clone

```bash
cd ~/repos/ai-powered-job-search        # the clone lives beside its data root
git clone https://github.com/henryennis/career-ops.git
cd career-ops
git checkout patched
fork/bootstrap.sh --data-root ../career-ops-data
fork/status.sh
```

`bootstrap.sh` is idempotent. It adds the `upstream` remote, turns on rerere, creates `patched` if missing, links `config/local-paths.txt` to `fork/local-paths.txt`, excludes the marker files locally, writes the data root marker, appends the fork block to `modes/_custom.md`, links data-root skills into the checkout, writes `CLAUDE.local.md`, and installs npm packages without the browser download.

## Vocabulary

- **Vendor branch**: a branch that tracks someone else's code unchanged, so local changes can be measured against it.
- **Patch stack**: local changes kept as an ordered series of commits on top of the vendor branch, rebased forward rather than merged.
- **rerere**: git's per-repository memory of how you resolved a conflict, keyed by the conflicting hunks, replayed when the same conflict recurs.
- **Force-with-lease**: a force push that refuses if the remote branch moved since you last fetched it, so a rebase cannot overwrite someone else's push.
- **Trailer**: a `Key: value` line at the end of a commit message that git can parse (`git log --format=%(trailers)`).
- **Upstream-Status**: the OpenEmbedded convention for that trailer, recording where a carried patch stands with its upstream.
