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
    out.textContent = window.ALTER.humanizeErr(r && r.error);
  }
});

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

function runRow(r) {
  const row = document.createElement("div");
  row.className = "run";
  const mark = document.createElement("span");
  mark.className = "run-mark" + (r.error ? " run-fail" : "");
  if (!r.done) mark.innerHTML = '<span class="run-dot"></span>';
  else mark.textContent = r.error ? "✕" : "✓";
  const main = document.createElement("div");
  main.className = "run-main";
  const label = document.createElement(r.url ? "a" : "span");
  label.className = "run-label";
  label.textContent = r.label;
  if (r.url) {
    label.href = r.url;
    label.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: r.url });
    });
  }
  const sub = document.createElement("div");
  sub.className = "run-sub" + (r.error ? " run-fail" : "");
  sub.textContent = r.done
    ? `${r.error ? r.error : "Finished"} · ${ago(r.startedAt)} ago`
    : `${r.step || "Starting"} · ${ago(r.startedAt)}`;
  main.append(label, sub);
  row.append(mark, main);
  if (!r.done) {
    const stop = document.createElement("button");
    stop.className = "run-stop";
    stop.textContent = "Stop";
    stop.addEventListener("click", async () => {
      stop.disabled = true;
      await send({ type: "cancel", runId: r.runId });
      loadRuns();
    });
    row.append(stop);
  } else {
    const x = document.createElement("button");
    x.className = "run-stop run-x";
    x.textContent = "×";
    x.title = "Remove";
    x.addEventListener("click", async () => {
      row.remove();
      await send({ type: "dismiss", runId: r.runId });
      loadRuns();
    });
    row.append(x);
  }
  return row;
}

async function loadRuns() {
  const box = $("runs");
  const r = await send({ type: "runs" });
  const list = r && r.ok ? r.data : [];
  box.innerHTML = "";
  const running = list.filter((x) => !x.done);
  const done = list.filter((x) => x.done).slice(0, 4);
  const section = (title, items, clear) => {
    if (!items.length) return;
    const h = document.createElement("div");
    h.className = "runs-h";
    h.textContent = title;
    if (clear) {
      const c = document.createElement("button");
      c.className = "runs-clear";
      c.textContent = "Clear";
      c.addEventListener("click", async () => {
        await send({ type: "dismiss" });
        loadRuns();
      });
      h.append(c);
    }
    box.append(h, ...items.map(runRow));
  };
  section(running.length ? `Running now · ${running.length}` : "", running);
  section("Recently finished", done, true);
  if (running.length) setTimeout(loadRuns, 3000);
}

refresh();
loadRuns();
