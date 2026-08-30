#!/bin/sh
# One-time: scaffold per-version benches for the repro flow — classic (bench) or
# pilot (frappe/pilot). Each bench gets frappe (+ hrms, erpnext) and ONE reusable
# repro site. This is the slow part, paid ONCE; repros then reuse the site and
# roll back, so runs are seconds (no per-run new-site/drop-site).
#
# Classic:  ALTER_REPRO_ROOT=~/repro sh repro-setup.sh
#           sh repro-setup.sh ~/repro
# Pilot:    sh repro-setup.sh --pilot          (pilot chooses the benches dir)
#
# Env: REPRO_VERSIONS (default "develop version-16 version-15"),
#      REPRO_APPS (default "hrms erpnext"), REPRO_ADMIN_PW (default admin),
#      MYSQL_ROOT_PASSWORD (MariaDB root pw, classic), ALTER_REPRO_SITE (repro.localhost).
set -u

mode="classic"
root=""
for a in "$@"; do
  case "$a" in
    --pilot) mode="pilot" ;;
    -*) echo "unknown option: $a" >&2; exit 2 ;;
    *) root="$a" ;;
  esac
done

site="${ALTER_REPRO_SITE:-repro.localhost}"
versions="${REPRO_VERSIONS:-develop version-16 version-15}"
apps="${REPRO_APPS:-hrms erpnext}"

# ---- pilot mode -------------------------------------------------------------
if [ "$mode" = "pilot" ]; then
  command -v pilot >/dev/null 2>&1 || { echo "'pilot' not on PATH — install from github.com/frappe/pilot" >&2; exit 1; }

  # Best-effort locate of a bench's bench.toml (pilot puts benches at
  # <pilot pkg>/../benches/<name>). Works if pilot is importable as python3.
  toml_for() {
    python3 - "$1" 2>/dev/null <<'PY' || true
import sys
try:
    import pilot.utils as u
    p = u.benches_dir() / sys.argv[1] / "bench.toml"
    print(str(p) if p.exists() else "")
except Exception:
    print("")
PY
  }

  for ver in $versions; do
    echo
    echo "############ $ver (pilot) ############"
    pilot new "$ver" || { echo "!! pilot new $ver failed — skipping"; continue; }

    toml="$(toml_for "$ver")"
    if [ -n "$toml" ] && [ -f "$toml" ]; then
      python3 - "$toml" "$ver" <<'PY' && echo ">> set frappe branch = $ver in bench.toml"
import sys, re
p, ver = sys.argv[1], sys.argv[2]
s = open(p).read()
# first standalone `branch = "..."` is the framework (frappe) app at this point.
open(p, "w").write(re.sub(r'(\bbranch\s*=\s*)"[^"]*"', r'\1"%s"' % ver, s, count=1))
PY
    else
      echo "!! couldn't locate bench.toml for $ver — set the frappe branch to '$ver' in it (or via 'pilot start' wizard) BEFORE it initializes."
    fi

    pilot -b "$ver" init || echo "   (init reported an issue for $ver)"
    for app in $apps; do
      pilot -b "$ver" get-app "https://github.com/frappe/$app" --branch "$ver" || echo "   (skip $app@$ver)"
    done
    # install framework + extra apps on the repro site
    pilot -b "$ver" new-site "$site" --admin-password "${REPRO_ADMIN_PW:-admin}" --apps frappe $apps \
      || pilot -b "$ver" new-site "$site" --admin-password "${REPRO_ADMIN_PW:-admin}" \
      || echo "   (new-site $site reported an issue)"
  done
  echo
  echo "Done (pilot). Run 'pilot ls' to see the benches directory, then set"
  echo "Alter → Settings → Repro benches to it. Verify each bench's frappe branch."
  exit 0
fi

# ---- classic mode -----------------------------------------------------------
root="${root:-${ALTER_REPRO_ROOT:-}}"
[ -n "$root" ] || { echo "pass the folder or set ALTER_REPRO_ROOT (or use --pilot)" >&2; exit 2; }
command -v bench >/dev/null 2>&1 || { echo "'bench' CLI not on PATH — install frappe-bench, or use --pilot." >&2; exit 1; }
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
