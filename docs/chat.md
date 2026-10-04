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

## Attachments and artifacts

Images are saved to disk under the app data folder, PDFs and text files are read in. HTML and SVG the model produces open in the artifact side panel.

## Related

- [connections.md](connections.md) for what each connection can do
- [troubleshooting.md](troubleshooting.md#chat) for errors shown in a chat
