#!/usr/bin/env bash
# Take upstream's changes into this fork. See fork/README.md, "The sync loop".
#
#   fork/sync-upstream.sh [--no-push] [--skip-tests]
#
#   1. fetch upstream
#   2. fast-forward the mirror branch (main) to upstream/main
#   3. rebase the patch stack (patched) onto the mirror; rerere replays
#      resolutions you made before, and a patch upstream has absorbed is dropped
#   4. npm run lint, then node test-all.mjs --quick (unless --skip-tests)
#   5. push main (fast-forward) and patched (force-with-lease) unless --no-push
set -euo pipefail

UPSTREAM_REMOTE="${FORK_UPSTREAM_REMOTE:-upstream}"
ORIGIN_REMOTE="${FORK_ORIGIN_REMOTE:-origin}"
MIRROR_BRANCH="${FORK_MIRROR_BRANCH:-main}"
STACK_BRANCH="${FORK_STACK_BRANCH:-patched}"
PUSH=1
RUN_TESTS=1
for argument in "$@"; do
  case "$argument" in
    --no-push) PUSH=0 ;;
    --skip-tests) RUN_TESTS=0 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "sync: unknown flag: $argument" >&2; exit 2 ;;
  esac
done

repository_root="$(git rev-parse --show-toplevel)"
cd "$repository_root"
git_directory="$(git rev-parse --absolute-git-dir)"
conflict_log="$git_directory/fork-conflicts.log"
upstream_head="$UPSTREAM_REMOTE/$MIRROR_BRANCH"

