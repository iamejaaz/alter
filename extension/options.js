const $ = (id) => document.getElementById(id);
const ACTIONS = ["prReview", "grammar", "support", "summarize"];

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

function setStatus(text, cls) {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + (cls || "");
}

async function loadConnections() {
  const stored = await chrome.storage.local.get(["token", "models", "claudeModel"]);
  $("token").value = stored.token || "";
  $("claude-model").value = stored.claudeModel != null ? stored.claudeModel : "sonnet";

  const r = await send({ type: "connections" });
  if (!r || !r.ok) {
    setStatus(r?.error || "Not paired yet — paste your token and Save.", "err");
    ACTIONS.forEach((a) => ($("m-" + a).innerHTML = "<option>—</option>"));
    return;
  }
  const conns = r.data || [];
  const models = stored.models || {};
  const claude = conns.find((c) => c.isClaudeCode);
  ACTIONS.forEach((a) => {
    const sel = $("m-" + a);
    sel.innerHTML = "";
    const preferred = models[a] || (a === "support" && claude ? claude.id : null);
    conns.forEach((c) => {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.name;
      if (preferred === c.id) o.selected = true;
      sel.appendChild(o);
    });
  });
  await saveModels();
  setStatus(`Connected · ${conns.length} models`, "ok");
}

async function saveModels() {
  const models = {};
  ACTIONS.forEach((a) => (models[a] = $("m-" + a).value));
  await chrome.storage.local.set({ models, claudeModel: $("claude-model").value });
}

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ token: $("token").value.trim() });
  setStatus("Saved. Checking…");
  loadConnections();
});

ACTIONS.forEach((a) => $("m-" + a).addEventListener("change", saveModels));
$("claude-model").addEventListener("change", saveModels);

loadConnections();
