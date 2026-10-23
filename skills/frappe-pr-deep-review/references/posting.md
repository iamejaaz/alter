# Posting a review with a screenshot

In server mode, skip this section. Write frappe-pr-review's section 7 JSON, unchanged, to `${REVIEW_DRAFTS:-~/.claude/frappe-reviewer/drafts}/<PR>.json` and stop. Screenshots stay local files named in the result; the JSON never links them.

Default is report-only: hand back the frappe-pr-review result block plus the reproduction and the screenshot, and stop.

When the user says to post a Request-changes review **with the screenshot**: GitHub has no public API to upload an image to its CDN, so the only way to embed one is through a logged-in browser. Post as the maintainer, from their own GitHub account in their browser, never as the bot: the bot cannot attach an image.

1. The maintainer's logged-in browser (Claude in Chrome on the Mac): open `https://github.com/frappe/<repo>/pull/<PR>/files`, confirm logged in as the maintainer.
2. `Submit review` → type the body (frappe-pr-review's voice: user story first, one anchor, a question not an order; put the one-line fix in a ```js block citing file:line when the inline diff is collapsed and a line-anchored suggestion would be fragile).
3. Attach the screenshot by clipboard, the way a human does: `osascript -e 'set the clipboard to (read (POSIX file "<path>") as JPEG picture)'`, focus the comment box, `cmd+Down`, `cmd+v`. GitHub uploads it and inserts the `user-attachments` URL. The hidden file input is not in the a11y tree, so `file_upload` cannot target it; the paste is the reliable path.
4. Select **Request changes**, Submit.
5. Verify it landed: `gh api repos/frappe/<repo>/pulls/<PR>/reviews` — latest review by the maintainer is `CHANGES_REQUESTED` and its body contains the `user-attachments/assets/...` URL.

The bot script (`frappe-reviewer/bin/post`) posts text-only reviews for the digest and the server runner; it is never how a screenshot-backed review gets posted.

