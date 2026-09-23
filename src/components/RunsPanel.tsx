import { useEffect, useRef, useState } from "react";
import { Conversation, Routine, scheduleLabel } from "../lib/store";
import { confirmDialog } from "../lib/confirm";

interface Props {
  routine: Routine;
  runs: Conversation[];
  streamingIds: string[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenRoutines: () => void;
  onClose: () => void;
}

const MIN_W = 220;
const MAX_W = 520;

// When a run happened, in the routine's own terms: the title only repeats the
// routine name, so the time is the identity.
function runLabel(c: Conversation) {
  const d = new Date(c.createdAt);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((midnight.getTime() - d.getTime()) / 86400000) + 1;
  if (days <= 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
}

// A run that produced nothing came back empty — the model errored or was stopped
// before it wrote a word. Anything with an answer counts as completed.
function statusOf(c: Conversation, running: boolean): "running" | "failed" | "completed" {
  if (running) return "running";
  const answered = c.messages.some((m) => m.role === "assistant" && (m.content || "").trim());
  return answered ? "completed" : "failed";
}

export default function RunsPanel({
  routine,
  runs,
  streamingIds,
  activeId,
  onSelect,
  onDelete,
  onOpenRoutines,
  onClose,
}: Props) {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem("alter.runsWidth"));
    return saved >= MIN_W && saved <= MAX_W ? saved : 250;
  });
  const dragging = useRef(false);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      setWidth(Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - e.clientX)));
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem("alter.runsWidth", String(width));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [width]);

  const rows = runs.map((c) => ({ run: c, status: statusOf(c, streamingIds.includes(c.id)) }));
  const groups = [
    { label: "Running", items: rows.filter((r) => r.status === "running") },
    { label: "Completed", items: rows.filter((r) => r.status !== "running") },
  ].filter((g) => g.items.length);

  return (
    <aside
      className="relative shrink-0 flex flex-col border-l border-[var(--bd-soft)] bg-[var(--bg)]"
      style={{ width }}
    >
      <div
        onPointerDown={() => {
          dragging.current = true;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        className="absolute left-0 top-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-col-resize"
        title="Drag to resize"
      />
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--bd-soft)] pl-3 pr-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--txt)]">{routine.name}</span>
        <button
          onClick={onOpenRoutines}
          className="shrink-0 text-[11px] text-[var(--txt-faint)] hover:text-[var(--txt)] transition-colors"
        >
          Details
        </button>
        <button
          onClick={onClose}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-[var(--txt-faint)] hover:bg-[var(--panel-2)] hover:text-[var(--txt)] transition-colors"
          title="Close"
          aria-label="Close runs"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        <p className="truncate px-1.5 pb-1 text-[11px] text-[var(--txt-faint)]">
          {scheduleLabel(routine)}
          {!routine.enabled && " · paused"}
        </p>
        {groups.map((g) => (
          <div key={g.label} className="mt-2">
            <p className="px-1.5 pb-1 text-[11px] text-[var(--txt-faint)]">{g.label}</p>
            {g.items.map(({ run, status }) => (
              <div
                key={run.id}
                onClick={() => onSelect(run.id)}
                className={`group flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 transition-colors ${
                  run.id === activeId ? "bg-[var(--panel-2)]" : "hover:bg-[var(--panel)]"
                }`}
              >
                <span className="w-3 shrink-0 text-center" aria-hidden>
                  {status === "running" ? (
                    <span className="mx-auto block h-1.5 w-1.5 rounded-full bg-[var(--txt-dim)] animate-pulse" />
                  ) : status === "failed" ? (
                    <span className="block text-[11px] leading-none text-red-400">⊗</span>
                  ) : (
                    <span className="block text-[11px] leading-none text-[var(--txt-faint)]">✓</span>
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--txt-dim)] group-hover:text-[var(--txt)]">
                  {runLabel(run)}
                </span>
                {status === "failed" && <span className="shrink-0 text-[10px] text-red-400/80">failed</span>}
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (await confirmDialog("Delete this run? This can't be undone.")) onDelete(run.id);
                  }}
                  className="shrink-0 text-[var(--txt-faint)] opacity-0 transition-opacity hover:text-[var(--txt)] group-hover:opacity-100"
                  title="Delete run"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ))}
        {!runs.length && (
          <p className="px-1.5 py-8 text-center text-[11px] text-[var(--txt-faint)]">
            No runs yet. This routine runs {scheduleLabel(routine).toLowerCase()}.
          </p>
        )}
      </div>
    </aside>
  );
}
