// Talks to the Alter desktop app's local bridge. Content scripts run in the
// page origin (https) and can't reach http://localhost (mixed content), so all
// bridge calls funnel through this service worker, which holds the token.

const BRIDGE = "http://127.0.0.1:8765";

async function bridge(path, opts = {}) {
  const { token } = await chrome.storage.local.get("token");
  const res = await fetch(BRIDGE + path, {
    ...opts,
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
  const { models } = await chrome.storage.local.get("models");
  const connectionId = models && models.grammar;
  if (!connectionId) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => alert("Pick a grammar model in the Alter extension popup first.") });
    return;
  }
  const r = await bridge("/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId, system: GRAMMAR_SYSTEM, prompt: text }),
  });
  if (!r.ok || !r.body.content) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (m) => alert("Alter: " + m), args: [r.body.error || "grammar fix failed"] });
    return;
  }
  chrome.scripting.executeScript({ target: { tabId: tab.id }, func: replaceSelectionInPage, args: [r.body.content] });
});

// Streaming variant: a long-lived port streams model tokens to the content
// script as they arrive, so the panel fills in live instead of hanging.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "run-stream") return;
  port.onMessage.addListener(async (msg) => {
    // MV3 kills the service worker after ~30s idle — during a long agent run
    // (10–30s before the first token) that would abort the streaming read. Ping
    // a chrome API every 20s to keep the worker alive until the stream ends.
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
    try {
      const { token } = await chrome.storage.local.get("token");
      const res = await fetch(BRIDGE + "/run-stream", {
        method: "POST",
        headers: { Authorization: "Bearer " + (token || ""), "Content-Type": "application/json" },
        body: JSON.stringify(msg),
      });
      if (!res.ok || !res.body) {
        port.postMessage({ error: res.status === 401 ? "Wrong or missing token — set it in the popup." : "Bridge error " + res.status });
        port.postMessage({ done: true });
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true });
        if (text) port.postMessage({ delta: text });
      }
      port.postMessage({ done: true });
    } catch (e) {
      port.postMessage({ error: "Stream dropped — " + (e && e.message ? e.message : "check the Alter app is running.") });
      port.postMessage({ done: true });
    } finally {
      clearInterval(keepAlive);
    }
  });
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
          }),
        });
        sendResponse(r.ok ? { ok: true, data: r.body } : { ok: false, error: r.body.error || hint(r) });
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
  if (r.status === 401) return "Wrong or missing token — set it in the Alter extension popup.";
  return "Bridge error " + r.status;
}
