# Changelog — Alter browser extension

## Unreleased

- **Softer bot reviews** — the review skill opens a discussion instead of issuing instructions, varies its opener, and always posts as a comment rather than requesting changes.
- **Pushback gets investigated** — when the author says a finding is wrong, the review re-checks their claim against the code and retracts when it cannot name a fact their reply misses.
- **Threads close themselves** — a re-review resolves its own threads once the ask is addressed and never restates an ask that is already open.
- Alter now installs the `frappe-pr-review` skill into `~/.claude/skills` on first run, alongside the support skill.
- **Auto-review** (Settings toggle) — a review request or PR assignment in your GitHub notifications starts the review within a minute, notifies you when the draft is ready, and opening the PR shows it. Drafts only, never posts.
- **Inline asks** — the post preview parses `📍 path:line` blocks into inline review comments; unanchored text becomes the review body.
- **PR review** runs the `frappe-pr-review` skill instead of its own prompt, so the extension and the daily digest review the same way; the draft is read from the skill's JSON.
- **Post as frappe-pr-bot** — dispatches the repo's `post-review.yml` workflow so the review lands under the bot, not your account.

## 0.1.0

- **PR review (GitHub)** — maintainer-lens review with a live tool feed; Draft comment; editable post preview before *Post as comment* / *Request changes*; follow-ups; reconnect after a page reload.
- **Frappe Helpdesk agent** — Summarize / Diagnose / Draft on `support.frappe.io` tickets. Read-only (site writes blocked), uses the `frappe-support-diagnosis` skill; proposed writes appear as Approve & run cards. **Continue in… →** Alter chat / fr assistant / Create PR. Reconnect after reload.
- **Grammar fix** (right-click) and **Describe this page** (popup).
- **Models & bridge** — per-action model + Claude sub-model (Opus/Sonnet/Haiku); no keys in the browser (token-gated localhost bridge); live feed via polling (no timeout); Stop kills the run; session-limit banner.
