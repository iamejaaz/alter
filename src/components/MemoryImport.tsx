import { useMemo, useState } from "react";

const PROMPT = `I am moving to another assistant and want to take my context with me. List everything you have stored or learned about me from our past conversations.

Cover all of these, in my own words where you can:
1. Instructions I gave you about how to respond: tone, format, style, things to always or never do.
2. Personal details: name, location, job, family, interests.
3. Projects, goals and recurring topics.
4. Tools, languages and frameworks I use.
5. Preferences and corrections I made to your behaviour.
6. Anything else you have stored about me.

Put the whole list in one code block, one fact per line, each line starting with "- ". Do not summarise, group or leave anything out. After the code block, say whether that is the complete set.`;

const MAX_ITEMS = 200;
const MAX_LEN = 400;

export function parseMemories(raw: string, existing: string[]): string[] {
  const fenced = raw.match(/```[^\n]*\n([\s\S]*?)```/g);
  const text = fenced ? fenced.map((b) => b.replace(/```[^\n]*\n|```/g, "")).join("\n") : raw;
  const seen = new Set(existing.map((e) => e.trim().toLowerCase()));
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const t = line
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
      .replace(/^\[[^\]]*\]\s*[-:]?\s*/, "")
      .trim();
    if (t.length < 4 || /^#+\s|^[A-Za-z ]{1,40}:$/.test(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t.slice(0, MAX_LEN));
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

interface Props {
  existing: string[];
  onImport: (texts: string[]) => void;
  onClose: () => void;
}

export default function MemoryImport({ existing, onImport, onClose }: Props) {
  const [raw, setRaw] = useState("");
  const [copied, setCopied] = useState(false);
  const [dropped, setDropped] = useState<string[]>([]);
  const found = useMemo(() => parseMemories(raw, existing), [raw, existing]);
  const items = found.filter((t) => !dropped.includes(t));
  const btn = "rounded-lg border border-[var(--bd)] px-3 py-1.5 text-[13px] text-[var(--txt)] hover:bg-[var(--panel-2)] disabled:opacity-40 transition-colors";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-[560px] max-w-[92vw] flex-col rounded-xl border border-[var(--bd)] bg-[var(--modal)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 className="text-[15px] font-semibold text-[var(--txt)]">Import memory</h2>
          <button onClick={onClose} className="text-[18px] leading-none text-[var(--txt-faint)] hover:text-[var(--txt)]" aria-label="Close">
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <div className="flex items-center justify-between">
              <p className="text-[13px] text-[var(--txt)]">1. Paste this prompt into the other assistant</p>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(PROMPT);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className={btn}
              >
                {copied ? "Copied" : "Copy prompt"}
              </button>
            </div>
            <pre className="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--input)] px-3 py-2 text-[12px] leading-snug text-[var(--txt-dim)]">{PROMPT}</pre>
          </div>
          <div>
            <p className="text-[13px] text-[var(--txt)]">2. Paste its answer here</p>
            <textarea
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                setDropped([]);
              }}
              rows={5}
              placeholder="- Prefers short answers&#10;- Works on Frappe Framework"
              className="mt-2 w-full resize-none rounded-lg border border-[var(--bd)] bg-[var(--input)] px-3 py-2 font-mono text-[12px] focus:border-[var(--txt-faint)] focus:outline-none"
            />
          </div>
          {raw.trim() && (
            <div>
              <p className="text-[13px] text-[var(--txt)]">
                3. Check what will be added
                <span className="ml-2 text-[var(--txt-faint)]">
                  {items.length ? `${items.length} new` : "nothing new found"}
                </span>
              </p>
              <div className="mt-2">
                {items.map((t) => (
                  <div key={t} className="flex items-start gap-2 border-b border-[var(--bd-soft)] py-1.5 text-[13px] text-[var(--txt-dim)] last:border-b-0">
                    <span className="min-w-0 flex-1">{t}</span>
                    <button
                      onClick={() => setDropped((d) => [...d, t])}
                      className="shrink-0 text-[var(--txt-faint)] hover:text-[var(--txt)]"
                      title="Leave this one out"
                      aria-label="Leave this one out"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--bd-soft)] px-5 py-3">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px] text-[var(--txt-dim)] hover:text-[var(--txt)]">
            Cancel
          </button>
          <button onClick={() => onImport(items)} disabled={!items.length} className={`${btn} bg-[var(--panel-2)]`}>
            {items.length ? `Add ${items.length} ${items.length === 1 ? "memory" : "memories"}` : "Add memories"}
          </button>
        </div>
      </div>
    </div>
  );
}
