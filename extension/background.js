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
  if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT") && el.selectionStart != null && el.selectionEnd > el.selectionStart) {
    el.setRangeText(corrected, el.selectionStart, el.selectionEnd, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
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
      } else if (msg.type === "run") {
        const r = await bridge("/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectionId: msg.connectionId,
            system: msg.system,
            prompt: msg.prompt,
          }),
        });
        sendResponse(r.ok ? { ok: true, data: r.body } : { ok: false, error: r.body.error || hint(r) });
      }
    } catch (e) {
      sendResponse({ ok: false, error: "Can't reach Alter. Is the app running?" });
    }
  })();
  return true; // keep the channel open for the async reply
});

function hint(r) {
  if (r.status === 401) return "Wrong or missing token — set it in the Alter extension popup.";
  return "Bridge error " + r.status;
}
