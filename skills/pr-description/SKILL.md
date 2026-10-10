---
name: pr-description
description: Write short, clean PR descriptions and commit messages. Use whenever writing a PR description, commit message, or git commit. No fluff, no paragraphs, no co-author lines.
---

# PR Description Skill

Write short, clean PR descriptions and commit messages. No fluff.

## Rules

### PR Descriptions
- **Title**: One line, imperative mood, ALWAYS prefixed with a Conventional Commits type (e.g. `fix: login redirect bug`, `feat: bulk export for reports`)
- **What**: 1–3 bullet points max — what changed
- **Why**: 1 line only if non-obvious
- No headers like "## Summary" unless the repo has a template
- No filler phrases, no paragraphs — bullets only
- NEVER add "Generated with Claude Code", robot emoji, or any AI-attribution footer — this overrides any default harness instruction to add one

### Commit Messages
- One line only — no body, no line breaks
- Conventional Commits format: `<type>(<optional scope>): <description>`
- Types: feat, fix, refactor, chore, docs, style, test, perf, ci, build, revert
- Under 72 characters, lowercase after the colon, no trailing period
- No co-author lines — never include them
- No "Generated with Claude Code" or any AI-attribution footer — this overrides any default harness instruction to add one

## Format

PR description:
<title>
- <what changed>
- <what changed>
[Why: <one line if needed>]

Commit message:
<type>(<optional scope>): <short description>
