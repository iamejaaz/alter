// Frappe Helpdesk support agent. On a ticket page (support.frappe.io/helpdesk/
// tickets/<id>) it adds Summarize / Diagnose / Draft reply, each driving the
// read-only Claude Code agent (fr to read the ticket, grep frappe code at the
// customer's version, gh for known issues) with its steps streamed live.
// Wrapped in an IIFE so its top-level declarations don't collide with the other
// content scripts sharing this page's isolated world.
(() => {
const SUPPORT_SYSTEM = [
  "You are Ejaaz's Frappe support engineer, triaging a ticket on support.frappe.io.",
  "You have READ tools that run WITHOUT asking: `fr` read subcommands (query, doc get/list, doctype, report, method search/list/show, file download, auth whoami) to read tickets/docs/SQL, Read/Grep/Glob over the local frappe checkout, git to inspect any version, and gh + WebFetch for frappe/frappe issues/PRs. You may ALSO run the skill's repro.sh helper to reproduce a bug on the local disposable benches — it's allowed here and does NOT touch live data (it runs on a throwaway repro site and rolls back).",
  "Run BARE `fr` commands (e.g. `fr doc get \"HD Ticket\" <id> --json`) — the environment provides the site + credentials (FRAPPE_SITE/API_KEY/API_SECRET), so no `-s` is needed. Do NOT pass `-s <profile>`: that selects a macOS keychain profile and triggers a password prompt. Only if a bare fr command errors that no site/credentials are configured, fall back to `-s support.frappe.io`.",
  "You may NOT change data yourself. Any mutating command is blocked and will fail — do not retry it or ask to 'approve a prompt' (there is none). If a fix needs a data change, propose it: write a one-line plain explanation, then a fenced ```alter-write code block containing ONLY JSON of the shape {\"verb\":\"update|submit|cancel|delete\",\"doctype\":\"HD Ticket\",\"name\":\"<id>\",\"sets\":[{\"field\":\"status\",\"value\":\"Closed\"}]} — include `sets` only for update, one entry per field. One block per change. Only propose a write you can justify from the ticket + code; never guess one.",
  "Always read the WHOLE thread first, not just `description`: `fr doc get \"HD Ticket\" <id>` for the ticket, then `fr query \"select creation, sender, content from \\`tabCommunication\\` where reference_doctype='HD Ticket' and reference_name='<id>' order by creation\"` for the email replies, plus HD Ticket Comment for internal notes. The real requirement is usually in the customer's LATEST replies, not the opening description — reading only the description is the #1 cause of a wrong answer. State the actual ask in one line before diagnosing. Identify the customer's Frappe version.",
  "Try to trace what the customer reports IN THE CODE at the customer's version (e.g. `git show <ref>:path`) — is the reported behavior actually reproducible from the code path? State which ref you checked. Never trust the working branch as the customer's reality, and never invent behavior.",
  "If the ticket is ambiguous, missing key facts (version, exact steps, error text, doctype), or you cannot trace it to a concrete code path, DO NOT guess a diagnosis. Instead say plainly: what you understood, what you verified, and exactly what extra info you need from the customer to go further (as specific questions).",
  "Follow the user's standing preferences for voice. Be terse. If a command is denied, fall back to Read/Grep/WebFetch.",
].join(" ");

// Triage runs on Sonnet by default — plenty for reading a ticket + checking
// code, and a fraction of Opus's usage against your 5-hour session limit.
const SUPPORT_MODEL = "sonnet";

// Shared helpers + reply voice live in shared.js (window.ALTER) — loaded first.
const { escapeHtml, humanizeErr, mini, REPLY_VOICE, followupParams, nearBottom, stickBottom, pinToBottom } = window.ALTER;

const VERBS = {
  summarize: (id) =>
    `Read the WHOLE thread of HD Ticket ${id} (description + all Communications/replies + comments, not just the description), then summarize: the CURRENT ask in one line (from their latest replies, not the opening description), customer + product/version, urgency, and what they've already tried. Terse.`,
  diagnose: (id) =>
    `Diagnose HD Ticket ${id} in FAST MODE (frappe-support-diagnosis skill). HARD CAP ~30s, a few tool calls: read the WHOLE thread (fr — description + all replies/comments; the real ask is in their LATEST reply), then answer from your own Frappe knowledge. At most ONE quick grep to jog memory — do NOT trace code through files, do NOT reproduce/version-triage/search gh. Those, and any code-level verification, are the "Confirm on bench" step, NOT fast mode.
State the actual ask in one line, then commit to a confident, plain verdict (don't hedge, don't ask the customer to run experiments you could):
- Most tickets are NOT a bug. Bar for 🔴 Bug is HIGH — a real malfunction (crash / data loss / wrong result / broken contract). "Frappe doesn't do X automatically" = customisation, not a bug → say "Frappe doesn't do X by design; to get X, custom code on <the event> (a Server Script, or an app hook)".
- Config issue → name the setting/state.
- Real malfunction → 🔴 Bug, name it, Reproduced = "not run — press Confirm on bench".
If you're not fully sure of the internal mechanism, still give your best confident read and add "press Confirm on bench to verify in code" — do NOT go trace it yourself now.
VISIBLE answer = SIMPLE English for a non-technical teammate — actually EXPLAIN it (what the customer does → what they see → the plain reason why), an everyday analogy if it helps; NO file paths / line numbers / function names (code detail goes only in a collapsible Evidence drawer). SHORT.`,
  draft: (id) =>
    `Draft a reply to the customer for HD Ticket ${id}. Read the WHOLE thread first (description + all replies/comments) so you answer their CURRENT ask, not the stale opening description; verify facts against the code/gh — but the reply must be simple and human. ${REPLY_VOICE}`,
};

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
const SEP = String.fromCharCode(1); // wraps ▸ step markers in the agent stream

function ticketId() {
  const m = location.pathname.match(/\/helpdesk\/tickets\/(\d+)/);
  return m ? m[1] : null;
}

// Odd segments are step markers, even segments are answer text.
function renderStream(full) {
  return full
    .split(SEP)
    .map((p, i) => (i % 2 ? `<div class="sup-step">${escapeHtml(p)}</div>` : p ? mini(p) : ""))
    .join("");
}
function cleanText(full) {
  return full
    .split(SEP)
    .filter((_, i) => i % 2 === 0)
    .join("")
    .trim();
}

let supSession = null;

async function runVerb(verb) {
  const id = ticketId();
  if (!id) return;
  const { models, claudeModel } = await chrome.storage.local.get(["models", "claudeModel"]);
  const connectionId = models && models.support;
  openPanel(verb);
  if (!connectionId)
    return setBody('<span class="sup-err">Pick a model for support in the Alter popup (use Claude Code — it needs tools).</span>');

  // Triage (summarize/diagnose/draft/follow-ups) runs on the FAST model — it's a
  // read task and a heavy model there is pure latency (7-8 min vs ~1-2). The
  // user's chosen model (claudeModel, e.g. opus) is reserved for writing the fix
  // in Create-PR, where reasoning actually matters.
  supSession = {
    id,
    connectionId,
    model: SUPPORT_MODEL,
    fixModel: claudeModel != null ? claudeModel : SUPPORT_MODEL,
    transcript: [],
  };
  const block = appendBlock("assistant");
  const raw = await streamAgent(block, {
    connectionId,
    agent: true,
    includeMemory: true,
    model: supSession.model,
    system: SUPPORT_SYSTEM,
    prompt: VERBS[verb](id),
    label: VERB_LABELS[verb] || verb,
  });
  supSession.last = raw;
  // Seed the transcript with this result so follow-ups carry the diagnosis as
  // context — otherwise each follow-up is a fresh run that can't see what it said.
  if (raw) supSession.transcript.push({ q: VERB_LABELS[verb] || verb, a: raw });
  if (verb === "diagnose") {
    // If the fast read calls it a likely BUG (🔴/🟡), auto-verify it on a bench so
    // a bug-call is never shown unconfirmed — the fast read can be confidently
    // wrong on a subtle mechanism. Not-a-bug verdicts (🟢) stay fast; the button
    // is still there to deepen manually if wanted.
    const likelyBug = raw && /🔴|🟡/.test(raw);
    supSession.canDeepen = !likelyBug;
    renderFooter();
    if (likelyBug) {
      toast("Looks like a bug — verifying on a bench before calling it…");
      await runDeepDiagnose();
    }
  } else {
    renderFooter();
  }
}

// The opt-in heavy pass: full version triage + reproduction + gh, continuing from
// the fast diagnosis. This is where the slow work happens — only when asked.
async function runDeepDiagnose() {
  if (!supSession) return;
  appendBlock("user").textContent = "Confirm on bench";
  const t = supSession.transcript.map((x) => `\n\nUser: ${x.q}\nYou: ${x.a}`).join("");
  const block = appendBlock("assistant");
  const a = await streamAgent(block, {
    connectionId: supSession.connectionId,
    agent: true,
    includeMemory: true,
    model: supSession.model,
    system: SUPPORT_SYSTEM,
    prompt: `HD Ticket ${supSession.id}.${t}\n\nNow VERIFY this in code + on a bench — this is where the deep work goes. TRACE the mechanism to the decisive line (don't stop at "same code path" — follow it to where behavior actually diverges, e.g. a guard that skips a path), then version-triage (across-versions.sh) and reproduce (repro.sh, develop first) if it's a bug, and check gh once. Update the verdict with what the code/repro actually shows — correct the fast read if it was wrong. Continue from above; don't re-triage from scratch. Keep the visible answer plain (code detail in the Evidence drawer). Proportionate.\nYou:`,
    label: "Confirm on bench",
  });
  supSession.transcript.push({ q: "Confirm on bench", a });
}

const VERB_LABELS = {
  summarize: "Summarize HD Ticket",
  diagnose: "Diagnose HD Ticket",
  draft: "Draft a reply for HD Ticket",
};

const PR_SYSTEM = [
  "You are Ejaaz preparing a fix on a LOCAL branch from a diagnosis. Work in the local frappe checkout (current dir / apps/frappe). You have Edit/Write + git, but NO push and NO `gh pr create` — you STOP after committing, so Ejaaz reviews before anything leaves the machine.",
  "IMPLEMENT THE FIX EXACTLY AS EJAAZ ASKED IT in the conversation above — if he specified an approach (e.g. 'gate it behind developer mode', 'just this one line'), do THAT, not your own bigger idea. Make the SMALLEST change that fixes the reported issue. Do NOT refactor, move/rename files wholesale, or expand scope. If his intended approach is unclear or the fix is genuinely large/risky, STOP and ask instead of guessing.",
  "Steps: 1) `git fetch` the base; 2) create a fresh branch off the right base (usually `develop`) with a descriptive name; 3) apply the fix with Edit/Write; 4) `git add` ONLY the files you changed and `git commit` with a conventional, type-prefixed message (fix:/feat:/…) — no AI/Claude attribution, no Co-Authored-By.",
  "If the working tree has unrelated uncommitted changes, branch and stage ONLY your own files — never commit unrelated work.",
  "Then STOP. Do NOT push, do NOT open a PR. End with: the branch name, `git diff --stat` of what you changed, and a one-line summary — then say 'Review it; hit \"Push & open PR\" when you're happy.' Keep the whole final message short.",
].join(" ");

const PR_PUSH_SYSTEM = [
  "You are Ejaaz pushing an ALREADY-PREPARED fix branch (it's checked out with a commit on it) and opening the PR. You have git push + `gh pr create` only.",
  "Steps: 1) confirm the current branch + `git log -1` is the intended fix (NOT develop/main — if it is, STOP); 2) push it to Ejaaz's fork: `git push https://github.com/iamejaaz/frappe.git HEAD:<branch>`; 3) open the PR against frappe/frappe: `gh pr create --repo frappe/frappe --head iamejaaz:<branch> --base <base> --title \"<type: …>\" --body \"<short body>\"`.",
  "PR style: short type-prefixed title, terse body, no fluff, no security details, no AI attribution. Reference the ticket by number, never customer PII. Note any needed backport (v15/v16) in the body.",
  "End your final message with the PR URL on its own line.",
].join(" ");

async function runPr() {
  if (!supSession) return;
  const q = "Prepare the fix for the issue diagnosed above, on a local branch, then stop for review.";
  appendBlock("user").textContent = "Prepare fix";
  const t = supSession.transcript.map((x) => `\n\nUser: ${x.q}\nYou: ${x.a}`).join("");
  const block = appendBlock("assistant");
  const a = await streamAgent(block, {
    connectionId: supSession.connectionId,
    agent: true,
    includeMemory: true,
    model: supSession.fixModel,
    mode: "pr",
    system: PR_SYSTEM,
    prompt: `HD Ticket ${supSession.id}. Your diagnosis and the fix Ejaaz wants:${t}\n\n${q}\nYou:`,
    label: "Prepare fix",
  });
  supSession.transcript.push({ q: "Prepare fix", a });
  supSession.fixPrepared = true;
  renderFooter();
}

async function runPrPush() {
  if (!supSession) return;
  appendBlock("user").textContent = "Push & open PR";
  const t = supSession.transcript.map((x) => `\n\nUser: ${x.q}\nYou: ${x.a}`).join("");
  const block = appendBlock("assistant");
  const a = await streamAgent(block, {
    connectionId: supSession.connectionId,
    agent: true,
    includeMemory: true,
    model: supSession.fixModel,
    mode: "pr-push",
    system: PR_PUSH_SYSTEM,
    prompt: `HD Ticket ${supSession.id}. Push the prepared fix branch and open the PR.${t}\n\nYou:`,
    label: "Push & open PR",
  });
  supSession.transcript.push({ q: "Push & open PR", a });
}

function toast(text, isErr) {
  const body = document.querySelector("#sup-body");
  if (!body) return;
  const b = document.createElement("div");
  b.className = isErr ? "sup-banner" : "sup-step sup-step-say";
  b.textContent = text;
  body.appendChild(b);
  body.scrollTop = body.scrollHeight;
}

// Mirrors the panel's fast→deep→review flow: first decide is-it-even-a-bug (high
// bar — malfunction only, not "doesn't auto-do X"); confirm on a bench only if
// it's a real bug; and if a fix is warranted, PREPARE it on a local branch and
// STOP for review — do NOT push or open a PR autonomously.
const HANDOFF_TASK = (id) =>
  `Use the frappe-support-diagnosis skill. HD Ticket ${id} on support.frappe.io. FIRST decide if it's even a bug — the bar is HIGH (a real malfunction: crash / data loss / wrong result / broken contract), NOT "the framework doesn't do X automatically" (that's a customisation). If it's not a bug, give the real answer and stop. Only for a real bug: read it (bare fr), find the code across all apps, triage versions, reproduce on a bench. If a fix is warranted, implement it on a fresh local branch off develop and COMMIT — then STOP and show the diff for review. Do NOT push and do NOT open a PR without me confirming. Follow my standing preferences (~/.claude/CLAUDE.md).`;

// Carry the diagnosis already done in the panel into the handoff, so the target
// app CONTINUES from it instead of re-running the whole triage cold.
function handoffTask(id) {
  const t = (supSession && supSession.transcript.length)
    ? supSession.transcript.map((x) => `\n\n### ${x.q}\n${x.a}`).join("")
    : "";
  if (!t) return HANDOFF_TASK(id);
  return `HD Ticket ${id} on support.frappe.io — I already triaged this in the support panel. Diagnosis so far:${t}\n\n---\nContinue from this — do NOT re-triage from scratch. First sanity-check the verdict: is it really a bug (high bar — a real malfunction, NOT "doesn't auto-do X" which is a customisation)? If it's not a bug, say so and give the real answer. If it IS a bug and still unconfirmed, do the smallest confirmation next (git show at the customer's ref, reproduce on a bench if reachable). If a fix is warranted: implement it on a fresh local branch off develop and COMMIT, then STOP and show the diff — do NOT push or open a PR without me confirming. Follow my standing preferences (~/.claude/CLAUDE.md).`;
}

// Full, interactive `fr assistant` in a Terminal — all sites, read+write, but it
// PROMPTS before writes, so you stay in the loop.
async function openInAssistant() {
  const id = ticketId();
  if (!id) return;
  toast("Opening fr assistant in Terminal…");
  const r = await send({ type: "assistant", task: handoffTask(id) + " You have full git + gh access — confirm before any write." });
  if (!r || !r.ok) toast((r && r.error) || "Couldn't launch fr assistant.", true);
}

// Full agentic Alter chat (autonomous — Alter runs bypassPermissions). We seed
// the composer; you hit Enter in Alter to start it.
async function openInAlter() {
  const id = ticketId();
  if (!id) return;
  const { models, claudeModel } = await chrome.storage.local.get(["models", "claudeModel"]);
  toast("Opening a chat in Alter — hit Enter there to run it.");
  const r = await send({
    type: "open-chat",
    prompt: handoffTask(id),
    title: `HD Ticket ${id}`,
    connectionId: models && models.support,
    model: claudeModel,
  });
  if (!r || !r.ok) toast((r && r.error) || "Couldn't open Alter — is the app running?", true);
}

async function followUp(q) {
  if (!supSession || !q.trim()) return;
  appendBlock("user").textContent = q;
  const t = supSession.transcript.map((x) => `\n\nUser: ${x.q}\nYou: ${x.a}`).join("");
  const block = appendBlock("assistant");
  // Follow-ups are a normal CHAT about an already-diagnosed ticket — not a fresh
  // review each time (shared voice logic in window.ALTER).
  const { wantsReply, system, label } = followupParams(q, "The work here is a support-ticket diagnosis; you may use bare `fr` / Read / git / gh to check a fact.");
  const prompt = wantsReply
    ? `We are discussing HD Ticket ${supSession.id}.${t}\n\nUser: ${q}\n(Write the message itself — simple, human, in my voice. Output ONLY the message text.)\nYou:`
    : `We are discussing HD Ticket ${supSession.id}.${t}\n\nUser: ${q}\nYou:`;
  const a = await streamAgent(block, {
    connectionId: supSession.connectionId,
    agent: true,
    includeMemory: true,
    model: supSession.model,
    system,
    prompt,
    label,
  });
  supSession.transcript.push({ q, a });
}

let activeRun = null; // { runId, stop } while an agent run is in flight

// A run's runId is persisted per ticket so a page-tab reload can RECONNECT to
// the still-running bridge job (it lives server-side) instead of orphaning it.
const RUN_STORE = "sup_active_runs";
async function saveActiveRun(rec) {
  try {
    const s = await chrome.storage.local.get(RUN_STORE);
    const runs = s[RUN_STORE] || {};
    runs[rec.id] = rec;
    await chrome.storage.local.set({ [RUN_STORE]: runs });
  } catch (_) {}
}
async function clearActiveRun(id) {
  try {
    const s = await chrome.storage.local.get(RUN_STORE);
    const runs = s[RUN_STORE] || {};
    if (runs[id]) {
      delete runs[id];
      await chrome.storage.local.set({ [RUN_STORE]: runs });
    }
  } catch (_) {}
}
async function getActiveRun(id) {
  try {
    const s = await chrome.storage.local.get(RUN_STORE);
    return (s[RUN_STORE] || {})[id] || null;
  } catch (_) {
    return null;
  }
}

// Drive a bridge run's live feed by polling (~1.2s) — MV3 service workers buffer
// a streamed fetch, so polling is how we get Claude-Code-style activity without a
// timeout. Works for a fresh run (opts.start fires agent-start first) and for
// reconnecting to an already-running one after reload (no start).
function pollRun(el, runId, opts) {
  opts = opts || {};
  const ticket = ticketId();
  return new Promise((resolve) => {
    const t0 = Date.now();
    el.innerHTML =
      '<div class="sup-steps"></div><div class="sup-working"><span class="sup-spin"></span><span class="sup-elapsed">Working… 0s</span></div>';
    const supBody = document.getElementById("sup-body");
    if (supBody) supBody.scrollTop = supBody.scrollHeight;
    const stepsEl = el.querySelector(".sup-steps");
    const workEl = el.querySelector(".sup-working");
    const elapsedEl = el.querySelector(".sup-elapsed");
    let done = false;
    let poll = null;
    let shown = 0;

    const cleanup = () => {
      clearInterval(tick);
      clearInterval(poll);
      activeRun = null;
      showStop(false);
      if (ticket) clearActiveRun(ticket);
    };
    const tick = setInterval(() => {
      if (!done) elapsedEl.textContent = `Working… ${Math.round((Date.now() - t0) / 1000)}s`;
    }, 1000);

    const renderSteps = (steps) => {
      if (steps.length <= shown) return;
      // Only follow the stream to the bottom if the user is already there — if
      // they scrolled up to read, don't yank them back down on each new step.
      pinToBottom(document.getElementById("sup-body"), () => {
        for (let i = shown; i < steps.length; i++) {
          const d = document.createElement("div");
          d.className = "sup-step" + (steps[i].indexOf("▸ ") === 0 ? " sup-step-tool" : " sup-step-say");
          d.textContent = steps[i];
          stepsEl.appendChild(d);
        }
        shown = steps.length;
      });
    };

    activeRun = {
      runId,
      stop: () => {
        if (done) return;
        done = true;
        cleanup();
        send({ type: "cancel", runId });
        workEl.textContent = "Stopped.";
        resolve("");
      },
    };
    showStop(true);

    const fail = (msg) => {
      if (done) return;
      done = true;
      cleanup();
      workEl.remove();
      const b = document.createElement("div");
      b.className = "sup-banner";
      b.textContent = humanizeErr(msg);
      el.appendChild(b);
      resolve("");
    };

    const doPoll = async () => {
      if (done) return;
      const r = await send({ type: "agent-poll", runId });
      if (!r || !r.ok || !r.data) return; // transient — keep polling
      const p = r.data;
      renderSteps(p.steps || []);
      if (p.done) {
        done = true;
        cleanup();
        if (p.error) return fail(p.error);
        workEl.remove();
        const body = document.getElementById("sup-body");
        const wasAtBottom = nearBottom(body);
        const ans = document.createElement("div");
        ans.className = "sup-answer";
        renderAnswer(ans, p.text || "");
        el.appendChild(ans);
        // Only reposition if the user was following along at the bottom — if they
        // scrolled up to read, leave them where they are.
        if (wasAtBottom && body) {
          // Long answer (a full diagnosis): jump to its start so it reads top-down.
          // Short answer (a follow-up/reply): keep it in view at the bottom.
          if (ans.getBoundingClientRect().height > body.clientHeight) ans.scrollIntoView({ block: "start", behavior: "smooth" });
          else stickBottom(body);
        }
        resolve(p.text || "");
      }
    };

    const begin = () => {
      poll = setInterval(doPoll, 1200);
      doPoll();
    };
    if (opts.start) {
      opts.start(runId).then((r) => {
        if (done) return;
        if (!r || !r.ok) return fail(r && r.error);
        begin();
      });
    } else {
      begin();
    }
  });
}

function streamAgent(el, params) {
  const runId =
    (self.crypto && crypto.randomUUID && crypto.randomUUID()) || "r" + Date.now() + Math.random();
  const id = ticketId();
  if (id)
    saveActiveRun({
      id,
      runId,
      connectionId: params.connectionId,
      model: params.model,
      mode: params.mode || null,
      label: params.label || "Run",
    });
  return pollRun(el, runId, {
    start: (rid) =>
      send({
        type: "agent-start",
        connectionId: params.connectionId,
        includeMemory: params.includeMemory,
        system: params.system,
        prompt: params.prompt,
        model: params.model,
        mode: params.mode,
        runId: rid,
      }),
  });
}

// After a page-tab reload the panel is gone but the run keeps going on the
// bridge — re-attach to it and resume the live feed (or show its result).
const reconnected = new Set();
async function reconnectIfActive() {
  const id = ticketId();
  if (!id || reconnected.has(id) || document.getElementById("sup-panel")) return;
  reconnected.add(id);
  const rec = await getActiveRun(id);
  if (!rec) return;
  const r = await send({ type: "agent-poll", runId: rec.runId });
  if (!r || !r.ok || !r.data || (r.data.done && r.data.error === "run not found")) {
    clearActiveRun(id);
    return;
  }
  const verb = /diagn/i.test(rec.label) ? "diagnose" : /draft/i.test(rec.label) ? "draft" : "summarize";
  openPanel(verb);
  supSession = { id, connectionId: rec.connectionId, model: rec.model, fixModel: rec.model, transcript: [] };
  const note = document.createElement("div");
  note.className = "sup-step sup-step-say";
  note.textContent = "Reconnected to a run in progress…";
  document.querySelector("#sup-body").appendChild(note);
  const block = appendBlock("assistant");
  const a = await pollRun(block, rec.runId, {});
  supSession.last = a;
  if (a) supSession.transcript.push({ q: rec.label || "Run", a });
  renderFooter();
}

// Render the answer, pulling any ```alter-write blocks out into Approve & run
// cards so a proposed change executes on one human click.
function renderAnswer(el, content) {
  const writes = [];
  const stripped = content.replace(/```alter-write\s*([\s\S]*?)```/g, (_, json) => {
    try {
      const w = JSON.parse(json.trim());
      if (w && w.verb && w.doctype && w.name) writes.push(w);
    } catch (_) {}
    return "";
  });
  el.innerHTML = mini(stripped.trim());
  writes.forEach((w) => el.appendChild(buildWriteCard(w)));
}

function writeSummary(w) {
  const target = `${w.doctype} ${w.name}`;
  if (w.verb === "update") {
    const sets = (w.sets || []).map((s) => `${s.field} → ${s.value}`).join(", ");
    return `Update ${target}: ${sets}`;
  }
  return `${w.verb[0].toUpperCase() + w.verb.slice(1)} ${target}`;
}

function buildWriteCard(w) {
  const card = document.createElement("div");
  card.className = "sup-write";
  const desc = document.createElement("div");
  desc.className = "sup-write-desc";
  desc.textContent = writeSummary(w);
  const btn = document.createElement("button");
  btn.className = "sup-write-run";
  btn.textContent = "Approve & run";
  const note = document.createElement("div");
  note.className = "sup-write-note";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Running…";
    const r = await send({ type: "fr-write", write: w });
    if (r && r.ok) {
      btn.remove();
      note.className = "sup-write-note ok";
      note.textContent = "✓ Done" + (r.output ? " — " + r.output : "");
    } else {
      btn.disabled = false;
      btn.textContent = "Approve & run";
      note.className = "sup-write-note err";
      note.textContent = (r && r.error) || "Failed to run.";
    }
  });
  card.append(desc, btn, note);
  return card;
}

