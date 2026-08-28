import { useEffect, useMemo, useRef, useState } from "react";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  section: string;
  run: () => void;
}

interface Props {
  commands: Command[];
  onClose: () => void;
}

export default function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? commands.filter((c) => (c.label + " " + (c.hint ?? "")).toLowerCase().includes(q)) : commands),
    [commands, q]
  );

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const run = (c?: Command) => {
    if (!c) return;
    onClose();
    c.run();
  };

  let lastSection = "";

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[12vh]" onClick={onClose}>
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-[var(--bd)] bg-[var(--modal)] shadow-2xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(filtered[idx]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="Search chats, models, actions…"
          className="w-full border-b border-[var(--bd-soft)] bg-transparent px-4 py-3 text-[15px] text-[var(--txt)] placeholder:text-[var(--txt-faint)] focus:outline-none"
        />
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-[var(--txt-faint)]">No matches.</p>
          )}
          {filtered.map((c, i) => {
            const header = c.section !== lastSection ? c.section : null;
            lastSection = c.section;
            return (
              <div key={c.id}>
                {header && (
                  <p className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-[var(--txt-faint)]">
                    {header}
                  </p>
                )}
                <button
                  data-active={i === idx}
                  onMouseMove={() => setIdx(i)}
                  onClick={() => run(c)}
                  className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm transition-colors ${
                    i === idx ? "bg-[var(--panel-2)] text-[var(--txt)]" : "text-[var(--txt-dim)]"
                  }`}
                >
                  <span className="truncate">{c.label}</span>
                  {c.hint && <span className="shrink-0 text-xs text-[var(--txt-faint)]">{c.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
