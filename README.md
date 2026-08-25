# Alter

Your second self — a lightweight desktop AI companion with memory. Bring your own model.

![Alter](docs/screenshot.png)

Alter is a small, fast desktop chat app. It talks to any OpenAI-compatible model, remembers what matters about you across conversations, can read and edit files in a folder you attach, and runs saved prompts on a schedule. It uses your OS's native webview (via Tauri), so the app is a few MB and light on memory — no bundled browser.

## Features

- **Bring your own model** — presets for DeepSeek, Moonshot (Kimi), and the Vercel AI Gateway, or point the base URL at any OpenAI-compatible endpoint. Your API key is stored only on your device.
- **Streaming chat** with markdown rendering, syntax-highlighted code blocks, and copy buttons.
- **Memory** — Alter automatically remembers lasting facts and preferences you share, and carries them into every future conversation. Review or forget any of them in Settings.
- **File tools** — attach a working folder, then ask Alter to show a file tree, search across files (like grep), read files, or write files (writes ask for confirmation first).
- **Attachments** — drop in images (for vision-capable models) or text/code files; they're sent along with your message.
- **Chat search** — filter conversations by title or message content from the sidebar.
- **Modes** — choose how Alter uses tools: **Auto** (acts freely, writes ask first), **Ask first** (confirm every action), **Plan** (describes what it would do without acting), or **Chat only** (no tools).
- **Shows its work** — every file read, search, web fetch, or write appears as a step in the conversation as Alter takes it.
- **Web access** — Alter can search the web and read pages to answer with current information.
- **Browser mode** — for JavaScript-heavy pages or tasks that need clicking and typing, Alter drives a real browser (uses your installed Chrome, or downloads a browser engine on first use).
- **Routines** — save a prompt and an interval; Alter runs it automatically and drops each result into a new conversation. Scheduled runs execute in the Rust backend, so they fire even with the window closed.
- **Runs in the background** — a menu-bar tray keeps Alter alive when you close the window, plus an optional launch-at-login.

## Stack

Tauri 2 · React 18 · TypeScript · Tailwind CSS 3 · Vite

## Prerequisites

- [Rust](https://rustup.rs) (stable)
- [Node](https://nodejs.org) 18+
- macOS: Xcode Command Line Tools (`xcode-select --install`)

## Develop

```sh
npm install
npm run dev
```

On first launch, open **Settings**, choose a provider preset, paste your API key, and save.

## Build a macOS bundle

```sh
npm run tauri build
```

The `.app` and `.dmg` land in `src-tauri/target/release/bundle/`.

## Always-on routines (optional)

By default, routines run whenever Alter is open (including minimized to the menu-bar tray). To keep them running even after you quit the app, install the background service after building:

```sh
npm run tauri build
cp -R src-tauri/target/release/bundle/macos/Alter.app /Applications/
./scripts/install-service.sh
```

Remove it anytime with `./scripts/uninstall-service.sh`.

## How memory works

Alter's system prompt asks the model to tag durable facts as it replies. Those are extracted, stored locally, and prepended to future conversations as context. This is retrieval, not fine-tuning — nothing about the model's weights changes, and everything stays on your machine.

## Configuration

Everything is stored in the app's local storage on your device:

| Setting | Where |
| --- | --- |
| API key, base URL, model | Settings → Connection |
| Remembered facts | Settings → Memory |
| Routines | Routines |
| Launch at login | Settings → Connection |

## Notes

- Shell/command execution is intentionally not included — Alter can read, search, and write files, but does not run arbitrary commands.

## License

MIT
