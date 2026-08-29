#!/bin/sh
# Find where a DocType / symbol / string lives across EVERY installed app.
# Run from the bench root (the dir containing apps/). Usage: find-code.sh "Job Applicant"
set -eu
term="${1:?usage: find-code.sh <search term>}"
root="${BENCH:-$PWD}"
[ -d "$root/apps" ] || { echo "no apps/ under $root — run from the bench root or set BENCH=" >&2; exit 1; }

echo "installed apps:"; ls "$root/apps"
echo
# DocType folders are snake_case of the name; also grep the raw term for code refs.
slug=$(printf '%s' "$term" | tr '[:upper:] ' '[:lower:]_')
for app in "$root"/apps/*/; do
  name=$(basename "$app")
  # doctype definition dirs
  find "$app" -type d -name "$slug" 2>/dev/null | sed "s|^|[$name] doctype dir: |"
  # code/string references (skip node_modules, .git, dist)
  grep -rIl --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
    -e "$term" "$app" 2>/dev/null | head -15 | sed "s|^|[$name] ref: |"
done
