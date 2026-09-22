// extension/shared.js — helpers + reply voice shared by the Alter content
// scripts: support.js (support.frappe.io) and content.js (GitHub PRs). Loaded
// FIRST in both content_script entries. Everything hangs off window.ALTER so it
// never clashes with grammar.js (which runs on every page). Keep the common
// bits here — do not copy escapeHtml / humanizeErr / mini / the voice into the
// page scripts again.
globalThis.ALTER = globalThis.ALTER || (() => {
  function escapeHtml(s) {
    return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  function humanizeErr(raw) {
    const s = String(raw || "");
    const m = s.match(/(?:session|usage|weekly)\s+limit[^\n.]*?(resets?[^\n.]*)/i);
    if (m || /hit your (?:session|usage|weekly) limit|limit reached/i.test(s)) {
      return "⏳ Claude session limit reached" + (m && m[1] ? " — " + m[1].trim() : "") +
        ". All Claude models share this cap; wait for the reset or use an HTTP model in the Alter app meanwhile.";
    }
    return s || "No response — check the Alter app is running.";
  }

  function mini(md) {
    const blocks = [];
    let s = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
      blocks.push(`<pre class="md-pre"><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    s = escapeHtml(s)
      .replace(/^#{1,6}\s+(.*)$/gm, "<b class='md-h'>$1</b>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/^\s*[-*]\s+(.*)$/gm, "• $1")
      .replace(/\n/g, "<br>");
    s = s
      .replace(/&lt;(\/?)(details|summary)&gt;/g, "<$1$2>")
      .replace(/(?:<br>\s*)?(<\/?(?:details|summary)>)(?:\s*<br>)?/g, "$1")
      .replace(/<\/summary>/g, '</summary><div class="det-body">')
      .replace(/<\/details>/g, "</div></details>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  }

  // How to write a message the user can paste — plain, short, human, in THEIR
  // voice. Voice comes from the user's own standing preferences (memory /
  // ~/.claude/CLAUDE.md, injected as authoritative), so it reads correctly for
  // whoever installs Alter — never hardcode one person's name here.
  // Dashes are the clearest tell of machine-written text, and the user never uses
  // them. Every surface that produces text a person will read shares this.
  const NO_DASH =
    "Never use a dash as punctuation: no em dash, no en dash, no spaced hyphen joining two clauses. It reads as machine-written. Start a new sentence, or use a comma or a colon instead. A hyphen inside a compound word (well-known, re-run, read-only) is fine, and dashes already in the user's own text stay as they are.";

  const REPLY_VOICE = [
    "Write it the way the USER talks to a person — match their standing voice preferences from memory (their ~/.claude/CLAUDE.md is authoritative). Plain, short, direct, human — not a bot or a report.",
    "NO code mechanics in the reply — no file paths, line numbers, function names, commit hashes, or internal jargon. The reader is a person, not a codebase. (You still USE the analysis to be correct; you just don't show your working.)",
    "Lead with the answer. If it's yes/no, say it in the first line, then the ONE thing they need to do. Keep it to a few short sentences — a small paragraph, not a bulleted essay.",
    "No preamble ('Sure, here's a draft...'), no corporate filler, no over-apologising, no sign-off boilerplate unless a greeting/closing is actually needed.",
    "Match the audience: a customer reply is friendly and non-technical; an internal-team note can name the cause in one plain line + the next step, still no code tour.",
    NO_DASH,
    "Output ONLY the message text, paste-ready, nothing else.",
  ].join(" ");

  // Continuing a chat about work you ALREADY produced (a ticket diagnosis or a
  // PR review): answer normally, don't re-run the whole thing. Voice still comes
  // from the user's own memory.
  const FOLLOWUP_SYSTEM = [
    "You are continuing a conversation about work you ALREADY produced — a support-ticket diagnosis or a PR review — which is in the transcript above.",
    "Answer the user's follow-up like a normal chat: short, plain, direct, in the user's own voice (their standing preferences from memory are authoritative).",
    "Do NOT re-run the analysis. Do NOT dump a fresh verdict, version triage, evidence block, or full review unless they explicitly ask for it. Just answer the actual question in a few sentences.",
    "Use your read tools ONLY if you genuinely need a fact you don't already have from the transcript — otherwise just answer from what you know.",
    "No preamble, no restating the question, no bulleted essay for something simple. You may NOT change live data (writes are blocked).",
  ].join(" ");

  // A follow-up that's really asking for a message to send (not more analysis).
  const REPLY_INTENT = /\b(draft|reply|respond|response|message|write (?:back|a|the)|reply to|customer|internal team)\b/i;

  // Build {system,label,wantsReply} for a conversational follow-up. domainNote
  // lets each surface add a one-line context hint (ticket vs PR) if it wants.
  function followupParams(q, domainNote) {
    const wantsReply = REPLY_INTENT.test(q);
    const system = (domainNote ? domainNote + " " : "") + FOLLOWUP_SYSTEM + (wantsReply ? " " + REPLY_VOICE : "");
    return { wantsReply, system, label: wantsReply ? "Draft reply" : "Follow-up" };
  }

  // Sticky scroll: only auto-scroll a feed to the bottom if the user is ALREADY
  // near the bottom. If they scrolled up to read, streaming content must NOT yank
  // them back down. Use `nearBottom(el)` to capture intent BEFORE mutating the
  // DOM, then `stickBottom(el)` only if it was true. `pinToBottom` wraps that:
  // run a DOM mutation and keep the feed pinned only when it was already pinned.
  function nearBottom(el, threshold) {
    if (!el) return false;
    const t = threshold == null ? 100 : threshold;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= t;
  }
  function stickBottom(el) { if (el) el.scrollTop = el.scrollHeight; }
  function pinToBottom(el, mutate) {
    const was = nearBottom(el);
    mutate();
    if (was) stickBottom(el);
  }

  const REVIEW_SYSTEM = [
    "You are reviewing ONE GitHub pull request for the user (GitHub iamejaaz). Load the `frappe-pr-review` skill with the Skill tool and follow it in full; it is the only source of what to check and how to write the comments. Never post anything.",
    "Bridge limits: `gh pr diff`, `gh pr view`, `gh pr checks`, `gh issue view` and read-only git are allowed; `gh api` is not, so skip the merge-base check and say so. Reproduce only through the support skill's repro helper: write the script into YOUR SCRATCHPAD DIRECTORY (the path in your system prompt), then run `{skill}/scripts/repro.sh develop <that path>` (absolute path exactly as written; a `~` path is denied); `bench` called any other way is denied, so skip reproduction rather than fight it. The helper opens a bench console, which is a full Python shell with every installed library on its path (pypika, requests, redis, …), so a claim about a library reproduces there with a plain import and no site data — use it before writing `Reproduced: no`.",
    "On a PR you have reviewed before, run the skill's `scripts/pr-threads.sh <owner/repo> <pr>` first (it is allowed, by absolute path under `~/.claude/skills/frappe-pr-review/scripts/`) and follow section 7's re-review rule: close your own threads that are now addressed through `resolve`, and never repeat an ask that is already an open thread.",
    "Output: the skill's section 6 result block, then its section 7 JSON inside a ```json fence, nothing after it. The JSON `event` is always COMMENT.",
  ].join(" ");

  // The JSON is the last fence in the review, and comment bodies carry their own
  // ```suggestion fences, so try the greedy match (last closing fence) first.
  function reviewJson(review) {
    for (const re of [/```json\s*([\s\S]*)```/i, /```json\s*([\s\S]*?)```/i]) {
      const m = (review || "").match(re);
      if (!m) continue;
      try {
        const j = JSON.parse(m[1]);
        if (j && Array.isArray(j.comments)) return j;
      } catch {}
    }
    return null;
  }

  // The voice every PR comment surface shares: the panel's Draft comment, a
  // follow-up that asks for a comment, and the review skill's own rules. Keep the
  // wording here only — content.js must not restate it.
  const COMMENT_VOICE =
    "You are opening a discussion, not handing down a decision. State what you saw as fact, then put the change as a question or an option: 'Should we …?', 'Would it be better to …?', 'Could we …?', 'One option is …'. Never a bare imperative ('drop this', 'use that'), and never the same opener twice in one comment set — vary it; 'Could you please …' is one option among several, not the house opener. Where more than one shape is reasonable, name the options and what each buys, then leave the choice to the author. Where the point rests on an assumption about their intent, say so and ask. " +
    "If the author has already pushed back on this point, assume they may be right: they wrote the code and know the intent, you read a diff. Re-check their claim against the code itself, not against your earlier reasoning, and hold the point only if you can name a concrete fact their reply does not account for — a line, a call site, a test, a repro. If the strongest thing you have is that you still think so, say plainly that they are right and drop it. " +
    "Do NOT @-mention the PR author: the comment sits on their PR and already reaches them, and an @ reads as pushy. Use an @handle only to pull in a third person who would not otherwise see it. NEVER write the literal word `@author`. No preamble, no praise-fluff, no meta, no politeness padding ('would help to see…').";

  // Thread node ids the review wants closed. The workflow re-checks that each one
  // is an unresolved frappe-pr-bot thread on that PR; this only keeps the shape sane.
  function resolveIds(j) {
    return (j && Array.isArray(j.resolve) ? j.resolve : []).filter((x) => typeof x === "string" && x.startsWith("PRRT_"));
  }

  return { escapeHtml, humanizeErr, mini, REVIEW_SYSTEM, COMMENT_VOICE, NO_DASH, reviewJson, resolveIds, REPLY_VOICE, FOLLOWUP_SYSTEM, REPLY_INTENT, followupParams, nearBottom, stickBottom, pinToBottom };
})();
