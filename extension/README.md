# Alter browser extension

Reuse your Alter desktop app's models on any page. Talks to Alter's local bridge
(`127.0.0.1:8765`) — **no API keys live in the browser**, and Claude Code works
because Alter drives it. Each action remembers its own model, with a separate
Opus / Sonnet / Haiku picker for the Claude Code ones.

## Install (Brave / Chrome, unpacked)

1. Make sure the Alter desktop app is running.
2. Open `brave://extensions` (or `chrome://extensions`), enable **Developer mode**.
3. **Load unpacked** → select this `extension/` folder.
4. Click the Alter toolbar icon → paste the **pairing token** from
   Alter → Settings → *Browser bridge* → **Save**.
5. Pick a model per action (PR review, grammar, support, page summary) and, for
   Claude Code, a sub-model. Done.

## PR review (GitHub)

Open any pull request → **Review with Alter** (bottom-right). It fetches the diff
and CI status and reviews it with a maintainer's lens — verdict, mechanism,
assessment, and a draft comment — streaming each step live as it reads code and
checks `gh`. Then:

- **Draft comment** — a terse, ready-to-paste review comment.
- **Post** — *Post as comment* / *Request changes* open an editable preview of the
  exact text; nothing posts until you confirm. Posting uses your own `gh` auth.
- Ask follow-ups; reload the tab and it re-attaches to a review still running.

## Frappe Helpdesk support agent

On a `support.frappe.io` ticket → **Summarize / Diagnose / Draft reply**. A
Claude Code agent reads the ticket via `frappectl`, traces the issue in the frappe
code at the customer's version, and checks `gh` — steps stream live. It reads
freely but can't mutate the site; any data change it proposes appears as an
**Approve & run** card. **Continue in… ▾** hands the ticket off to:

- **Alter chat** — a full agentic Alter session (seeded, you hit Enter to run).
- **fr assistant** — a supervised `fr assistant` in a Terminal.
- **Create PR** — a scoped agent that branches, applies the fix, pushes to your
  fork, and opens a PR (it stops at the link; it never merges).

Reload the tab mid-run and the panel re-attaches to the job.

## Elsewhere

- **Fix grammar** — right-click any editable text → *Fix grammar with Alter*.
- **Describe this page** — from the popup, summarize the active tab.

## Notes

- The bridge is token-gated and localhost-only; the extension holds no keys.
- Private repos work — the diff is fetched with your GitHub session.
- Large diffs are truncated to 60k chars (noted in the prompt).
- Data an agent reads is sent to your model provider (e.g. Anthropic), same as
  any chat. The support agent is network-gated (can't write the site); the
  handoffs are more powerful — Alter chat is autonomous, fr assistant prompts.
