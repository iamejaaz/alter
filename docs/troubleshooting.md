# Troubleshooting

Find the exact message, read the cause, apply the fix. Messages are grouped by where they appear.

## Start and build

| Message | Cause | Fix |
| --- | --- | --- |
| `bridge: failed to bind 127.0.0.1:8765` in the app log | Another process, usually a second Alter, holds the port | Quit the other Alter (menu bar icon, Quit). `lsof -iTCP:8765` shows the holder |
| App opens on Settings every start | Older builds required an API key to show the chat. Fixed, Claude Code and Codex have no key | Update the app |
| Rust build fails after pulling | Toolchain or crate changes | `rustup update`, then `cargo check` in `src-tauri` |
| `Could not find the Alter binary at` from `install-service.sh` | The app is not in `/Applications` | Build it, copy `Alter.app` there, or pass the path as the first argument |
| Chat area blank after a code change in dev | The window was hidden while React remounted and the fade in animation did not run | Bring the window to front. It repaints |

## Connections and sign in

| Message | Cause | Fix |
| --- | --- | --- |
| `Add a connection in Settings to start chatting.` | No usable connection | Settings, Connections, add one. Claude Code needs no key |
| `Pick a model for this connection in Settings.` | An HTTP connection with an empty model | Fill the Model field |
| `Claude Code isn't installed. Install it from claude.com/code` | `claude` is not in PATH or the known folders (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.claude/local`, `~/.npm-global/bin`, `~/.bun/bin`, `~/.volta/bin`) | Install it, or symlink it into one of those folders. Alter does not read your shell profile |
| `Not signed in` under Claude Code on this Mac | `claude auth status` reports logged out | Click Sign in, finish in the browser. If the browser did not open use the link under the button, or Sign in from Terminal instead |
| `Claude Code isn't signed in, or its login expired. Sign in to continue.` in a chat | The CLI refused with an auth error | The Sign in button appears next to the error. Same flow |
| `Couldn't start Claude Code — is the claude CLI installed and on your PATH?` | The binary was found but did not start | Run `claude --version` in Terminal. Reinstall if it fails |
| `Claude Code process closed — try again.` | The CLI exited mid turn | Send the message again. The chat resumes its session |
| `Sign in timed out after 5 minutes. Try again.` | The browser flow was not completed | Click Sign in again and finish in the browser |
| `Codex isn't installed.` | Neither `codex` in PATH nor `/Applications/Codex.app` | Install the Codex app or `codex` CLI |
| `Login expired` under Codex | `codex login status` says logged in, but a real request failed | Click Sign in again |
| `This ChatGPT account can't use Codex.` | Free ChatGPT plan | Codex needs Plus, Pro, Team or Enterprise, or sign in with another account |
| `Codex didn't start within a minute.` or `Codex closed unexpectedly.` | The app server did not come up | Run `codex --version` in Terminal. Reinstall if it fails |
| `Connected. (No model list returned.)` after Test | The endpoint answered but has no models route | Nothing to fix. Type the model name yourself |
| Test fails with 401 or 403 | Wrong key, or the key has no access to the model | Check the key on the provider's site |
| Test fails with a connection error | Wrong Base URL, or the host blocks the request | The URL must end at the API root, for example `https://api.deepseek.com`. Alter adds `/chat/completions` |
| `<name> was unavailable — switched to <other>` | The active connection failed before any text streamed and Alter fell back to another saved connection | Fix the first connection, or leave it. The chat stays on the fallback |
| `⏳ Claude session limit reached` | Your Claude plan's session, usage or weekly cap | Wait for the reset in the message, or use an HTTP connection meanwhile. All Claude models share the cap |

## Chat

| Message | Cause | Fix |
| --- | --- | --- |
| `Couldn't save your chats — local storage is full.` | Web storage quota | Delete old chats. Images already live on disk and do not count |
| `Voice dictation isn't supported in this app's webview yet.` | WebKit has no speech API here | Use the Mac's own dictation shortcut in the text box |
| `Folder picker is only available in the desktop app` | You are on the Vite dev page in a browser | Use the Tauri window |
| `The app was quit while you were working. Please continue from where you left off.` appears in a chat | Alter quit or restarted while that chat was running, so it resumes the turn once on the next start. The dead turn's empty reply is removed first, so only one resume shows | Nothing to do. In development every Rust change restarts the app, so avoid long jobs while editing `src-tauri` |
| A permission or question card appeared and I cannot type | The turn is waiting for the card | Answer, Skip or Deny. Esc interrupts the turn |
| Message says `Sending at the next step` and nothing happens | The running turn has not reached a step boundary | Press Esc to interrupt it now, or × on the bubble to drop the message |
| Scheduled message did not send | Alter was closed at that time, or the chat's connection failed | It sends when Alter next opens. Check the chat for an error under it |
| Routine never runs | Alter was not open at the time. Missed daily or weekly runs do not catch up | Keep Alter open or install the background service. Use Run now to test the prompt |
| Routine chat shows `(routine error running claude: …)` | The routine's connection is Claude Code and the CLI failed | See the sign in rows above |
| `/skill` command was sent as plain text | The name did not match a saved skill or a Claude Code skill | Check Settings, Skills, and `~/.claude/skills` |
| Memory I added is not in `~/.claude/CLAUDE.md` | Only facts extracted from chats are appended there. Added and imported ones stay in Alter | Add the line to CLAUDE.md yourself if Claude Code needs it |

## Media in replies

| Message | Cause | Fix |
| --- | --- | --- |
| A reply names an image but nothing shows | The path does not exist, has a space, or the reply gave a bare file name | Ask the model for the full path. Relative paths only work when the chat has a folder |
| Image box shows broken | The CSP or asset protocol settings in `src-tauri/tauri.conf.json` were changed | Keep `assetProtocol.enable` true and `img-src`/`media-src` allowing `asset:` and `http://asset.localhost` |

## Agent browser

| Message | Cause | Fix |
| --- | --- | --- |
| `No Chromium based browser found` | No Brave, Chrome, Edge, Chromium, Vivaldi, Opera or Arc in Applications | Install one. Safari and Firefox cannot be driven |
| `The agent browser started but did not open its control port 9333` | Another program holds port 9333, or the browser refused the flag | `lsof -iTCP:9333` to find the holder. Quit it and try Open browser again |
| `Node is not installed, so the browser connector can't start` | No `npx` in PATH, Homebrew, or `~/.nvm` | Install Node 18 or newer |
| Tool result `connect ECONNREFUSED 127.0.0.1:9333` | The agent browser was closed after the chat started | Send the message again, or press Open browser in Settings first |
| The agent says it cannot use the browser | The chat's Claude Code process started before the setting was turned on | Send the message again. A changed connector list restarts the process |
| Browser pane says `Could not attach to the agent browser's tab.` | The browser was just started or closed its last tab | Wait a second, it retries every refresh. If it stays, press Window and open a tab |
| Browser pane picture is frozen | The pane only refreshes while the Alter window is visible, or the tab is hung | Bring Alter forward. Reload from the pane |
| Typing in the pane does nothing | The picture is not focused | Click the page in the pane first. A thin frame shows when it has focus |
| A site keeps asking to sign in | The agent window has its own profile, separate from your normal browser | Open browser, sign in there once |

## Connectors

| Message | Cause | Fix |
| --- | --- | --- |
| `That name is already used.` | Two connectors would get the same key, or the name is `browser` | Pick another name |
| Add connector stays disabled | Name empty, or no command, or the URL is still `https://` | Fill them in |
| The model says it has no such tool | The connector failed to start. Claude Code drops a server that does not answer | Run the command and arguments in Terminal. Check the environment lines. For `npx` or `uvx` make sure the program is installed |
| A connector works in Claude Code chats but not in API chats | Connectors are only passed to Claude Code and Codex | Use a Claude Code or Codex connection for that chat |

## Extension and bridge

| Message | Cause | Fix |
| --- | --- | --- |
| `Not paired — open Settings to add your token.` | No token saved in the extension | Alter, Settings, Browser extension, Copy. Paste in the extension settings, Save |
| `Wrong or missing token — set it in the Alter extension settings.` | 401 from the bridge. The token in the extension does not match `bridge.token` | Copy the token again. The token changes if the app data folder was reset |
| `Couldn't open Alter — is the app running?` or `Bridge error 0` | Nothing listening on 8765 | Start Alter. If it is running, check the port, see Start and build |
| `Lost contact with Alter. Check the app is running, then run this again.` | The bridge stopped answering mid run, usually because the app restarted | Start the run again |
| `Alter restarted and lost this run — run it again.` | The run list is in memory and the app restarted | Run it again |
| `The Alter extension was updated. Refresh this page to keep using it.` | The extension was reloaded under an open tab | Refresh the tab |
| `unknown_connection` | The connection id the extension saved no longer exists in Alter | The extension repairs stale ids to the Claude Code connection on load. Reopen the extension settings and pick again |
| `No response — check the Alter app is running.` | Empty answer from the bridge | Start Alter, run again |
| Popup says `Connected · 0 models` | Paired, but Alter has no connections | Add one in Alter |
| No Review with Alter button on a PR | The page is not `github.com/<owner>/<repo>/pull/<n>`, or the extension is not loaded | Reload the extension, refresh the page |
| No Summarize and Diagnose buttons on a ticket | The site is not `support.frappe.io` and no helpdesk site is set, or the URL is not `/helpdesk/tickets/<id>` | Set the helpdesk site in the extension settings and grant the site permission |
| Panel cannot be moved or resized | Extension older than the grab zone fix | Reload the extension, refresh the page. Drag by the header, resize at any edge or corner, double click the header to reset |
| `Bot` posting option missing | No bot account in Alter settings, or the repo has no `post-review.yml` workflow | Set Review bot in Alter, Settings, Browser extension, and add the workflow to the repo |

## Browser agents

| Message | Cause | Fix |
| --- | --- | --- |
| `can't run fr: …` | `fr` (frappectl) is not installed or not in PATH for the app | Install frappectl. Alter looks in PATH and the usual bin folders |
| `can't run gh: …` | `gh` missing or not signed in | `gh auth login` |
| `fr` prompts for a keychain password during a run, or the run hangs | Frappe credentials are empty, so `fr` uses the keychain | Settings, Support agent, Frappe credentials. Import from fr or fill them in |
| `Profile '<name>' not found in frappectl config.` or `Couldn't parse frappectl config` | Import from fr could not read `~/.frappectl` | Run `fr` once by hand to create the profile, then import again |
| `context script not installed` | `~/.claude/skills/frappe-support-diagnosis/scripts/context.py` is missing | Restart Alter. It reinstalls the bundled skills |
| `Unknown JSON field` from `gh pr view` in a review step | Your `gh` is older than a field the skill asked for | Fixed in the bundled skill. Update the app, or `brew upgrade gh` |
| `no bench for '<version>'` from `repro.sh` | That repro bench is not configured | Settings, Support agent, Repro benches |
| `The agent stopped without an answer (it may have been stopped or hit the session limit).` | The CLI exited with nothing, often the Claude cap | See the session limit row above |
| `run not found` | Polling a run id the bridge no longer has | The app restarted. Run again |
| `The PR changed after this review was drafted, so its comments may point at old code.` | New commits since the review | Run again before posting |
| `fr assistant handoff is only wired for macOS right now` | Not macOS | Use Continue in Alter chat instead |
| Push to PR refused | Pushes are blocked by the push guard in every step except the explicit push, and that step is fast forward only | Use Push to PR after Fix this PR made a commit. If the PR branch moved, run Fix this PR again |
| The run's result says parts are unverified | The turn budget ran out | Ask a follow up for the unverified part, it continues the same session |

## Where to look when nothing above matches

- The app's log: run the dev build with `npm run dev` and watch the terminal, or `Console.app` filtered on `alter` for a release build.
- The run's steps: open the folded steps in the panel. Each tool call and its first line of output is there.
- The bridge directly: `curl -H "Authorization: Bearer $(cat ~/Library/Application\ Support/com.ejaaz.alter/bridge.token)" http://127.0.0.1:8765/runs`
