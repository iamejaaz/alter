# Alter

Tauri 2 desktop chat app (Rust in `src-tauri/`, React in `src/`) with an MV3 extension in `extension/`. Read [docs/development.md](docs/development.md) before changing anything: repo map, how a chat turn flows, where state lives, how to run, check and ship, and the rules.

The short version:
- Check with `npx tsc --noEmit -p .` and `(cd src-tauri && cargo check)` before committing.
- Commit to `master` and push at once; every push is an update for the installed app. Conventional Commits, one line, no attribution, one fix per commit, never force push.
- Every long lived process goes through `own_group` and `children::track`. Never restart the app under an open window.
- Run one Alter at a time: quit `/Applications/Alter.app` before `npm run dev`. A Rust change in dev restarts the app and kills running turns.
- No explanatory comments in code. Reuse existing helpers and components. Update the matching `docs/` page in the same commit.
