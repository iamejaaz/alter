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
