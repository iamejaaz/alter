---
name: frappe-support-diagnosis
description: Diagnose a Frappe/ERPNext/HRMS support ticket like a senior maintainer — read the ticket via frappectl, find the code across ALL installed apps, triage which versions are affected (develop → v16 → v15), reproduce on a bench where it decides the verdict, and check gh for an existing fix. Use whenever triaging a support.frappe.io helpdesk ticket or any "is this a bug, where, and is it fixed" question about Frappe apps.
---

# Frappe support diagnosis

Diagnose a ticket the way a senior maintainer would: reach the *right* verdict
with the *least* work, and say it plainly. Not every ticket is a bug; not every
bug needs a repro; not every answer needs a wall of evidence. Judge, don't grind.

## Ground rules (judgment)

- **Decide "is it even a bug?" first — default to NOT a bug.** Most tickets are
  expected behavior, a misunderstanding, a config/permission issue, or a
  customisation the customer must script themselves. It's a framework bug only if
  the code does something it clearly *shouldn't*. If the real answer is "change
  this setting / write this script / these two things are separate by design /
  it's documented behavior", that guidance **is** the answer — deliver it plainly,
  don't inflate it into a defect. A correct "works as designed" beats a wrong bug
  report every time.
- **Reproducing shows what the code *does*, not that it's *wrong*.** A green repro
  never upgrades expected behavior into a bug — the bug call is a separate judgment
  about intent. So reproduce (step 5) only when it actually settles bug-vs-not or
  which-version. Skip it for config/expected-behavior verdicts, and don't verify
  every side-claim the customer made just to be thorough. Answer what was asked.
- **Match the effort and the output to the finding.** A one-line answer for a
  one-line ticket. Depth is earned by a real, contested bug — not spent by default.
- **Never assume — check.** Before saying "that's a custom app / that commit isn't
  here / that doctype doesn't exist", prove it (`ls apps/`, `git cat-file -t`).
  Don't invent a missing fact; if a fact you need (version, exact steps, the
  DocType, the error, a flag) is absent and you can't derive it, ask precisely.
- **Git is READ-ONLY here.** Inspect with `git -C apps/<app> show <ref>:path` /
  `log` / `diff` / `cat-file`. Never checkout/commit/reset/push or change the tree.
  (Branching/PRs happen only in a Create-PR run or a handoff.)
- **PII.** Tickets carry real names/emails/resumes — never paste them into a public
  issue/PR; refer to the ticket by number.

## Method

**Work fast — every step is a slow model round-trip, so do the FEWEST.** Aim to
finish in a handful of tool calls, not dozens. Budget:
1. Read the ticket + establish facts (steps 1–2). **Then classify: bug, or
   customisation / functional-query / config / user-error?**
2. If it's **not a clear framework bug**, STOP now — give the answer (the setting,
   the script, why it's intended). No code hunt, no version triage, no repro, no
   gh. Most tickets end here.
3. Only for a genuine framework bug: locate the code (step 3), triage versions
   (step 4), and — only if it changes the verdict — reproduce **once** (step 5) and
   check gh **once** (step 6).

Hard caps: **one** repro attempt (never a second "variant"), **one** gh search
pass, and never re-verify the customer's side-claims for thoroughness. If a repro
needs heavy fixtures (creating DocTypes/Workflows) or you can't settle it in one
go, trace it and say "unconfirmed" rather than grinding. Batch shell work into few
calls. Stop the moment the verdict is decided.

### 1. Read the ticket
`fr doc get "HD Ticket" <id> --json`. Run **bare** `fr` — the environment provides
site + credentials (FRAPPE_SITE/API_KEY/API_SECRET); do NOT pass `-s <profile>` (it
hits the macOS keychain and prompts). Fall back to `-s support.frappe.io` only if
bare `fr` says no site/creds. Pull siblings/related with `fr query`/`fr doc list`
when the report is thin.

### 2. Establish the facts
Frappe version + installed apps (often in a version field on the ticket), the
DocType/feature, the exact steps, and the exact error. Missing and blocking? Ask.

### 3. Locate the code — across ALL installed apps
```sh
ls apps/                         # frappe erpnext hrms payments …
scripts/find-code.sh "<term>"    # grep the term across every app
```
Only call something "a custom app not in this checkout" after `ls apps/` proves it.

### 4. Version triage — develop → v16 → v15
```sh
scripts/across-versions.sh <repo-relative-path>
```
It fetches **narrowly** (`--no-tags`, the 3 branches only — a plain `git fetch
upstream` drags in thousands of tags) and skips the fetch if run in the last 10
min. Compare the **`upstream/*`** refs, never local branches or a fork's `origin`
(they can be years stale — the #1 cause of a verdict flip-flopping). Report per
version: broken on develop → **new fix** needed; fixed on develop but broken on the
customer's line → **backport** (find the fixing commit/PR via `git log -S<symbol>`
and gh).

