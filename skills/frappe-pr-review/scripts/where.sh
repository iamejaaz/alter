#!/bin/sh
# Resolve the local bench and app checkout for the repo being reviewed, so the
# review never assumes one machine or one app.
# Usage: where.sh <owner/repo> [base-branch]
#   where.sh frappe/erpnext          -> BENCH, APP, APP_PATH, SITE for erpnext
# Overrides: ALTER_BENCH (bench root), ALTER_REVIEW_SITE (site to reproduce on).
set -eu
full="${1:?usage: where.sh <owner/repo> [base-branch]}"
base="${2:-develop}"
app="${full##*/}"

looks_like_bench() { [ -d "$1/apps" ] && [ -d "$1/sites" ]; }
with_app=""

bench=""
for cand in "${ALTER_BENCH:-}" "${ALTER_AGENT_WORKDIR:-}" "${ALTER_REPRO_DEVELOP:-}" "$PWD"; do
  [ -n "$cand" ] && looks_like_bench "$cand" && bench="$cand" && break
done
# Walk up from here: the agent often starts inside an app checkout.
if [ -z "$bench" ]; then
  d="$PWD"
  while [ "$d" != "/" ]; do
    looks_like_bench "$d" && bench="$d" && break
    d="$(dirname "$d")"
  done
fi
# Last resort: a shallow scan of the usual places. Several benches can hold the
# same app, so pick the one that actually runs this line of the code: fewest
# commits on its HEAD that the PR's base branch does not have. A v15 bench has
# thousands, so develop PRs never land on it.
if [ -z "$bench" ]; then
  fallback=""; closest=""
  for root in "$HOME" "$HOME/projects" "$HOME/projects"/* "$HOME/frappe" "$HOME/benches" "${ALTER_REPRO_ROOT:-}"; do
    [ -d "$root" ] || continue
    for cand in "$root"/*; do
      looks_like_bench "$cand" || continue
      [ -n "$fallback" ] || fallback="$cand"
      [ -d "$cand/apps/$app/.git" ] || continue
      [ -n "$with_app" ] || with_app="$cand"
      for ref in "upstream/$base" "origin/$base"; do
        git -C "$cand/apps/$app" rev-parse --verify "$ref" >/dev/null 2>&1 || continue
        n="$(git -C "$cand/apps/$app" rev-list --count "$ref..HEAD" 2>/dev/null || echo 999999)"
        if [ -z "$closest" ] || [ "$n" -lt "$closest" ]; then closest="$n"; bench="$cand"; fi
        break
      done
    done
  done
  [ -n "$bench" ] || bench="${with_app:-$fallback}"
fi

[ -n "$bench" ] || { echo "BENCH="; echo "note=no bench found — set ALTER_BENCH, or review from the diff only"; exit 0; }

app_path="$bench/apps/$app"
[ -d "$app_path/.git" ] || app_path=""

# A site to reproduce on: the explicit pick, then the bench default, then any
# site with a config. Whether this app is installed on it is the agent's check.
site="${ALTER_REVIEW_SITE:-}"
if [ -z "$site" ] && [ -f "$bench/sites/currentsite.txt" ]; then
  site="$(tr -d ' \n' < "$bench/sites/currentsite.txt")"
fi
if [ -z "$site" ]; then
  for s in "$bench"/sites/*/site_config.json; do
    [ -f "$s" ] || continue
    site="$(basename "$(dirname "$s")")"
    break
  done
fi

echo "BENCH=$bench"
echo "APP=$app"
echo "APP_PATH=${app_path:-"(not cloned on this bench — read the code from the diff and gh)"}"
echo "SITE=${site:-"(no site — skip reproduction)"}"
[ -n "$app_path" ] || exit 0

remote=upstream
git -C "$app_path" remote get-url upstream >/dev/null 2>&1 || remote=origin
echo "REMOTE=$remote"
if [ -z "$(find "$app_path/.git/FETCH_HEAD" -mmin -10 2>/dev/null)" ]; then
  git -C "$app_path" fetch --quiet --no-tags "$remote" "$base" 2>/dev/null || true
fi
git -C "$app_path" rev-parse --verify --short "$remote/$base" >/dev/null 2>&1 \
  && echo "BASE_REF=$remote/$base ($(git -C "$app_path" rev-parse --short "$remote/$base"))" \
  || echo "BASE_REF=(no $remote/$base — fetch it before comparing)"
for f in code_review.md AGENTS.md CLAUDE.md; do
  [ -f "$app_path/$f" ] && echo "RUBRIC=$app_path/$f"
done
exit 0
