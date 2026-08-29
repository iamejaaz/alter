# Changelog — Alter browser extension

## 0.1.0

- **PR review (GitHub)** — maintainer-lens review with a live tool feed; Draft comment; editable post preview before *Post as comment* / *Request changes*; follow-ups; reconnect after a page reload.
- **Frappe Helpdesk agent** — Summarize / Diagnose / Draft on `support.frappe.io` tickets. Read-only (site writes blocked), uses the `frappe-support-diagnosis` skill; proposed writes appear as Approve & run cards. **Continue in… →** Alter chat / fr assistant / Create PR. Reconnect after reload.
- **Grammar fix** (right-click) and **Describe this page** (popup).
- **Models & bridge** — per-action model + Claude sub-model (Opus/Sonnet/Haiku); no keys in the browser (token-gated localhost bridge); live feed via polling (no timeout); Stop kills the run; session-limit banner.
