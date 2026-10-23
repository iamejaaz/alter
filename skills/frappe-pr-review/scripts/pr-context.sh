#!/bin/bash
# pr-context.sh <owner/repo> <pr-number> [app-path]
# Everything a review needs before reading code, in one call: the PR's details and
# CI state, the PR head fetched into the local checkout, the merge base, the review
# threads and the diff. Read-only for the working tree.
set -uo pipefail
repo="${1:?owner/repo}"; num="${2:?pr number}"; app="${3:-}"
here="$(cd "$(dirname "$0")" && pwd)"

echo "=== PR ==="
gh pr view "$num" -R "$repo" --json number,title,author,state,isDraft,isCrossRepository,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,labels,body \
  --jq '"#\(.number) \(.title)\nauthor: \(.author.login)  state: \(.state)\(if .isDraft then " (draft)" else "" end)  fork: \(.isCrossRepository)\nbase: \(.baseRefName)  head: \(.headRefName) \(.headRefOid)\nsize: +\(.additions) -\(.deletions) in \(.changedFiles) files  labels: \([.labels[].name] | join(", "))\n\n--- body ---\n\(.body)"'
base=$(gh pr view "$num" -R "$repo" --json baseRefName --jq .baseRefName)

echo
echo "=== CI ==="
gh pr view "$num" -R "$repo" --json statusCheckRollup \
  --jq '[.statusCheckRollup[] | "\(.conclusion // .state // .status) \(.name // .context)"] | group_by(split(" ")[0]) | map("\(.[0] | split(" ")[0]): \(length)" + (if (.[0] | test("^(FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED)")) then "\n  " + (map(sub("^[^ ]+ "; "")) | join("\n  ")) else "" end)) | .[]'

if [ -n "$app" ] && [ -d "$app/.git" ]; then
  remote=upstream
  git -C "$app" remote get-url upstream >/dev/null 2>&1 || remote=origin
  echo
  echo "=== CHECKOUT ==="
  echo "app: $app  HEAD: $(git -C "$app" rev-parse --short HEAD)  $(git -C "$app" status --short | head -3 | wc -l | tr -d ' ') changed files in the tree"
  if git -C "$app" fetch --quiet --no-tags "$remote" "+pull/$num/head:refs/remotes/$remote/pr-$num" "+refs/heads/$base:refs/remotes/$remote/$base" 2>/dev/null; then
    mb=$(git -C "$app" merge-base "$remote/pr-$num" "$remote/$base" 2>/dev/null)
    echo "PR_REF=$remote/pr-$num ($(git -C "$app" rev-parse --short "$remote/pr-$num"))"
    echo "BASE_REF=$remote/$base ($(git -C "$app" rev-parse --short "$remote/$base"))"
    [ -n "$mb" ] && echo "MERGE_BASE=$(git -C "$app" rev-parse --short "$mb"), $(git -C "$app" rev-list --count "$mb..$remote/$base") base commits since"
    echo "PR commits:"
    git -C "$app" log --format='  %h %s' "$mb..$remote/pr-$num" 2>/dev/null | head -20
  else
    echo "could not fetch the PR head into $app"
  fi
fi

echo
"$here/pr-threads.sh" "$repo" "$num"

echo
echo "=== DIFF ==="
gh pr diff "$num" -R "$repo" | head -2500
lines=$(gh pr diff "$num" -R "$repo" | wc -l | tr -d ' ')
[ "$lines" -gt 2500 ] && echo "... diff cut at 2500 of $lines lines; read the rest by file with git diff MERGE_BASE PR_REF -- <path>"
exit 0
