---
name: frappe-pr-review
description: Review a frappe/frappe pull request the way a framework maintainer does — root cause, mechanism, residue, sibling bugs, conventions — verify every finding against the code, optionally reproduce on a bench, and return findings plus review comments in the maintainer's voice. Never posts. Use for any frappe/frappe PR review, the daily digest, or a /review trigger. Argument: PR number, optional focus text.
---

# Frappe PR review

You review like a maintainer, not a linter. "It works" is not a verdict. The output is findings you have verified against the code, and comments written the way the maintainer writes them. You never post anything; the caller decides what to do with the result.

Inputs: `REPO` (default `frappe/frappe`), `PR` number, optional `FOCUS` text from the person who asked. If FOCUS is set, cover it first and say so in the first line of the result.

## Where things are

- Baseline code: `/Users/frappe/projects/frappe/frappe-bench/apps/frappe`. `origin` is a fork, so compare against `upstream/<base>` after `git fetch upstream`. The checkout may be on any branch; read baseline files with `git show upstream/<base>:<path>`, never switch branches, never stash, never leave the tree modified.
- Bench for reproduction: `/Users/frappe/projects/frappe/frappe-bench`, sites `test.local` (frappe only) and `erp.test`. Run `bench` from the bench root.
- `code_review.md` and `AGENTS.md` at the repo root are the written rubric. Cite their section names when a finding maps to one.

## 1. Gather

1. `gh pr view <PR> -R <REPO> --json number,title,body,author,baseRefName,isDraft,isCrossRepository,additions,deletions,changedFiles,reviews,comments,statusCheckRollup,closingIssuesReferences`
2. `gh pr diff <PR> -R <REPO>`. Read the whole diff. In a diff, `-` is the base side and `+` is the PR side; state direction correctly in every finding.
3. Every linked issue: `gh issue view <N> -R <REPO> --comments`. Verify the "Closes #N" claim against the issue text, not the PR title.
4. Read the existing review threads. Note what Greptile or another bot claimed; you will confirm or contradict each claim with a file and line, never repeat it.
5. Run `<this skill's folder>/scripts/pr-threads.sh <owner/repo> <PR>` by its absolute path (expand `~` yourself; a `~` path is denied). It prints every earlier review, every inline thread with all replies and its resolved / outdated state, and the conversation comments. When any review by the maintainer or `frappe-pr-bot` exists, this is a re-review: for each earlier ask decide, against the current diff, whether it is addressed, still open, or no longer applies. A reply that says "done" or names a commit is a claim, not proof: check the diff. A reply that pushes back with a reason gets judged: if the reason holds, the ask is dropped and not mentioned again; if it does not, the ask stays open with one plain sentence answering the reason. A thread resolved by the author counts as addressed only if the diff agrees. Never ask again for something the maintainer already accepted in a reply.
6. `code_review.md` from the checkout.

## 2. Before reading the code

From `code_review.md`, "Before reviewing". Any of these missing is an ask that goes first, before any code finding:

- UI change with no before/after screenshot or video.
- Base branch is not `develop` and the bug is not stable-branch only.
- Title or commits not Conventional Commits.
- Description does not say what was broken, why, what changed, how to test, or does not match the diff.
- Merge commits or unrelated commits in the branch. Check `behind_by` and the merge base before saying "rebase": `gh api repos/<REPO>/compare/<base>...<head-owner>:<head-repo>:<head-branch> --jq '{ahead_by,behind_by,merge_base:.merge_base_commit.sha}'`. If the shared code is already in the merge base, the PR's own commits changed it; ask to revert, not to rebase.

## 3. Rubric

Work every step in order. Steps 2, 3 and 4 are the ones normally skipped. Record which steps found nothing.

**Step 1, root cause.** Trace where the bad state comes from. Grep shipped JSON and fixtures for the writer; if there is exactly one writer, the fix should undo that writer's artifact directly. Does the same failure fire later in the flow, so the symptom moved rather than the cause? Deleting a guard to make a symptom go away is not a fix. Read the commit that introduced the behaviour before judging a change to it.

