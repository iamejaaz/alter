---
name: frappe-debugging
description: "Debug a Frappe app (frappe, erpnext, hrms, any app) on a local bench: find the bench and site, get the server up, log into the site without typing a password, reproduce in the browser or the console, read the right logs, and know when a change needs a build, a migrate or a restart. Use when something on a local site is broken, a fix needs checking in the UI, or a page or request fails."
---

# Frappe debugging

Find the cause on a real local site, then prove it. Read before changing, change one thing at a time, and leave the bench as you found it.

## 1. Where things are

- A bench is a folder with `apps/` and `sites/`. Run `bench` from that folder, never by absolute path.
- The site: `sites/currentsite.txt`, else the folder under `sites/` with a `site_config.json`. The port: `webserver_port` in `sites/common_site_config.json` (8000 by default). Local sites usually resolve as `http://<site>:<port>`.
- App code is `apps/<app>`. Check the branch with `git -C apps/<app> rev-parse --abbrev-ref HEAD` before assuming what code is running.
- When the frappe-pr-review skill is installed, its `scripts/where.sh <owner/repo>` prints `BENCH`, `APP_PATH` and `SITE` for you.

## 2. Is the server up and current

- `lsof -nP -iTCP:<port> -sTCP:LISTEN` shows what answers on the port, and its working folder tells you which bench it serves. Another bench on the same port is the usual cause of "my change does nothing".
- Redis must be up for most pages and for tests: `redis-cli -p <port> ping` for the ports in `common_site_config.json` (`redis_cache`, `redis_queue`). Not running means `bench start` is not running.
- Python changes need a server restart unless it runs with auto-reload. A login or session that works through `bench --site <site> console` but fails over HTTP means the running server is stale: restart it.
- JS, CSS and Vue changes need `bench build --app <app>`, or a running `bench watch`, then a hard reload. A doctype `.json` or `patches.txt` change needs `bench --site <site> migrate`. Cached meta or settings need `bench --site <site> clear-cache`.

## 3. Log in without a password

Never type a password into a site. For a local site:

```sh
bench --site <site> browse --user Administrator --sid
```

It prints a session id. Open `http://<site>:<port>/app?sid=<id>` in the browser and the browser is signed in. Another user needs `developer_mode` on that site. Older benches without `--sid`: run `bench --site <site> browse --user Administrator` and use the URL it opens.

## 4. Reproduce

- Backend: `bench --site <site> console` for a quick check, `bench --site <site> execute <dotted.path>` for one function. Wrap writes so they roll back (`frappe.db.rollback()`), or delete what you made.
- UI: drive the agent browser. Read the page, click, type into fields, then read the browser console and failed network requests. A 417 or 500 response body carries the server traceback.
- Tests: `bench --site <site> run-tests --module <dotted.module>`. If testing is disabled, `bench --site <site> set-config allow_tests true` once.

## 5. Where errors go

- Server tracebacks: the `Error Log` doctype (`frappe.get_all("Error Log", order_by="creation desc", limit=5)` in the console), then `logs/web.error.log`, `logs/worker.error.log`, `logs/frappe.log` and `sites/<site>/logs/`.
- Background jobs: `logs/worker.error.log` and the `RQ Job` list. Scheduler state: `bench --site <site> doctor`.
- Client errors: the browser console. A `frappe.throw` shows as a dialog, and its message is in the response body.

## 6. Clean up what you started

- Before starting anything, note what already runs: `lsof -nP -iTCP:<port> -sTCP:LISTEN` and `pgrep -fl "bench|frappe|redis"`. Those are the user's. Never stop them.
- Start servers so you can find them again: note the PID it prints, or start it in the background and record `$!` in your scratchpad.
- Before you finish, stop every process you started (`bench start`, `bench serve`, `bench watch`, redis, a test server) with `kill <pid>`, and confirm the port is free again. If you restarted the user's own server, start it again the way it was running.
- Put back anything else you changed for the check: a branch, a config flag, a temporary file.

## 7. Report

Say what a user sees, the cause with `file:line`, and the fix. Then what you ran to prove it, which processes you stopped, and anything you left changed on purpose (a migrate, a config flag). Never claim it works without having run it.
