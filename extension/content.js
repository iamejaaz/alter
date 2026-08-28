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

  session = { parts, connectionId, model: claudeModel || undefined, diff, note, review: "", transcript: [] };
  clearBody();
  const block = appendBlock("assistant");
  const raw = await streamInto(block, {
    connectionId,
    includeMemory: true,
    model: session.model,
    system: REVIEW_SYSTEM,
    prompt,
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
  const a = await streamInto(block, {
    connectionId: session.connectionId,
    includeMemory: true,
    model: session.model,
    system:
      "You are the maintainer discussing your review of this PR with the author. Answer the question specifically and concisely; reference file:line where relevant.",
    prompt,
  });
  session.transcript.push({ q, a });
}

async function postToGh(event, btn) {
  if (!session) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Posting…";
  const r = await send({
    type: "gh",
    repo: `${session.parts.owner}/${session.parts.repo}`,
    num: session.parts.num,
    body: session.review,
    event,
  });
  btn.disabled = false;
  btn.textContent = label;
  const note = document.querySelector("#alter-foot-note");
  if (r && r.ok) {
    note.innerHTML = "✓ Posted to the PR.";
  } else {
    note.innerHTML = `<span class="alter-err">${escapeHtml((r && r.error) || "Failed to post.")}</span>`;
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

// Non-streaming: MV3 service workers buffer a fetch stream until it completes,
// so incremental streaming can't work here — run it and show the full answer.
// Stop kills the run on the bridge so it doesn't keep going after you close it.
function streamInto(el, params) {
  const runId =
    (self.crypto && crypto.randomUUID && crypto.randomUUID()) || "r" + Date.now() + Math.random();
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const tick = setInterval(() => {
      if (done) return;
      el.innerHTML = `<span style="color:#a1a1aa">Thinking… ${Math.round((Date.now() - t0) / 1000)}s</span>`;
    }, 1000);
    const finish = (html, val) => {
      if (done) return;
      done = true;
      clearInterval(tick);
      clearTimeout(to);
      activeRun = null;
      showStop(false);
      el.innerHTML = html;
      resolve(val);
    };
    const to = setTimeout(
      () => finish('<span class="alter-err">Timed out after 3 min — try again or a smaller diff.</span>', ""),
      180000
    );
    activeRun = {
      runId,
      stop: () => {
        send({ type: "cancel", runId });
        finish('<div class="alter-msg">Stopped.</div>', "");
      },
    };
    showStop(true);
    el.innerHTML = '<span style="color:#a1a1aa">Thinking… 0s</span>';
    send({
      type: "run",
      connectionId: params.connectionId,
      includeMemory: params.includeMemory,
      model: params.model,
      system: params.system,
      prompt: params.prompt,
      runId,
    }).then((r) => {
      if (r && r.ok && r.data && r.data.content) {
        const clean = displayText(r.data.content) ?? r.data.content;
        finish(mini(clean), clean);
      } else {
        finish(`<div class="alter-banner">${escapeHtml(humanizeErr(r && r.error))}</div>`, "");
      }
    });
  });
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
        <button id="alter-close" title="Close">×</button>
      </div>
    </div>
    <div id="alter-panel-body"></div>
    <div id="alter-panel-foot"></div>`;
  document.body.appendChild(el);
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
      <button data-ev="comment">💬 Post as comment</button>
      <button data-ev="request_changes">🔴 Request changes</button>
    </div>
    <div id="alter-foot-ask">
      <input id="alter-ask" placeholder="Ask a follow-up…" />
      <button id="alter-ask-send">Send</button>
    </div>
    <div id="alter-foot-note"></div>`;
  foot.querySelectorAll("#alter-foot-btns button").forEach((b) =>
    b.addEventListener("click", () => postToGh(b.dataset.ev, b))
  );
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

setInterval(ensureButton, 1500);
ensureButton();
})();