### 5. Reproduce — only when it settles the verdict
A trace is a hypothesis; for a *real* bug, a repro is proof. Write a script that
ASSERTS the buggy outcome and rolls back (no residue). The console auto-connects
the site, so use `frappe.*` directly. Run it via the helper — **the read-only
extension agent may run this too** (its one allowed bench command); pipe the script
on **stdin** with `-`, no Write tool needed:
```sh
~/.claude/skills/frappe-support-diagnosis/scripts/repro.sh develop - <<'PY'
import frappe
reproduced = False
# … build the trigger, set reproduced = <the buggy outcome actually happened> …
print("REPRODUCED" if reproduced else "NOT REPRODUCED")
frappe.db.rollback()
PY
```
Do **develop first** (reproduces there → new fix; not there but on v15/v16 →
backport). If the helper says "no bench for '<ver>'", that bench isn't configured —
say so and fall back to the trace; never claim a repro you didn't run. Config-
specific bugs: reproduce the config on a fresh site — never restore a PII-laden
production backup. If you've already concluded "not a bug", skip this step.

### 6. Check gh for an existing fix
```sh
gh search issues --repo frappe/frappe "<symptom>" --state all --limit 20
gh search prs    --repo frappe/frappe "<symptom>" --state all --limit 20
```
Also try the fixing symbol/function name; repeat for `frappe/hrms`/`frappe/erpnext`
when the code lives there.

## Output — scannable, proportionate

The reader grades **"is it a bug, and is it fixed?"** in one glance. **Match length
to the finding** — the short block is usually the whole answer:
- Simple / low-severity / works-as-designed → 4–6 lines, no `<details>`, no extras.
- A real, contested bug → the short block + at most **one** short Evidence block.
- The template is a CEILING, not a checklist — drop any line the finding doesn't
  need; never pad it back to full length. Never invent extra sections (no "answers
  to their N questions", no second collapsible, no side-essays). Plain, terse, no
  preamble. No wide markdown tables (use `key — value` lines). Emojis carry the
  verdict.

```
**<🔴 Bug (severity: low/med/high) | 🟢 Not a bug / works as designed | 🟡 Bug — needs one fact>** · <one-line what-it-is> · **<✅ Fixed everywhere | ⚠️ Fixed on develop, NOT on v15/v16 | ❌ Not fixed anywhere | ❔ unknown>**

**Root cause / answer** — <≤2 sentences, plain English>. <Confirmed by repro | Traced only | Works as designed>.

**Fix / next step** — one of:
  • ✅ Merged: <PR link>. <On the customer's line | Needs backport to v15/v16>.
  • 🔧 No fix yet — press **Create PR** (prepares a branch you review), or **Continue in Alter**. The fix: <one line>.
  • 🛠️ Not a bug — the real answer: <the setting/script/why it's intended>.
  • ❔ Can't tell until <the one fact you need>.

**Reproduced** — <✅ version-15 → "REPRODUCED" | ❌ not run — <why> | n/a — not a bug>.

**Related** — <PR/issue/discuss links · sibling tickets — or "none found (searched: <terms>)">.

**Ask the customer** — <1–3 crisp questions, or "none — conclusive">.

<!-- ONLY for a genuinely contested/complex bug; omit for simple/expected verdicts -->
<details><summary>Evidence — refs &amp; version triage</summary>

<per-version refs as short lines (`upstream/develop @ <sha> — <finding>, file.py:NN`); the customer-ref check; what you ruled out; the repro output if you ran one. Keep it tight.>

</details>
```

**Consistency across surfaces.** The read-only extension agent and the full Alter
agent must not sound like they disagree. Anchor the verdict to things that don't
drift: the version triage comes from the script's `upstream/*` refs (state it the
same way every run), and whether *this* run could reproduce changes only your
*confidence*, never the bug-vs-not verdict. The read-only agent still reproduces
(via repro.sh) and fills the same template; it just can't push — so its **Fix**
line names the button (**Create PR** / **Continue in Alter**), never "I opened a
PR". A handoff carries the whole diagnosis, so the next run continues it rather
than re-triaging.

## Anti-patterns

- ❌ Calling expected/by-design behavior a "bug" because you reproduced the
  mechanism. Reproducing ≠ proving a defect.
- ❌ Reproducing, or verifying every customer side-claim, when the verdict is
  "works as designed".
- ❌ "That's a custom app / that commit isn't here" without running `ls apps/` /
  `git cat-file`.
- ❌ Comparing local/`origin` branches instead of fresh `upstream/*`.
- ❌ A wall of evidence for a one-line answer.
