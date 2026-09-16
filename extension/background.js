// Talks to the Alter desktop app's local bridge. Content scripts run in the
// page origin (https) and can't reach http://localhost (mixed content), so all
// bridge calls funnel through this service worker, which holds the token.

importScripts("shared.js");

const BRIDGE = "http://127.0.0.1:8765";

async function bridge(path, opts = {}) {
  const { token } = await chrome.storage.local.get("token");
  const res = await fetch(BRIDGE + path, {
    ...opts,
    signal: opts.signal || AbortSignal.timeout(180_000),
    headers: { ...(opts.headers || {}), Authorization: "Bearer " + (token || "") },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// Right-click "Fix grammar with Alter" — the browser hands us the exact
// selection (info.selectionText), so this works in any editor GitHub uses,
// shadow DOM or not, with no selection-detection guesswork.
const GRAMMAR_SYSTEM =
  "You are a precise copy editor. Fix spelling, grammar, and punctuation. Preserve meaning, tone, and formatting. Do not add, remove, or rephrase beyond fixing errors. Reply with ONLY the corrected text — no quotes, no commentary.";

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "alter-fix-grammar",
      title: "Fix grammar with Alter",
      contexts: ["editable"],
    });
  });
}
chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

// Injected into the page to swap the current selection for the corrected text.
function replaceSelectionInPage(corrected) {
  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }
  const el = deepActive();
  if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
    // Only replace a real range — never insertText into an input with a
    // collapsed selection, which would append the fix alongside the original.
    if (el.selectionStart != null && el.selectionEnd > el.selectionStart) {
      el.setRangeText(corrected, el.selectionStart, el.selectionEnd, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    return false;
  }
  // contenteditable / rich editors: insertText replaces the live selection.
  const ok = document.execCommand && document.execCommand("insertText", false, corrected);
  return !!ok;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "alter-fix-grammar") return;
  const text = (info.selectionText || "").trim();
  if (!text || !tab) return;
  // Keep the worker alive through a slow model — MV3 idles it out after ~30s.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  setTimeout(() => clearInterval(keepAlive), 190_000);
  const { models } = await chrome.storage.local.get("models");
  const connectionId = models && models.grammar;
  if (!connectionId) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => alert("Pick a grammar model in the Alter extension settings first.") });
    return;
  }
  const tell = (m) =>
    chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (x) => alert("Alter: " + x), args: [m] });
  let r;
  try {
    r = await bridge("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId, system: GRAMMAR_SYSTEM, prompt: text }),
    });
  } catch {
    tell("Can't reach Alter. Is the app running?");
    return;
  }
  if (!r.ok || !r.body.content) {
    tell(r.body.error ? ALTER.humanizeErr(r.body.error) : hint(r));
    return;
  }
  chrome.scripting.executeScript({ target: { tabId: tab.id }, func: replaceSelectionInPage, args: [r.body.content] });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
    try {
      if (msg.type === "diff") {
        // GitHub's .diff 302-redirects to patch-diff.githubusercontent.com (a
        // different origin), so a page-context fetch is CORS-blocked. The worker
        // has host permissions and can follow it, with the user's session.
        const res = await fetch(msg.url, { credentials: "include" });
        if (!res.ok) {
          sendResponse({ ok: false, error: "GitHub returned " + res.status });
          return;
        }
        sendResponse({ ok: true, text: await res.text() });
      } else if (msg.type === "support-start" || msg.type === "support-prompt") {
        const r = await bridge("/support", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ticket: msg.ticket, verb: msg.verb, connectionId: msg.connectionId, site: msg.site, voice: msg.voice,
            transcript: msg.transcript, question: msg.question, resume: msg.resume, images: msg.images, issue: msg.issue, model: msg.model, runId: msg.runId, includeMemory: msg.includeMemory,
            renderOnly: msg.type === "support-prompt",
          }),
        });
        sendResponse(r.ok ? { ok: true, runId: r.body.runId, prompt: r.body.prompt, system: r.body.system } : { ok: false, error: r.body.error || hint(r) });
      } else if (msg.type === "ticket-context") {
        const r = await bridge("/ticket-context", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket: msg.ticket }) });
        sendResponse(r.ok ? { ok: true, data: r.body } : { ok: false, error: r.body && r.body.error ? r.body.error : hint(r) });
      } else if (msg.type === "repro-info") {
        const r = await bridge("/repro-info");
        sendResponse(r.ok ? { ok: true, data: r.body } : { ok: false, error: hint(r) });
      } else if (msg.type === "connections") {
        const r = await bridge("/connections");
        sendResponse(r.ok ? { ok: true, data: r.body } : { ok: false, error: hint(r) });
      } else if (msg.type === "gh-checks") {
        const r = await bridge("/gh-checks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: msg.repo, num: msg.num }),
        });
        sendResponse(r.ok ? { ok: true, text: r.body.output || "" } : { ok: false, error: hint(r) });
      } else if (msg.type === "gh") {
        const r = await bridge("/gh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: msg.repo, num: msg.num, body: msg.body, event: msg.event, comments: msg.comments || [] }),
        });
        sendResponse(r.ok ? { ok: true, note: r.body.note || "" } : { ok: false, error: r.body.error || hint(r) });
      } else if (msg.type === "gh-bot") {
        const json = JSON.stringify(msg.review || {});
        const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
        const r = await bridge("/gh-bot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: msg.repo, num: msg.num, review_b64: b64 }),
        });
        sendResponse(r.ok ? { ok: true } : { ok: false, error: r.body.error || hint(r) });
      } else if (msg.type === "run") {
        const r = await bridge("/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectionId: msg.connectionId,
            system: msg.system,
            prompt: msg.prompt,
            agent: msg.agent,
            includeMemory: msg.includeMemory,
            model: msg.model,
            runId: msg.runId,
          }),
        });
        sendResponse(r.ok ? { ok: true, data: r.body } : { ok: false, error: r.body.error || hint(r) });
      } else if (msg.type === "agent-start") {
        const r = await bridge("/agent-start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectionId: msg.connectionId,
            system: msg.system,
            prompt: msg.prompt,
            includeMemory: msg.includeMemory,
            model: msg.model,
            runId: msg.runId,
            mode: msg.mode,
          }),
        });
        sendResponse(r.ok ? { ok: true, runId: r.body.runId } : { ok: false, error: r.body.error || hint(r) });
      } else if (msg.type === "agent-poll") {
        const r = await bridge("/agent-poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: msg.runId }),
        });
        sendResponse(r.ok ? { ok: true, data: r.body } : { ok: false, error: hint(r) });
      } else if (msg.type === "open-chat") {
        const r = await bridge("/open-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: msg.prompt, title: msg.title, connectionId: msg.connectionId, model: msg.model }),
        });
        sendResponse(r.ok ? { ok: true } : { ok: false, error: r.body.error || hint(r) });
      } else if (msg.type === "assistant") {
        const r = await bridge("/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task: msg.task }),
        });
        sendResponse(r.ok ? { ok: true } : { ok: false, error: r.body.error || hint(r) });
      } else if (msg.type === "cancel") {
        const r = await bridge("/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: msg.runId }),
        });
        sendResponse(r.ok ? { ok: true } : { ok: false, error: r.body.error || hint(r) });
      } else if (msg.type === "fr-write") {
        const r = await bridge("/fr-write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.write),
        });
        sendResponse(r.ok ? { ok: true, output: r.body.output || "" } : { ok: false, error: r.body.error || hint(r) });
      } else {
        sendResponse({ ok: false, error: "Unknown request type: " + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: "Can't reach Alter. Is the app running?" });
    } finally {
      clearInterval(keepAlive);
    }
  })();
  return true; // keep the channel open for the async reply
});

