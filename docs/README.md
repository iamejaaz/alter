# Alter docs

Alter is a Tauri desktop chat app (Rust backend, React front end) with a browser extension. These pages describe every piece of configuration, where its state lives, and what to do when something breaks. They are written so an agent given an error message can find the cause without reading the source.

## Pages

| Page | Covers |
| --- | --- |
| [Setup](setup.md) | Install, run in dev, build, where data is stored, background service |
| [Connections and sign in](connections.md) | API providers, Claude Code, Codex, sign in flows and their errors |
| [Chat](chat.md) | Modes, permission cards, queued and scheduled messages, memory, skills, projects, routines, sidebar |
| [Bridge and extension](bridge-and-extension.md) | The local bridge on 127.0.0.1:8765, pairing, routes, extension settings |
| [Browser agents](agents.md) | PR review, ticket diagnosis, fix a PR, what each run may and may not do |
| [Troubleshooting](troubleshooting.md) | Every error message Alter shows, with cause and fix |

## If you have an error

Search [troubleshooting.md](troubleshooting.md) for the exact text first. The sections there are grouped by where the error appears: in a chat, in Settings, in the extension popup or panel, in the sidebar run list, or in the terminal when building.

## Facts to check first

1. Is the desktop app running? The bridge, routines and scheduled messages only work while it is.
2. Which connection is the chat on? Claude Code and Codex use a local CLI and your subscription. Every other connection is an OpenAI compatible HTTP endpoint with a key.
3. Is the extension paired? Popup shows `Connected · N models` when it is.
4. Is the agent working folder set? Browser triggered runs start there.

## Layout of the repo

```
src/            React front end (App.tsx is the main screen, components/ the panels, lib/ the API and storage code)
src-tauri/src/  Rust backend: lib.rs (commands), bridge.rs (local HTTP bridge), local_cli.rs (claude and codex), peers.rs, browser.rs
extension/      MV3 browser extension: background.js, shared.js, content.js (GitHub), support.js (Helpdesk), popup, options
skills/         Skills bundled with the app and installed into ~/.claude/skills at start
scripts/        Background service install and uninstall
docs/           These pages and screenshots
```