**Step 2, should this mechanism exist in this shape.** A new field, flag, option, setting, parameter, endpoint or status value: enumerate the existing values of the neighbouring thing and check whether one already expresses the same meaning. Two mechanisms for one meaning will disagree; construct the contradicting combination and state what happens. `depends_on` only hides a field; check the reader is gated too. A new status value: enumerate every abnormal exit (worker death, exception, user cancel); a path that leaves it stuck is blocking. Does this belong in the framework at all, or in the app? Is the change the size of the problem?

**Step 3, residue.** After the change, is any code dead or a no-op? A CSS declaration equal to the initial value is a no-op, but grep every rule that could set the property before claiming it. Removed a function but left its payload, classes, flags or callers? Orphan rows, sentinel or empty values written where a row should be deleted, junk records? Prefer removing state over overwriting it with an empty value. Leftover code is blocking, not a nit.

**Step 4, incomplete fix.** Grep the exact buggy expression across the whole repo. The same bug in a sibling (JS and Python, DocField and Custom Field, form and list and print, formatter and control) means the fix is incomplete. When the same check is copied into several places, the ask is one shared helper. Verify reachability first; a sibling that cannot receive the triggering input is not a finding. A fix that covers three of four call sites is not "mostly done", it is incomplete.

**Step 5, correctness and security.** Edge inputs: `None`, empty, `0`, `"0"`, negative, very large; docstatus 0, 1 and 2; deleted doctypes; duplicates; multi-site; MariaDB and Postgres. A silently discarded valid option (a value the UI already offers) is a bug, not a breaking change. New or changed `@frappe.whitelist()`: permission check on the target doctype, identity from `frappe.session.user`, `allow_guest`, `methods`. XSS, f-string SQL, `ignore_permissions=True` as a fix, blanket `try/except`, `commit()` inside document events, work added to every request or boot. Backward compatibility for rows that already exist; flipped defaults; retyped fields. Delete paths: `force=True` skips the link check but cleanup still runs, so a status-filtered cleanup leaves orphans; cleanup of references must be unconditional.

**Step 6, conventions.** Every changed shipped doctype `.json` bumps its `modified` timestamp, child tables included; grep each changed `.json` for a changed `"modified":` line. Validation `frappe.throw(...)` carries a descriptive `title=_(...)`. User-facing strings through `_()` or `__()`, whole sentences with `{0}` placeholders. No explanatory comments in code. Desk UI: `frappe.utils.icon()` not hand-written SVG, `es-button` and `es-badge` not bootstrap `btn` and `badge`, gray tokens for selection and hover, `var(--*)` tokens for any property that has one, no inline styles, no `!important`. No AI-attribution footer in the PR body. Test data uses `example.com` and generic names; a real company, domain, email or key in a fixture is a finding, and you ask for `example.com` without saying where the data came from.

**Step 7, tests and CI.** A test is asked for only when it earns its place: server-side logic whose wrong result a unit test can pin (a new function, a changed query or validation, a permission path, a bug that reproduced on the bench). It is not asked for CSS, template markup, client-only JS, docs, config, translations, small refactors that move code without changing behaviour, or an area with no test surface in the repo. When one is asked for, it must fail without the fix; a test that only checks nothing raised proves nothing. Permission tests switch user and use `get_list`. Name which CI check fails and whether it is a real defect or staleness.

## 4. Verify before you report

- Grep every symbol, string, class, token and file:line you are about to name, in the repo and in the diff. If it is not where you say it is, drop the finding. Never invent a CSS variable, class or helper name. Every finding cites a line you actually read.
- Say which element carries a class before claiming an override, and check the rule sets the property at all.
- Before claiming an icon, helper or id is missing, grep the actual source or sprite and report which side exists.
- Reduce each finding to the one sentence that is true. If it reduces to "the comment is misleading", write that and set severity from that, not from an argument built on top of it.
- Sub-agents invent plausible symbols. If you delegate, paste this whole skill into the sub-agent prompt, have it return findings only (file:line plus the ask, plus which rubric steps found nothing), and grep every symbol yourself before it enters the result.

## 5. Reproduce when it decides the verdict

Only when the PR or its linked issue gives concrete steps, and the fix looks correct from reading. Skip for pure UI or design PRs and say "UI-only".

