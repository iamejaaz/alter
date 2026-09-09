---
name: frappe-support-diagnosis
description: Diagnose a Frappe/ERPNext/HRMS support ticket like a senior maintainer — read the ticket via frappectl, find the code across ALL installed apps, triage which versions are affected (develop → v16 → v15), reproduce on a bench where it decides the verdict, and check gh for an existing fix. Use whenever triaging a support.frappe.io helpdesk ticket or any "is this a bug, where, and is it fixed" question about Frappe apps.
---

# Frappe support diagnosis

Diagnose a ticket the way a senior maintainer would: reach the *right* verdict
with the *least* work, and say it plainly. Not every ticket is a bug; not every
bug needs a repro; not every answer needs a wall of evidence. Judge, don't grind.

## Ground rules (judgment)

- **BE DECISIVE — you resolve it, you don't punt it back.** You have the source and
  a bench; when the verdict hinges on "does X actually happen", DETERMINE it —
  trace to the decisive line or reproduce it — then commit to a flat verdict. Do
  NOT hedge into "🟡 can't confirm, ask the customer whether direct-cancel also
  breaks" when a 30-second repro or one more line of trace would settle it. Only
  ask the customer for facts **only they have** (their exact config, their script,
  their version if no field carries it) — never for an experiment you can run.
  Land on ONE of these, said plainly:
  - **The functionality doesn't exist** → say it directly: "Frappe does not do X.
    It's not a bug; to get X, do <the customisation>." (customisation / by design)
  - **The feature exists and is broken** → confirm it: **🔴 Bug**, with the malfunction named.
  - **It's their configuration** → name the exact setting/state that's wrong and the fix.
- **Be decisive about the FRAMEWORK; never assume the customer's SETUP.** You can
  verify what Frappe does (source + bench) — state that flatly. You CANNOT see the
  customer's config: their Server Script, their Workflow's states, their settings.
  Don't assert "your script is mis-scoped" or "your workflow has no Cancelled
  state" as fact, and don't invent setup they never mentioned (only say "you have a
  Before Cancel script" if the thread says so). Frame anything about their setup as
  the thing to check: "if X is set / isn't set, that explains it — can you confirm?"
  Keep the two apart: framework = decided; their config = asked.
