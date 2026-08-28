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

const DESC_SYSTEM = [
  "Write a short, clean GitHub PR description from the diff.",
  "Title needs a type prefix: feat: / fix: / refactor: / chore: etc.",
  "No long paragraphs, no fluff, no preamble. A one-line summary then a tight bullet list of the changes.",
  "Never add AI/Claude attribution or Co-Authored-By footers.",
  "Keep exploit/vuln specifics out — no security details in the description.",
  "Output plain Markdown ready to paste: first line is the title, then a blank line, then the body.",
].join(" ");

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

function prParts() {
  const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], num: m[3] } : null;
}

const ACTIONS = {
  review: {
    title: "PR review",
    model: "prReview",
    system: REVIEW_SYSTEM,
    verb: (parts, diff, note) => `Review this pull request diff (${parts.owner}/${parts.repo}#${parts.num}):\n\n${diff}${note}`,
    working: "Reviewing… (this can take a few seconds)",
  },
  describe: {
    title: "PR description",
    model: "prDesc",
    system: DESC_SYSTEM,
    verb: (parts, diff, note) => `Write the PR description for this diff (${parts.owner}/${parts.repo}#${parts.num}):\n\n${diff}${note}`,
    working: "Writing the description…",
  },
};

async function getDiff(parts) {
  const url = `${location.origin}/${parts.owner}/${parts.repo}/pull/${parts.num}.diff`;
  const r = await send({ type: "diff", url });
  if (!r || !r.ok) throw new Error(r?.error || "Couldn't fetch the PR diff.");
  return r.text || "";
}

async function run(actionKey) {
  const action = ACTIONS[actionKey];
  const parts = prParts();
  if (!parts) return;
  const { models } = await chrome.storage.local.get("models");
  const connectionId = models && models[action.model];
  if (!connectionId) {
    panel(action.title, `Pick a model for ${action.title} in the Alter extension popup first.`, true);
    return;
  }

  panel(action.title, "Fetching the diff…");
  let diff = "";
  try {
    diff = await getDiff(parts);
  } catch (e) {
    panel(action.title, String(e.message || e), true);
    return;
  }
  if (!diff.trim()) {
    panel(action.title, "Empty diff — nothing to do.", true);
    return;
  }

  let note = "";
  const CAP = 60000;
  if (diff.length > CAP) {
    diff = diff.slice(0, CAP);
    note = "\n\n[diff truncated to first 60k chars]";
  }

  panel(action.title, action.working);
  const r = await send({
    type: "run",
    connectionId,
    includeMemory: true,
    system: action.system,
    prompt: action.verb(parts, diff, note),
  });
  if (!r || !r.ok) {
    panel(action.title, r?.error || "Failed.", true);
    return;
  }
  panel(action.title, r.data.content || "(empty response)");
}

function ensureButton() {
  if (!prParts()) return;
  if (document.getElementById("alter-actions")) return;
  const wrap = document.createElement("div");
  wrap.id = "alter-actions";
  const mk = (label, key) => {
    const b = document.createElement("button");
    b.className = "alter-action-btn";
    b.textContent = label;
    b.addEventListener("click", () => run(key));
    return b;
  };
  wrap.appendChild(mk("Describe", "describe"));
  wrap.appendChild(mk("Review with Alter", "review"));
  document.body.appendChild(wrap);
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

function panel(title, content, isError) {
  let el = document.getElementById("alter-panel");
  if (!el) {
    el = document.createElement("div");
    el.id = "alter-panel";
    el.innerHTML = `
      <div id="alter-panel-head">
        <span id="alter-panel-title"></span>
        <div>
          <button id="alter-copy" title="Copy">Copy</button>
          <button id="alter-close" title="Close">×</button>
        </div>
      </div>
      <div id="alter-panel-body"></div>`;
    document.body.appendChild(el);
    el.querySelector("#alter-close").addEventListener("click", () => el.remove());
  }
  el.querySelector("#alter-panel-title").textContent = "Alter — " + title;
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