function hint(r) {
  if (r.status === 401) return "Wrong or missing token — set it in the Alter extension settings.";
  return "Bridge error " + r.status;
}


// A custom helpdesk site (options page) gets the support panel via a dynamically
// registered content script; support.frappe.io stays in the manifest as default.
async function registerHelpdesk() {
  const { helpdeskSite } = await chrome.storage.local.get("helpdeskSite");
  const id = "alter-helpdesk";
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
  } catch {}
  let origin = "";
  try {
    origin = helpdeskSite ? new URL(helpdeskSite.includes("://") ? helpdeskSite : "https://" + helpdeskSite).origin : "";
  } catch {}
  if (!origin || /support\.frappe\.io$/.test(origin)) return;
  const granted = await chrome.permissions.contains({ origins: [origin + "/*"] });
  if (!granted) return;
  await chrome.scripting.registerContentScripts([
    { id, matches: [origin + "/*"], js: ["shared.js", "support.js"], css: ["support.css"], runAt: "document_idle" },
  ]);
}
chrome.runtime.onInstalled.addListener(() => void registerHelpdesk());
chrome.runtime.onStartup.addListener(() => void registerHelpdesk());
chrome.storage.onChanged.addListener((c) => {
  if (c.helpdeskSite) void registerHelpdesk();
});

// Auto-review: a "review requested" / "assigned" entry in the GitHub notifications
// feed starts the same review the panel would, keeps its runId under the PR key
// so opening the PR page reconnects to it, and posts the result as frappe-pr-bot
// (or only notifies when auto-post is off).
const AUTO_ALARM = "alter-auto-review";
const AUTO_POLL = "alter-auto-poll";
const AUTO_STORE = "auto_reviews";
const notifyUrls = {};

async function syncAutoReview() {
  const { autoReview } = await chrome.storage.local.get("autoReview");
  if (autoReview) chrome.alarms.create(AUTO_ALARM, { periodInMinutes: 1, delayInMinutes: 0.1 });
  else {
    chrome.alarms.clear(AUTO_ALARM);
    chrome.alarms.clear(AUTO_POLL);
  }
}

