#!/bin/bash
# pr-threads.sh <owner/repo> <pr-number>
# Prints every review on the PR, every inline review thread with all replies and
# its resolved / outdated state, and the top-level conversation comments. Read-only.
set -euo pipefail
repo="${1:?owner/repo}"; num="${2:?pr number}"
owner="${repo%%/*}"; name="${repo##*/}"

echo "=== REVIEWS (top-level bodies) ==="
gh api "repos/$repo/pulls/$num/reviews" --paginate --jq '.[] | select(.body != "") | "--- \(.user.login) \(.state) \(.submitted_at) \(.html_url)\n\(.body)\n"'

echo
echo "=== INLINE THREADS ==="
cursor=""
while :; do
  page=$(gh api graphql -F o="$owner" -F r="$name" -F n="$num" -F c="$cursor" -f query='
    query($o:String!,$r:String!,$n:Int!,$c:String){ repository(owner:$o,name:$r){ pullRequest(number:$n){
      reviewThreads(first:100, after:$c){ pageInfo{hasNextPage endCursor}
        nodes{ isResolved isOutdated path line originalLine
          comments(first:100){ nodes{ author{login} createdAt url body } } } } } } }')
  echo "$page" | jq -r '.data.repository.pullRequest.reviewThreads.nodes[] |
    "--- \(.path):\(.line // .originalLine) resolved=\(.isResolved) outdated=\(.isOutdated)",
    (.comments.nodes[] | "  [\(.author.login) \(.createdAt)] \(.url)\n\(.body | split("\n") | map("    " + .) | join("\n"))"),
    ""'
  next=$(echo "$page" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo | if .hasNextPage then .endCursor else "" end')
  [ -z "$next" ] && break
  cursor="$next"
done

echo "=== CONVERSATION COMMENTS ==="
gh api "repos/$repo/issues/$num/comments" --paginate --jq '.[] | "--- \(.user.login) \(.created_at) \(.html_url)\n\(.body)\n"'
