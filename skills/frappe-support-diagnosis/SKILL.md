---
name: frappe-support-diagnosis
description: Diagnose a Frappe/ERPNext/HRMS support ticket like a senior maintainer — read the ticket via frappectl, find the code across ALL installed apps, triage which versions are affected (develop → v16 → v15), reproduce on a bench where possible, and check gh for an existing fix. Use whenever triaging a support.frappe.io helpdesk ticket or any "is this a bug, where, and is it fixed" question about Frappe apps.
---

# Frappe support diagnosis

A rigorous, repeatable method for diagnosing a support ticket. The goal is a
maintainer-grade verdict: is it a bug, where is the code, which versions are
affected, is it already fixed, and can it be reproduced — never a plausible guess
dressed up as a conclusion.

## Ground rules

- **Never assume. Check.** The most common failure is claiming "that doctype is a
  custom app, I can't see it" or "the customer's commit isn't available" — both
  are usually wrong. Run `ls apps/` and `git cat-file -t <ref>` before you say
  something isn't here.
- **Ask when a fact is missing.** If the version, exact repro steps, the specific
  DocType/web form, the error text, or a config flag you need isn't in the ticket
  and you can't derive it, STOP and ask the user precise questions. Do not invent
  the missing piece.
- **Reproduce before you conclude.** A code-trace is a hypothesis. If you can run
  a bench, confirm it (see step 5). If you can't, say the root cause is
  *unconfirmed* and what would confirm it.
- **Git is READ-ONLY during diagnosis.** Inspect with `git -C apps/<app> show
  <ref>:path`, `git -C apps/<app> log`/`diff`/`cat-file` — the bench root isn't a
  repo, so always target the app with `-C apps/<app>`. NEVER `checkout`, `switch`,
  `commit`, `reset`, `restore`, `merge`, `rebase`, or `push`; never change the
  working tree or a remote. Read history with `show` — don't check anything out.
  (Branching/committing/PRs happen only in a Create-PR run or a handoff session.)
- **Scan for PII.** Tickets carry real customer names, emails, resumes. Never
  paste candidate/customer PII into a public PR or issue; refer to the ticket by
  number.
- **Know your capability.** If you are the read-only browser triage agent (no
  write/execute), do the read-only steps (1–4, 6) fully and hand off reproduction
  (step 5). If you have a bench + execute (fr assistant, Alter chat, plain Claude
  Code), do everything.

## Method

### 1. Read the ticket
`fr -s support.frappe.io doc get "HD Ticket" <id> --json` (see the `frappectl`
skill). Pull related tickets/data with `fr query` / `fr doc list` when the report
is thin. Look for a sibling ticket on the same site with more detail.

### 2. Establish the facts
Extract and write down:
- **Frappe version + installed apps** — usually in a `custom_installed_apps` /
  version field on the ticket (e.g. `frappe version-15 @ c6bacad806`). If absent,
  ask, or pull via site access.
- **DocType / web form / feature**, exact steps, and the exact error.
If any of these is missing and blocks you, ask now (see Ground rules).

### 3. Locate the code — across ALL installed apps
Never assume a DocType is "custom / not here" without checking. From the bench:
```sh
ls apps/                                   # frappe erpnext hrms payments ...
scripts/find-code.sh "Job Applicant"       # grep the term across every app
```
HRMS doctypes (Job Applicant, Job Opening, …) live in `apps/hrms`; ERPNext ones
in `apps/erpnext`. Only call something "a custom app not in this checkout" after
`ls apps/` proves it.

### 4. Version triage — develop → v16 → v15
Find where the buggy code path exists, checking newest first and recording each:
```sh
scripts/across-versions.sh frappe/website/doctype/web_form/web_form.py
```
**FETCH UPSTREAM FIRST** — `git -C apps/<app> fetch upstream` — and compare the
`upstream/*` refs (frappe/frappe), NOT the local branches. Local branches and a
fork's `origin` can be badly stale: a real run found the local `version-15-hotfix`
**3 years old**, which would have wrongly concluded "fixed". This is the #1 cause
of a diagnosis flip-flopping between runs — always compare against fresh upstream.

