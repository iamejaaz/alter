// Injected on GitHub PR pages. Adds a "Review with Alter" button that pulls the
// PR diff and runs it through the model you picked for PR review in the popup.
// IIFE-wrapped so its top-level names don't collide with sibling content scripts.
(() => {
const REVIEW_SYSTEM = [
  "You are reviewing ONE GitHub pull request as a senior maintainer, in the reviewer's terse daily-review style.",
  "Open with a verdict on its own first line — exactly one of: '🟢 Ready to approve', '🟡 Needs your judgment', or '🔴 Needs changes'.",
  "If CI status is provided, factor it in and say whether a failing check is caused by this diff or unrelated/pre-existing.",
  "Then **Mechanism:** — one or two lines: what the PR changes and the root cause it addresses (judge the cleanest mechanism, not just 'it works').",
  "Then **Assessment:** — terse bullets: is the root cause actually fixed, any leftover state/residue, is the fix minimally scoped, test coverage (call out untested new paths), and scan fixtures/test data for real domains, emails, names, or keys — flag any PII (expect example.com).",
  "If the verdict is 🔴 Needs changes, add **Draft comment:** — a ready-to-paste review comment: @author-addressed, terse plain English, cite file:line, explain as a plain before/after user example where it helps, and include a ```suggestion block when a concrete fix fits.",
  "Terse throughout. No preamble, no meta, no praise-fluff. No premature victory — progress is distance-to-parity with the real thing.",
].join(" ");

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

function prParts() {
  const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], num: m[3] } : null;
}

async function getDiff(parts) {
  const url = `${location.origin}/${parts.owner}/${parts.repo}/pull/${parts.num}.diff`;
  const r = await send({ type: "diff", url });
  if (!r || !r.ok) throw new Error(r?.error || "Couldn't fetch the PR diff.");
  return r.text || "";
}

async function getChecks(parts) {
  const r = await send({ type: "gh-checks", repo: `${parts.owner}/${parts.repo}`, num: parts.num });
  return r && r.ok ? r.text || "" : "";
}

let session = null;

async function run() {
  const parts = prParts();
  if (!parts) return;
  const { models, claudeModel } = await chrome.storage.local.get(["models", "claudeModel"]);
  const connectionId = models && models.prReview;
  openPanel();
  if (!connectionId) return setStatus("Pick a model for PR review in the Alter popup first.", true);

  setStatus("Fetching the diff + CI…");
  let diff = "";
  try {
    diff = await getDiff(parts);
  } catch (e) {
    return setStatus(String(e.message || e), true);
  }
  if (!diff.trim()) return setStatus("Empty diff — nothing to review.", true);
  const checks = await getChecks(parts).catch(() => "");

  let note = "";
  const CAP = 60000;
  if (diff.length > CAP) {
    diff = diff.slice(0, CAP);
    note = "\n\n[diff truncated to first 60k chars]";
  }

  const ciBlock = checks.trim() ? `CI checks:\n${checks.slice(0, 4000)}\n\n` : "";
  const prompt = `Review this pull request (${parts.owner}/${parts.repo}#${parts.num}).\n\n${ciBlock}Diff:\n${diff}${note}`;

  session = { parts, connectionId, model: claudeModel || undefined, diff, note, review: "", draft: "", transcript: [] };
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
  const prompt =
    `PR diff (may be truncated):\n${session.diff}${session.note}\n\n` +
    `Your review:\n${session.review}${t}\n\nUser: ${q}\nYou:`;
  const block = appendBlock("assistant");
  const a = await streamAgent(block, {
    connectionId: session.connectionId,
    includeMemory: true,
    model: session.model,
    system:
      "You are the maintainer discussing your review of this PR with the author. Answer the question specifically and concisely; reference file:line where relevant.",
    prompt,
    label: "followup",
  });
  session.transcript.push({ q, a });
}

const DRAFT_SYSTEM =
  "You are Ejaaz writing the review comment to post on this PR. Terse, plain English, @author-addressed where useful, cite file:line, and include a ```suggestion block when a concrete fix fits. No preamble, no praise-fluff, no meta. Output ONLY the comment body, ready to paste.";

async function draftComment() {
  if (!session) return;
  appendBlock("user").textContent = "Draft comment";
  const block = appendBlock("assistant");
  const draft = await streamAgent(block, {
    connectionId: session.connectionId,
    includeMemory: true,
    model: session.model,
    system: DRAFT_SYSTEM,
    prompt: `PR ${session.parts.owner}/${session.parts.repo}#${session.parts.num}. Your review:\n${session.review}\n\nWrite the comment to post.`,
    label: "draft",
  });
  if (draft) {
    session.draft = draft;
    renderPostPreview(draft);
  }
}

async function postToGh(event, body, btn) {
  if (!session) return;
  const note = document.querySelector("#alter-foot-note");
  if (!body || !body.trim()) {
    if (note) note.innerHTML = `<span class="alter-err">Nothing to post — the comment is empty.</span>`;
    return;
  }
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Posting…";
  const r = await send({
    type: "gh",
    repo: `${session.parts.owner}/${session.parts.repo}`,
    num: session.parts.num,
    body,
    event,
  });
  btn.disabled = false;
  btn.textContent = label;
  if (r && r.ok) {
    if (note) note.innerHTML = "✓ Posted to the PR.";
  } else {
    if (note) note.innerHTML = `<span class="alter-err">${escapeHtml((r && r.error) || "Failed to post.")}</span>`;
  }
}

