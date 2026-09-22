// Injected on GitHub PR pages. Adds a "Review with Alter" button that pulls the
// PR diff and runs it through the model you picked for PR review in the extension settings.
// IIFE-wrapped so its top-level names don't collide with sibling content scripts.
(() => {

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

// Shared helpers + reply voice live in shared.js (window.ALTER) — loaded first.
const { escapeHtml, humanizeErr, mini, REVIEW_SYSTEM, COMMENT_VOICE, reviewJson, followupParams, FOLLOWUP_SYSTEM, REPLY_INTENT, nearBottom, stickBottom, pinToBottom } = window.ALTER;

function prParts() {
  const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], num: m[3] } : null;
}

function issueParts() {
  const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], num: m[3] } : null;
}

const pageParts = () => prParts() || issueParts();

function prAuthor() {
  const el = document.querySelector("a.author");
  if (!el) return "";
  const href = el.getAttribute("href") || "";
  const m = href.match(/^\/([^/?#]+)$/);
  const login = m ? m[1] : el.textContent.trim();
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(login) ? login : "";
}

async function getChecks(parts) {
  const r = await send({ type: "gh-checks", repo: `${parts.owner}/${parts.repo}`, num: parts.num });
  return r && r.ok ? r.text || "" : "";
}

let session = null;
let running = false;

// Ignore re-clicks while a review is in flight: a second run() would clear the
// panel and detach the live block.
async function run() {
  if (running) return;
  running = true;
  const btn = document.querySelector("#alter-actions button");
  if (btn) btn.disabled = true;
  try {
    await runInner();
  } finally {
    running = false;
    if (btn && btn.isConnected) btn.disabled = false;
  }
}

async function runInner() {
  const parts = prParts();
  if (!parts) return;
  const { models, claudeModel } = await chrome.storage.local.get(["models", "claudeModel"]);
  const connectionId = models && models.prReview;
  openPanel();
  if (!connectionId) return setStatus("Pick a model for PR review in the Alter extension settings first.", true);

  setStatus("Reading CI…");
  const checks = await getChecks(parts).catch(() => "");
  const author = prAuthor();
  const authorBlock = author ? `PR author GitHub handle: @${author}\n\n` : "";
  const ciBlock = checks.trim() ? `CI checks:\n${checks.slice(0, 4000)}\n\n` : "";
  const prompt = `Review ${parts.owner}/${parts.repo}#${parts.num} with the frappe-pr-review skill.\n\n${authorBlock}${ciBlock}`;

  session = { parts, author, connectionId, model: claudeModel || undefined, review: "", draft: "", transcript: [] };
  clearBody();
  const block = appendBlock("assistant");
  const raw = await streamAgent(block, {
    connectionId,
    includeMemory: true,
    model: session.model,
    system: REVIEW_SYSTEM,
    prompt,
    label: "review",
  });
  session.review = raw;
  renderFooter();
}

async function followUp(q) {
  if (!session || !q.trim()) return;
  appendBlock("user").textContent = q;
  const t = session.transcript.map((x) => `\n\nUser: ${x.q}\nYou: ${x.a}`).join("");
  // Normal CHAT about the PR you already reviewed — not a fresh review each time.
  // A request for a comment to POST is a PR review comment (code refs welcome, in
  // your own review voice), NOT a customer reply — so bypass the customer voice.
  const isIssue = session.kind === "issue";
  const domain = isIssue
    ? "The work here is a fix you prepared on a local branch for a GitHub issue; you may read the branch with git and cite file:line."
    : "The work here is your review of a GitHub PR; cite file:line when the question is about the code.";
  const wantsReply = REPLY_INTENT.test(q);
  const system = wantsReply
    ? `${domain} ${FOLLOWUP_SYSTEM} You are drafting a PR REVIEW COMMENT to post on GitHub, in your OWN terse review voice from memory (not a customer reply): plain, direct, your exact phrasing. ${COMMENT_VOICE} ${ANCHOR_FORMAT} Output ONLY the comment.`
    : followupParams(q, domain).system;
  const label = wantsReply ? "Draft comment" : "Follow-up";
  const prompt =
    (isIssue ? `GitHub issue ${session.issue}.\n\n` : "") +
    `Your review:\n${session.review}${t}\n\nUser: ${q}\nYou:`;
  const block = appendBlock("assistant");
  const a = await streamAgent(block, {
    connectionId: session.connectionId,
    includeMemory: true,
    model: session.model,
    system,
    prompt,
    label,
  });
  session.transcript.push({ q, a });
}

const ANCHOR_FORMAT =
  "FORMAT, strictly: every ask that points at a line in the diff starts on its own line with `📍 <path>:<line>` (new-file side, a line that is IN the diff), followed by one to three short sentences and, when the fix is a one-liner, a ```suggestion block. Asks with no diff line (tests, title, rebase, screenshots, description) go together under one line containing only `💬`, at the end. Nothing before the first marker. Each 📍 block is posted as an inline comment on that line; the 💬 block is the review body.";

const DRAFT_SYSTEM =
  "You are the reviewer writing the comment to post on this PR, in your OWN standing voice from memory: terse, plain, direct, your exact phrasing — not a cleaned-up polished version. " + COMMENT_VOICE + " " + ANCHOR_FORMAT + " Output ONLY the comment, ready to paste.";

// Verify a PR by actually running it on a throwaway repro bench (SWE-agent-style
// reproducer). Uses the per-version repro benches; never touches the user's own
// checkout (works via `git -C <bench>/apps/<repo>`), and always restores the branch.
const VERIFY_SYSTEM = [
  "You verify a GitHub PR by RUNNING it on a throwaway repro bench, not by reading the diff. Benches: $ALTER_REPRO_DEVELOP / $ALTER_REPRO_VERSION_16 / $ALTER_REPRO_VERSION_15 (already set — do not echo or inspect them; the repro helper reads them itself). Pick the one matching the PR's base branch (a develop-targeted PR → $ALTER_REPRO_DEVELOP). If none is set, say so and stop.",
  "Work only via `git -C <bench>/apps/<repo>` so you never disturb the user's own checkout.",
  "Steps, batched into as few calls as possible: 1) record the current branch (rev-parse --abbrev-ref HEAD) and refuse to continue if `git status --short` is dirty. 2) fetch + checkout the PR: git -C <path> fetch upstream pull/<num>/head:pr-<num> && git -C <path> checkout pr-<num> (fall back to origin if there is no upstream remote). 3) if there are schema/patch changes, `bench --site <repro site> migrate`. 4) run the change — prefer the PR's OWN tests (`bench --site <repro site> run-tests --module <touched module>` — call `bench` bare from the bench root you are already in, never by absolute path, never with `cd`, never wrapped in `timeout`; if the site says testing is disabled, run `bench --site <repro site> set-config allow_tests true` once); else Write a script into YOUR SCRATCHPAD DIRECTORY (the path in your system prompt; nowhere else) that exercises the changed path, asserts the outcome and rolls back, and run it ONLY through `{skill}/scripts/repro.sh develop <that path>` — never `env/bin/python`, never `bench console` directly, both are denied. 5) ALWAYS restore in the same run: `git -C <path> checkout <original-branch>` and delete pr-<num>, leaving the bench exactly as found — never end with the PR branch checked out.",
  "Output: **Verified** — works on <version> (what you ran + the result), or **Failed** — what broke (paste the error), or **Couldn't verify** — why (no repro bench, no tests to run, etc.). Terse and honest — NEVER claim verified without actually running something.",
].join(" ");

async function verifyOnBench() {
  if (!session) return;
  appendBlock("user").textContent = "Verify on bench";
  const p = session.parts;
  const block = appendBlock("assistant");
  const a = await streamAgent(block, {
    connectionId: session.connectionId,
    includeMemory: true,
    model: session.model,
    mode: "verify",
    system: VERIFY_SYSTEM,
    prompt: `Verify PR ${p.owner}/${p.repo}#${p.num}. Check its base branch with gh, pick the matching repro bench, run it, and report.`,
    label: "verify",
  });
  session.verify = a;
}

async function draftComment() {
  if (!session) return;
  appendBlock("user").textContent = "Draft comment";
  // The skill already wrote the comments as JSON; render those instead of
  // asking the model for a second, prose version that would lose its anchors.
  const fromSkill = reviewJson(session.review);
  if (fromSkill) {
    session.draft = draftFromJson(fromSkill);
    appendBlock("assistant").textContent = session.draft || "The review has nothing to ask.";
    renderPostPreview(session.draft);
    return;
  }
  const block = appendBlock("assistant");
  const draft = await streamAgent(block, {
    connectionId: session.connectionId,
    includeMemory: true,
    model: session.model,
    system: DRAFT_SYSTEM,
    prompt: `PR ${session.parts.owner}/${session.parts.repo}#${session.parts.num}.${session.author ? ` PR author GitHub handle: @${session.author}.` : ""}\n\nYour review:\n${session.review}\n\nWrite the comment to post.`,
    label: "draft",
  });
  if (draft) {
    session.draft = draft;
    renderPostPreview(draft);
  }
}

function parseDraft(text) {
  const out = { body: [], comments: [] };
  let cur = out.body;
  for (const raw of (text || "").split("\n")) {
    const line = raw.trim();
    const a = line.match(/^📍\s*([^\s:]+):(\d+)\s*$/);
    if (a) {
      cur = [];
      out.comments.push({ path: a[1], line: Number(a[2]), lines: cur });
      continue;
    }
    if (/^💬\s*$/.test(line)) {
      cur = out.body;
      continue;
    }
    cur.push(raw);
  }
  return {
    body: out.body.join("\n").trim(),
    comments: out.comments.map((c) => ({ path: c.path, line: c.line, body: c.lines.join("\n").trim() })).filter((c) => c.body),
  };
}

async function postToGh(event, text, btn) {
  if (!session) return;
  const note = document.querySelector("#alter-foot-note");
  const { body, comments } = parseDraft(text);
  if (!body && !comments.length) {
    if (note) note.innerHTML = `<span class="alter-err">Nothing to post — the comment is empty.</span>`;
    return;
  }
  // Outward action — confirm the destination + kind before it leaves the machine.
  const dest = `${session.parts.owner}/${session.parts.repo}#${session.parts.num}`;
  const kind = event === "request_changes" ? "a 🔴 Request-changes review" : event === "approve" ? "a 🟢 Approve review" : "a comment";
  const inline = comments.length ? ` with ${comments.length} inline comment${comments.length > 1 ? "s" : ""}` : "";
  if (!window.confirm(`Post ${kind}${inline} to ${dest}?\n\nThis is public and posts as you.`)) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Posting…";
  const r = await send({
    type: "gh",
    repo: `${session.parts.owner}/${session.parts.repo}`,
    num: session.parts.num,
    body,
    event,
    comments,
  });
  btn.disabled = false;
  btn.textContent = label;
  if (r && r.ok) {
    if (note) note.innerHTML = r.note ? `✓ Posted. ${escapeHtml(r.note)}` : "✓ Posted to the PR.";
  } else {
    if (note) note.innerHTML = `<span class="alter-err">${escapeHtml((r && r.error) || "Failed to post.")}</span>`;
  }
}

// Hide the reasoning-model <think> block while it streams; show the answer that
// follows the closing tag.
function draftFromJson(j) {
  const parts = j.comments.map((c) => `📍 ${c.path}:${c.line}\n${(c.body || "").trim()}`);
  if ((j.body || "").trim()) parts.push(`💬\n${j.body.trim()}`);
  return parts.join("\n\n");
}

function extractDraft(review) {
  const j = reviewJson(review);
  if (j) return draftFromJson(j);
  const m = (review || "").match(/\*\*Draft comment[^\n]*?:\**[ \t]*\n?([\s\S]*?)(?=\n\s*(?:---\s*\n)?\s*(?:\*\*)?Review event|$)/i);
  if (!m) return "";
  return m[1].split("\n").map((l) => l.replace(/^>\s?/, "")).join("\n").replace(/^\s*---\s*$/gm, "").trim();
}

function extractEvent(review) {
  const m = (review || "").match(/Review event:?\**\s*\**\s*(APPROVE|REQUEST_CHANGES|COMMENT)/i);
  return m ? m[1].toLowerCase() : "comment";
}

function displayText(full) {
  if (full.includes("</think>")) return full.slice(full.lastIndexOf("</think>") + 8).trim();
  if (full.includes("<think>")) return null; // still thinking
  return full;
}

// Every in-flight run, not just the newest. A second follow-up sent before the
// first finished used to overwrite a single slot, leaving the first one running
// with nothing able to reach it, so Stop only killed the last one.
const activeRuns = new Set(); // { runId, stop, detach }
const stopAllRuns = () => [...activeRuns].forEach((r) => r.stop());
const detachAllRuns = () => [...activeRuns].forEach((r) => r.detach());

// Persist a run's runId per PR so a page-tab reload can RECONNECT to the
// still-running bridge job instead of orphaning it.
const RUN_STORE = "pr_active_runs";
function prKey(parts) {
  return `${parts.owner}/${parts.repo}#${parts.num}`;
}
async function saveActiveRun(rec) {
  try {
    const s = await chrome.storage.local.get(RUN_STORE);
    const runs = s[RUN_STORE] || {};
    runs[rec.key] = rec;
    await chrome.storage.local.set({ [RUN_STORE]: runs });
  } catch (_) {}
}
async function clearActiveRun(key) {
  try {
    const s = await chrome.storage.local.get(RUN_STORE);
    const runs = s[RUN_STORE] || {};
    if (runs[key]) {
      delete runs[key];
      await chrome.storage.local.set({ [RUN_STORE]: runs });
    }
  } catch (_) {}
}
async function getActiveRun(key) {
  try {
    const s = await chrome.storage.local.get(RUN_STORE);
    return (s[RUN_STORE] || {})[key] || null;
  } catch (_) {
    return null;
  }
}

// Drive a bridge run's live feed by polling (~1.2s). Works for a fresh run
// (opts.start fires agent-start) and for reconnecting to an already-running one
// after reload (no start — it already exists server-side).
function pollRun(el, runId, opts) {
  opts = opts || {};
  const parts = pageParts();
  const key = parts ? prKey(parts) : null;
  return new Promise((resolve) => {
    const t0 = Date.now();
    el.innerHTML =
      '<div class="alter-steps"></div><div class="alter-working"><span class="alter-spin"></span><span class="alter-elapsed">Thinking… 0s</span></div>';
    const panelBody = document.getElementById("alter-panel-body");
    if (panelBody) panelBody.scrollTop = panelBody.scrollHeight;
    const stepsEl = el.querySelector(".alter-steps");
    const workEl = el.querySelector(".alter-working");
    const elapsedEl = el.querySelector(".alter-elapsed");
    let done = false;
    let poll = null;
    let shown = 0;
    // A tool call with no result yet means the agent is waiting on execution,
    // not on the model, and the label should say so.
    let running = false;

    const cleanup = () => {
      clearInterval(tick);
      clearInterval(poll);
      activeRuns.delete(run);
      showStop(activeRuns.size > 0);
      if (key) clearActiveRun(key);
    };
    const tick = setInterval(() => {
      if (!done) elapsedEl.textContent = `${running ? "Running" : "Thinking"}… ${Math.round((Date.now() - t0) / 1000)}s`;
    }, 1000);

    const renderSteps = (steps) => {
      if (steps.length <= shown) return;
      // Only follow the stream to the bottom if the user is already there.
      pinToBottom(document.getElementById("alter-panel-body"), () => {
        for (let i = shown; i < steps.length; i++) {
          const d = document.createElement("div");
          const tool = steps[i].indexOf("▸ ") === 0;
          const out = steps[i].indexOf("↳ ") === 0;
          d.className = "alter-step" + (tool ? " alter-step-tool" : out ? " alter-step-out" : " alter-step-say");
          d.textContent = steps[i];
          stepsEl.appendChild(d);
          running = tool;
        }
        shown = steps.length;
      });
    };

    const run = {
      runId,
      stop: () => {
        if (done) return;
        done = true;
        cleanup();
        send({ type: "cancel", runId });
        workEl.textContent = "Stopped.";
        resolve("");
      },
      // Let go of the run without cancelling it: stop polling and leave the
      // stored runId alone, so the bridge keeps working and opening the PR again
      // reconnects. Closing a tab already behaves this way; leaving the page
      // should not be the one thing that throws a review away.
      detach: () => {
        if (done) return;
        done = true;
        clearInterval(tick);
        clearInterval(poll);
        activeRuns.delete(run);
        showStop(activeRuns.size > 0);
        resolve("");
      },
    };
    activeRuns.add(run);
    showStop(true);

    const fail = (msg) => {
      if (done) return;
      done = true;
      cleanup();
      workEl.remove();
      const b = document.createElement("div");
      b.className = "alter-banner";
      b.textContent = humanizeErr(msg);
      el.appendChild(b);
      resolve("");
    };

    let misses = 0;
    const doPoll = async () => {
      if (done) return;
      const r = await send({ type: "agent-poll", runId });
      if (!r || !r.ok || !r.data) {
        // Transient — keep polling, but give up after ~20s of silence so the
        // spinner can't run forever once Alter has quit.
        if (++misses >= 15) {
          done = true;
          cleanup();
          fail("Lost contact with Alter — is the app still running?");
        }
        return;
      }
      misses = 0;
      const p = r.data;
      renderSteps(p.steps || []);
      if (p.done) {
        done = true;
        cleanup();
        if (p.error) return fail(p.error === "run not found" ? "Alter restarted and lost this run — run it again." : p.error);
        if (!(p.text || "").trim()) return fail("The model returned an empty reply — try again.");
        workEl.remove();
        const ans = document.createElement("div");
        ans.className = "alter-answer";
        const clean = displayText(p.text || "") ?? (p.text || "");
        const body = document.getElementById("alter-panel-body");
        const wasAtBottom = nearBottom(body);
        ans.innerHTML = mini(clean);
        el.appendChild(ans);
        // Only reposition if the user was following along at the bottom.
        if (wasAtBottom && body) {
          if (ans.getBoundingClientRect().height > body.clientHeight) ans.scrollIntoView({ block: "start", behavior: "smooth" });
          else stickBottom(body);
        }
        resolve(clean);
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
  const parts = pageParts();
  if (parts)
    saveActiveRun({
      key: prKey(parts),
      runId,
      connectionId: params.connectionId,
      model: params.model,
      label: params.label || "review",
    });
  return pollRun(el, runId, {
    start: (rid) =>
      params.support
        ? send({ type: "support-start", ...params.support, connectionId: params.connectionId, includeMemory: params.includeMemory, model: params.model, runId: rid })
        : send({
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

// After a page-tab reload, re-attach to a review still running on the bridge.
const reconnected = new Set();
async function reconnectIfActive() {
  const parts = pageParts();
  if (!parts) return;
  const key = prKey(parts);
  if (reconnected.has(key) || document.getElementById("alter-panel")) return;
  reconnected.add(key);
  const rec = await getActiveRun(key);
  if (!rec) return;
  const r = await send({ type: "agent-poll", runId: rec.runId });
  if (!r || !r.ok || !r.data || (r.data.done && r.data.error === "run not found")) {
    clearActiveRun(key);
    return;
  }
  openPanel();
  const isIssue = !!issueParts();
  session = { parts, connectionId: rec.connectionId, model: rec.model, diff: "", note: "", review: "", draft: "", transcript: [], kind: isIssue ? "issue" : "pr", issue: isIssue ? `${location.origin}/${parts.owner}/${parts.repo}/issues/${parts.num}` : "" };
  if (isIssue) document.querySelector("#alter-panel-title").textContent = "Alter — Fix issue";
  clearBody();
  const note = document.createElement("div");
  note.className = "alter-step alter-step-say";
  note.textContent = "Reconnected to a review in progress…";
  document.querySelector("#alter-panel-body").appendChild(note);
  const block = appendBlock("assistant");
  const a = await pollRun(block, rec.runId, {});
  if (rec.label === "draft") {
    session.draft = a;
    renderPostPreview(a);
  } else {
    session.review = a;
    if (session.kind === "issue") {
      session.transcript.push({ q: rec.label || "Prepare fix", a });
      session.fixPrepared = rec.label !== "Push & open PR" && !!a;
    }
    renderFooter();
  }
}

function showStop(on) {
  const b = document.getElementById("alter-stop");
  if (b) b.style.display = on ? "" : "none";
}

function ensureButton() {
  const isIssue = !!issueParts();
  if (!prParts() && !isIssue) return;
  if (document.getElementById("alter-actions")) return;
  const wrap = document.createElement("div");
  wrap.id = "alter-actions";
  const b = document.createElement("button");
  b.className = "alter-action-btn";
  b.textContent = isIssue ? "Fix with Alter" : "Review with Alter";
  b.addEventListener("click", () => (isIssue ? runIssueFix() : run()));
  wrap.appendChild(b);
  document.body.appendChild(wrap);
}

async function runIssueFix() {
  if (running) return;
  running = true;
  const btn = document.querySelector("#alter-actions button");
  if (btn) btn.disabled = true;
  try {
    const parts = issueParts();
    const { models, claudeModel } = await chrome.storage.local.get(["models", "claudeModel"]);
    const connectionId = models && models.prReview;
    openPanel();
    document.querySelector("#alter-panel-title").textContent = "Alter — Fix issue";
    clearBody();
    if (!connectionId) return setStatus("Pick a model for PR review in the Alter extension settings first.", true);
    const issue = `${location.origin}/${parts.owner}/${parts.repo}/issues/${parts.num}`;
    session = { parts, issue, connectionId, model: claudeModel || undefined, review: "", draft: "", transcript: [], kind: "issue" };
    appendBlock("user").textContent = `Fix ${parts.owner}/${parts.repo}#${parts.num}`;
    const block = appendBlock("assistant");
    const a = await streamAgent(block, {
      connectionId,
      includeMemory: true,
      model: session.model,
      mode: "pr",
      support: { ticket: parts.num, verb: "issue", site: "github.com", issue },
      label: "Prepare fix",
    });
    session.review = a;
    session.transcript.push({ q: "Prepare fix", a });
    session.fixPrepared = !!a;
    renderFooter();
  } finally {
    running = false;
    if (btn && btn.isConnected) btn.disabled = false;
  }
}

async function pushIssueFix() {
  if (!session || session.kind !== "issue") return;
  appendBlock("user").textContent = "Push & open PR";
  const t = session.transcript.map((x) => `\n\nUser: ${x.q}\nYou: ${x.a}`).join("");
  const block = appendBlock("assistant");
  const a = await streamAgent(block, {
    connectionId: session.connectionId,
    includeMemory: true,
    model: session.model,
    mode: "pr-push",
    support: { ticket: session.parts.num, verb: "issue_push", site: "github.com", issue: session.issue, transcript: t },
    label: "Push & open PR",
  });
  session.transcript.push({ q: "Push & open PR", a });
}

function openPanel() {
  let el = document.getElementById("alter-panel");
  if (el) return el;
  el = document.createElement("div");
  el.id = "alter-panel";
  el.innerHTML = `
    <div id="alter-panel-head">
      <span id="alter-panel-title">Alter — PR review</span>
      <div>
        <button id="alter-copy" title="Copy the review (or draft comment)">Copy</button>
        <button id="alter-stop" title="Stop the review" style="display:none">Stop</button>
        <button id="alter-min" title="Minimize">–</button>
        <button id="alter-close" title="Close">×</button>
      </div>
    </div>
    <div id="alter-panel-body"></div>
    <div id="alter-panel-foot"></div>
    <div class="alter-grip" data-grip="x" title="Drag to resize"></div>
    <div class="alter-grip" data-grip="y" title="Drag to resize"></div>
    <div class="alter-grip" data-grip="xy" title="Drag to resize"></div>`;
  document.body.appendChild(el);
  // The panel is anchored bottom-right, so it grows up and to the left. Size is
  // remembered per browser, since a long review is unreadable at the default.
  const applySize = (w, h) => {
    el.style.width = Math.min(Math.max(340, w), window.innerWidth - 40) + "px";
    el.style.height = Math.min(Math.max(220, h), window.innerHeight - 100) + "px";
    el.style.maxHeight = "none";
  };
  const saveSize = () => {
    try {
      localStorage.setItem("alter_panel_size", JSON.stringify({ w: el.offsetWidth, h: el.offsetHeight }));
    } catch (_) {}
  };
  try {
    const s = JSON.parse(localStorage.getItem("alter_panel_size") || "null");
    if (s && s.w && s.h) applySize(s.w, s.h);
  } catch (_) {}
  // Anchored bottom-right, so the left edge widens it and the top edge makes it
  // taller. The corner between them does both.
  el.querySelectorAll(".alter-grip").forEach((grip) =>
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const axis = grip.dataset.grip;
      const r = el.getBoundingClientRect();
      const x0 = e.clientX, y0 = e.clientY, w0 = r.width, h0 = r.height;
      el.classList.add("alter-resizing");
      const move = (ev) =>
        applySize(axis === "y" ? w0 : w0 + (x0 - ev.clientX), axis === "x" ? h0 : h0 + (y0 - ev.clientY));
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        el.classList.remove("alter-resizing");
        saveSize();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    })
  );

  el.querySelector("#alter-copy").addEventListener("click", () => {
    const b = el.querySelector("#alter-copy");
    const text = session ? session.draft || session.review || "" : "";
    if (!text) return;
    navigator.clipboard.writeText(text);
    b.textContent = "Copied";
    setTimeout(() => (b.textContent = "Copy"), 1500);
  });
  el.querySelector("#alter-min").addEventListener("click", () => {
    const min = el.classList.toggle("alter-collapsed");
    el.querySelector("#alter-min").textContent = min ? "▢" : "–";
    el.querySelector("#alter-min").title = min ? "Expand" : "Minimize";
  });
  el.querySelector("#alter-stop").addEventListener("click", () => {
    stopAllRuns();
  });
  el.querySelector("#alter-close").addEventListener("click", () => {
    stopAllRuns();
    el.remove();
    session = null;
  });
  return el;
}

function clearBody() {
  document.querySelector("#alter-panel-body").innerHTML = "";
}
function setStatus(text, isError) {
  document.querySelector("#alter-panel-body").innerHTML = isError
    ? `<span class="alter-err">${escapeHtml(text)}</span>`
    : escapeHtml(text);
}
function appendBlock(cls) {
  const b = document.createElement("div");
  b.className = "alter-msg alter-" + cls;
  document.querySelector("#alter-panel-body").appendChild(b);
  return b;
}

function renderFooter() {
  const foot = document.querySelector("#alter-panel-foot");
  if (session && session.kind === "issue") {
    foot.innerHTML = `
    <div id="alter-foot-btns">
      ${session.fixPrepared ? '<button id="alter-push">Push &amp; open PR</button>' : ""}
    </div>
    <div id="alter-foot-ask">
      <input id="alter-ask" placeholder="Ask a follow-up…" />
      <button id="alter-ask-send">Send</button>
    </div>
    <div id="alter-foot-note"></div>`;
    const pushBtn = foot.querySelector("#alter-push");
    if (pushBtn) pushBtn.addEventListener("click", (e) => { e.target.disabled = true; pushIssueFix(); });
    const input = foot.querySelector("#alter-ask");
    const go = () => {
      const q = input.value.trim();
      if (!q) return;
      input.value = "";
      followUp(q);
    };
    foot.querySelector("#alter-ask-send").addEventListener("click", go);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    return;
  }
  foot.innerHTML = `
    <div id="alter-foot-btns">
      <button id="alter-draft">✍️ Draft comment</button>
      <button id="alter-verify">🔬 Verify on bench</button>
      <button id="alter-post-review" class="alter-ghost">Post…</button>
    </div>
    <div id="alter-foot-ask">
      <input id="alter-ask" placeholder="Ask a follow-up…" />
      <button id="alter-ask-send">Send</button>
    </div>
    <div id="alter-foot-note"></div>`;
  foot.querySelector("#alter-draft").addEventListener("click", (e) => {
    e.target.disabled = true;
    draftComment().finally(() => {
      if (e.target.isConnected) e.target.disabled = false;
    });
  });
  const verifyBtn = foot.querySelector("#alter-verify");
  verifyBtn.addEventListener("click", (e) => {
    e.target.disabled = true;
    verifyOnBench().finally(() => {
      if (e.target.isConnected) e.target.disabled = false;
    });
  });
  // Gate Verify on bench: disable it until a repro bench is configured in Alter.
  send({ type: "repro-info" }).then((r) => {
    if (!(r && r.ok && r.data && r.data.configured)) {
      verifyBtn.disabled = true;
      verifyBtn.title = "Set up a repro bench in Alter → Settings → Repro benches first";
      verifyBtn.textContent = "🔬 Verify on bench — set up a bench";
    }
  });
  foot.querySelector("#alter-post-review").addEventListener("click", () => renderPostPreview(session.draft || extractDraft(session.review), extractEvent(session.review)));
  const input = foot.querySelector("#alter-ask");
  const go = () => {
    const q = input.value.trim();
    if (!q) return;
    input.value = "";
    followUp(q);
  };
  foot.querySelector("#alter-ask-send").addEventListener("click", go);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
}

// Show the exact text that will be posted, editable, with the post actions — so
// clicking Post/Request always shows what goes to the PR first.
function renderPostPreview(text, suggested) {
  const foot = document.querySelector("#alter-panel-foot");
  const ev = suggested || (session && extractEvent(session.review)) || "comment";
  foot.innerHTML = `
    <div class="alter-preview-label">Only this posts. Each 📍 path:line block goes inline on that line, the rest is the review body. Suggested: ${escapeHtml(ev.replace("_", " "))}.</div>
    <textarea id="alter-post-text" class="alter-post-text" rows="6"></textarea>
    <div id="alter-foot-btns">
      <button data-ev="approve" class="${ev === "approve" ? "alter-primary" : ""}">Approve</button>
      <button data-ev="request_changes" class="${ev === "request_changes" ? "alter-primary" : ""}">Request changes</button>
      <button data-ev="comment" class="${ev === "comment" ? "alter-primary" : ""}">Comment</button>
    </div>
    <div id="alter-foot-btns2">
      <button id="alter-post-bot">Post as frappe-pr-bot</button>
      <button id="alter-back" class="alter-ghost">Back</button>
    </div>
    <div id="alter-foot-note"></div>`;
  const ta = foot.querySelector("#alter-post-text");
  ta.value = text || "";
  const noteEl = foot.querySelector("#alter-foot-note");
  const btn = (ev) => foot.querySelector(`#alter-foot-btns button[data-ev="${ev}"]`);
  // Only the events that match the draft are offered: approving while it carries
  // asks contradicts itself, and requesting changes with nothing to ask is empty.
  // Comment stays in both, because "No changes requested" is posted as a comment.
  const syncEvents = () => {
    const { body, comments } = parseDraft(ta.value);
    const empty = !body.trim() && !comments.length;
    const asks = !empty && (comments.length > 0 || !/^no changes requested\.?/i.test(body.trim()));
    btn("approve").hidden = asks;
    btn("request_changes").hidden = !asks;
    btn("comment").disabled = empty;
  };
  const warnAnchors = () => {
    syncEvents();
    if (!ta.value.trim()) noteEl.textContent = "No draft comment in this review — write the comment you want to post.";
    else if (!parseDraft(ta.value).comments.length) noteEl.innerHTML = `<span class="alter-err">No 📍 path:line blocks — the whole text would post as one review body with no inline comments.</span>`;
    else noteEl.textContent = "";
  };
  warnAnchors();
  ta.addEventListener("input", warnAnchors);
  foot.querySelector("#alter-back").addEventListener("click", renderFooter);
  foot.querySelectorAll("#alter-foot-btns button[data-ev]").forEach((b) =>
    b.addEventListener("click", () => postToGh(b.dataset.ev, ta.value, b))
  );
  const bot = foot.querySelector("#alter-post-bot");
  bot.addEventListener("click", () => postAsBot(ta.value, bot));
}

// Same text, posted by the bot: the bridge dispatches the repo's post-review
// workflow, which posts a COMMENT review under frappe-pr-bot. Never as you.
async function postAsBot(text, btn) {
  if (!session) return;
  const note = document.querySelector("#alter-foot-note");
  const { body, comments } = parseDraft(text);
  const j = reviewJson(session.review);
  const replies = (j && Array.isArray(j.replies) ? j.replies : []).filter((x) => x && typeof x.in_reply_to === "number" && (x.body || "").trim());
  const resolve = window.ALTER.resolveIds(j);
  if (!body && !comments.length && !replies.length && !resolve.length) {
    if (note) note.innerHTML = `<span class="alter-err">Nothing to post — the comment is empty.</span>`;
    return;
  }
  const dest = `${session.parts.owner}/${session.parts.repo}#${session.parts.num}`;
  const extras = [
    comments.length ? `${comments.length} inline comment${comments.length > 1 ? "s" : ""}` : "",
    replies.length ? `${replies.length} thread repl${replies.length > 1 ? "ies" : "y"}` : "",
    resolve.length ? `${resolve.length} thread${resolve.length > 1 ? "s" : ""} resolved` : "",
  ].filter(Boolean);
  const inline = extras.length ? ` with ${extras.join(", ")}` : "";
  if (!window.confirm(`Post a comment review${inline} to ${dest} as frappe-pr-bot?\n\nThis is public.`)) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Dispatching…";
  const r = await send({
    type: "gh-bot",
    repo: `${session.parts.owner}/${session.parts.repo}`,
    num: session.parts.num,
    review: { event: "COMMENT", body, comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })), replies, resolve },
  });
  btn.disabled = false;
  btn.textContent = label;
  if (note) note.innerHTML = r && r.ok ? "✓ Dispatched. The bot posts within a minute." : `<span class="alter-err">${escapeHtml((r && r.error) || "Failed to dispatch.")}</span>`;
}

// GitHub is an SPA: the URL changes without reloading. If the PR under an open
// panel changes, drop the stale panel so it can't show the wrong PR's review,
// then let reconnectIfActive pick up any run for the new one.
let lastPrKey = pageParts() ? prKey(pageParts()) : null;
setInterval(() => {
  const parts = pageParts();
  const key = parts ? prKey(parts) : null;
  if (key !== lastPrKey) {
    const left = lastPrKey;
    lastPrKey = key;
    const panel = document.getElementById("alter-panel");
    if (panel) {
      detachAllRuns();
      panel.remove();
      session = null;
    }
    // Coming back to the PR we just left should re-attach to its run.
    if (left) reconnected.delete(left);
  }
  ensureButton();
  reconnectIfActive();
}, 1500);
ensureButton();
reconnectIfActive();
})();
