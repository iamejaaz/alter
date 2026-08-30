#!/bin/sh
# One-time: scaffold per-version benches for the repro flow. Creates
# <root>/bench-<version> for develop, version-16, version-15 — each with frappe
# (+ hrms, erpnext) and ONE reusable repro site.
#
# ALTERNATIVE: frappe/pilot manages benches/sites too. If you use it, create
# benches named by version (e.g. `pilot new develop`, `pilot new version-15`)
# under its benches dir and point Settings → Repro benches there. repro.sh works
# with pilot benches — it runs the console via env/bin/python (pilot doesn't
# install the `bench` CLI). This is the slow part (bench
# init downloads + builds per version); it's paid ONCE. After this, each repro
# reuses the site and rolls back (frappe.db.rollback), so runs are seconds — no
# per-run new-site/drop-site.
#
# Usage:
#   ALTER_REPRO_ROOT=~/repro sh repro-setup.sh
#   sh repro-setup.sh ~/repro
# Env: REPRO_VERSIONS (default "develop version-16 version-15"),
#      REPRO_APPS (default "hrms erpnext"), REPRO_ADMIN_PW (default admin),
#      MYSQL_ROOT_PASSWORD (your MariaDB root pw), ALTER_REPRO_SITE (repro.localhost).
set -u
root="${1:-${ALTER_REPRO_ROOT:-}}"
[ -n "$root" ] || { echo "pass the folder or set ALTER_REPRO_ROOT" >&2; exit 2; }
site="${ALTER_REPRO_SITE:-repro.localhost}"
versions="${REPRO_VERSIONS:-develop version-16 version-15}"
apps="${REPRO_APPS:-hrms erpnext}"
command -v bench >/dev/null 2>&1 || { echo "'bench' CLI not on PATH — install frappe-bench first." >&2; exit 1; }
mkdir -p "$root"

for ver in $versions; do
  echo
  echo "############ $ver ############"
  bench_dir="$root/bench-$ver"

  if [ -d "$bench_dir/apps/frappe" ]; then
    echo "bench exists — skipping init ($bench_dir)"
  else
    echo ">> bench init --frappe-branch $ver  (downloads + builds; slow, one-time)"
    if ! bench init --frappe-branch "$ver" "$bench_dir"; then
      echo "!! bench init failed for $ver (branch may not exist) — skipping this version"
      continue
    fi
    for app in $apps; do
      echo ">> get-app $app@$ver"
      (cd "$bench_dir" && bench get-app --branch "$ver" "$app") || echo "   (skip $app@$ver)"
    done
  fi

  if [ -d "$bench_dir/sites/$site" ]; then
    echo "site $site already exists"
  else
    echo ">> new-site $site (one-time)"
    if [ -n "${MYSQL_ROOT_PASSWORD:-}" ]; then
      (cd "$bench_dir" && bench new-site "$site" --admin-password "${REPRO_ADMIN_PW:-admin}" --mariadb-root-password "$MYSQL_ROOT_PASSWORD")
    else
      (cd "$bench_dir" && bench new-site "$site" --admin-password "${REPRO_ADMIN_PW:-admin}")
    fi
    for app in $apps; do
      (cd "$bench_dir" && bench --site "$site" install-app "$app") || echo "   (skip install $app)"
    done
  fi
done

echo
echo "Done. In Alter → Settings → Repro benches, choose: $root"
echo "Each repro then reuses $site and rolls back — no per-run site create/delete."
