// Injected on GitHub PR pages. Adds a "Review with Alter" button that pulls the
// PR diff and runs it through the model you picked for PR review in the popup.

const REVIEW_SYSTEM = [
  "You are reviewing a GitHub pull request as a senior maintainer of this project.",
  "Judge with a maintainer's lens: cleanest mechanism, root cause fixed, no state residue — not just 'it works'.",
  "START with a merge verdict on its own first line — exactly one of:",
  "'🟢 Safe to merge' (no blocking issues), '🟡 Merge after addressing the points below' (nits/non-blocking), or '🔴 Not safe to merge' (correctness/security/design blocker).",
  "Then a one-line why, then the issues.",
  "Write terse, @author-addressed comments in plain English. No preamble, no meta, no praise-fluff.",
  "Explain each issue as a plain before/after example where useful (user does X → shows Y → PR shows worse Z); defer file/line/mechanism until needed.",
  "Scan test data / fixtures for real domains, emails, names, or keys — flag any PII (expect example.com).",
  "No premature victory — progress is distance-to-parity with the real thing.",
  "List the highest-signal issues first (most severe first), each with file:line. If it's clean, say so plainly.",
].join(" ");


const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

function prParts() {
  const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], num: m[3] } : null;
}

const ACTIONS = {
  review: {
    title: "PR review",
    model: "prReview",
    system: REVIEW_SYSTEM,
    verb: (parts, diff, note) => `Review this pull request diff (${parts.owner}/${parts.repo}#${parts.num}):\n\n${diff}${note}`,
    working: "Reviewing… (this can take a few seconds)",
  },
};

async function getDiff(parts) {
  const url = `${location.origin}/${parts.owner}/${parts.repo}/pull/${parts.num}.diff`;
  const r = await send({ type: "diff", url });
  if (!r || !r.ok) throw new Error(r?.error || "Couldn't fetch the PR diff.");
  return r.text || "";
}

let session = null;

async function run() {
  const parts = prParts();
  if (!parts) return;
  const { models } = await chrome.storage.local.get("models");
  const connectionId = models && models.prReview;
  openPanel();
  if (!connectionId) return setStatus("Pick a model for PR review in the Alter popup first.", true);

  setStatus("Fetching the diff…");
  let diff = "";
  try {
    diff = await getDiff(parts);
  } catch (e) {
    return setStatus(String(e.message || e), true);
  }
  if (!diff.trim()) return setStatus("Empty diff — nothing to review.", true);

  let note = "";
  const CAP = 60000;
  if (diff.length > CAP) {
    diff = diff.slice(0, CAP);
    note = "\n\n[diff truncated to first 60k chars]";
  }

  session = { parts, connectionId, diff, note, review: "", transcript: [] };
  clearBody();
  const block = appendBlock("assistant");
  const raw = await streamInto(block, {
    connectionId,
    includeMemory: true,
    system: ACTIONS.review.system,
    prompt: ACTIONS.review.verb(parts, diff, note),
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

function streamInto(el, params) {
  return new Promise((resolve) => {
    el.innerHTML = '<span style="color:#a1a1aa">Thinking…</span>';
    let full = "";
    let raw = "";
    const port = chrome.runtime.connect({ name: "run-stream" });
    port.postMessage(params);
    port.onMessage.addListener((m) => {
      if (m.delta) {
        full += m.delta;
        const shown = displayText(full);
        raw = shown == null ? "" : shown;
        el.innerHTML = shown == null ? '<span style="color:#a1a1aa">Thinking…</span>' : mini(shown) || "…";
        const body = document.querySelector("#alter-panel-body");
        if (body) body.scrollTop = body.scrollHeight;
      } else if (m.error) {
        el.innerHTML = `<span class="alter-err">${escapeHtml(m.error)}</span>`;
      } else if (m.done) {
        port.disconnect();
        if (!full.trim()) el.innerHTML = '<span class="alter-err">(empty response)</span>';
        resolve(raw);
      }
    });
  });
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
function mini(md) {
  return escapeHtml(md)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function openPanel() {
  let el = document.getElementById("alter-panel");
  if (el) return el;
  el = document.createElement("div");
  el.id = "alter-panel";
  el.innerHTML = `
    <div id="alter-panel-head">
      <span id="alter-panel-title">Alter — PR review</span>
      <button id="alter-close" title="Close">×</button>
    </div>
    <div id="alter-panel-body"></div>
    <div id="alter-panel-foot"></div>`;
  document.body.appendChild(el);
  el.querySelector("#alter-close").addEventListener("click", () => {
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
      <button data-ev="comment">💬 Comment</button>
      <button data-ev="request_changes">🔴 Request changes</button>
      <button data-ev="approve">🟢 Approve</button>
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
