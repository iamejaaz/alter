# Setup

## Requirements

- macOS. The background service, tray and sign in flows are macOS only.
- Rust stable, Node 18 or newer, Xcode Command Line Tools (`xcode-select --install`).
- For Claude Code connections: the `claude` CLI on your PATH and signed in. See [connections.md](connections.md).
- For browser agents: `gh` signed in, `fr` (frappectl) installed, a bench checkout. See [agents.md](agents.md).

## Run in development

```sh
npm install
npm run dev
```

`npm run dev` starts Vite on port 5173 and the Tauri shell. The front end hot reloads. A change under `src-tauri/src` rebuilds the Rust side and restarts the app, which clears the in memory run list of the bridge.

## Build

```sh
npm run tauri build
```

The `.app` and `.dmg` land in `src-tauri/target/release/bundle/`. There is no auto update. Install a new build by replacing `Alter.app`.

## Updating

Settings, General, **Update Alter**, or **Update** in the extension popup. Both run `git pull --ff-only` in the repo the app was built from. In `npm run dev` the app then rebuilds and restarts itself when Rust files changed, and the front end reloads on its own. A built `.app` needs `npm run tauri build` again for app changes. The extension reloads itself when its own files changed.

## Where state lives

| What | Where |
| --- | --- |
| Settings, chats, memories, routines, skills, projects, scheduled messages | The app's web storage, keys prefixed `alter.` (`alter.settings`, `alter.conversations`, `alter.memories`, `alter.routines`, `alter.skills`, `alter.projects`, `alter.scheduled`, `alter.theme`, `alter.folder`, `alter.activeProject`) |
| Bridge pairing token | `~/Library/Application Support/com.ejaaz.alter/bridge.token` (dev builds use the `alter` identifier) |
| Image attachments, snapshots, routine state and results | `~/Library/Application Support/com.ejaaz.alter/attachments`, `snapshots`, `results.json` |
| Bundled skills | Installed into `~/.claude/skills/frappe-support-diagnosis`, `~/.claude/skills/frappe-pr-review`, `~/.claude/skills/plain-writing` on every start, refreshed when the bundled copy changed |
| Facts Alter learned from chats | Appended to `~/.claude/CLAUDE.md` so Claude Code sees them too |
| Extension settings | The extension's own storage: `token`, `models`, `claudeModel`, `helpdeskSite`, `grammarEverywhere`, `autoReview`, `autoReviewPost` |
| Panel size and position | The page's local storage on github.com and the helpdesk site: `alter_panel_box`, `alter_sup_box` |

Chats are limited by web storage size. When it is full Alter shows `Couldn't save your chats`. Delete old chats to free space.

## Background service

Routines and scheduled messages run only while Alter is open, including when it sits in the menu bar. To keep them running after you quit:

```sh
npm run tauri build
cp -R src-tauri/target/release/bundle/macos/Alter.app /Applications/
./scripts/install-service.sh
```

This writes `~/Library/LaunchAgents/com.ejaaz.alter.plist` and loads it. Remove it with `./scripts/uninstall-service.sh`. Pass a different app path as the first argument if the app is not in `/Applications`.

## Launch at login and tray

Settings, General, Launch at login uses the Tauri autostart plugin. Closing the window hides Alter to the menu bar. Quit from the menu bar icon or with Cmd Q.

## Related

- [connections.md](connections.md) for the first connection
- [troubleshooting.md](troubleshooting.md) for build and start errors
