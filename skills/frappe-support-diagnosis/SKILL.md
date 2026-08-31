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
`fr doc get "HD Ticket" <id> --json` (see the `frappectl` skill). Run **bare**
`fr` — the environment provides the site + credentials (FRAPPE_SITE/API_KEY/
API_SECRET); do NOT pass `-s <profile>` (it hits the macOS keychain and prompts).
Only fall back to `-s support.frappe.io` if bare fr says no site/creds are set.
Pull related tickets/data with `fr query` / `fr doc list` when the report
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
**FETCH UPSTREAM FIRST, BUT NARROW** — fetch only the 3 branches you triage, with
`--no-tags`; a plain `git fetch upstream` drags in frappe's thousands of tags and
is the slowest step in the whole run:
```sh
git -C apps/<app> fetch --no-tags upstream develop version-16-hotfix version-15-hotfix
```
`across-versions.sh` already does this (and skips the fetch if it ran in the last
10 min). Then compare the `upstream/*` refs (frappe/frappe), NOT the local
branches: local branches and a fork's `origin` can be badly stale — a real run
found the local `version-15-hotfix` **3 years old**, which would have wrongly
concluded "fixed". This is the #1 cause of a diagnosis flip-flopping between runs.

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

**Sandbox** = a throwaway Frappe site on a **per-version bench**. The user picks a
bench folder per version in Alter → Settings → Repro benches, exposed as
`$ALTER_REPRO_DEVELOP`, `$ALTER_REPRO_VERSION_16`, `$ALTER_REPRO_VERSION_15` (or a
folder-of-benches under `$ALTER_REPRO_ROOT` as a fallback). Each bench has frappe
+ the relevant apps and ONE reusable repro site (`repro.localhost`). Don't parse
these yourself — just call `scripts/repro.sh <version> <script.py>`; it resolves
the bench. If none is configured, tell the user to set them in Settings (and
`scripts/repro-setup.sh` can scaffold missing ones). The site is reused and the
script rolls back, so a repro is seconds — never a per-run new-site/drop-site.

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
site, rolls back). **Even the read-only extension agent may run this** — it's the
one bench command allowed there, by its installed absolute path, and it only ever
touches your local disposable benches. Call it by that path (`~` expands), and
pipe the script on **stdin** with `-` so no scratch file / `Write` tool is needed:
```sh
~/.claude/skills/frappe-support-diagnosis/scripts/repro.sh develop - <<'PY'
import frappe
# … build the trigger, set reproduced = <bug actually happened> …
print("REPRODUCED" if reproduced else "NOT REPRODUCED")
frappe.db.rollback()
PY
```
(A file path still works too: `…/repro.sh version-15 /tmp/repro.py`.) If the
helper reports "no bench for '<ver>'", that version's folder isn't set — say so
and fall back to the trace; don't claim a repro you didn't run.

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

## Output — scannable in one minute, depth on demand

The reader must grade **"is it a bug, and is it fixed?"** in one glance. Default
to the SHORT block ONLY. Depth is optional and must be *earned* by the ticket.

**Proportionality — match the output to the finding. This is the #1 rule.**
- The short block below is usually the WHOLE answer. For a simple, clear, or
  low-severity finding (a config/user-error, a "works as designed", an obvious
  one-file bug, fixture noise) **STOP after it.** No `<details>`, no evidence
  dump, no repro scripts, no essays.
- The template is a CEILING, not a checklist to fill maximally. Every line you
  add must earn its place. If the verdict + root cause + fix already answer it,
  you're done — resist adding more.
- Add a `<details>` block ONLY when the bug is genuinely contested or complex and
  someone would actually open it. **At most ONE** collapsible (Evidence), and
  keep it short. Never a second/third collapsible.
- NEVER invent extra sections the template doesn't have — no "answers to their N
  disposition questions", no multiple repro scripts, no "severity, honestly"
  side-essays. If they want that, they'll ask.
- Rough budget: trivial/low-severity ⇒ 4–6 lines total, no collapsible.
  Confirmed real bug ⇒ the short block + at most one tight Evidence block.

Hard rules:
- Both surfaces render `<details>`/`<summary>` — but see Proportionality: use it
  rarely, not by default.
