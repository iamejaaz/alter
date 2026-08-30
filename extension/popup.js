const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

const SUMMARY_SYSTEM =
  "Summarize the page for a busy reader. Lead with a one-line what-this-is, then 3-6 tight bullets of the key points. Plain text, no preamble.";

function setStatus(text, cls) {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + (cls || "");
}

async function refresh() {
  const r = await send({ type: "connections" });
  if (r && r.ok) setStatus(`Connected · ${(r.data || []).length} models`, "ok");
  else setStatus(r?.error || "Not paired — open Settings to add your token.", "err");
}

$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

$("describe-page").addEventListener("click", async () => {
  const out = $("summary");
  const { models } = await chrome.storage.local.get("models");
  const connectionId = models && models.summarize;
  if (!connectionId) {
    out.innerHTML = '<span class="err">Pick a page-summary model in Settings first.</span>';
    return;
  }
  out.textContent = "Reading the page…";
  let text = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.body.innerText.slice(0, 20000),
    });
    text = res.result || "";
  } catch {
    out.innerHTML = '<span class="err">Can\'t read this page (try a normal http/https tab).</span>';
    return;
  }
  if (!text.trim()) {
    out.innerHTML = '<span class="err">No readable text on this page.</span>';
    return;
  }
  out.textContent = "Summarizing…";
  const r = await send({ type: "run", connectionId, system: SUMMARY_SYSTEM, prompt: text });
  if (r && r.ok && r.data && r.data.content) {
    out.style.color = "";
    out.textContent = r.data.content;
  } else {
    out.style.color = "#f87171";
    out.textContent = (r && r.error) || "No response — is the Alter app running?";
  }
});

refresh();
