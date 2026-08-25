# Alter

Your second self — a lightweight desktop AI companion with memory. Tauri 2 + React 18 + TypeScript + Tailwind CSS.

## Setup

```sh
npm install
```

## Develop

```sh
npm run dev
```

Opens the desktop window with hot reload.

First launch: open **Settings**, pick a provider preset (DeepSeek prefilled), paste your API key, save. The key lives only in local storage on this device.

## Memory

Alter remembers lasting facts you share (preferences, instructions, who you are) and carries them into every future conversation. Manage or delete them under **Settings → Memory**.

## Build a macOS bundle

```sh
npm run tauri build
```

Output lands in `src-tauri/target/release/bundle/` (`.app` and `.dmg`).

The current icon is a plain indigo placeholder. To replace it, overwrite `app-icon.png` (1024×1024) in the project root and run `npm run tauri icon`.
