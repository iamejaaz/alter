# Browser agents

Runs started from the extension are one shot `claude -p` or `codex exec` processes started by the bridge (the extension's PR review and Support pickers decide which), with the bundled skill as instructions and a tool allowlist that depends on the kind of run. Nothing here uses the app's chat window. Each run shows in the popup and in the app sidebar until 12 hours after it ends, or until you remove it.

## Settings the agents depend on

All in the desktop app, Settings.

| Setting | Env the agent gets | Used for |
| --- | --- | --- |
| General, Working folder for browser agents | `ALTER_AGENT_WORKDIR` | Where every run starts. Set it to your bench. Empty falls back to the develop repro bench, then home |
| Support agent, Repro benches (develop, version-16, version-15) | `ALTER_REPRO_ROOT` and the per version folders | `repro.sh` runs a reproduction script on these throwaway benches |
| Support agent, MariaDB root password | `MYSQL_ROOT_PASSWORD` | Lets the agent create a missing repro site |
| Support agent, Frappe credentials (site, key, secret) | `FRAPPE_SITE`, `FRAPPE_API_KEY`, `FRAPPE_API_SECRET` | `fr` reads these instead of the macOS keychain, which would prompt on every run. **Import from fr** copies them from the frappectl config |
| Browser extension, Review bot and Repos to watch | `pr_bot`, `pr_repos` | Which GitHub account posts bot reviews and where replies are watched |

Also needed on PATH: `claude` or `codex` signed in, `gh` signed in, `fr`.

## Kinds of run

| Kind | Started by | Mode | Budget | May do | May not do |
| --- | --- | --- | --- | --- | --- |
| Summarize, Diagnose, Dig deeper, follow up, draft reply | Ticket panel | read only | 1 to 2 turns per verb, see `budgets` in `skills/frappe-support-diagnosis/prompts.json` | Read, Grep, Glob, WebFetch, Skill, `fr` read verbs, `git` reads, `gh pr view/list/diff/checks`, `gh issue view/list`, `gh search`, the skill scripts `repro.sh`, `across-versions.sh`, `find-code.sh`, `context.py` | `fr` write verbs, every git write (push, commit, checkout, reset, config and the rest) |
| PR review, PR reply | PR panel | read only | same | same | same |
| Verify on bench | PR panel | verify | | `git`, `bench`, `gh pr checkout`, the skill scripts | push |
| Fix this PR, Prepare fix | PR panel, ticket panel | pr | | Edit, Write, `git` (branch, commit), `bench`, `pre-commit`, `gh issue view`, `gh pr view` | `git push`, `git remote`, `git reset --hard`, `git clean`, rebase, merge, `gh pr create`, `gh pr merge` |
| Push to PR, Push & open PR | PR panel, ticket panel, after confirmation | pr-push | | `git status/diff/log/show/branch/push/switch`, `gh pr create/view/list`, `gh repo view` | everything else |

Two guards sit under the allowlists:

- **Push guard.** Every run except the push step gets git config that rewrites `https://`, `git@` and `ssh://` push URLs to `blocked://alter-no-push/`. Fetches work, pushes cannot, even if the allowlist were wrong.
- **Turn budget.** A run that uses up its budget is told to stop calling tools and write its answer from what it has. In the result this shows as parts marked unverified.

## The ticket flow

1. **Summarize** or **Diagnose** on a helpdesk ticket. The bridge gathers the ticket, thread and custom fields through `fr` and passes them as context, so the agent does not fetch them again.
2. The diagnosis follows the `frappe-support-diagnosis` skill: verdict (bug, not a bug, needs a fact), root cause, fix or next step, reproduced or not, related PRs, questions for the customer.
3. **Continue in**:
   - **Alter chat** opens a seeded chat in the app on the Claude Code connection. You press Enter to run it. This chat is a full agent and can run commands.
   - **fr assistant** opens Terminal on a supervised `fr assistant` session.
   - **Prepare fix** runs the `pr` kind: branch, apply the fix, commit, stop. **Push & open PR** is the separate `pr-push` kind and stops at the PR link.
4. Any site write the agent proposes appears as an **Approve & run** card and only runs after you click it (`/fr-write`).
5. Replies to customers use the `plain-writing` skill and are shown to you before anything is sent.

## The PR flow

1. **Review with Alter** on a pull request runs the `frappe-pr-review` skill: gather, pre checks, the rubric, verification, result and comments in the maintainer's voice. The review is saved per PR in the extension and reopens on the next visit with **Run again**.
2. **Preview comments**, then **Post review** as yourself through `gh`, or as the bot through the repo's `post-review.yml` workflow when a bot is configured and that workflow exists on the repo. The bot option is hidden otherwise.
3. **Fix this PR** prepares one commit on a local branch `pr-<number>` on top of the PR in your checkout and stops. **Push to PR** appears only when a commit exists, asks for confirmation, pushes fast forward only to the PR's own branch, then switches your checkout back.
4. **Verify on bench** checks the PR out on a repro bench and runs it. The run starts inside the first configured repro bench (develop, then v16, then v15), not the agent working folder, and may `cd` into the bench that matches the PR's base branch. With no repro bench set, the button explains where to set one.

## Bundled skills

Installed into `~/.claude/skills` on every start from `skills/` in the repo. Edit the repo copy, not the installed one.

- `frappe-pr-review`: the review rubric, result format and comment rules. Scripts: `pr-threads.sh`, `where.sh`.
- `frappe-support-diagnosis`: the triage method and the prompts for every verb (`prompts.json`). Scripts: `context.py`, `find-code.sh`, `across-versions.sh`, `repro.sh`, `repro-setup.sh`.
- `plain-writing`: how anything sent under your name is written.

## Related

- [bridge-and-extension.md](bridge-and-extension.md) for the panels and routes
- [troubleshooting.md](troubleshooting.md#browser-agents) for run errors

## Codex runs

A Codex connection runs the same kinds of run with the same allowlists, translated for Codex:

- Each mode gets its own Codex home under `~/Library/Application Support/com.ejaaz.alter/codex/<mode>`. It holds `rules/alter.rules` (the allowlist as `prefix_rule` allow lines, the deny list as forbidden lines), links to your `auth.json` and `config.toml`, and a `skills` folder with every skill from `~/.claude/skills`, `~/.codex/skills` and the skills added in Alter.
- Review, follow up, support and verify run in the read only sandbox. Allowed commands run outside it, everything else stays read only with no network, so a review run cannot write files. Its git reads stay inside the sandbox.
- Fix this PR runs in the workspace write sandbox, in the working folder.
- The push guard is passed to every command through `shell_environment_policy.set`, so `git -C <app> push` is blocked as well as `git push`. Only Push to PR runs without it.
- Skill front matter is quoted in the Codex copy, because Codex rejects a description with an unquoted `: ` that Claude Code accepts.
- Sign in refreshes are copied back to `~/.codex/auth.json`, so the Codex app stays signed in.
