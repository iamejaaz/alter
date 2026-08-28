// Grammar-fix on any page. Select text in an editable field → a "Fix grammar"
// pill appears → click replaces it in place, using the model you picked for
// grammar in the popup. Works in <textarea>, text <input>, and contenteditable
// (Gmail, Froala/Quill editors, the Frappe support portal, etc).
// IIFE-wrapped so its top-level names don't collide with sibling content scripts.
(() => {
const GRAMMAR_SYSTEM = [
  "You are a precise copy editor.",
  "Fix spelling, grammar, and punctuation in the user's text.",
  "Preserve the original meaning, tone, and formatting.",
  "Do not add, remove, or rephrase content beyond correcting errors.",
  "Reply with ONLY the corrected text — no quotes, no commentary, no explanation.",
].join(" ");

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

let pill = null;
let target = null; // { kind, el, start?, end?, text, rect }

function isEditableInput(el) {
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") {
    const t = (el.type || "text").toLowerCase();
    return ["text", "search", "email", "url", ""].includes(t);
  }
  return false;
}

function contentEditableHost(node) {
  let el = node && node.nodeType === 3 ? node.parentElement : node;
  while (el) {
    if (el.isContentEditable) return el;
    el = el.parentElement;
  }
  return null;
}

// Pierce shadow roots — GitHub's composer and many editors put the real
// <textarea>/contenteditable inside a shadow tree, so document.activeElement
// only gives the outer host.
function deepActive() {
  let a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

function currentTarget() {
  const active = deepActive();
  // input / textarea: selection lives on the element, not window.getSelection().
  if (isEditableInput(active)) {
    const { selectionStart: s, selectionEnd: e, value } = active;
    if (s != null && e != null && e > s) {
      return { kind: "input", el: active, start: s, end: e, text: value.slice(s, e), rect: active.getBoundingClientRect() };
    }
    return null;
  }
  // contenteditable / rich editors.
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.rangeCount) {
    const host = contentEditableHost(sel.anchorNode);
    const text = sel.toString();
    if (host && text.trim()) {
      return { kind: "ce", el: host, text, rect: sel.getRangeAt(0).getBoundingClientRect() };
    }
  }
  return null;
}

function removePill() {
  if (pill) {
    pill.remove();
    pill = null;
  }
}

function showPill(t) {
  removePill();
  pill = document.createElement("button");
  pill.id = "alter-grammar-pill";
  pill.textContent = "Fix grammar";
  const top = Math.min(window.innerHeight - 40, Math.max(8, t.rect.bottom + 6));
  const left = Math.min(window.innerWidth - 120, Math.max(8, t.rect.left));
  pill.style.top = top + "px";
  pill.style.left = left + "px";
  // preventDefault keeps the selection/focus; stopPropagation stops editors
  // (e.g. Frappe Helpdesk's reply box) from treating the pill click as a
  // click-away and closing themselves before the fix applies.
  pill.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    fix(t);
  });
  document.body.appendChild(pill);
}

async function fix(t) {
  // Hold a local ref — a scroll during the await calls removePill() and nulls
  // the global `pill`, which would make the post-await mutations throw.
  const p = pill;
  if (!p) return;
  const { models } = await chrome.storage.local.get("models");
  const connectionId = models && models.grammar;
  if (!connectionId) {
    p.textContent = "Pick a grammar model in Alter";
    return;
  }
  p.textContent = "Fixing…";
  p.disabled = true;
  const r = await send({ type: "run", connectionId, system: GRAMMAR_SYSTEM, prompt: t.text });
  if (!r || !r.ok || !r.data || !r.data.content) {
    p.textContent = r && r.error ? "Error" : "No change";
    p.disabled = false;
    setTimeout(removePill, 1500);
    return;
  }
  const changed = replace(t, r.data.content);
  // Confirm visibly so it's obvious the fix landed (the editor may have shifted).
  p.textContent = changed ? "✓ Fixed" : "✓ Copied";
  p.disabled = true;
  setTimeout(removePill, 1000);
}

// Returns true if the text was replaced in place; false if it fell back to the
// clipboard (so the caller can say "✓ Copied" — paste to use it).
function replace(t, corrected) {
  try {
    if (t.kind === "input") {
      t.el.focus();
      try {
        t.el.setSelectionRange(t.start, t.end);
      } catch {}
      if (typeof t.el.setRangeText === "function") {
        t.el.setRangeText(corrected, t.start, t.end, "end");
      } else {
        t.el.value = t.el.value.slice(0, t.start) + corrected + t.el.value.slice(t.end);
      }
      t.el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    t.el.focus();
    // execCommand keeps the site's own undo stack and framework bindings happy.
    let ok = document.execCommand && document.execCommand("insertText", false, corrected);
    if (!ok) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(corrected));
        ok = true;
      }
    }
    t.el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    if (ok) return true;
  } catch {}
  // Couldn't write it back (editor closed/moved) — put it on the clipboard.
  navigator.clipboard.writeText(corrected).catch(() => {});
  return false;
}

// Poll the focused editable for a selection. This does NOT depend on any event
// firing, so it survives shadow DOM, custom editors, and stopped-propagation —
// whatever GitHub or a site does, reading selectionStart/End still works.
let lastKey = "";
setInterval(() => {
  if (pill && pill.matches(":hover")) return; // don't yank it while aiming at it
  const t = currentTarget();
  if (t) {
    const key = t.kind + "|" + t.text;
    if (key !== lastKey) {
      lastKey = key;
      target = t;
      showPill(t);
    }
  } else if (lastKey) {
    lastKey = "";
    removePill();
  }
}, 400);
document.addEventListener("scroll", removePill, true);

// ⌘⇧L / Ctrl+⇧L fixes the whole focused field even without a selection.
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "l") {
    const active = deepActive();
    let t = currentTarget();
    if (!t && isEditableInput(active) && active.value.trim()) {
      t = { kind: "input", el: active, start: 0, end: active.value.length, text: active.value, rect: active.getBoundingClientRect() };
    } else if (!t && active && active.isContentEditable && active.textContent.trim()) {
      const range = document.createRange();
      range.selectNodeContents(active);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      t = { kind: "ce", el: active, text: active.textContent, rect: active.getBoundingClientRect() };
    }
    if (t) {
      e.preventDefault();
      showPill(t);
      fix(t);
    }
  }
});

console.log("[Alter] grammar-fix ready");
})();
