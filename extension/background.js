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
          body: JSON.stringify({ repo: msg.repo, num: msg.num, body: msg.body, event: msg.event }),
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