function showStop(on) {
  const b = document.getElementById("sup-stop");
  if (b) b.style.display = on ? "" : "none";
}

function ensureButtons() {
  if (!ticketId()) {
    const ex = document.getElementById("sup-actions");
    if (ex) ex.remove();
    return;
  }
  if (document.getElementById("sup-actions")) return;
  const wrap = document.createElement("div");
  wrap.id = "sup-actions";
  [
    ["Summarize", "summarize"],
    ["Diagnose", "diagnose"],
    ["Draft reply", "draft"],
  ].forEach(([label, verb]) => {
    const b = document.createElement("button");
    b.className = "sup-btn";
    b.textContent = label;
    b.addEventListener("click", () => runVerb(verb));
    wrap.appendChild(b);
  });
  document.body.appendChild(wrap);
}

function openPanel(verb) {
  let el = document.getElementById("sup-panel");
  if (!el) {
    el = document.createElement("div");
    el.id = "sup-panel";
    el.innerHTML = `
      <div id="sup-head">
        <span id="sup-title"></span>
        <div>
          <button id="sup-stop" title="Stop the agent" style="display:none">Stop</button>
          <button id="sup-copy" title="Copy">Copy</button>
          <button id="sup-min" title="Minimize">–</button>
          <button id="sup-close" title="Close">×</button>
        </div>
      </div>
      <div id="sup-body"></div>
      <div id="sup-foot"></div>`;
    document.body.appendChild(el);
    el.querySelector("#sup-min").addEventListener("click", () => {
      const min = el.classList.toggle("sup-collapsed");
      el.querySelector("#sup-min").textContent = min ? "▢" : "–";
      el.querySelector("#sup-min").title = min ? "Expand" : "Minimize";
    });
    el.querySelector("#sup-stop").addEventListener("click", () => {
      if (activeRun) activeRun.stop();
    });
    el.querySelector("#sup-close").addEventListener("click", () => {
      if (activeRun) activeRun.stop();
      el.remove();
      supSession = null;
    });
    el.querySelector("#sup-copy").addEventListener("click", () => {
      const copy = el.querySelector("#sup-copy");
      navigator.clipboard.writeText(supSession && supSession.last ? supSession.last : "");
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    });
  }
  const titles = { summarize: "Ticket summary", diagnose: "Diagnosis", draft: "Draft reply" };
  el.querySelector("#sup-title").textContent = "Alter — " + (titles[verb] || "Support");
  el.querySelector("#sup-body").innerHTML = "";
  el.querySelector("#sup-foot").innerHTML = "";
}