- **Don't assert framework INTERNALS from memory — verify, or flag it unverified.**
  Your recall of Frappe's internals is often subtly wrong (e.g. "submit/cancel
  auto-sync the workflow field" is true for submit but NOT cancel — cancel skips
  the whole validation path). So NEVER state a specific internal ("Frappe has a
  built-in X that does Y", "the cascade runs the same hooks") as fact unless you
  actually checked the source. In a fast read where you haven't checked, give your
  best guess AND mark it unverified: "I believe … — press Confirm on bench to
  verify the exact mechanism." A confidently-wrong mechanism is the worst outcome.
- **Never pin it on the customer's config on an UNVERIFIED framework premise.**
  "It must be your workflow/script config" is only valid once you've confirmed the
  framework does its part. If you haven't verified that, don't list their possible
  misconfigs as the diagnosis — say "likely their config OR a framework gap; I'll
  confirm which" (Confirm on bench), and only then blame config.
- **When you DO trace, trace to the DECISIVE line — don't stop at a plausible
  mid-point.** "It calls the same `.cancel()`, so the hooks are identical" is *not*
  an answer — follow the path to where behavior actually diverges (e.g. `_save` runs
  `if self._action != "cancel": self._validate()` — so on cancel the whole
  validate/workflow-sync path is SKIPPED). A verdict built on an unchecked
  assumption is worse than "unknown". BUT: a **fast first read** need not trace at
  all — answer from your Frappe knowledge + the thread, give a confident verdict,
  and leave the code-level trace/verification to the confirm-on-bench pass. Don't
  grind a multi-file trace when a quick knowledgeable answer will do.
- **The bar for 🔴 Bug is HIGH — clear it before you use the word.** A bug is the
  framework **malfunctioning**: it crashes, loses or corrupts data, returns a
  *wrong* result, or violates its own **documented/obvious contract**. That is a
  narrow set. Default to NOT a bug; most tickets are expected behavior, config, a
  misunderstanding, or a customisation the customer must script. If you can't name
  which of {crash / data loss / wrong result / broken contract} it is, it is **not
  a bug** — say what it actually is and give the real answer.
- **"The framework doesn't do X automatically" is NOT a bug — it's a customisation
  or at most an enhancement.** This is the trap that produces false bug reports.
  Ask yourself: *does my proposed fix ADD behavior* ("also sync Y on cancel", "make
  it auto-register Z", "have it update W too")? Then you're describing an
  enhancement the customer wants, not a defect — the framework isn't *wrong*, it
  just doesn't do the extra thing. Classify it **customisation** and describe the
  mechanism **generically**: "custom code that runs on <the event>" — do NOT assume
  they use, or already have, a **Server Script** (that's one specific Frappe
  feature/DocType; saying "your Server Script" implies everyone has one). Name the
  concrete options as *options* — "via a Server Script, or a `doc_events` hook in a
  custom app" — not as the default. You may add a one-line "could be a framework
  enhancement" note — but do NOT stamp it 🔴 Bug.
  A deliberate `if` that skips something (e.g. "skip validation on cancel") is a
  design decision, not an accidental gap — don't read intent as oversight.
  (Contrast a *real* bug: cancelling a file deletes the bytes but leaves the DB
  row → a dead link — that's data loss + a broken invariant, so it clears the bar.)
- **Reproducing shows what the code *does*, not that it's *wrong*.** A green repro
  never upgrades expected behavior into a bug — the bug call is a separate judgment
  about intent and the bar above. So reproduce (step 5) only when it settles
  bug-vs-not or which-version. Skip it for config/expected-behavior/enhancement
  verdicts, and don't verify every side-claim the customer made just to be
  thorough. Answer what was asked.
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
1. `scripts/context.py <id>` (step 1), then app/version and the cheap answers
   (step 2). **Then classify: setting / already fixed / platform / customisation /
   bug?**
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

`prompts.json` beside this file holds the surface prompts (system rules, the
summarize / diagnose / draft / deepen verbs, prepare-fix, push, handoff). The Alter
bridge renders them for the helpdesk panel and chat handoffs; edit them there, not
in any client.

### 1. Get the context in ONE call
```sh
scripts/context.py <id>          # ~2s: facts, installed apps + exact versions, the thread, bot output, similar tickets
```
It prints one bundle and replaces separate `fr` calls (the extension attaches the
same bundle to its prompt — when it is already in the prompt, do not run it again).
What it gives you and how to read it:
- **Ticket facts** — subject, queue (`custom_app`), type, module, site, plan, PR
  field, awaiting-release flag. The queue is where the ticket was filed, not proof
  of which app is at fault.
- **Site apps** — every installed app with branch, tag and commit, live from
  Frappe Cloud when reachable, else the snapshot taken when the ticket was created.
  This is your version source. Read code at exactly these refs.
- **Thread with a trust label** — `[customer]` messages are the facts; the ask is
  in their LATEST messages, and the thread beats the description. `[staff]`
  replies are claims to verify, not conclusions.
- **Bot output** — support bots, suggested drafts, cloud alerts. Hypotheses only.
  Never repeat one as fact; say explicitly whether you confirmed or refuted it.
- **Similar resolved tickets** — hints with the most useful staff reply. Cheap to
  read, never proof.
- **Gaps** — what the bundle could not get (no site, no apps, no version).

`fr` runs bare in the agent environment (site + credentials come from env). Pass
`--site <profile>` only outside it. **State the actual ask in one line before
diagnosing.**

### 2. Resolve app, version, and the cheap answers first
- **App**: the product the customer describes plus the apps table, not the queue.
  Helpdesk, CRM, Drive, LMS, Insights and Frappe Cloud tickets routinely sit in the
  ERPNext or Framework queue. An app missing from `apps/` is fetched at the
  customer's ref (`gh api`, or a shallow clone) — never declared "custom" unchecked.
- **Version**: the branch + commit from the table. Trace at that ref
  (`git -C apps/<app> show <commit>:<path>`), and name the ref you checked.
- Then, in this order, and say which one applied:
  1. **A setting governs it** — the app's Settings doctypes, System Settings, site
     config keys, hooks. Answer with the exact path to change it.
  2. **Already fixed after their commit** — `git log --oneline <commit>..origin/<branch> -- <path>`
     (or gh). Answer "fixed in <version>, update".
  3. **Platform, not code** — deploy, bench, server, backup, DNS, storage, billing.
     Say so and route it; no code hunt.
  4. Only then a real malfunction with a code path → continue to step 3.
- `custom_allow_database_access` = Yes lets you query the customer's site
  (`fr -s <site>`) for real config instead of guessing. `custom_is_security_issue`
  = checked → keep exploit details out of anything public.
- Never suggest a plan upgrade or warranty as an answer.

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
extension agent may run this too** (its one allowed bench command); write the script to a file under /tmp (Write is allowed there; a heredoc with Python braces trips the shell checker) and pass the path — it runs as one unit, so functions and try/except work:
```sh
# /tmp/repro.py
import frappe
reproduced = False
# … build the trigger, set reproduced = <the buggy outcome actually happened> …
print("REPRODUCED" if reproduced else "NOT REPRODUCED")
frappe.db.rollback()
```
```sh
~/.claude/skills/frappe-support-diagnosis/scripts/repro.sh develop /tmp/repro.py
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

## Output — plain-English for a mixed audience, code in the drawer

This is read by support folk who are **not all engineers**. The visible answer
must read like you're **explaining it out loud to a teammate** — plain, calm,
short. The person needs to know: what's going on, is it a bug, and what do we tell
the customer. That's it.

**The visible block carries NO code identifiers.** No file paths, no line numbers,
no function names, no `snake_case` symbols, no "pipeline/hook/validate()" jargon.
Say "cancelling the document doesn't touch the workflow field", not
"`set_workflow_state_on_action` isn't reached because `_validate` is skipped". ALL
of that — file:line, function names, the trace — goes **only** in the collapsible
Evidence drawer, for the one engineer who opens it. If a sentence in the visible
part names a code thing, move it to Evidence.

**Match length to the finding** — the visible block is usually the whole answer:
- Simple / not-a-bug / config → 3–5 short lines, no `<details>`.
- A real, contested bug → the short block + at most **one** Evidence drawer.
- The template is a CEILING — drop any line the finding doesn't need; never pad.
  No invented sections, no second collapsible, no side-essays. Terse, no preamble.
  No wide tables (use `key — value` lines). Emojis carry the verdict.

```
**<🔴 Bug (severity: low/med/high) | 🟢 Not a bug / works as designed | 🟡 Bug — needs one fact>** · <one-line what-it-is> · **<✅ Fixed everywhere | ⚠️ Fixed on develop, NOT on v15/v16 | ❌ Not fixed anywhere | ❔ unknown>**

**What's going on** — <explain it in SIMPLE English, like to a non-technical colleague: what the customer does → what they see → the plain reason why. Use an everyday analogy if it helps. 2-3 short sentences. NO code names/paths (those go in Evidence).> <Confirmed by repro | Traced | By design>.

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

- ❌ Diagnosing from the ticket `description` alone. The real ask is in the
  replies — read the whole Communication thread and answer their *latest* ask.
- ❌ Hedging ("🟡 can't confirm — ask the customer whether a direct cancel also
  breaks") when you could trace one more line or run a 30-second repro and KNOW.
  Ask the customer only for facts you can't see; resolve everything else yourself.
- ❌ Stopping a trace at "it's the same code path" — follow it to where behavior
  actually diverges before you commit to a verdict.
- ❌ Calling expected/by-design behavior a "bug" because you reproduced the
  mechanism. Reproducing ≠ proving a defect.
- ❌ Reproducing, or verifying every customer side-claim, when the verdict is
  "works as designed".
- ❌ "That's a custom app / that commit isn't here" without running `ls apps/` /
  `git cat-file`.
- ❌ Comparing local/`origin` branches instead of fresh `upstream/*`.
- ❌ A wall of evidence for a one-line answer.
