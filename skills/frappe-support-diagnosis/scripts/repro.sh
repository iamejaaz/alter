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
[ -f "$script" ] || { echo "no such script: $script" >&2; exit 2; }
site="${ALTER_REPRO_SITE:-repro.localhost}"

# Resolve the bench for this version. Prefer an explicit per-version path picked
# in Settings (ALTER_REPRO_DEVELOP / ALTER_REPRO_VERSION_16 / ALTER_REPRO_VERSION_15);
# fall back to a folder-of-benches convention under ALTER_REPRO_ROOT.
key="ALTER_REPRO_$(printf '%s' "$ver" | tr 'a-z-' 'A-Z_')"
eval "explicit=\${$key:-}"
bench=""
if [ -n "$explicit" ] && [ -d "$explicit/apps/frappe" ]; then
  bench="$explicit"
elif [ -n "${ALTER_REPRO_ROOT:-}" ]; then
  for cand in "$ALTER_REPRO_ROOT/bench-$ver" "$ALTER_REPRO_ROOT/$ver" "$ALTER_REPRO_ROOT/frappe-bench-$ver"; do
    [ -d "$cand/apps/frappe" ] && bench="$cand" && break
  done
fi
[ -n "$bench" ] || { echo "no bench for '$ver' — pick its folder in Alter → Settings → Repro benches (or set $key)." >&2; exit 2; }

echo "== reproduce on $ver :: $bench (site $site) =="
cd "$bench"
# Run the frappe console via the bench's own venv python + bench_helper. This
# works for BOTH a classic frappe-bench AND a pilot bench (pilot doesn't install
# the `bench` CLI; it drives frappe as `env/bin/python -m frappe.utils.bench_helper`).
# The console auto-inits + connects the site, so the script can use `frappe.*`
# directly — just assert the bug and frappe.db.rollback() at the end.
py="$bench/env/bin/python"
if [ -x "$py" ]; then
  "$py" -m frappe.utils.bench_helper frappe --site "$site" console < "$script"
elif command -v bench >/dev/null 2>&1; then
  bench --site "$site" console < "$script"
else
  echo "no venv python at $py and no 'bench' CLI — can't open a console" >&2; exit 2
fi