- The always-visible part stays under ~8 lines. Terse, plain, no preamble.
- **No wide markdown tables** — use short `key — value` lines instead.
- Status emojis carry the verdict so it's scannable at a glance.

Fill this template — but drop any line the finding doesn't need (see
Proportionality); do NOT pad it back to full length:

```
**<🔴 Bug | 🟢 Not a bug / works as designed | 🟡 Bug — needs one fact to confirm>** <(severity: low/med/high) if a bug> · <one-line what-it-is> · **<✅ Fixed on develop & the customer's line | ⚠️ Fixed on develop, NOT on v15/v16 | ❌ Not fixed anywhere | ❔ fix status unknown>**

**Root cause** — <≤2 sentences, plain English, no file paths here>. <Confirmed by repro | Traced only — unconfirmed>.

**Fix** — pick one:
  • ✅ Merged: <PR link>. <Already on the customer's line | Needs backport to v15/v16>.
  • 🔧 No fix yet — I can open one: press **Create PR** here, or **Continue in Alter** for a full agent run. The fix: <one line>.
  • ❔ Can't tell until <the one fact you need>.

**Reproduced** — <✅ version-15 on repro.localhost → "<result line>" | ❌ not run — <what's needed, or "no bench reachable">>.

**Related** — <PR/issue links · discuss.frappe.io threads · sibling tickets — or "none found (searched: <terms>)">.

**Ask the customer** (paste-ready) — <1–3 crisp questions, or "none — verdict is conclusive">.

<!-- OPTIONAL, and only for a genuinely complex/contested bug — omit entirely for
     simple or low-severity findings: -->
<details><summary>Evidence — refs &amp; version triage</summary>

<per-version findings as short lines, e.g. `upstream/develop @ e2e1006be4 — guard present, file.py:240`; the customer-ref check; what you ruled out and why. Keep it tight. Include the repro script/output here too if you actually ran one — do NOT add a separate collapsible for it.>

</details>
```

### Say the SAME thing every run — don't contradict the other surface

The extension triage agent and the desktop/Alter agent look at the same code but
have different powers (read-only sandbox vs. full bench). They must never *sound*
like they disagree. Anchor the verdict to facts that don't drift between runs:

- **Version triage is deterministic** — it comes from `across-versions.sh` /
  `git show` on fixed upstream refs. State "fixed on develop, absent on v15/v16"
  the same way every time. Never re-reason it into a different answer.
- **Reproduced ≠ the verdict.** Whether *this* run could execute a bench does not
  change whether it's a bug or whether a PR is needed — only your *confidence*.

**If you are the read-only triage agent (the extension):** you STILL reproduce —
run `repro.sh` (the one allowed bench command, shown above) on the local benches,
just like the full agent. Fill the same template:
- **Reproduced** reports what the helper actually printed: `✅ version-15 on
  repro.localhost → "REPRODUCED"`, or `❌ NOT REPRODUCED`, or — only if that
  version's bench isn't configured — `⚠️ not run (no version-15 bench set)`. Run
  it before you conclude; don't default to "can't reproduce" just because you're
  the extension. That old assumption was wrong — the bench is reachable here.
- **Fix** names the exact next action. If a fix/PR is warranted: `🔧 Fix needed
  (<one line>). Press **Create PR**, or **Continue in Alter** for a full run`. If
  already merged: link the PR + whether a backport is needed. Do NOT say "I
  created a PR" — you can't open PRs from the read-only run; the Create-PR button
  or Alter does that.
- Never invent a different root cause than the trace/repro supports.

The handoff already carries this whole diagnosis as context, so the Alter/PR run
CONTINUES it (reproduce → confirm → fix → PR); it does not re-triage from scratch.

## Anti-patterns (caught in the wild)

- ❌ "Job Applicant is a custom app not in this checkout" when `apps/hrms` exists.
- ❌ WebFetching a file from GitHub when the customer's commit is already local
  (`git show <ref>:path`).
- ❌ Presenting a code-trace as a confirmed root cause without reproducing.
- ❌ Guessing which of several plausible bugs fired instead of asking for the one
  fact that disambiguates.
