# Chat

## Modes

The composer has a mode menu. It is a global setting and applies to the next turn of any chat.

| Mode | HTTP connections | Claude Code | Codex |
| --- | --- | --- | --- |
| Auto | File, web and browser tools run freely | `--permission-mode bypassPermissions`, no cards | approval `never`, full access |
| Ask first | Tools run, writes confirm | `--permission-mode default`, every command or edit shows a permission card | approval `untrusted`, workspace write |
| Plan | No actions | `--permission-mode plan` | read only |
| Chat only | No tools | No tools | read only |

Slash commands `/auto`, `/ask`, `/plan`, `/chat` switch the mode.

## Permission and question cards

In Ask first mode a Claude Code or Codex turn pauses and shows a card above the composer:

- **Permission card:** the tool and its input, with Allow once, rule buttons the CLI suggested (for the rest of the session), and Deny. Deny ends that action with a message to the model.
- **Question card:** one question at a time, with the options the model offered and a free text box. Skip skips only that question. Skipping all answers nothing and the model continues.

Cards appear in any mode when the model asks a question. In Chat only mode permission requests are denied automatically.

If you are on another chat when a card appears, that chat is marked unread and Alter sends a notification.

## Interrupt and queue

- **Esc** interrupts the running turn at its next step. Work done so far stays in the chat.
- Typing and sending while a turn runs **queues** the message. It shows as a dashed bubble "Sending at the next step". The running turn is asked to stop at its next step and the queued message is sent when it ends. Remove the bubble with ×.

## Long jobs

A chat keeps running when you switch to another chat or hide the window.

- Its sidebar row shows the current step and how long it has been running, for example `Browser: open labs.google/flow · 3m`. The time refreshes every 15 seconds.
- Steps from connectors read as `<connector>: <tool>`. Browser steps read as plain actions: open, click, type, screenshot, read the page.
- When it finishes and you are not looking at that chat, the chat is marked unread, and if it ran for 20 seconds or more Alter sends a notification with how long it took. Mute a chat from its row menu to stop the notification.

## Send later

The clock beside Send schedules the typed message:

- Presets: In 30 minutes, In 1 hour, Tomorrow morning (9:00). Or pick a day and a time and press the button, which reads "Send today at 3:10 PM".
- The message waits in the chat as a dashed bubble with **Send now**, **Edit** and ×. The sidebar shows a clock on that chat.
- It sends into the same chat with that chat's connection. If a turn is running at that moment it waits for it to finish.
- Alter checks every 5 seconds while open, plus a tick from the backend every 15 seconds for a hidden window. A message whose time passed while Alter was closed sends when Alter next opens.
- Text only. Attachments cannot be scheduled. Not available in a chat paired with a Claude Code session.
- Stored under `alter.scheduled`.

## Memory

- The system prompt asks the model to wrap a lasting fact in `<memory>…</memory>` at the end of a reply. Alter strips it, saves it, and appends it to `~/.claude/CLAUDE.md`.
- `~/.claude/CLAUDE.md` is also read at start and given to every model as standing preferences.
- Settings, Memory lists everything, with edit in place and Forget.
- **Import memory** from another assistant: copy the prompt, paste the answer, review the list, add. Imported lines stay in Alter and are not written to CLAUDE.md. Duplicates are skipped.

## Skills

- A skill is a name, a one line description and instructions. The model sees names and descriptions, and the full instructions load when a request matches or when you type `/<name> args`.
- Claude Code's own skills in `~/.claude/skills` and `~/.claude/commands` also appear in the slash menu and pass through to the CLI unchanged.
- **Import skills** in Settings, Skills: from `~/.claude/skills` (copies, originals untouched) or from a SKILL.md file. A skill with the same name is not imported twice.
- The three bundled skills (`frappe-pr-review`, `frappe-support-diagnosis`, `plain-writing`) are installed into `~/.claude/skills` on every start and refreshed when the bundled copy changes. Edits you make there are overwritten by the next start.

## Projects and folders

- A project has a name, a working folder and instructions. The instructions are added to every chat in the project.
- Selecting a project in the sidebar dropdown filters the sidebar to it, sets the working folder and starts new chats inside it.
- Every new chat records the folder it started in. The sidebar groups chats by project, then by folder name, then "Other chats". Clicking a group name folds it, the + on a group starts a chat there.
- Old chats were sorted once by the first project folder path mentioned inside them (`alter.folderBackfill`). Use the row menu, Move to project, to correct one.

## Sidebar row menu

