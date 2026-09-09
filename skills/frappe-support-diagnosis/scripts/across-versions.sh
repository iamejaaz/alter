#!/bin/sh
# Show a file (or a git diff of it) across develop -> v16 -> v15 to see where a
# code path is broken vs fixed. Run from the bench root or from inside an app.
# Usage: across-versions.sh <path-relative-to-app-repo> [app]
#        across-versions.sh frappe/website/doctype/web_form/web_form.py frappe
set -eu
path="${1:?usage: across-versions.sh <repo-relative-path> [app=frappe] [symbol-regex]}"
app="${2:-frappe}"
sym="${3:-}"
root="${BENCH:-$PWD}"
repo="$root/apps/$app"
[ -d "$repo/.git" ] || repo="$PWD"   # allow running from inside the app repo
cd "$repo"

# Prefer upstream (frappe/frappe): local branches and a fork's `origin` can be
# badly stale (a real run found the local version-15-hotfix 3 years old, which
# would have wrongly read as "fixed"). Fetch ONLY the 3 branches we triage, with
# --no-tags — a plain `git fetch upstream` drags in frappe's thousands of tags
# and is the single slowest step. Skip the fetch entirely if we pulled within the
# last 10 min (FETCH_HEAD fresh), so repeat runs don't re-hit the network.
BR="develop version-16-hotfix version-15-hotfix"
fh=".git/FETCH_HEAD"
if [ -z "$(find "$fh" -mmin -10 2>/dev/null)" ]; then
  git fetch --quiet --no-tags upstream $BR 2>/dev/null \
    || git fetch --quiet --no-tags origin $BR 2>/dev/null || true
fi
for ref in develop version-16-hotfix version-15-hotfix; do
  full=$(git rev-parse --verify "upstream/$ref" 2>/dev/null \
    || git rev-parse --verify "origin/$ref" 2>/dev/null \
    || git rev-parse --verify "$ref" 2>/dev/null || true)
  if [ -z "$full" ]; then
    echo "=== $ref: not found (try: git fetch upstream $ref) ==="; echo; continue
  fi
  echo "=== $ref ($(git rev-parse --short "$full")) : $path ==="
  if ! body=$(git show "$full:$path" 2>/dev/null); then
    echo "(path absent at this ref)"; echo; continue
  fi
  n=$(printf '%s\n' "$body" | wc -l | tr -d ' ')
  if [ -n "$sym" ]; then
    printf '%s\n' "$body" | grep -n -E -B3 -A25 -- "$sym" || echo "(no match for '$sym' — $n lines)"
  elif [ "$n" -le 250 ]; then
    printf '%s\n' "$body"
  else
    echo "($n lines — pass a symbol regex as the 3rd arg to see just that region)"
    printf '%s\n' "$body" | grep -n -E '^(def |class |\t*def )' | head -60
  fi
  echo
done
echo "=== diff stat: version-15-hotfix..develop -- $path ==="
git --no-pager diff --stat "$(git rev-parse --verify upstream/version-15-hotfix 2>/dev/null || echo version-15-hotfix)" "$(git rev-parse --verify upstream/develop 2>/dev/null || echo develop)" -- "$path" 2>/dev/null || true
echo "Tip: to compare, diff two refs directly:"
echo "  git -C $repo diff version-15-hotfix develop -- $path"
