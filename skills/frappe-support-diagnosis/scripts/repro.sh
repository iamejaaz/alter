#!/bin/sh
# Run a reproduction script on the per-version bench, on its repro site.
# Usage: repro.sh <develop|version-16|version-15> <script.py>
#        repro.sh <develop|version-16|version-15> -   # read the script from stdin
#
# Benches live under $ALTER_REPRO_ROOT (set in Alter → Settings → Repro benches):
#   $ALTER_REPRO_ROOT/bench-develop, bench-version-16, bench-version-15
# each with frappe + the relevant apps installed and a repro site
# ($ALTER_REPRO_SITE, default repro.localhost). The script should assert the bug
# and roll back (frappe.db.rollback) so nothing persists.
set -eu
ver="${1:?usage: repro.sh <develop|version-16|version-15> <script.py|->}"
script="${2:?need a python repro script path (or - for stdin)}"
if [ "$script" = "-" ]; then
  tmp="$(mktemp -t alter-repro.XXXXXX.py)"
  trap 'rm -f "$tmp"' EXIT
  cat > "$tmp"
  script="$tmp"
fi
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

# Create the reusable repro site once if it's missing on this bench (then it's
# reused forever — repros roll back, so this is a one-time cost per bench).
if [ ! -d "$bench/sites/$site" ]; then
  echo ">> $site missing on $ver — creating it (one-time)"
  apps_list="${REPRO_APPS:-hrms erpnext}"
  if [ -f "$bench/bench.toml" ] && command -v pilot >/dev/null 2>&1; then
    name="$(basename "$bench")"
    # clone any missing apps into the bench at this version, then create the site
    for app in $apps_list; do
      [ -d "$bench/apps/$app" ] || { echo "   get-app $app@$ver"; pilot -b "$name" get-app "https://github.com/frappe/$app" --branch "$ver" || echo "   (couldn't get $app@$ver)"; }
    done
    pilot -b "$name" new-site "$site" --admin-password "${REPRO_ADMIN_PW:-admin}" --apps frappe $apps_list \
      || pilot -b "$name" new-site "$site" --admin-password "${REPRO_ADMIN_PW:-admin}" \
      || { echo "!! couldn't create $site via pilot" >&2; exit 3; }
  else
    # Resolve the CLASSIC bench CLI. `command -v bench` can point at a shadowing
    # binary (e.g. frappe/pilot's `bench` at ~/pilot/bench, whose `new-site` only
    # takes --admin-password) — so pick the first candidate whose new-site help
    # actually has a db-root-password flag, and remember which flag name it uses.
    BENCHBIN=""; pwflag=""
    for cand in /opt/homebrew/bin/bench /usr/local/bin/bench "$(command -v bench 2>/dev/null)"; do
      [ -n "$cand" ] && [ -x "$cand" ] || continue
      h="$("$cand" new-site --help 2>/dev/null)"
      if printf '%s' "$h" | grep -q -- "--db-root-password"; then BENCHBIN="$cand"; pwflag="--db-root-password"; break
      elif printf '%s' "$h" | grep -q -- "--mariadb-root-password"; then BENCHBIN="$cand"; pwflag="--mariadb-root-password"; break; fi
    done
    if [ -z "$BENCHBIN" ]; then
      echo "!! no classic 'bench' CLI with a db-root-password flag found (is ~/pilot/bench shadowing it on PATH?). Create $site manually." >&2
      exit 3
    fi
    if [ -z "${MYSQL_ROOT_PASSWORD:-}" ]; then
      echo "!! $site missing and MYSQL_ROOT_PASSWORD not set ($BENCHBIN new-site would prompt and hang)." >&2
      echo "   Set MYSQL_ROOT_PASSWORD (Alter → Settings → MariaDB root password) so this can auto-create it." >&2
      exit 3
    fi
    ( cd "$bench" && "$BENCHBIN" new-site "$site" --admin-password "${REPRO_ADMIN_PW:-admin}" "$pwflag" "$MYSQL_ROOT_PASSWORD" ) \
      || { echo "!! new-site $site failed" >&2; exit 3; }
    # clone (get-app) any missing apps at this version, then install them on the site
    for app in $apps_list; do
      if [ ! -d "$bench/apps/$app" ]; then
        echo "   get-app $app@$ver (one-time clone + deps)"
        ( cd "$bench" && "$BENCHBIN" get-app --branch "$ver" "$app" ) || { echo "   (couldn't get $app@$ver — skipping)"; continue; }
      fi
      ( cd "$bench" && "$BENCHBIN" --site "$site" install-app "$app" ) || true
    done
  fi
fi

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
