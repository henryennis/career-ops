#!/usr/bin/env bash
# Show what this fork carries on top of upstream, by layer, and which patches
# keep conflicting. Read-only. See fork/README.md.
set -euo pipefail

UPSTREAM_REMOTE="${FORK_UPSTREAM_REMOTE:-upstream}"
MIRROR_BRANCH="${FORK_MIRROR_BRANCH:-main}"
STACK_BRANCH="${FORK_STACK_BRANCH:-patched}"

cd "$(git rev-parse --show-toplevel)"
git_directory="$(git rev-parse --absolute-git-dir)"
conflict_log="$git_directory/fork-conflicts.log"

version_at() { git show "$1:VERSION" 2>/dev/null | cut -d'#' -f1 | tr -d ' \n'; }
short() { git rev-parse --short "$1"; }
when() { git log -1 --format=%cd --date=short "$1"; }

printf '%-9s %-16s %s  v%s  %s\n' mirror "$MIRROR_BRANCH" "$(short "$MIRROR_BRANCH")" "$(version_at "$MIRROR_BRANCH")" "$(when "$MIRROR_BRANCH")"
if git rev-parse --verify --quiet "$UPSTREAM_REMOTE/$MIRROR_BRANCH" >/dev/null; then
  behind="$(git rev-list --count "$MIRROR_BRANCH..$UPSTREAM_REMOTE/$MIRROR_BRANCH")"
  printf '%-9s %-16s %s  v%s  %s  (mirror is %s commit(s) behind, as of the last fetch)\n' upstream "$UPSTREAM_REMOTE/$MIRROR_BRANCH" "$(short "$UPSTREAM_REMOTE/$MIRROR_BRANCH")" "$(version_at "$UPSTREAM_REMOTE/$MIRROR_BRANCH")" "$(when "$UPSTREAM_REMOTE/$MIRROR_BRANCH")" "$behind"
fi
patch_count="$(git rev-list --count "$MIRROR_BRANCH..$STACK_BRANCH")"
printf '%-9s %-16s %s  %s patch(es) on top of %s\n' stack "$STACK_BRANCH" "$(short "$STACK_BRANCH")" "$patch_count" "$MIRROR_BRANCH"

echo
echo "Patches, oldest first:"
if [ "$patch_count" = 0 ]; then
  echo "  (none)"
else
  git log --reverse --format='  %h  %s%n          Upstream-Status: %(trailers:key=Upstream-Status,valueonly,separator=%x2C)' "$MIRROR_BRANCH..$STACK_BRANCH" \
    | sed 's/Upstream-Status: $/Upstream-Status: <missing>/'
fi

echo
echo "Files, by layer:"
name_status="$(git diff --name-status "$MIRROR_BRANCH..$STACK_BRANCH")"
added="$(printf '%s\n' "$name_status" | awk '$1 ~ /^A/ {print $2}' | grep . || true)"
changed="$(printf '%s\n' "$name_status" | awk '$1 !~ /^A/ && NF {print $1, $NF}' | grep . || true)"
added_count="$(printf '%s' "$added" | grep -c . || true)"
changed_count="$(printf '%s' "$changed" | grep -c . || true)"
echo "  layer 2, files upstream does not ship (free to carry): $added_count"
[ -z "$added" ] || printf '%s\n' "$added" | sed 's/^/    /'
echo "  layer 3, upstream files this fork changes (each one costs on every sync): $changed_count"
[ -z "$changed" ] || printf '%s\n' "$changed" | sed 's/^/    /'

echo
if [ -s "$conflict_log" ]; then
  echo "Conflict strikes on this machine (three on one patch = apply the kill rule):"
  cut -f2 "$conflict_log" | sort | uniq -c | sort -rn | sed 's/^/  /'
else
  echo "No conflicts recorded on this machine yet."
fi
