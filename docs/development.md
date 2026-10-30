# Developing Alter

Read this before changing Alter, whether you are a person or an agent. It covers how the app is built, how a chat turn flows, where state lives, how to run and ship a change, and the rules that keep the app from breaking in ways that were already hit once.

## What Alter is

A macOS desktop chat app built with Tauri 2: a Rust backend (`src-tauri/`) and a React + Tailwind front end (`src/`). It talks to three kinds of model backends, runs agents with tools on this Mac, and ships a browser extension (`extension/`) that talks to the app over a local bridge. It is used daily from `/Applications/Alter.app`, which updates itself from `master` on GitHub.

## Repo map

| Path | What it does |
| --- | --- |
| `src/App.tsx` | The main screen and most front end logic: chat list, the send loop for every backend, the tool loop for API models, permission cards, sidebar wiring. Large on purpose; search it before adding a new file. |
| `src/lib/api.ts` | Calls into Rust: `streamChat` for API models, `claudeCodeChat` for Claude Code, Codex, `testConnection`. |
| `src/lib/store.ts` | Types (`Settings`, `Connection`, `Conversation`), `PROVIDER_PRESETS`, and storage helpers (`storage.loadSettings` and friends). |
| `src/lib/tools.ts` | Tool definitions and execution for API models (`run_command`, `edit_file`, `browser_*`, `use_skill` ...), and the `RISKY` command list that decides what Auto mode still asks about. |
| `src/components/` | Panels: `SettingsPanel`, `Sidebar`, `Markdown` (all message rendering), `ReviewPanel` (PR review runs), `RoutinesPage`, `SkillsPage`, `BrowserPane`, and small shared pieces (`ComposerSelect`, `SettingsRow`, `Switch`). |
| `src-tauri/src/lib.rs` | Tauri commands (everything `invoke(...)` calls), the Claude Code and Codex process handling, chat file storage, tray, global shortcut, `setup` and the exit handler. Every new command must be added to `generate_handler!`. |
| `src-tauri/src/bridge.rs` | The HTTP bridge on `127.0.0.1:8765` used by the extension, agent runs, `self_update`. Routes are listed in [bridge-and-extension.md](bridge-and-extension.md). |
| `src-tauri/src/local_cli.rs` | Finds and signs in the `claude` and `codex` CLIs. |
| `src-tauri/src/agent_browser.rs` | The browser agents drive: Playwright's Chromium on CDP port 9333, its own profile, closed after 5 idle minutes and on quit. |
| `src-tauri/src/browser.rs`, `browser_pane.rs` | Browser tools for API models and the in app Browser pane, both attached to the agent browser. |
| `src-tauri/src/peers.rs` | Registers Alter as a peer of Claude Code sessions so they can message each other. |
| `src-tauri/src/updater.rs` | Auto update of the installed app (see Shipping). |
| `src-tauri/src/children.rs` | Tracks every long lived process Alter starts so they die with it. |
| `src-tauri/src/main.rs` | Entry point. Handles the `--alter-run-disclaimed` relaunch so macOS privacy prompts name the tool that asked, not Alter. |
| `src-tauri/build.rs` | Stamps the git commit into the binary (`ALTER_BUILD_COMMIT`). |
| `extension/` | MV3 extension. `shared.js` holds code shared by `content.js` (GitHub) and `support.js` (Helpdesk); put shared UX there once, never copy it. |
| `skills/` | Skills shipped with the app. `install_bundled_skills` in `lib.rs` copies them into `~/.claude/skills` on start; a new skill file must be added to its list. |
| `docs/` | User and agent docs. Update the page that covers your change in the same commit. |
| `scripts/` | Build cache guard (`trim-build-cache.sh`, runs before `npm run dev`) and the optional background service. |

## How a chat turn flows

Every connection is one of three backends. `isClaudeCodeUrl` and `isCodexUrl` in `store.ts` tell them apart.