// Hide the reasoning-model <think> block while it streams; show the answer that
// follows the closing tag.
function displayText(full) {
  if (full.includes("</think>")) return full.slice(full.lastIndexOf("</think>") + 8).trim();
  if (full.includes("<think>")) return null; // still thinking
  return full;
}

let activeRun = null; // { runId, stop } while a review/follow-up is in flight

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
  const parts = prParts();
  const key = parts ? prKey(parts) : null;
  return new Promise((resolve) => {
    const t0 = Date.now();
    el.innerHTML =
      '<div class="alter-steps"></div><div class="alter-working"><span class="alter-spin"></span><span class="alter-elapsed">Thinking… 0s</span></div>';
    const stepsEl = el.querySelector(".alter-steps");
    const workEl = el.querySelector(".alter-working");
    const elapsedEl = el.querySelector(".alter-elapsed");
    let done = false;
    let poll = null;
    let shown = 0;

    const cleanup = () => {
      clearInterval(tick);
      clearInterval(poll);
      activeRun = null;
      showStop(false);
      if (key) clearActiveRun(key);
    };
    const tick = setInterval(() => {
      if (!done) elapsedEl.textContent = `Thinking… ${Math.round((Date.now() - t0) / 1000)}s`;
    }, 1000);

    const renderSteps = (steps) => {
      for (let i = shown; i < steps.length; i++) {
        const d = document.createElement("div");
        d.className = "alter-step" + (steps[i].indexOf("▸ ") === 0 ? " alter-step-tool" : " alter-step-say");
        d.textContent = steps[i];
        stepsEl.appendChild(d);
      }
      shown = steps.length;
      if (shown) {
        const body = document.getElementById("alter-panel-body");
        if (body) body.scrollTop = body.scrollHeight;
      }
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
      b.className = "alter-banner";
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
        const ans = document.createElement("div");
        ans.className = "alter-answer";
        const clean = displayText(p.text || "") ?? (p.text || "");
        ans.innerHTML = mini(clean);
        el.appendChild(ans);
        ans.scrollIntoView({ block: "start", behavior: "smooth" });
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
  const parts = prParts();
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

// After a page-tab reload, re-attach to a review still running on the bridge.
const reconnected = new Set();
async function reconnectIfActive() {
  const parts = prParts();
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
  session = { parts, connectionId: rec.connectionId, model: rec.model, diff: "", note: "", review: "", draft: "", transcript: [] };
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
    renderFooter();
  }
}

function showStop(on) {
  const b = document.getElementById("alter-stop");
  if (b) b.style.display = on ? "" : "none";
}

function ensureButton() {
  if (!prParts()) return;
  if (document.getElementById("alter-actions")) return;
  const wrap = document.createElement("div");
  wrap.id = "alter-actions";
  const b = document.createElement("button");
  b.className = "alter-action-btn";
  b.textContent = "Review with Alter";
  b.addEventListener("click", () => run());
  wrap.appendChild(b);
  document.body.appendChild(wrap);
}

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
  // Pull fenced code blocks out first so nothing inside them gets reformatted.
  let s = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
    blocks.push(`<pre class="md-pre"><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return ` ${blocks.length - 1} `;
  });
  s = escapeHtml(s)
    .replace(/^#{1,6}\s+(.*)$/gm, "<b class='md-h'>$1</b>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^\s*[-*]\s+(.*)$/gm, "• $1")
    .replace(/\n/g, "<br>");
  return s.replace(/ (\d+) /g, (_, i) => blocks[+i]);
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
        <button id="alter-stop" title="Stop the review" style="display:none">Stop</button>
        <button id="alter-min" title="Minimize">–</button>
        <button id="alter-close" title="Close">×</button>
      </div>
    </div>
    <div id="alter-panel-body"></div>
    <div id="alter-panel-foot"></div>`;
  document.body.appendChild(el);
  el.querySelector("#alter-min").addEventListener("click", () => {
    const min = el.classList.toggle("alter-collapsed");
    el.querySelector("#alter-min").textContent = min ? "▢" : "–";
    el.querySelector("#alter-min").title = min ? "Expand" : "Minimize";
  });
  el.querySelector("#alter-stop").addEventListener("click", () => {
    if (activeRun) activeRun.stop();
  });
  el.querySelector("#alter-close").addEventListener("click", () => {
    if (activeRun) activeRun.stop();
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
  foot.innerHTML = `
    <div id="alter-foot-btns">
      <button id="alter-draft">✍️ Draft comment</button>
      <button id="alter-post-review" class="alter-ghost">Post review as-is…</button>
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
  foot.querySelector("#alter-post-review").addEventListener("click", () => renderPostPreview(session.review));
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
function renderPostPreview(text) {
  const foot = document.querySelector("#alter-panel-foot");
  foot.innerHTML = `
    <div class="alter-preview-label">This exact text posts to the PR — edit if needed:</div>
    <textarea id="alter-post-text" class="alter-post-text" rows="6"></textarea>
    <div id="alter-foot-btns">
      <button data-ev="comment">💬 Post as comment</button>
      <button data-ev="request_changes">🔴 Request changes</button>
      <button id="alter-back" class="alter-ghost">← Back</button>
    </div>
    <div id="alter-foot-note"></div>`;
  const ta = foot.querySelector("#alter-post-text");
  ta.value = text || "";
  foot.querySelector("#alter-back").addEventListener("click", renderFooter);
  foot.querySelectorAll("#alter-foot-btns button[data-ev]").forEach((b) =>
    b.addEventListener("click", () => postToGh(b.dataset.ev, ta.value, b))
  );
}

setInterval(() => {
  ensureButton();
  reconnectIfActive();
}, 1500);
ensureButton();
reconnectIfActive();
})();
