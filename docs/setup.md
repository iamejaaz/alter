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

The `.app` and `.dmg` land in `src-tauri/target/release/bundle/`. The installed app updates itself, see Daily use below.

## Updating

Settings, General, **Update Alter**, or **Update** in the extension popup. Both run `git pull --ff-only` in the repo the app was built from. In `npm run dev` the app then rebuilds and restarts itself when Rust files changed, and the front end reloads on its own. A built `.app` needs `npm run tauri build` again for app changes. The extension reloads itself when its own files changed.

## Where state lives

| What | Where |
| --- | --- |
| Chats | One file per chat in `~/Library/Application Support/com.ejaaz.alter/chats/` |
| Settings, memories, routines, skills, projects, scheduled messages | The app's web storage, keys prefixed `alter.` (`alter.settings`, `alter.conversations`, `alter.memories`, `alter.routines`, `alter.skills`, `alter.projects`, `alter.scheduled`, `alter.theme`, `alter.folder`, `alter.activeProject`) |
| Bridge pairing token | `~/Library/Application Support/com.ejaaz.alter/bridge.token` (dev builds use the `alter` identifier) |
| Image attachments, snapshots, routine state and results | `~/Library/Application Support/com.ejaaz.alter/attachments`, `snapshots`, `results.json` |
| Bundled skills | Installed into `~/.claude/skills/frappe-support-diagnosis`, `~/.claude/skills/frappe-pr-review`, `~/.claude/skills/plain-writing` on every start, refreshed when the bundled copy changed |
| Facts Alter learned from chats | Appended to `~/.claude/CLAUDE.md` so Claude Code sees them too |
| Extension settings | The extension's own storage: `token`, `models`, `claudeModel`, `helpdeskSite`, `grammarEverywhere`, `autoReview`, `autoReviewPost` |
| Panel size and position | The page's local storage on github.com and the helpdesk site: `alter_panel_box`, `alter_sup_box` |

The dev build and the installed app keep web storage apart (`~/Library/WebKit/alter` and `~/Library/WebKit/com.ejaaz.alter`), so settings changed in one don't show in the other. Chats are files and are shared.

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

## Daily use: the installed app with auto update

Build once and install, then use `/Applications/Alter.app` day to day instead of `npm run dev`:

```bash
cd ~/projects/frappe/alter && npm run tauri build -- --bundles app && ditto src-tauri/target/release/bundle/macos/Alter.app /Applications/Alter.app
```

The installed app keeps itself current:

- Every 10 minutes (first check a minute after start) it fetches `master` from iamejaaz/alter. When there is a new commit, it fast forwards this checkout and rebuilds the app in the background. The build log is `update.log` in the app data folder.
- When the build is ready, it installs when you quit Alter, or while the window is closed and no chat or extension run is going. Then it comes back hidden in the menu bar. It never restarts under an open window.
- **Update** in Settings checks right away, or restarts at once into a build that is already ready.
- Run only one Alter at a time: the installed app and `npm run dev` share the bridge port, the peer socket and the data folder.