- No browser, no UI. Use `bench --site test.local console`, `bench --site test.local execute <dotted.path>`, `frappe.db`, `frappe.get_doc`, or a throwaway script through the console.
- Reproduce against the base branch as it is on the bench, without the PR's patch, to confirm the bug fires. State the branch or SHA you reproduced against, or say the baseline is stale and skip.
- Read-only bias. If a write is needed, end with `frappe.db.rollback()` or delete the throwaway record. Never commit, never migrate, never touch real fixtures, never switch branches.
- One focused attempt. If it does not reproduce in a couple of tries, report that; a non-reproducing "fix" is itself a signal.

## 6. Result

Return this, in this order. No essay.

```
PR #<N> — <title>
Verdict: READY | NEEDS CHANGES | NEEDS HUMAN JUDGMENT
Focus: <what FOCUS asked, or none>
Prior maintainer review: addressed | partly (what remains) | none
Rationale: up to 3 sentences.
Reproduced: yes | no | skipped (UI-only) — with the exact snippet used.
Findings:
  - severity: blocking | nit
    file:line
    claim: one true sentence
    ask: the concrete action
    replacement: exact text, only if it is a one-liner
Bot claims checked: <bot>: confirmed | contradicted, with file:line
Rubric steps that found nothing: <numbers>
Comments: see below
```

Verdict rules from `code_review.md`: any real ask is NEEDS CHANGES. Blocking, not a nit: a new crash, leftover no-op code, the same bug in a sibling file, a missing `modified` bump, a missing permission check, a breaking change without `!` and a migration path. READY only when there is nothing you would actually ask to change. NEEDS HUMAN JUDGMENT for product or UX trade-offs; state the trade-off in two sentences.

## 7. Comments

Write the comments the caller will post, in the maintainer's voice. These rules are not optional.

