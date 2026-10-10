---
name: frappe-pr-deep-review
description: "End-to-end deep review of a Frappe PR: review it like a maintainer, then prove the findings on a real bench and in the browser, then post the verdict. Runs the frappe-pr-review rubric, checks the branch out on the bench, builds/migrates/enables what the feature needs, reproduces the bug in the desk UI, captures a screenshot, and (only when asked) posts a Request-changes review under the maintainer's own GitHub via the browser with the screenshot attached. Use when asked to 'review PR N in the same way', 'deep review', 'review and test on UI', or 'review and post'. Argument: PR number, optional focus text, optional 'post'."
---

# Frappe PR deep review

One command, the whole loop: read the PR like a maintainer, verify every finding against the code, prove the ones that need proof on a running bench and in the browser, and post the verdict only when told to. This wraps `frappe-pr-review` (the rubric and the maintainer voice) and adds the bench + UI + posting steps that a screenshot-backed review needs.

Inputs: `PR` number, optional `FOCUS`, optional `post` (post the result, don't just report it). Default is report-only; never post unless the caller said to.

## 1. Review, in two independent passes (always)

No single pass is trusted on its own. Split the work across agents: one produces findings, another tears them down.

1. **Reviewer pass.** Run the `frappe-pr-review` skill with the PR number and FOCUS — its rubric and maintainer voice are the single source, so do not re-derive them. For a large or multi-area PR, fan out: one reviewer agent per area (server logic, client/UI, schema, tests), each handed the whole skill and told to return findings only — file:line, the ask, and which rubric steps it cleared. Every reviewer agent is read-only: it never posts, dispatches, switches branches, or writes outside its scratchpad.

2. **Verifier pass.** Hand every finding to a *separate* agent that did not produce it. The verifier re-checks each one adversarially against the code as it stands now: it greps the symbol, reads the caller, the parent class, the base method and the test, and actively tries to prove the finding wrong — already handled three lines down, in a superclass, in a `validate` hook, or on a path the input can't reach. It returns CONFIRMED or REJECTED per finding with the one file:line that decides it. A finding the verifier cannot confirm is dropped, not softened.

Then, as orchestrator, grep every symbol in every surviving finding yourself before it enters the result; agents invent plausible names. Carry the confirmed findings and the verdict forward unchanged. Everything below only *adds proof* to those findings; it never invents new ones without the same two-pass check.

## 2. Resolve the bench

`<frappe-pr-review folder>/scripts/where.sh frappe/<repo> <baseRefName>` prints `BENCH`, `APP_PATH`, `SITE`, `REMOTE`, `BASE_REF`. Use what it prints. If no local checkout, stop here and report review-only (no bench).

The bench may be shared with other work. So: note what is already running before you touch anything (`lsof -nP -iTCP:<port> -sTCP:LISTEN`, `pgrep -fl "bench|redis"`), never kill the user's processes, and put the branch back when done unless the user wants to keep working on it.

## 3. Check the branch out

Only when the verdict turns on how the PR actually behaves, or the user asked to test on UI. Pure-logic findings are proven in the console (step 5 of frappe-pr-review); this step is for the desk UI.

1. In `APP_PATH`: `git status --short` must be clean of others' work. Save the current branch.
2. `gh pr checkout <PR> -R frappe/<repo>` (handles cross-repo forks).
3. Assets: the PATH `bench` here is a pilot wrapper and its `serve` does not resolve sites. Build with `bench build --app <app>` (writes `sites/assets/assets.json`), and serve the branch yourself with the bench's own python:
   ```sh
   cd <BENCH>/sites && ../env/bin/python -c "import frappe.app; frappe.app.serve(port=8899, site='<SITE>', sites_path='.', no_reload=True)"
   ```
   This runs the checked-out branch's Python (so `boot.py` changes take effect), on a port that won't collide with the user's server. It has no realtime, so socket.io 404s in the console are expected and not findings.
4. Redis: migrate and boot need this bench's redis. If `redis-cli -p <cache_port> ping` fails, start them from config: `redis-server config/redis_cache.conf` and `redis-server config/redis_queue.conf`. These are yours to stop afterwards.
5. If the diff touches a doctype `.json` or `patches.txt`, `bench --site <SITE> migrate`. Say so in the result (it is a left-behind schema change on a shared site).

## 4. Enable what the feature needs

A feature behind a flag will not show until the flag is on **and** reaches the client the way the code reads it. A System Settings boolean read client-side through `frappe.defaults.is_enabled(key)` only reaches `frappe.sys_defaults` when `System Settings.on_update → set_defaults` runs, and that only fires on a real value **change** (`has_value_changed`). So `frappe.db.set_single_value(...)` is not enough: toggle it properly.

```py
doc = frappe.get_doc("System Settings"); doc.<flag> = 0; doc.save(); frappe.db.commit()
doc = frappe.get_doc("System Settings"); doc.<flag> = 1; doc.save(); frappe.db.commit()
frappe.clear_cache()
# verify: frappe.defaults.get_defaults().get("<flag>") is truthy
```

If the flag's field is new in the PR and the DB predates it, `frappe.reload_doc("core","doctype","system_settings")` first. Record every flag you flipped; put them back in step 7.

## 5. Test it the way a user would — both UI and backend

Checking out the branch is not the test; *using* the feature is. Exercise **every surface the PR changes** the way a real user manually would, end to end — the UI flow in the browser **and** the backend path behind it. Reading the code tells you what it should do; this step is where you find out what it actually does.

Log in without a password: `bench --site <SITE> browse --user Administrator --sid` prints a raw sid. Open the desk through the built-in browser at `http://127.0.0.1:8899/app?sid=<sid>`, then walk the feature.

- **Walk the whole flow, not one line.** Do what the PR's description and its screenshots/video show a user doing, step by step, and confirm each step produces the right result — the feature *works*, not merely that nothing threw.
- **Produce the real thing the feature makes, with genuine data.** Don't stop at the control — create the actual record, document, render or output the feature exists to produce, using realistic data, and then *look at it as a user would*: is it correct, does it look right, is the interaction good? UX and visual defects (misalignment, wrong label, awkward step order, a state that reads wrong) only show up on the real output, never in the code. Where a real reference exists (the existing format, the old screen, the documented result), compare against it — parity with the real thing is the bar; a scaffold that merely renders is not done.
- **Cover the edges a user hits**, not just the happy path: empty, invalid, very large, `0`/`"0"`, duplicate, cancel midway, a second user with fewer permissions, mobile width for a UI change. These are where the real bugs are.
- **Backend too.** A change under a button is also an API call: exercise the changed endpoint / method as the UI calls it (`bench --site <SITE> console`, `execute`, or `xcall` through the browser), and confirm the stored result — the row written, the file shrunk, the value mapped — not just the toast. Roll back any writes.
- Prefer reading state over guessing: `read_page`, `get_page_text`, `javascript_tool` for the DOM and computed state; `cur_frm.doc.<field>` and `frappe.db`/`get_doc` for what was actually saved. A finding is confirmed only when the DOM or a value shows it.
- Read the console and network for errors; separate the PR's errors from the serve's own (socket.io 404s are the serve, not the PR).
- **Make sure you are testing the PR's code, not stale code.** After a checkout, confirm the serving process is yours and current (its start time, the branch it loaded, a string only the new code prints) before trusting a result — a server left from an earlier branch will "reproduce" bugs that are not there.
- Capture it: `computer {action:"screenshot"}` for the UI, the stored value for the backend. Save the frame; you will attach it to the review and send it to the user.

Report what a user sees (does X → gets Y → should get Z), not how you ran it.

## 6. Post — only when asked, and only as the maintainer

Default is report-only: hand back the frappe-pr-review result block plus the reproduction and the screenshot, and stop.

When the user says to post a Request-changes review **with the screenshot**: GitHub has no public API to upload an image to its CDN, so the only way to embed one is through a logged-in browser. Post as the maintainer, from their own GitHub account in their browser, never as the bot — a bot must not Request-changes, and it cannot attach an image.

1. Chrome (`mcp__claude-in-chrome__*`): open `https://github.com/frappe/<repo>/pull/<PR>/files`, confirm logged in as the maintainer.
2. `Submit review` → type the body (frappe-pr-review's voice: user story first, one anchor, a question not an order; put the one-line fix in a ```js block citing file:line when the inline diff is collapsed and a line-anchored suggestion would be fragile).
3. Attach the screenshot by clipboard, the way a human does: `osascript -e 'set the clipboard to (read (POSIX file "<path>") as JPEG picture)'`, focus the comment box, `cmd+Down`, `cmd+v`. GitHub uploads it and inserts the `user-attachments` URL. The hidden file input is not in the a11y tree, so `file_upload` cannot target it; the paste is the reliable path.
4. Select **Request changes**, Submit.
5. Verify it landed: `gh api repos/frappe/<repo>/pulls/<PR>/reviews` — latest review by the maintainer is `CHANGES_REQUESTED` and its body contains the `user-attachments/assets/...` URL.

The bot script (`frappe-reviewer/bin/post`) stays for the autonomous digest and for COMMENT reviews; it is never how a screenshot-backed Request-changes gets posted.

## 7. Restore

Stop every process you started (your `:8899` serve, any redis you launched) and confirm the ports are free. Put flags back to their original value (the same proper save as step 4) unless the user is still testing. Leave the branch checked out only if the user is working on it; otherwise restore the saved branch. Report what stayed changed on purpose: a migrate on the shared site, a flag left on, a branch left checked out, a server left running for the user.

## 8. Result

Lead with the frappe-pr-review verdict block (it already carries the findings and the Reproduced line). Then, when a UI reproduction ran, one plain before/after line per confirmed finding and the screenshot. When posting happened, the review URL and that the screenshot embedded. When it did not, say it is report-only and offer to post.
