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

function streamAgent(el, params) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let full = "";
    let finished = false;
    const scroll = () => {
      const body = document.querySelector("#sup-body");
      if (body) body.scrollTop = body.scrollHeight;
    };
    // Live elapsed counter while we wait for the first token, so it's obviously
    // alive (agent startup + fr + grep can take 10–30s) rather than stuck.
    const tick = setInterval(() => {
      if (finished || full) return;
      const s = Math.round((Date.now() - t0) / 1000);
      const hint = s > 40 ? " — agent tasks can take a minute; make sure the Alter app is running" : "";
      el.innerHTML = `<span style="color:#a1a1aa">Working… ${s}s${hint}</span>`;
    }, 1000);
    let timer;
    const stop = () => {
      finished = true;
      clearInterval(tick);
      clearTimeout(timer);
    };
    // Idle timeout — re-armed on each token, so a long agent run (many tool
    // steps) never gets falsely cut off; only a truly stuck one does.
    const armIdle = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (finished) return;
        stop();
        try { port.disconnect(); } catch {}
        if (!full) el.innerHTML = `<span class="sup-err">No output for a while — the agent may be stuck. Check the Alter app is running.</span>`;
        resolve(cleanText(full));
      }, ms);
    };
    armIdle(120000);

    el.innerHTML = '<span style="color:#a1a1aa">Working… 0s</span>';
    const port = chrome.runtime.connect({ name: "run-stream" });
    port.postMessage(params);
    port.onMessage.addListener((m) => {
      if (finished) return; // ignore the trailing done that follows an error
      if (m.delta) {
        armIdle(90000);
        full += m.delta;
        el.innerHTML = renderStream(full) || '<span style="color:#a1a1aa">Working…</span>';
        scroll();
      } else if (m.error) {
        stop();
        try { port.disconnect(); } catch {}
        el.innerHTML = full
          ? renderStream(full) + `<div class="sup-err">⚠ ${escapeHtml(m.error)}</div>`
          : `<span class="sup-err">${escapeHtml(m.error)}</span>`;
        resolve(cleanText(full));
      } else if (m.done) {
        stop();
        port.disconnect();
        const clean = cleanText(full);
        if (!full) {
          el.innerHTML =
            '<span class="sup-err">No response — check the Alter app is running and a Claude Code model is selected for support.</span>';
        } else if (!clean) {
          el.innerHTML = renderStream(full); // steps only, no final text
        }
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