Each chat row has a ⋮ menu: Pin, Rename, Mute notifications, Move to project, Delete. Delete asks first.

## Routines

Settings, Routines. A routine is a name, a prompt, a schedule and the connection it runs on.

- Schedules: every N minutes, daily at a time, weekly on chosen days at a time.
- Runs happen in the Rust backend once a minute while Alter is open, including in the menu bar. Results are written to `results.json` in the app data folder and picked up by the window within 20 seconds as a new chat titled `⏱ <name>`, listed under the routine in the sidebar.
- **Run now** starts one immediately in a new chat. **Fill in** turns a plain sentence into name, prompt and schedule.
- A daily or weekly run that was missed while Alter was closed does not catch up.
- To run with Alter quit, install the background service, see [setup.md](setup.md#background-service).

## Handoff and sessions

- `/handoff <task>` starts a background chat that does the task and reports back into the current chat with a card. `/handoff-full` includes the recent conversation.
- `@` lists running Claude Code sessions on this Mac. Picking one pairs the chat with it: what you type goes to that session and its replies land here. **Auto reply** lets this chat's model answer the session on its own, capped at 20 turns.

## Agent browser

Settings, General, Agent browser (on by default). A real browser window that chats can drive, the way Claude's built in browser works.

- **Which browser:** your default browser when it is Chromium based (Brave, Chrome, Edge, Chromium, Vivaldi, Opera, Arc), otherwise the first of those installed. Safari and Firefox cannot be driven.
- **Its own profile:** it runs as a separate instance with the profile in `browser-profile` in the app data folder, so it never touches your normal browser or its logins. Sign in to a site there once and it stays signed in.
- **Control port:** `127.0.0.1:9333`. Alter starts the browser in the background the first time a Claude Code or Codex chat starts, and leaves it running. **Open browser** in Settings brings it to the front.
- **How chats use it:** Claude Code and Codex get the Playwright connector (`@playwright/mcp@0.0.83`, run through `npx`) pointed at that port. API connections' own browser tools attach to the same window when it is running.
- **Sign in is yours.** The agent is told to stop and ask when a page wants a login, and never to type passwords, codes or payment details.
- Files it saves (screenshots, downloads) go to `media` in the app data folder.
- Closing the window is fine. The next chat starts it again.

## Connectors

Settings, Connectors. MCP servers that give Claude Code and Codex chats extra tools.

- **Browser** is built in, on the same switch as the agent browser above.
- **Add a connector** with one of: a command Alter starts (command, arguments separated by spaces with quotes around one that has a space, and `KEY=value` lines for environment), or a remote URL.
- Names must be unique and `browser` is reserved. The tools show up to the model under the name.
- Each connector has an on/off switch. The change applies to the next message in any chat, because a changed connector list restarts that chat's Claude Code process (the session resumes).
- How they are passed: Claude Code gets a temporary `--mcp-config` file in the system temp folder, Codex gets `-c mcp_servers.<name>...` overrides. API connections do not use connectors.
- **Already in Claude Code** lists the servers in `~/.claude.json`. Claude Code loads those on its own, so they are shown, not edited. Use `claude mcp` in Terminal for them.
- Stored in `alter.settings` under `connectors`, environment values included.

## Attachments and artifacts

Attach with the paperclip, paste, or drag files from Finder or another app onto the chat. A dashed "Drop to attach" frame shows while you drag. The window setting `dragDropEnabled: false` in `src-tauri/tauri.conf.json` is what lets the page receive those drops; turning it back on breaks drag and drop.

Images are saved to disk under the app data folder, PDFs and text files are read in. HTML and SVG the model produces open in the artifact side panel.

## Media in replies

When a reply mentions the path of an image (`png jpg jpeg gif webp svg`) or a video (`mp4 mov webm m4v`) that exists on disk, it shows inline under the reply: images open full size on click, videos play in place, and **Show in Finder** reveals the file.

- Paths can be absolute, start with `~/`, or be relative (`./shot.png`), which resolves against the chat's folder. Web URLs are left alone. Up to 12 per reply. Paths with spaces are not picked up.
- Files are loaded through Tauri's asset protocol. Its scope starts empty, and each file is allowed one by one only after Alter checks it exists and has a media extension (`media_allow`). Nothing else on disk is readable by the window.
- With the agent browser on, the model is asked to save into the `media` folder in the app data folder and to print each file's full path, so its screenshots and generated images show up here.

## Related

- [connections.md](connections.md) for what each connection can do
- [troubleshooting.md](troubleshooting.md#chat) for errors shown in a chat
