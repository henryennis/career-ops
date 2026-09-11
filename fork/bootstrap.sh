#!/usr/bin/env bash
# Set up a clone of the career-ops fork. Safe to rerun. See fork/README.md.
#
#   fork/bootstrap.sh [--data-root <path>] [--no-install]
#
#   --data-root  directory holding your personal files (cv.md, config/, modes/_profile.md,
#                data/, reports/ ...). Written to the .career-ops-data marker that
#                upstream's path resolver reads; a relative path is resolved from
#                the checkout root. Omit to keep the default (the checkout itself).
#   --no-install skip npm install
set -euo pipefail

UPSTREAM_URL="https://github.com/career-ops-hq/career-ops.git"
MIRROR_BRANCH="${FORK_MIRROR_BRANCH:-main}"
STACK_BRANCH="${FORK_STACK_BRANCH:-patched}"
DATA_ROOT=""
INSTALL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --data-root) DATA_ROOT="${2:?--data-root needs a path}"; shift 2 ;;
    --no-install) INSTALL=0; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "bootstrap: unknown flag: $1" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
git_directory="$(git rev-parse --absolute-git-dir)"
say() { printf '  %s\n' "$*"; }
resolved_data_root() { node -e "import('./path-resolver.mjs').then(m => process.stdout.write(m.getCareerOpsRoot()))"; }

echo "remotes"
if git remote get-url upstream >/dev/null 2>&1; then
  say "upstream = $(git remote get-url upstream)"
else
  git remote add upstream "$UPSTREAM_URL"
  say "added upstream = $UPSTREAM_URL"
fi
git fetch --quiet --prune upstream

echo "git config for this clone"
git config rerere.enabled true
git config rerere.autoUpdate true
say "rerere.enabled=true rerere.autoUpdate=true (a conflict you resolve once is replayed on later syncs)"

echo "branches"
if git show-ref --verify --quiet "refs/heads/$STACK_BRANCH"; then
  say "$STACK_BRANCH exists"
elif git show-ref --verify --quiet "refs/remotes/origin/$STACK_BRANCH"; then
  git branch --quiet --track "$STACK_BRANCH" "origin/$STACK_BRANCH"
  say "created $STACK_BRANCH tracking origin/$STACK_BRANCH"
else
  git branch --quiet "$STACK_BRANCH" "$MIRROR_BRANCH"
  say "created $STACK_BRANCH from $MIRROR_BRANCH (empty stack)"
fi
say "$MIRROR_BRANCH is the mirror of upstream; never commit to it"

echo "fork-owned paths declaration"
if [ -L config/local-paths.txt ]; then
  say "config/local-paths.txt -> $(readlink config/local-paths.txt)"
elif [ -e config/local-paths.txt ]; then
  say "config/local-paths.txt is a regular file; make sure it carries the lines of fork/local-paths.txt"
else
  ln -s ../fork/local-paths.txt config/local-paths.txt
  say "config/local-paths.txt -> ../fork/local-paths.txt"
fi

echo "local git excludes (untracked, never staged, no .gitignore patch needed)"
exclude_file="$git_directory/info/exclude"
for pattern in .career-ops-data CLAUDE.local.md; do
  grep -qxF "$pattern" "$exclude_file" 2>/dev/null || echo "$pattern" >> "$exclude_file"
done
say ".career-ops-data CLAUDE.local.md"

if [ -n "$DATA_ROOT" ]; then
  echo "data root"
  # Stored absolute on purpose. Upstream resolves a relative marker from
  # wherever the code sits, and its test suite copies the code into a temporary
  # directory, so a relative path would point a test run at a phantom directory
  # inside the checkout.
  data_root_absolute="$(realpath -m "$DATA_ROOT")"
  printf '%s\n' "$data_root_absolute" > .career-ops-data
  resolved="$(resolved_data_root)"
  mkdir -p "$resolved/data" "$resolved/config" "$resolved/modes"
  say "marker .career-ops-data = $data_root_absolute"
  say "personal files go there, never into this checkout"
fi
resolved="$(resolved_data_root)"

echo "agent house rules"
custom_file="$resolved/modes/_custom.md"
if [ ! -e "$custom_file" ]; then
  mkdir -p "$(dirname "$custom_file")"
  cp modes/_custom.template.md "$custom_file"
  say "created $custom_file from upstream's template"
fi
if grep -qF '<!-- fork: begin -->' "$custom_file"; then
  say "$custom_file already carries the fork block"
else
  { echo; cat fork/custom-mode-block.md; } >> "$custom_file"
  say "appended the fork block to $custom_file"
fi

echo "data-root skills (third-party agent skills kept beside your data, linked into the checkout)"
skills_root="$resolved/skills"
if [ -d "$skills_root" ]; then
  linked=0
  for skill_dir in "$skills_root"/*/; do
    [ -f "$skill_dir/SKILL.md" ] || continue
    skill_path="${skill_dir%/}"
    skill_name="$(basename "$skill_path")"
    for cli_dir in .claude/skills .agents/skills; do
      mkdir -p "$cli_dir"
      link="$cli_dir/$skill_name"
      if [ -L "$link" ]; then
        [ "$(readlink "$link")" = "$skill_path" ] || ln -sfn "$skill_path" "$link"
      elif [ -e "$link" ]; then
        say "$link exists and is not a link; left alone"
        continue
      else
        ln -s "$skill_path" "$link"
      fi
      grep -qxF "$link" "$exclude_file" 2>/dev/null || echo "$link" >> "$exclude_file"
      say "$link -> $skill_path"
      linked=$((linked + 1))
    done
  done
  [ "$linked" -gt 0 ] || say "no skill directories with a SKILL.md under $skills_root"
else
  say "none ($skills_root does not exist)"
fi

echo "Claude Code local instructions"
if [ -e CLAUDE.local.md ]; then
  if grep -qF '@fork/agent-rules.md' CLAUDE.local.md; then
    say "CLAUDE.local.md already imports fork/agent-rules.md"
  else
    printf '\n@fork/agent-rules.md\n' >> CLAUDE.local.md
    say "appended @fork/agent-rules.md to CLAUDE.local.md"
  fi
else
  printf '@fork/agent-rules.md\n' > CLAUDE.local.md
  say "created CLAUDE.local.md importing fork/agent-rules.md (untracked; Claude Code loads it beside CLAUDE.md, and upstream's suite does not police it)"
fi

if [ "$INSTALL" = 1 ]; then
  echo "dependencies"
  npm install --ignore-scripts --no-audit --no-fund --silent
  say "npm packages installed; Playwright's browser was not downloaded (run 'npx playwright install chromium' before generating PDFs)"
fi

echo
echo "done. Next: fork/status.sh, and fork/sync-upstream.sh whenever you want upstream's changes."