function notify(id, title, message, url) {
  chrome.notifications.create(id, { type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 1 });
  if (url) notifyUrls[id] = url;
}
chrome.notifications.onClicked.addListener((id) => {
  if (notifyUrls[id]) chrome.tabs.create({ url: notifyUrls[id] });
  chrome.notifications.clear(id);
});

async function autoReviewTick() {
  const { models, claudeModel, pr_active_runs, autoReviewSince } = await chrome.storage.local.get(["models", "claudeModel", "pr_active_runs", "autoReviewSince"]);
  const connectionId = models && models.prReview;
  if (!connectionId) return;
  const store = (await chrome.storage.local.get(AUTO_STORE))[AUTO_STORE] || {};
  const r = await bridge("/review-requests");
  if (!r.ok || !Array.isArray(r.body)) return;
  const runs = pr_active_runs || {};
  let started = 0;
  for (const pr of r.body) {
    const key = `${pr.owner}/${pr.repo}#${pr.num}`;
    if (runs[key] || Date.parse(pr.updated) < (autoReviewSince || 0)) continue;
    if (store[key] && (store[key].updated || 0) >= Date.parse(pr.updated)) continue;
    const chk = await bridge("/pr-reviewed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: `${pr.owner}/${pr.repo}`, num: String(pr.num) }) });
    if (!chk.ok) continue;
    if (chk.body.reviewed || chk.body.own) {
      store[key] = { runId: "", url: pr.url, title: pr.title, ts: Date.now(), updated: Date.parse(pr.updated), notified: true, skipped: chk.body.own ? "own PR" : "already reviewed" };
      continue;
    }
    const runId = crypto.randomUUID();
    const prompt = `Review ${key} with the frappe-pr-review skill.\n\nRead the PR author's GitHub handle from \`gh pr view\` and address them by it.\n\n`;
    const s = await bridge("/agent-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId, system: ALTER.REVIEW_SYSTEM, prompt, includeMemory: true, model: claudeModel || undefined, runId }),
    });
    if (!s.ok) continue;
    runs[key] = { key, runId, connectionId, model: claudeModel || undefined, label: "review" };
    store[key] = { runId, url: pr.url, title: pr.title, ts: Date.now(), updated: Date.parse(pr.updated), notified: false };
    notify("start-" + runId, `Reviewing #${pr.num} (${pr.reason === "assign" ? "assigned" : "review requested"})`, pr.title, pr.url);
    started++;
  }
  const week = 7 * 24 * 3600 * 1000;
  for (const k of Object.keys(store)) if (Date.now() - store[k].ts > week) delete store[k];
  await chrome.storage.local.set({ pr_active_runs: runs, [AUTO_STORE]: store });
  if (started || Object.values(store).some((x) => !x.notified)) chrome.alarms.create(AUTO_POLL, { periodInMinutes: 0.5 });
}

async function autoPollTick() {
  const store = (await chrome.storage.local.get(AUTO_STORE))[AUTO_STORE] || {};
  let pending = 0;
  for (const [key, rec] of Object.entries(store)) {
    if (rec.notified) continue;
    const r = await bridge("/agent-poll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: rec.runId }) });
    const p = r.ok ? r.body : null;
    if (!p || !p.done) {
      pending++;
      continue;
    }
    rec.notified = true;
    const num = key.split("#")[1];
    if (p.error === "run not found") continue;
    if (p.error) notify("done-" + rec.runId, `Review failed for #${num}`, p.error.slice(0, 120), rec.url);
    else {
      const verdict = ((p.text || "").split("\n").find((l) => l.trim()) || "Review ready").replace(/[*_`#]/g, "").slice(0, 120);
      const { autoReviewPost } = await chrome.storage.local.get("autoReviewPost");
      const j = autoReviewPost !== false ? ALTER.reviewJson(p.text) : null;
      if (j && (j.comments.length || (j.body || "").trim())) {
        const [repo, prNum] = key.split("#");
        const review = { event: j.event || "COMMENT", body: j.body || "", comments: j.comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })) };
        const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(review))));
        const post = await bridge("/gh-bot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo, num: prNum, review_b64: b64 }) });
        notify("done-" + rec.runId, post.ok ? `Posted as frappe-pr-bot on #${num}` : `Review ready for #${num}, bot post failed`, post.ok ? verdict : (post.body.error || "").slice(0, 120), rec.url);
      } else notify("done-" + rec.runId, `Review ready for #${num}`, verdict, rec.url);
    }
  }
  await chrome.storage.local.set({ [AUTO_STORE]: store });
  if (!pending) chrome.alarms.clear(AUTO_POLL);
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === AUTO_ALARM) autoReviewTick().catch(() => {});
  if (a.name === AUTO_POLL) autoPollTick().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => void syncAutoReview());
chrome.runtime.onStartup.addListener(() => void syncAutoReview());
chrome.storage.onChanged.addListener((c) => {
  if (c.autoReview) syncAutoReview();
});
