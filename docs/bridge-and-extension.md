# Bridge and extension

## The bridge

The desktop app runs a small HTTP server on `127.0.0.1:8765` (`src-tauri/src/bridge.rs`). The browser extension, and only it, talks to it. Every request carries a bearer token.

- **Token:** minted on first start and stored in `bridge.token` in the app data folder (`~/Library/Application Support/com.ejaaz.alter/`). Settings, Browser extension shows it with a Copy button.
- **Port:** fixed at 8765. If another process holds it the bridge does not start and the app log shows `bridge: failed to bind 127.0.0.1:8765`.
- **No keys leave the app.** The extension sends a connection id, the bridge looks up the key or runs the CLI.
- The run list the bridge keeps is in memory. Restarting the app empties it, which is why a panel can say `Alter restarted and lost this run`.

### Routes

| Route | Purpose |
| --- | --- |
| `GET /connections` | The connections the extension may pick, with an `isClaudeCode` flag |
| `GET /runs`, `POST /dismiss`, `POST /cancel` | The run list shown in the popup and the app sidebar, remove one or all, stop one |
| `POST /support` | Start a ticket run: `{ticket, verb, connectionId, ...}`. The bridge renders the skill's prompts and attaches the ticket context |
| `POST /ticket-context` | The gathered ticket bundle |
| `POST /agent-start`, `POST /agent-poll` | Start a PR review or other agent run and poll its steps and text |
| `POST /pr-reviewed` | Whether a PR already has an Alter review, and which bot account posts |
| `POST /gh`, `POST /gh-bot`, `POST /gh-checks` | Post a review as you, dispatch the bot workflow, read CI checks |
| `GET /review-requests`, `GET /bot-replies` | PRs waiting for your review, threads the bot still owes a reply |
| `POST /fr-write` | A site write the agent proposed, run only after you approve it in the panel |
| `POST /open-chat`, `POST /assistant` | Hand off into an Alter chat or into `fr assistant` in Terminal |
| `POST /update` | `git pull --ff-only` in Alter's repo, returns the new commits and which parts changed |
| `GET /repro-info` | Which repro benches are configured |

## Install the extension

1. Alter must be running.
2. `chrome://extensions` or `brave://extensions`, Developer mode on, **Load unpacked**, pick the `extension/` folder.
3. Click the Alter toolbar icon, open Settings, paste the pairing token, Save. The popup then shows `Connected · N models`.
4. Pick a connection per action, and a Claude Code model for the ones that use Claude Code.

After pulling new extension code: reload it on the extensions page, then refresh any GitHub or helpdesk tab. A tab opened before the reload shows `The Alter extension was updated. Refresh this page to keep using it.`

## Extension settings page

| Field | Stored as | What it does |
| --- | --- | --- |
| Pairing token | `token` | Sent as bearer on every bridge call |
| Model per action (PR review, grammar, support, page summary) | `models` | Connection id per action. Stale ids are repaired to the Claude Code connection on load |
| Claude Code model | `claudeModel` | Opus, Sonnet or Haiku for the Claude Code actions |
| Helpdesk site | `helpdeskSite` | Your own helpdesk origin. `support.frappe.io` is built in. A custom origin registers the support panel on it after you grant the site permission |
| Grammar everywhere | `grammarEverywhere` | Show the grammar pill on every editable field, not only GitHub and helpdesk |
| Auto review | `autoReview`, `autoReviewPost` | Every minute, review PRs where you were requested as reviewer. With post on, the result is posted as the bot. A reply watcher runs every 5 minutes |

## Panels

GitHub pull requests get **Review with Alter**. Helpdesk tickets get **Summarize** and **Diagnose**. Both open a panel that:

- streams the agent's steps, folded away once the run finishes, with a toggle to open them
- can be dragged by its header and resized from any edge or corner, the size and position are remembered per site, double click the header to reset
- takes follow up questions while a run is going: the message queues, **Send now** interrupts the run and continues it after answering
- shows **Copy**, minimise and close in the header

PR panel extras: **Copy**, **Preview comments** and **Post review** (the preview is the confirmation: one click on Comment, Request changes or Post as the bot posts what the cards show, and the note under the buttons names the PR), **Fix this PR** (hidden when the verdict is READY) and **Push to PR**, **Verify on bench** (always shown; with no repro bench set it says where to set one), **Continue in Alter** (opens an Alter chat carrying the review and the follow-ups). A follow-up that asks to verify, reproduce, or run something on the bench or console runs on the repro bench with the Verify on bench permissions. The badge on the button says `reviewed, not posted` when a review exists.

Ticket panel extras: **Continue in** Alter chat, fr assistant, or Prepare fix. **Approve & run** cards for any site write the agent proposes.

What the agents behind these panels are allowed to do is in [agents.md](agents.md).

## Runs in the app sidebar

Runs started from the extension also show at the top of Alter's sidebar. Clicking one opens a panel beside the chat, not the browser:

- **Status:** running with its time, finished with how long it took, or stopped with the reason. **Stop** ends a running one.
- **Result:** the review or the diagnosis as written, refreshed every 2 seconds while it runs. The JSON block of review comments is hidden; post those from the PR panel.
- **What it did:** the steps, folded.
- **Open PR on GitHub**, **Open ticket** or **Open page** opens the link only when you click it. **Copy** copies the result.

The panel reads `bridge_run` from the bridge's in memory list, so a run is gone after Alter restarts or 12 hours after it ends.

## Popup

**Update** runs `git pull --ff-only` in Alter's own repo through the bridge (`POST /update`), lists the new commits, and reloads the extension when files under `extension/` changed. Refresh open GitHub and helpdesk tabs after that. The same button is in the app, Settings, General, Update Alter.

Shows connection status, runs in progress with Stop, and runs finished in the last 12 hours with × and Clear. **Describe this page** summarises the active tab.

## Related

- [troubleshooting.md](troubleshooting.md#extension-and-bridge) for pairing and panel errors

## Staying current

The extension asks the bridge for the last commit that touched `extension/` (`GET /ext-version`) when you start something, at most every 15 seconds. When that differs from the version it loaded with, it reloads itself and asks you to refresh the page. A run that is already polling is never interrupted. You only reload it by hand once, to get this check.
