// Frappe Helpdesk support agent. On a ticket page (support.frappe.io/helpdesk/
// tickets/<id>) it adds Summarize / Diagnose / Draft reply, each driving the
// read-only Claude Code agent (fr to read the ticket, grep frappe code at the
// customer's version, gh for known issues) with its steps streamed live.
// Wrapped in an IIFE so its top-level declarations don't collide with the other
// content scripts sharing this page's isolated world.
(() => {
// The helpdesk this panel is on — the script only runs on helpdesk pages.
const SITE = location.host;

// Prompts live in the support skill (prompts.json); the bridge renders them.

// Triage runs on Sonnet by default — plenty for reading a ticket + checking
// code, and a fraction of Opus's usage against your 5-hour session limit.
const SUPPORT_MODEL = "sonnet";

// Shared helpers + reply voice live in shared.js (window.ALTER) — loaded first.
const { escapeHtml, humanizeErr, mini, REPLY_VOICE, REPLY_INTENT, nearBottom, stickBottom, pinToBottom } = window.ALTER;

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

function ticketId() {
  const m = location.pathname.match(/\/helpdesk\/tickets\/(\d+)/);
  return m ? m[1] : null;
}

let supSession = null;

let supRunning = false;

// Ignore re-clicks while a run is in flight: a second runVerb() would clear the
// panel body, detach the live block, and leave the first run un-stoppable.
const ctxCache = {};
async function loadContext(id) {
  if (ctxCache[id]) return ctxCache[id];
  const r = await send({ type: "ticket-context", ticket: id });
  const data = r && r.ok && r.data && r.data.markdown ? r.data : null;
  if (data) ctxCache[id] = data;
  renderContextCard(id, data, r && !r.ok ? r.error : null);
  return data;
}

function renderContextCard(id, data, err) {
  const body = document.querySelector("#sup-body");
  if (!body) return;
  const card = document.createElement("div");
  card.className = "sup-msg sup-ctx";
  if (!data) {
    card.innerHTML = `<div class="sup-step">Context: ${escapeHtml(err ? humanizeErr(err) : "unavailable — the agent will read the ticket itself")}</div>`;
    body.appendChild(card);
    return;
  }
  const t = data.ticket || {};
  const apps = (data.apps || []).map((a) => `${a.app} ${a.version || a.branch}${a.commit ? " @" + a.commit : ""}`);
  const sim = (data.similar || []).map((s) => `<a href="/helpdesk/tickets/${s.name}" target="_blank">#${s.name}</a>`).join(" ");
  card.innerHTML =
    `<div class="sup-ctx-row"><b>Site</b> ${escapeHtml(t.custom_site_name || "not set")}${t.custom_plan ? " · " + escapeHtml(t.custom_plan) : ""} · queue ${escapeHtml(t.custom_app || "?")} · ${escapeHtml(t.ticket_type || "?")}</div>` +
    `<div class="sup-ctx-row"><b>Apps</b> ${apps.length ? escapeHtml(apps.join(", ")) : "none"} <span class="sup-ctx-src">(${escapeHtml(data.apps_source || "")})</span></div>` +
    (data.hypotheses ? `<div class="sup-ctx-row"><b>Bot output</b> ${data.hypotheses} item${data.hypotheses > 1 ? "s" : ""}, treated as unverified</div>` : "") +
    (sim ? `<div class="sup-ctx-row"><b>Similar resolved</b> ${sim}</div>` : "") +
    (data.gaps && data.gaps.length ? `<div class="sup-ctx-row sup-ctx-gap"><b>Gaps</b> ${escapeHtml(data.gaps.join("; "))}</div>` : "");
  body.appendChild(card);
}

async function runVerb(verb) {
  if (supRunning) return;
  supRunning = true;
  const btns = document.querySelectorAll("#sup-actions .sup-btn");
  btns.forEach((b) => (b.disabled = true));
  try {
    await runVerbInner(verb);
  } finally {
    supRunning = false;
    btns.forEach((b) => b.isConnected && (b.disabled = false));
  }
}

async function runVerbInner(verb) {
  const id = ticketId();
  if (!id) return;
  const { models, claudeModel } = await chrome.storage.local.get(["models", "claudeModel"]);
  const connectionId = models && models.support;
  openPanel(verb);
  if (!connectionId)
    return setBody('<span class="sup-err">Pick a model for support in the Alter extension settings (use Claude Code — it needs tools).</span>');

  // Triage (summarize/diagnose/draft/follow-ups) runs on the FAST model — it's a
  // read task and a heavy model there is pure latency (7-8 min vs ~1-2). The
  // user's chosen model (claudeModel, e.g. opus) is used where reasoning changes
  // the output: the deep confirm-on-bench pass and writing the fix in Create-PR.
  supSession = {
    id,
    connectionId,
    model: SUPPORT_MODEL,
    fixModel: claudeModel != null ? claudeModel : SUPPORT_MODEL,
    transcript: [],
  };
  // One deterministic bundle (~2s) shown as a card and handed to the agent, so it
  // spends no tool calls re-reading the thread. Falls back to the agent doing it.
  await loadContext(id);
  const block = appendBlock("assistant");
  const raw = await streamAgent(block, {
    connectionId,
    includeMemory: true,
    model: supSession.model,
    support: { ticket: id, verb, site: SITE, voice: verb === "draft" ? REPLY_VOICE : "" },
    label: VERB_LABELS[verb] || verb,
  });
  supSession.last = raw;
  // Seed the transcript with this result so follow-ups carry the diagnosis as
  // context — otherwise each follow-up is a fresh run that can't see what it said.
  if (raw) supSession.transcript.push({ q: VERB_LABELS[verb] || verb, a: raw });
  if (verb === "diagnose") {
    // The fast read is a first take; the bench pass always verifies it in code
    // before the verdict is trusted.
    renderFooter();
    if (raw) {
      toast("Verifying in code on the bench…");
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
    includeMemory: true,
    model: supSession.fixModel,
    support: { ticket: supSession.id, verb: "deepen", site: SITE, transcript: t, resume: supSession.sessionId },
    label: "Confirm on bench",
  });
  supSession.transcript.push({ q: "Confirm on bench", a });
}

const VERB_LABELS = {
  summarize: "Summarize HD Ticket",
  diagnose: "Diagnose HD Ticket",
  draft: "Draft a reply for HD Ticket",
};

async function runPr() {
  if (!supSession) return;
  appendBlock("user").textContent = "Prepare fix";
  const t = supSession.transcript.map((x) => `\n\nUser: ${x.q}\nYou: ${x.a}`).join("");
  const block = appendBlock("assistant");
  const a = await streamAgent(block, {
    connectionId: supSession.connectionId,
    includeMemory: true,
    model: supSession.fixModel,
    mode: "pr",
    support: { ticket: supSession.id, verb: "pr", site: SITE, transcript: t },
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
    includeMemory: true,
    model: supSession.fixModel,
    mode: "pr-push",
    support: { ticket: supSession.id, verb: "pr_push", site: SITE, transcript: t },
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

// The handoff prompt is rendered by the bridge from the skill's prompts.json,
// carrying the panel's transcript so the target continues instead of re-triaging.
async function handoffTask(id) {
  const t = (supSession && supSession.transcript.length)
    ? supSession.transcript.map((x) => `\n\n### ${x.q}\n${x.a}`).join("")
    : "";
  const r = await send({ type: "support-prompt", ticket: id, verb: "handoff", site: SITE, transcript: t });
  if (!r || !r.ok || !r.prompt) throw new Error((r && r.error) || "Couldn't build the handoff prompt.");
  return r.prompt;
}

// Full, interactive `fr assistant` in a Terminal — all sites, read+write, but it
// PROMPTS before writes, so you stay in the loop.
async function openInAssistant() {
  const id = ticketId();
  if (!id) return;
  toast("Opening fr assistant in Terminal…");
  let task;
  try {
    task = await handoffTask(id);
  } catch (e) {
    return toast(humanizeErr(e.message), true);
  }
  const r = await send({ type: "assistant", task: task + " You have full git + gh access — confirm before any write." });
  if (!r || !r.ok) toast((r && r.error) || "Couldn't launch fr assistant.", true);
}

// Full agentic Alter chat (autonomous — Alter runs bypassPermissions). Alter
// creates the chat and starts the run itself.
async function openInAlter() {
  const id = ticketId();
  if (!id) return;
  const { models, claudeModel } = await chrome.storage.local.get(["models", "claudeModel"]);
  toast("Opening a chat in Alter and running it there…");
  let prompt;
  try {
    prompt = await handoffTask(id);
  } catch (e) {
    return toast(humanizeErr(e.message), true);
  }
  const r = await send({
    type: "open-chat",
    prompt,
    title: `HD Ticket ${id}`,
    connectionId: models && models.support,
    model: claudeModel,
  });
  if (!r || !r.ok) toast((r && r.error) || "Couldn't open Alter — is the app running?", true);
}

async function followUp(q, images) {
  if (!supSession || !q.trim()) return;
  const u = appendBlock("user");
  u.textContent = q;
  (images || []).forEach((src) => {
    const img = document.createElement("img");
    img.className = "sup-user-img";
    img.src = src;
    u.appendChild(img);
  });
  const t = supSession.transcript.map((x) => `\n\nUser: ${x.q}\nYou: ${x.a}`).join("");
  const block = appendBlock("assistant");
  const wantsReply = REPLY_INTENT.test(q);
  const a = await streamAgent(block, {
    connectionId: supSession.connectionId,
    agent: true,
    includeMemory: true,
    model: supSession.model,
    label: wantsReply ? "Draft reply" : "Follow-up",
    support: { ticket: supSession.id, verb: "followup", site: SITE, transcript: t, question: q, resume: supSession.sessionId, images: images || [], voice: wantsReply ? "Output ONLY the message text for the customer. " + REPLY_VOICE : "" },
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
      if (p.sessionId && supSession) supSession.sessionId = p.sessionId;
      renderSteps(p.steps || []);
      if (p.done) {
        done = true;
        cleanup();
        if (p.error) return fail(p.error === "run not found" ? "Alter restarted and lost this run — run it again." : p.error);
        if (!(p.text || "").trim()) return fail("The model returned an empty reply — try again.");
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
  const { claudeModel } = await chrome.storage.local.get("claudeModel");
  supSession = { id, connectionId: rec.connectionId, model: rec.model, fixModel: claudeModel || rec.model, transcript: [] };
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
      ${supSession && supSession.fixPrepared ? '<button id="sup-pr-push">Push &amp; open PR</button>' : ""}
    </div>
    <div id="sup-foot-ask"><div id="sup-ask-wrap"><div id="sup-ask-images"></div><textarea id="sup-ask" rows="1" placeholder="Ask a follow-up… (paste a screenshot, ⇧⏎ for a new line)"></textarea></div><button id="sup-ask-send">Send</button></div>`;
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
  const pushBtn = foot.querySelector("#sup-pr-push");
  if (pushBtn) pushBtn.addEventListener("click", () => runPrPush());
  const input = foot.querySelector("#sup-ask");
  const imagesEl = foot.querySelector("#sup-ask-images");
  let images = [];
  const grow = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  };
  const renderImages = () => {
    imagesEl.innerHTML = "";
    images.forEach((src, i) => {
      const chip = document.createElement("span");
      chip.className = "sup-ask-img";
      const img = document.createElement("img");
      img.src = src;
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.addEventListener("click", () => { images.splice(i, 1); renderImages(); });
      chip.append(img, x);
      imagesEl.appendChild(chip);
    });
    imagesEl.hidden = images.length === 0;
  };
  renderImages();
  const go = () => {
    const q = input.value.trim();
    if (!q && !images.length) return;
    const sent = images;
    images = [];
    input.value = "";
    renderImages();
    grow();
    followUp(q || "See the attached screenshot.", sent);
  };
  foot.querySelector("#sup-ask-send").addEventListener("click", go);
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const { selectionStart: a, selectionEnd: b, value } = input;
        input.value = value.slice(0, a) + "\n" + value.slice(b);
        input.selectionStart = input.selectionEnd = a + 1;
        grow();
      }
      return;
    }
    e.preventDefault();
    go();
  });
  input.addEventListener("paste", (e) => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    files.forEach((f) => {
      const r = new FileReader();
      r.onload = () => { images.push(String(r.result)); renderImages(); };
      r.readAsDataURL(f);
    });
  });
}

// Close the Continue menu on any outside click.
document.addEventListener("click", (e) => {
  const menu = document.getElementById("sup-menu");
  if (menu && !menu.hidden && !e.target.closest(".sup-menu-wrap")) menu.hidden = true;
});

// Helpdesk is an SPA: the URL changes without reloading. If the ticket under
// an open panel changes, drop the stale panel so it can't show the wrong ticket,
// then let reconnectIfActive pick up any run for the new one.
let lastTicketId = ticketId();
setInterval(() => {
  const id = ticketId();
  if (id !== lastTicketId) {
    lastTicketId = id;
    const panel = document.getElementById("sup-panel");
    if (panel) {
      if (activeRun) activeRun.stop();
      panel.remove();
      supSession = null;
    }
  }
  ensureButtons();
  reconnectIfActive();
}, 1500);
ensureButtons();
reconnectIfActive();
console.log("[Alter] support agent ready");
})();
