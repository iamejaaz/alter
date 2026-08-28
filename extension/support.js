// Frappe Helpdesk support agent. On a ticket page (support.frappe.io/helpdesk/
// tickets/<id>) it adds Summarize / Diagnose / Draft reply, each driving the
// read-only Claude Code agent (fr to read the ticket, grep frappe code at the
// customer's version, gh for known issues) with its steps streamed live.
// Wrapped in an IIFE so its top-level declarations don't collide with the other
// content scripts sharing this page's isolated world.
(() => {
const SUPPORT_SYSTEM = [
  "You are Ejaaz's Frappe support engineer, triaging a ticket on support.frappe.io.",
  "You have READ-ONLY tools: `fr` (frappectl, default profile = support.frappe.io) to read tickets/docs/SQL, Read/Grep/Glob over the local frappe checkout, git to inspect any version, and gh + WebFetch for frappe/frappe issues/PRs.",
  "Always: read the ticket first with `fr doc get \"HD Ticket\" <id>` (and `fr query`/`fr doctype` for related data); identify the customer's Frappe version.",
  "When verifying behavior, check the code AT THE CUSTOMER'S VERSION (e.g. `git show <ref>:path`) and state which ref you checked — never trust the working branch as the customer's reality, and never invent behavior.",
  "Follow the user's standing preferences for voice. Be terse. If a command is denied, fall back to Read/Grep/WebFetch.",
].join(" ");

const VERBS = {
  summarize: (id) =>
    `Summarize HD Ticket ${id}: the issue in one line, customer + product/version, urgency, and what they've already tried. Terse.`,
  diagnose: (id) =>
    `Diagnose HD Ticket ${id} as a senior support engineer. Read it via fr. Classify it: functional-query vs bug vs config/user-error. Find the root cause, verify it against the code at the customer's version (state the ref), and check gh for an existing issue/PR. Output: **Classification**, **Root cause** (with the ref you checked), **Known issue/PR** (if any), **Suggested next step**.`,
  draft: (id) =>
    `Draft a reply to the customer for HD Ticket ${id} in my voice. Read it via fr and verify any facts against the code/gh. Accurate, friendly, terse. Output ONLY the reply text, ready to paste.`,
};

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
const SEP = String.fromCharCode(1); // wraps ▸ step markers in the agent stream

function ticketId() {
  const m = location.pathname.match(/\/helpdesk\/tickets\/(\d+)/);
  return m ? m[1] : null;
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
  const { models } = await chrome.storage.local.get("models");
  const connectionId = models && models.support;
  openPanel(verb);
  if (!connectionId)
    return setBody('<span class="sup-err">Pick a model for support in the Alter popup (use Claude Code — it needs tools).</span>');

  supSession = { id, connectionId, transcript: [] };
  const block = appendBlock("assistant");
  const raw = await streamAgent(block, {
    connectionId,
    agent: true,
    includeMemory: true,
    system: SUPPORT_SYSTEM,
    prompt: VERBS[verb](id),
  });
  supSession.last = raw;
  renderFooter();
}

async function followUp(q) {
  if (!supSession || !q.trim()) return;
  appendBlock("user").textContent = q;
  const t = supSession.transcript.map((x) => `\n\nUser: ${x.q}\nYou: ${x.a}`).join("");
  const block = appendBlock("assistant");
  const a = await streamAgent(block, {
    connectionId: supSession.connectionId,
    agent: true,
    includeMemory: true,
    system: SUPPORT_SYSTEM,
    prompt: `We are discussing HD Ticket ${supSession.id}.${t}\n\nUser: ${q}\nYou:`,
  });
  supSession.transcript.push({ q, a });
}

// Reliable path: MV3 service-worker streaming can stall, so when the live
// stream produces nothing we fall back to the plain (non-streaming) /run, which
// returns the whole answer at once. Loses live steps but always completes.
async function nonStreamFallback(el, params) {
  el.innerHTML = '<span style="color:#a1a1aa">Working… (live steps unavailable — waiting for the full answer)</span>';
  const r = await send({
    type: "run",
    connectionId: params.connectionId,
    agent: params.agent,
    includeMemory: params.includeMemory,
    system: params.system,
    prompt: params.prompt,
  });
  if (r && r.ok && r.data && r.data.content) {
    el.innerHTML = mini(r.data.content);
    return r.data.content;
  }
  el.innerHTML = `<span class="sup-err">${escapeHtml((r && r.error) || "No response — check the Alter app is running.")}</span>`;
  return "";
}

function streamAgent(el, params) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let full = "";
    let finished = false;
    const scroll = () => {
      const body = document.querySelector("#sup-body");
      if (body) body.scrollTop = body.scrollHeight;
    };
    const tick = setInterval(() => {
      if (finished || full) return;
      const s = Math.round((Date.now() - t0) / 1000);
      el.innerHTML = `<span style="color:#a1a1aa">Working… ${s}s</span>`;
    }, 1000);
    let timer;
    const stop = () => {
      finished = true;
      clearInterval(tick);
      clearTimeout(timer);
      try { port.disconnect(); } catch {}
    };
    const fallback = () => {
      if (finished) return;
      stop();
      nonStreamFallback(el, params).then(resolve);
    };
    // First-token watchdog: if the stream delivers nothing in 25s, the worker
    // likely dropped it — switch to the reliable non-streaming path instead of
    // waiting out a long timeout.
    let firstToken = setTimeout(fallback, 25000);
    // Idle timeout while actively streaming — re-armed on each token.
    const armIdle = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(fallback, ms);
    };

    el.innerHTML = '<span style="color:#a1a1aa">Working… 0s</span>';
    const port = chrome.runtime.connect({ name: "run-stream" });
    port.postMessage(params);
    port.onMessage.addListener((m) => {
      if (finished) return;
      if (m.delta) {
        clearTimeout(firstToken);
        armIdle(90000);
        full += m.delta;
        el.innerHTML = renderStream(full) || '<span style="color:#a1a1aa">Working…</span>';
        scroll();
      } else if (m.error) {
        // Stream errored — try the reliable path before giving up.
        fallback();
      } else if (m.done) {
        clearTimeout(firstToken);
        const clean = cleanText(full);
        if (!full) {
          fallback(); // empty stream → non-streaming retry
          return;
        }
        stop();
        if (!clean) el.innerHTML = renderStream(full);
        resolve(clean);
      }
    });
  });
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
          <button id="sup-copy" title="Copy">Copy</button>
          <button id="sup-close" title="Close">×</button>
        </div>
      </div>
      <div id="sup-body"></div>
      <div id="sup-foot"></div>`;
    document.body.appendChild(el);
    el.querySelector("#sup-close").addEventListener("click", () => {
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
  foot.innerHTML = `<input id="sup-ask" placeholder="Ask a follow-up…" /><button id="sup-ask-send">Send</button>`;
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

setInterval(ensureButtons, 1500);
ensureButtons();
console.log("[Alter] support agent ready");
})();