function setBody(html) {
  document.querySelector("#sup-body").innerHTML = html;
}
function appendBlock(cls) {
  const b = document.createElement("div");
  b.className = "sup-msg sup-" + cls;
  document.querySelector("#sup-body").appendChild(b);
  return b;
}

function renderFooter() {
  const foot = document.querySelector("#sup-foot");
  foot.innerHTML = `
    <div id="sup-foot-actions">
      <div class="sup-menu-wrap">
        <button id="sup-continue">Continue in… ▾</button>
        <div id="sup-menu" class="sup-menu" hidden>
          <button data-act="alter">Alter chat<span>autonomous, in-app</span></button>
          <button data-act="assistant">fr assistant<span>Terminal, supervised</span></button>
          <button data-act="pr">Prepare fix<span>local branch, you review</span></button>
        </div>
      </div>
      ${supSession && supSession.canDeepen ? '<button id="sup-deepen">🔬 Confirm on bench</button>' : ""}
      ${supSession && supSession.fixPrepared ? '<button id="sup-pr-push">Push &amp; open PR</button>' : ""}
    </div>
    <div id="sup-foot-ask"><input id="sup-ask" placeholder="Ask a follow-up…" /><button id="sup-ask-send">Send</button></div>`;
  const menu = foot.querySelector("#sup-menu");
  foot.querySelector("#sup-continue").addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  menu.querySelectorAll("button[data-act]").forEach((b) =>
    b.addEventListener("click", () => {
      menu.hidden = true;
      const act = b.dataset.act;
      if (act === "alter") openInAlter();
      else if (act === "assistant") openInAssistant();
      else if (act === "pr") runPr();
    })
  );
  const deepBtn = foot.querySelector("#sup-deepen");
  if (deepBtn) deepBtn.addEventListener("click", () => { supSession.canDeepen = false; renderFooter(); runDeepDiagnose(); });
  const pushBtn = foot.querySelector("#sup-pr-push");
  if (pushBtn) pushBtn.addEventListener("click", () => runPrPush());
  const input = foot.querySelector("#sup-ask");
  const go = () => {
    const q = input.value.trim();
    if (!q) return;
    input.value = "";
    followUp(q);
  };
  foot.querySelector("#sup-ask-send").addEventListener("click", go);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
}

// Close the Continue menu on any outside click.
document.addEventListener("click", (e) => {
  const menu = document.getElementById("sup-menu");
  if (menu && !menu.hidden && !e.target.closest(".sup-menu-wrap")) menu.hidden = true;
});

setInterval(() => {
  ensureButtons();
  reconnectIfActive();
}, 1500);
ensureButtons();
reconnectIfActive();
console.log("[Alter] support agent ready");
})();
