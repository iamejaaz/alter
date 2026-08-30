#!/bin/sh
# Run a reproduction script on the per-version bench, on its repro site.
# Usage: repro.sh <develop|version-16|version-15> <script.py>
#
# Benches live under $ALTER_REPRO_ROOT (set in Alter → Settings → Repro benches):
#   $ALTER_REPRO_ROOT/bench-develop, bench-version-16, bench-version-15
# each with frappe + the relevant apps installed and a repro site
# ($ALTER_REPRO_SITE, default repro.localhost). The script should assert the bug
# and roll back (frappe.db.rollback) so nothing persists.
set -eu
ver="${1:?usage: repro.sh <develop|version-16|version-15> <script.py>}"
script="${2:?need a python repro script path}"
root="${ALTER_REPRO_ROOT:-}"
[ -n "$root" ] || { echo "ALTER_REPRO_ROOT is not set — set it in Alter → Settings → Repro benches (a folder holding your per-version benches)." >&2; exit 2; }
[ -f "$script" ] || { echo "no such script: $script" >&2; exit 2; }
site="${ALTER_REPRO_SITE:-repro.localhost}"

bench=""
for cand in "$root/bench-$ver" "$root/$ver" "$root/frappe-bench-$ver"; do
  [ -d "$cand/apps/frappe" ] && bench="$cand" && break
done
[ -n "$bench" ] || { echo "no bench for '$ver' under $root (looked for bench-$ver, $ver, frappe-bench-$ver)." >&2; exit 2; }

echo "== reproduce on $ver :: $bench (site $site) =="
cd "$bench"
bench --site "$site" console < "$script"
