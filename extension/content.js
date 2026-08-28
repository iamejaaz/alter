// Injected on GitHub PR pages. Adds a "Review with Alter" button that pulls the
// PR diff and runs it through the model you picked for PR review in the popup.

const REVIEW_SYSTEM = [
  "You are reviewing a GitHub pull request as a senior maintainer of this project.",
  "Judge with a maintainer's lens: cleanest mechanism, root cause fixed, no state residue — not just 'it works'.",
  "Write terse, @author-addressed comments in plain English. No preamble, no meta, no praise-fluff.",
  "Explain each issue as a plain before/after example where useful (user does X → shows Y → PR shows worse Z); defer file/line/mechanism until needed.",
  "Scan test data / fixtures for real domains, emails, names, or keys — flag any PII (expect example.com).",
  "No premature victory — progress is distance-to-parity with the real thing.",
  "Output: a one-line verdict, then a short bulleted list of the highest-signal issues (most severe first), each with file:line. If it's clean, say so plainly.",
].join(" ");

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

function prParts() {
  const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], num: m[3] } : null;
}

async function review() {
  const parts = prParts();
  if (!parts) return;
  const { models } = await chrome.storage.local.get("models");
  const connectionId = models && models.prReview;
  if (!connectionId) {
    panel("Pick a model for PR review in the Alter extension popup first.", true);
    return;
  }

  panel("Fetching the diff…");
  let diff = "";
  try {
    const url = `${location.origin}/${parts.owner}/${parts.repo}/pull/${parts.num}.diff`;
    const res = await fetch(url, { credentials: "same-origin" });
    diff = await res.text();
  } catch {
    panel("Couldn't fetch the PR diff.", true);
    return;
  }
  if (!diff.trim()) {
    panel("Empty diff — nothing to review.", true);
    return;
  }

  let note = "";
  const CAP = 60000;
  if (diff.length > CAP) {
    diff = diff.slice(0, CAP);
    note = "\n\n[diff truncated to first 60k chars]";
  }

  panel("Reviewing… (this can take a few seconds)");
  const r = await send({
    type: "run",
    connectionId,
    system: REVIEW_SYSTEM,
    prompt: `Review this pull request diff (${parts.owner}/${parts.repo}#${parts.num}):\n\n${diff}${note}`,
  });
  if (!r || !r.ok) {
    panel(r?.error || "Review failed.", true);
    return;
  }
  panel(r.data.content || "(empty response)");
}

function ensureButton() {
  if (!prParts()) return;
  if (document.getElementById("alter-review-btn")) return;
  const btn = document.createElement("button");
  btn.id = "alter-review-btn";
  btn.textContent = "Review with Alter";
  btn.addEventListener("click", review);
  document.body.appendChild(btn);
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function mini(md) {
  return escapeHtml(md)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function panel(content, isError) {
  let el = document.getElementById("alter-panel");
  if (!el) {
    el = document.createElement("div");
    el.id = "alter-panel";
    el.innerHTML = `
      <div id="alter-panel-head">
        <span>Alter — PR review</span>
        <div>
          <button id="alter-copy" title="Copy">Copy</button>
          <button id="alter-close" title="Close">×</button>
        </div>
      </div>
      <div id="alter-panel-body"></div>`;
    document.body.appendChild(el);
    el.querySelector("#alter-close").addEventListener("click", () => el.remove());
  }
  const body = el.querySelector("#alter-panel-body");
  body.innerHTML = isError ? `<span class="alter-err">${escapeHtml(content)}</span>` : mini(content);
  const copy = el.querySelector("#alter-copy");
  copy.onclick = () => {
    navigator.clipboard.writeText(content);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1500);
  };
}

setInterval(ensureButton, 1500);
ensureButton();