1. **API models** (any OpenAI compatible URL: baseten, OpenRouter, Anthropic's endpoint). `App.tsx` runs the agent loop itself: it calls `streamChat`, Rust `stream_chat` streams the HTTP response back over a Tauri channel, tool calls run through `tools.ts`, results go back into the next request. Long runs have no step limit; old tool output is trimmed past 60% of the context, and there are retry, "continue" and no-progress checkpoints.
2. **Claude Code.** Rust starts `claude -p --input-format stream-json --output-format stream-json` per chat and keeps it warm between messages (`ClaudeState` in `lib.rs`). It is restarted only when the model, folder, effort, permission mode, MCP config or API key changes. Two connections can point at it: **Claude Code** (your subscription sign in) and **Claude Code (API)** (has an `apiKey`, passed as `ANTHROPIC_API_KEY`). Background jobs (routines, extension handoffs) must pick the one without a key.
3. **Codex.** Rust runs `codex app-server` and speaks its JSON protocol.

The agent browser is started only when a chat's MCP config includes it (`needs_browser`).

## Where state lives

| What | Where |
| --- | --- |
| Chats | One file per chat in `~/Library/Application Support/com.ejaaz.alter/chats/<id>.json`, plus `_order.json`. Written by `save_conversations` (only the chats that changed). |
| Settings, connections, projects, routines, skills, memories | WebKit local storage, keys starting with `alter.` (`alter.settings`, ...). |
| Bridge token, update log, installed version, tracked processes | `bridge.token`, `update.log`, `installed-commit`, `children.txt` in the same app data folder. |
| Agent browser profile and media | `browser-profile/` and `media/` in the app data folder. |

The app data folder is shared by the dev build and the installed app. **WebKit local storage is not**: the dev build stores it under `~/Library/WebKit/alter`, the installed app under `~/Library/WebKit/com.ejaaz.alter`. Settings changed in one do not show in the other. Never change the bundle identifier `com.ejaaz.alter`; it would orphan every user's data.

## Run it

```sh
npm install
npm run dev
```

- Vite serves the front end with hot reload. A change under `src-tauri/src` rebuilds Rust and **restarts the app, which kills any running chat turn**. Do Rust changes when no long run is going.
- Run only one Alter at a time. Dev and the installed app share port 8765, the peer socket and the data folder. Quit `/Applications/Alter.app` before `npm run dev`.
- Stop dev with Ctrl+C. Alter cleans up its child processes on Ctrl+C, quit, `kill` and hangup, and kills leftovers from a crash on the next start.
- `predev` trims `src-tauri/target` when it passes 15 GB. Debug info is `line-tables-only` to keep it small.

## Check before you commit

```sh
npx tsc --noEmit -p .              # front end types
(cd src-tauri && cargo check)      # Rust
npx vite build                     # when you touched Tailwind classes or imports
```

Then check the change itself in the running app when it is something a user sees or a regression someone reported. Say plainly what you did not check.

### UI harness

To see and click through a UI change without building the app, run the real front end in a browser with the Rust backend replaced by a stand-in (`scripts/ui-harness/mock.js`):

```sh
npm run ui-harness         # example chats and settings from scripts/ui-harness/sample
npm run ui-harness:mine    # your own chats and settings, API keys replaced (exported to scripts/ui-harness/data, git ignored)
```

Open http://localhost:5174. Everything that renders from chats and settings works: the sidebar, messages, code blocks, the composer, Settings and its forms, dialogs and keyboard handling. Sending a message, streaming, and anything else that needs the backend does nothing. When a screen calls a command the stand-in doesn't know, it gets `null`; add an answer to `answers` in `mock.js` if the screen needs one. It runs in Chromium, so check WebKit-only behaviour (text selection painting, for example) in the real app.

Testing the `claude` CLI from a shell inside the Claude desktop app is misleading: that shell carries the desktop app's own auth variables. Use a clean environment, the way Alter launches it:

```sh
env -i HOME=$HOME PATH=$PATH USER=$USER claude -p "say hi" --output-format json
```

## Shipping

Commit to `master` and push right away. That is the release.

- The installed app checks GitHub every 10 minutes. When `master` is ahead of `installed-commit`, it fast forwards this checkout, runs `npm run tauri build -- --bundles app` in the background (log in `update.log`), and installs the new build **only** when you quit Alter or while its window is closed and no chat or extension run is going. It never restarts under an open window. After a background install it comes back hidden in the menu bar.
- A push that only changes files under `skills/` is not rebuilt. The updater pulls it and copies the skills into `~/.claude/skills` from the checkout, with no restart. The app always installs skills from the checkout on disk, falling back to the copy built into it.
- Settings, General, **Update** installs a ready build at once or checks now.
- So every push becomes an update for the user. Group small fixes when you can.
- To install by hand: `npm run tauri build -- --bundles app`, quit Alter, `ditto src-tauri/target/release/bundle/macos/Alter.app /Applications/Alter.app`, write the commit into `installed-commit`, open it.

Commit style: Conventional Commits (`feat:`, `fix:`, `chore:`, `refactor:`), one line, no body, no AI attribution. One fix per commit. Never force push or rewrite history.

## Rules

Each of these comes from a bug that already happened.

**Processes**
- Every long lived process goes through `own_group(...)` and `children::track(pid)`. Without it, quitting Alter leaves it running (a hidden browser kept running for days and blocked a Brave update).
- Anything started on demand must also stop on its own when idle (see `agent_browser::start_reaper`).
- Don't start agents with the user's own browser. The agent browser is Playwright's Chromium.

**Updates and restarts**
- Never restart or relaunch the app while its window is open. Never bring the window to the front unless the user asked.
- Compare versions against `installed-commit` on disk, not only the compile time stamp; a stale stamp once caused a restart every 10 minutes.
- Working from a chat inside Alter: never quit, restart, rebuild into or swap `/Applications/Alter.app`, and never kill Alter processes. Your own turn runs inside that app, so stopping it kills you mid task and the user sees a loop. Commit, push, and tell the user to click Settings, General, Update.
- Update in Settings installs right after the build, waiting only for running chats; the 10 minute check waits for the window to close.

**Chats and storage**
- Never save an empty chat list over real chats (a hot reload once did). Keep the "skip the first empty save" guard and the fallback to the legacy `conversations.json`.
- Write files atomically (write `.tmp`, then rename), as `save_conversations` does.
- Don't put large data in local storage; it caps at about 5 MB.

**Permissions**
- Auto mode acts like Claude Code: commands, edits and writes run without asking, except what the `RISKY` list in `tools.ts` matches. "Always allow" persists in `alter.localAllowed`.
- The extension never holds API keys. It sends a connection id and the bridge looks up the key.

**UI**
- Render every message through `components/Markdown.tsx`. Code blocks have a fixed header with Copy, wrap long lines and collapse past about 20 lines; keep it that way.
- One reply per turn. While running, show a single live status line; no step rows after the turn.
- Use the CSS tokens (`var(--txt)`, `var(--panel)`, `var(--bd)`, ...) and existing components (`ComposerSelect`, `SettingsRow`, `Switch`). No new colors, no inline styles.
- Settings that write as you type save on change. There is no Save button to forget.

**Connections**
- A new provider is an entry in `PROVIDER_PRESETS`. If it is only a different URL for an OpenAI compatible endpoint, don't add a quick add button; list it in `QUICK_ADD_HIDDEN` so **Custom** covers it.
- Code that needs "the" Claude Code connection must prefer the one without an `apiKey` (subscription) and fall back to any.

**Code**
- No explanatory comments. Reuse what exists before writing a new helper; `App.tsx` and `lib.rs` already have most utilities.
- Smallest correct fix. When a fix creates a new problem, revert and rethink instead of stacking fixes.
- Update the matching page in `docs/` in the same commit.

## When something breaks

1. Search [troubleshooting.md](troubleshooting.md) for the exact error text.
2. Update problems: read `update.log` in the app data folder.
3. Processes left behind: `ps -axo pid,ppid,command | grep -E "remote-debugging-port=9333|claude -p|codex app-server"`, and `children.txt`.
4. A chat lost: the files in `chats/`, then the legacy `conversations.json` in the same folder.
5. Settings look reset in the installed app: you are looking at the other WebKit store (see Where state lives).

## Other docs

[setup.md](setup.md), [connections.md](connections.md), [chat.md](chat.md), [bridge-and-extension.md](bridge-and-extension.md), [agents.md](agents.md), [troubleshooting.md](troubleshooting.md).
