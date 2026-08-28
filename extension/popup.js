const $ = (id) => document.getElementById(id);
const ACTIONS = ["prReview", "grammar", "support", "summarize"];

const SUMMARY_SYSTEM =
  "Summarize the page for a busy reader. Lead with a one-line what-this-is, then 3-6 tight bullets of the key points. Plain text, no preamble.";

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

function setStatus(text, cls) {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + (cls || "");
}

async function loadConnections() {
  const stored = await chrome.storage.local.get(["token", "models"]);
  $("token").value = stored.token || "";
  const models = stored.models || {};

  const r = await send({ type: "connections" });
  if (!r || !r.ok) {
    setStatus(r?.error || "Not paired yet — paste your token and Save.", "err");
    ACTIONS.forEach((a) => ($("m-" + a).innerHTML = "<option>—</option>"));
    return;
  }
  const conns = r.data || [];
  const claude = conns.find((c) => c.isClaudeCode);
  ACTIONS.forEach((a) => {
    const sel = $("m-" + a);
    sel.innerHTML = "";
    // Support needs a tool-capable agent — default it to Claude Code.
    const preferred = models[a] || (a === "support" && claude ? claude.id : null);
    conns.forEach((c) => {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.name;
      if (preferred === c.id) o.selected = true;
      sel.appendChild(o);
    });
  });
  // Persist whatever is shown (defaults included) so an untouched dropdown still
  // counts as a real choice — otherwise its action reports "no model".
  await saveModels();
  setStatus(`Connected · ${conns.length} models`, "ok");
}

async function saveModels() {
  const models = {};
  ACTIONS.forEach((a) => (models[a] = $("m-" + a).value));
  await chrome.storage.local.set({ models });
}

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ token: $("token").value.trim() });
  setStatus("Saved. Checking…");
  loadConnections();
});

ACTIONS.forEach((a) => $("m-" + a).addEventListener("change", saveModels));

$("describe-page").addEventListener("click", async () => {
  const out = $("summary");
  const connectionId = $("m-summarize").value;
  if (!connectionId) {
    out.innerHTML = '<span class="err">Pick a model for page summary first.</span>';
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
  out.textContent = r && r.ok ? r.data.content : (r && r.error) || "Failed.";
  if (!r || !r.ok) out.innerHTML = `<span class="err">${out.textContent}</span>`;
});

loadConnections();