fail() { printf 'sync: %s\n' "$*" >&2; exit 1; }
rebase_output="$(mktemp)"
tests_worktree=""
cleanup() {
  rm -f "$rebase_output"
  if [ -n "$tests_worktree" ] && [ -d "$tests_worktree" ]; then
    git worktree remove --force "$tests_worktree" >/dev/null 2>&1 || rm -rf "$tests_worktree"
    git worktree prune >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
step() { printf '\n== %s\n' "$*"; }
rebase_in_progress() { [ -d "$git_directory/rebase-merge" ] || [ -d "$git_directory/rebase-apply" ]; }
stuck_patch() { git log -1 --format=%s REBASE_HEAD 2>/dev/null || echo '(unknown patch)'; }
stuck_status() { git log -1 --format='%(trailers:key=Upstream-Status,valueonly)' REBASE_HEAD 2>/dev/null | tr -d '\n'; }

# Preconditions
git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1 \
  || fail "no '$UPSTREAM_REMOTE' remote. Run fork/bootstrap.sh first."
git show-ref --verify --quiet "refs/heads/$STACK_BRANCH" \
  || fail "no local '$STACK_BRANCH' branch. Run fork/bootstrap.sh first."
if rebase_in_progress; then
  fail "a rebase is already in progress. Finish it (git add <files> && git rebase --continue) or abandon it (git rebase --abort), then rerun."
fi
[ -z "$(git status --porcelain)" ] \
  || fail "working tree is not clean. Commit or stash first."
[ "$(git config --get rerere.enabled || true)" = "true" ] \
  || echo "sync: warning: rerere is off, so conflict resolutions will not be remembered. Run fork/bootstrap.sh." >&2

# 1. Fetch
step "fetch $UPSTREAM_REMOTE"
git fetch --prune --tags "$UPSTREAM_REMOTE"

# 2. Mirror
step "fast-forward $MIRROR_BRANCH to $upstream_head"
git merge-base --is-ancestor "$MIRROR_BRANCH" "$upstream_head" \
  || fail "$MIRROR_BRANCH has commits upstream does not have. It must stay a pure mirror. Move them onto $STACK_BRANCH (git cherry-pick) and reset $MIRROR_BRANCH to $upstream_head."
mirror_before="$(git rev-parse --short "$MIRROR_BRANCH")"
if [ "$(git symbolic-ref --quiet --short HEAD || true)" = "$MIRROR_BRANCH" ]; then
  git merge --quiet --ff-only "$upstream_head"
else
  git branch --quiet -f "$MIRROR_BRANCH" "$upstream_head" \
    || fail "could not move $MIRROR_BRANCH. Is it checked out in another worktree? (git worktree list)"
fi
mirror_after="$(git rev-parse --short "$MIRROR_BRANCH")"
mirror_version="$(git show "$MIRROR_BRANCH:VERSION" 2>/dev/null | cut -d'#' -f1 | tr -d ' \n')"
if [ "$mirror_before" = "$mirror_after" ]; then
  echo "$MIRROR_BRANCH already at $mirror_after (v$mirror_version); nothing new upstream"
else
  echo "$MIRROR_BRANCH: $mirror_before -> $mirror_after (v$mirror_version, $(git rev-list --count "$mirror_before..$mirror_after") new commit(s))"
fi

# 3. Rebase the stack
step "rebase $STACK_BRANCH onto $MIRROR_BRANCH"
git checkout --quiet "$STACK_BRANCH"
stack_before="$(git rev-parse --short "$STACK_BRANCH")"
patches_before="$(git rev-list --count "$MIRROR_BRANCH..$STACK_BRANCH")"
subjects_before="$(git log --format=%s "$MIRROR_BRANCH..$STACK_BRANCH")"
if ! git rebase "$MIRROR_BRANCH" >"$rebase_output" 2>&1; then
  iterations=0
  last_stuck=""
  while :; do
    iterations=$((iterations + 1))
    [ "$iterations" -le 500 ] || fail "rebase did not converge after $iterations steps; inspect with: git status"
    if ! rebase_in_progress; then
      cat "$rebase_output" >&2
      fail "rebase failed without a conflict (output above)"
    fi
    unresolved="$(git diff --name-only --diff-filter=U)"
    if [ -n "$unresolved" ]; then
      patch="$(stuck_patch)"
      printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$patch" "$(printf '%s' "$unresolved" | paste -sd,)" >> "$conflict_log"
      strikes="$(awk -F'\t' -v p="$patch" '$2 == p' "$conflict_log" | wc -l)"
      cat >&2 <<MESSAGE

sync: CONFLICT replaying patch: $patch
      Upstream-Status: $(stuck_status)
      files: $(printf '%s' "$unresolved" | paste -sd' ')
      strikes for this patch on this machine: $strikes (log: $conflict_log)

  Resolve, then:  git add <files> && git rebase --continue && fork/sync-upstream.sh
  Abandon:        git rebase --abort
  Third strike:   apply the kill rule in fork/README.md (upstream it, move it to a lower layer, or drop it)
MESSAGE
      exit 1
    fi
    # Nothing unresolved: rerere replayed a remembered resolution, or the patch is now empty.
    stuck="$(git rev-parse REBASE_HEAD 2>/dev/null || echo none)"
    [ "$stuck" != "$last_stuck" ] || fail "rebase is stuck on '$(stuck_patch)' with no conflict to resolve; inspect with: git status"
    last_stuck="$stuck"
    git add -u
    if git diff --cached --quiet; then
      echo "dropped (upstream now carries the same change): $(stuck_patch)"
      if git rebase --skip >"$rebase_output" 2>&1; then break; else continue; fi
    fi
    echo "rerere replayed a remembered resolution: $(stuck_patch)"
    if GIT_EDITOR=true git rebase --continue >"$rebase_output" 2>&1; then break; else continue; fi
  done
fi
stack_after="$(git rev-parse --short "$STACK_BRANCH")"
patches_after="$(git rev-list --count "$MIRROR_BRANCH..$STACK_BRANCH")"
echo "$STACK_BRANCH: $stack_before -> $stack_after, $patches_before -> $patches_after patch(es)"
subjects_after="$(git log --format=%s "$MIRROR_BRANCH..$STACK_BRANCH")"
dropped="$(comm -23 <(printf '%s\n' "$subjects_before" | grep . | sort) <(printf '%s\n' "$subjects_after" | grep . | sort) || true)"
[ -z "$dropped" ] || printf '%s\n' "$dropped" | sed 's/^/dropped (upstream now carries it): /'

# 4. Verify
step "lint (node --check on every script)"
npm run --silent lint
if [ "$RUN_TESTS" = 1 ]; then
  step "tests: node test-all.mjs --quick (in a throwaway copy)"
  # The suite runs in a detached worktree of the rebased stack, never in this
  # checkout. Two of upstream's own tests write the tracker and the follow-up
  # file at their real paths and restore them afterwards (tests/stats.test.mjs,
  # tests/plugin-run-isolation-and-gmail-dryrun.test.mjs); a run that is
  # interrupted never reaches the restore, which would leave fixture rows in
  # the user's tracker. A copy also gives the suite the default data-root
  # resolution it asserts, whether or not this checkout holds user files.
  tests_worktree="$(mktemp -d "${TMPDIR:-/tmp}/career-ops-sync-tests.XXXXXX")"
  rm -rf "$tests_worktree"
  git worktree add --detach "$tests_worktree" HEAD >/dev/null \
    || fail "could not create the test worktree at $tests_worktree"
  ln -s "$repository_root/node_modules" "$tests_worktree/node_modules"
  ln -s ../fork/local-paths.txt "$tests_worktree/config/local-paths.txt"
  ( cd "$tests_worktree" && node test-all.mjs --quick ) \
    || fail "tests failed on the rebased stack. $STACK_BRANCH is rebased locally and NOT pushed. Fix the patch (git rebase -i $MIRROR_BRANCH), then rerun." 
else
  echo "tests skipped (--skip-tests)"
fi

# 5. Push
if [ "$PUSH" = 1 ]; then
  step "push to $ORIGIN_REMOTE"
  git push --quiet "$ORIGIN_REMOTE" "$MIRROR_BRANCH:$MIRROR_BRANCH" \
    || fail "$ORIGIN_REMOTE/$MIRROR_BRANCH refused a fast-forward, so the GitHub mirror has diverged. Inspect: git log $ORIGIN_REMOTE/$MIRROR_BRANCH --not $upstream_head"
  git push --quiet --force-with-lease "$ORIGIN_REMOTE" "$STACK_BRANCH"
  echo "pushed $MIRROR_BRANCH (fast-forward) and $STACK_BRANCH (force-with-lease)"
else
  echo "push skipped (--no-push)"
fi

step "state"
# Not `exec`: that replaces this shell, and the EXIT trap that removes the
# test worktree would never run, leaving a full copy of the repository in
# the temp directory after every successful sync.
"$repository_root/fork/status.sh"