Check, in order:
1. **upstream/develop** — is it still broken on the latest line?
2. **upstream/version-16-hotfix**
3. **upstream/version-15-hotfix** — the customer's line (also `git show
   <customer-ref>:path` for their exact commit when you have it).

Interpret:
- Fixed on develop/v16 but broken on the customer's version → the fix is a
  **backport**; find the commit/PR that fixed it (`git log -S<symbol> --oneline
  <path>`, and gh).
- Broken on develop too → a **new fix** is needed.
State the exact refs you compared and the verdict per version.

### 5. Reproduce — develop first, then the customer's version
A trace is a hypothesis; reproduction is proof. Mirror how automated repro works
(SWE-agent / OpenHands / MarsCode "Reproducer"): write a repro SCRIPT, run it in
an isolated sandbox, and ASSERT the buggy outcome — never eyeball it.

**Sandbox** = a throwaway Frappe site on a **per-version bench**. The benches live
under `$ALTER_REPRO_ROOT` (the folder set in Alter → Settings → Repro benches):
`bench-develop`, `bench-version-16`, `bench-version-15`, each with frappe + the
relevant apps (hrms/erpnext) and ONE reusable repro site (`repro.localhost`). Run
`echo "$ALTER_REPRO_ROOT"`; if unset, tell the user to set it in Settings (and to
run `scripts/repro-setup.sh` once to scaffold the benches). The site is reused
every run and the script rolls back — so a repro is seconds, never a per-run
new-site/drop-site.

**Order — develop FIRST, then narrow:**
1. **develop** — does the bug reproduce on latest? If YES → it needs a **new fix**.
2. If NO on develop but YES on the customer's line (v16/v15) → already fixed on
   develop → the fix is a **backport** (find the fixing PR). This tells you the
   fix strategy before you write a line of fix.

Benches can be classic `frappe-bench` or `pilot`-managed (same `apps/`, `sites/`,
`env/` layout — `repro.sh` handles both). The console auto-inits + connects the
site, so the script uses `frappe.*` directly (no `frappe.init`/`connect` needed)
and just asserts the bug, wrapped so it leaves **no residue** (roll back):
```python
import frappe
reproduced = False
try:
    # build the trigger (e.g. web_form accept() with an empty Attach on an
    # existing doc) and set reproduced = <the buggy outcome actually happened>
    print("REPRODUCED" if reproduced else "NOT REPRODUCED")
finally:
    frappe.db.rollback()   # never persist test state
```
Run it per version with the helper (routes to the right bench, runs on its repro
site, rolls back):
```sh
scripts/repro.sh develop /tmp/repro.py
scripts/repro.sh version-15 /tmp/repro.py
```

- **Config/data-specific bugs** (need the customer's exact setup, e.g. a web
  form's `allow_edit`): reproduce the CONFIG on a fresh site (ask them for the
  web-form export). NEVER restore a PII-laden production backup into an
  agent-reachable site.
- **Read-only triage agent:** you can't run bench. Produce the trace + version
  triage and hand off — "Continue in… → fr assistant / Alter chat" — to run the
  repro above. Say clearly that repro was not run and what would confirm it.

### 6. Check gh for an existing fix
Search open AND closed:
```sh
gh search issues --repo frappe/frappe "<symptom>" --limit 20
gh search prs   --repo frappe/frappe "<symptom>" --state all --limit 20
```
Also try the fixing symbol (`gh search prs --repo frappe/frappe <function_name>`).
Do the same for `frappe/hrms` / `frappe/erpnext` when the code lives there.

## Output

Terse, in Ejaaz's voice — no preamble, no praise-fluff:

- **Classification** — functional-query vs bug vs config/user-error.
- **Root cause** — the mechanism, with the exact file + refs you checked, and
  whether it's confirmed (reproduced) or a leading hypothesis (traced only).
- **Versions affected** — develop / v16 / v15, and whether already fixed (→ which
  commit/PR to backport).
- **Reproduction** — what you ran and saw, or what's needed to confirm.
- **Known issue/PR** — link it, or say none found and what you searched.
- **Suggested next step** — the smallest concrete action; if blocked, the exact
  questions/access you need.

## Anti-patterns (caught in the wild)

- ❌ "Job Applicant is a custom app not in this checkout" when `apps/hrms` exists.
- ❌ WebFetching a file from GitHub when the customer's commit is already local
  (`git show <ref>:path`).
- ❌ Presenting a code-trace as a confirmed root cause without reproducing.
- ❌ Guessing which of several plausible bugs fired instead of asking for the one
  fact that disambiguates.