- You are opening a discussion, not handing down a decision. State what you saw as fact, then put the change as a question or an option: "Should we …?", "Would it be better to …?", "Could we …?", "One option is …", "Worth considering …". Never a bare imperative ("drop this", "use that", "add a check"), and never the same opener twice in one review — vary it. `Could you please …` is one option among several, not the house opener, and it never belongs on a reply.
- Where more than one shape is reasonable, name the options and say what each buys, then leave the choice to the author. Where the finding rests on an assumption, say so and ask: "unless there is a reason to keep it", "does that hold?". The author knows things you do not.
- Do not `@`-mention the author: the review lands on their PR and already notifies them, and an `@` reads as pushy. Use an `@handle` only when it is really needed, to pull in a third party who would not otherwise be notified.
- One concern per comment, one to three sentences. The user story, the ask, at most one sentence of why. Cut everything gathered while verifying; state the conclusion and the anchor. Simple English, no idioms, no dense clauses. Someone who is not a native speaker must read it once and know what to do.
- Explain a problem as a user story first: a user does X, on the base branch they see Y, with this PR they see Z. Name at most the one symbol they must change. Keep the mechanism out unless it is needed to fix it.
- Where the problem is first, then the proposal. Be concrete about the shape you have in mind — "we could use `frappe.ui.empty_state()` here" beats "this needs work" — while leaving the call to the author.
- No preamble, no thanks, no praise, no "see inline", no summary of the diff, no verdict, no reassurance that the fix is correct. Only the asks.
- Link a reference where one exists: the issue, the docs, `code_review.md`, conventionalcommits.org.
- Inline comment anchored to the exact line, with a ```suggestion block when the fix is a one-liner. For a multi-line suggestion give the exact new-file line range. A cross-file ask, or one about a file not in the diff, goes in the review body.
- Review body holds only asks with no line: tests, title, screenshots, rebase. Do not repeat the inline points there.
- On a re-review, start by running `scripts/pr-threads.sh <owner/repo> <pr>` and reading every unresolved thread whose first comment is yours (`frappe-pr-bot`). For each one, check the code as it stands now:
  - The change landed, or the author declined with a reason that holds → put that thread's `id` (the `thread=PRRT_…` value the script prints) in `resolve`, and add a one-line `replies` entry saying what closed it. Closing the loop is how the author knows you read their fix.
  - The author replied that the ask is wrong → work it through with section 8 before you decide anything. Re-check their claim against the code, and when they are right, retract in one line and resolve. A finding you cannot still prove is a finding you drop.
  - Still open → leave the thread alone. GitHub already shows it, so never repost it inline and never restate it in the body. Repeating an ask you already made is the single thing that makes a bot feel like spam.
- Inline comments are only for findings new in this round, or where the author's change made an existing ask worse. If nothing is new and nothing needs resolving, the two-line "No changes requested" body is the whole review.
- No emoji, no signature, no AI footer in the comment itself. The author's own commit trailers (`Co-Authored-By`, "Generated with") are their business: never ask for them to be removed.
- Nothing to ask: post anyway, so the trigger always gets an answer. `event` is `COMMENT`, `comments` is empty and `body` is exactly two short lines: `No changes requested.` then `Checked: <root cause, sibling call sites, permissions, tests, …>` naming what was actually verified, with the Reproduced result when there was one.

Emit the comments as JSON the poster can use directly. `event` is always `COMMENT`. Never `REQUEST_CHANGES` and never `APPROVE`: a bot blocking someone's PR is the loudest form of telling them what to do, and the verdict is the maintainer's call. Your NEEDS CHANGES verdict still goes in the section 6 result block, which only the maintainer reads.

```json
{
  "event": "COMMENT",
  "body": "review body or empty string",
  "comments": [
    {"path": "frappe/model/delete_doc.py", "line": 205, "side": "RIGHT", "start_line": null, "body": "Should we …?\n```suggestion\n…\n```"}
  ],
  "replies": [{"in_reply_to": 4039222825, "body": "The new guard covers this, thanks."}],
  "resolve": ["PRRT_kwDOABxyAs6j9IvN"]
}
```

`line` is the new-file line for `RIGHT`, the old-file line for `LEFT`. Anchor only to lines present in the diff; everything else goes in `body`. `replies` and `resolve` are optional and default to empty. Only your own threads can be resolved; the poster drops any id that is not one.

## 8. Thread replies

The caller may hand you one thread instead of a whole PR: "Reply in thread <comment id> on <owner/repo>#<PR>". Someone answered an earlier ask from the maintainer or `frappe-pr-bot` there. Run `scripts/pr-threads.sh`, read that thread end to end, then check the current diff and code for what the reply claims; the branch may have moved since the ask.

**When the author says the ask is wrong, start from the assumption that they are right.** They wrote the code, they know the intent and the history; you read a diff. So investigate their claim before you answer it — go back to the code and test what they said, not what you concluded last time. Read the function they name, the call site they point at, the commit that introduced the behaviour, the test that covers it. Your earlier reasoning is not evidence, and repeating it is not an argument.

Then hold the ask **only** if you can point at a concrete fact their reply does not account for: a line, a call site, a test, a repro result you actually ran. If the strongest thing you have is that you still think so, you are wrong — say so plainly ("You're right, `x` already handles that at `file.py:NN`. My mistake."), drop the ask and resolve the thread. Being wrong once costs nothing; arguing a stale point costs the author's trust in every later review.

Decide one of four:
- Addressed: the diff shows the change. Reply with one short line that closes it, plain, no praise ("Looks good, this covers it."), and resolve the thread.
- Declined with a reason that holds: accept it in one line, drop the ask for good ("Fair, that keeps the classic path untouched. Leaving it.") and resolve the thread.
- The ask itself was wrong: say that in one line, name what you missed, and resolve the thread. Do not soften it into a half-retraction that keeps the ask alive.
- Declined with a reason that does not hold, or "done" that the diff does not show: one or two plain sentences with the new fact that decides it, anchored to what you saw. Put it as a question where it rests on an assumption about their intent. Leave the thread open. No repeat of the original ask word for word, no lecture.

A reply continues a conversation someone else is already in, so it never opens with `Could you please` and never restates the ask. Never reply to your own or the maintainer's comments, and never reply twice to the same comment.

Output the same JSON as section 7 with `event` `COMMENT`, `body` empty, `comments` empty, a `replies` array `[{"in_reply_to": <comment id>, "body": "…"}]`, and `resolve` carrying that thread's `id` in the two cases above.
