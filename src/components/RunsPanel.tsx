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
  const rows = runs.map((c) => ({ run: c, status: statusOf(c, streamingIds.includes(c.id)) }));
  const groups = [
    { label: "Running", items: rows.filter((r) => r.status === "running") },
    { label: "Completed", items: rows.filter((r) => r.status !== "running") },
  ].filter((g) => g.items.length);

  return (
    <aside className="w-[340px] min-w-[300px] shrink-0 flex flex-col border-l border-[var(--bd-soft)] bg-[var(--bg)]">
      <div className="flex items-center gap-2 h-12 px-4 shrink-0 border-b border-[var(--bd-soft)]">
        <span className="flex-1 text-sm font-medium text-[var(--txt)]">Runs</span>
        <button
          onClick={onClose}
          className="rounded-lg hover:bg-[var(--panel-2)] px-2 py-1 text-sm text-[var(--txt-dim)] hover:text-[var(--txt)] transition-colors"
          title="Close"
          aria-label="Close runs"
        >
          ✕
        </button>
      </div>

      <div className="px-4 pt-3 pb-2 shrink-0">
        <div className="flex items-baseline gap-2">
          <h2 className="flex-1 truncate text-sm font-medium text-[var(--txt)]">{routine.name}</h2>
          <button
            onClick={onOpenRoutines}
            className="shrink-0 text-[11px] text-[var(--txt-dim)] hover:text-[var(--txt)] transition-colors"
          >
            Details
          </button>
        </div>
        <p className="mt-0.5 text-[11px] text-[var(--txt-faint)]">
          {scheduleLabel(routine)}
          {!routine.enabled && " · paused"}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-4">
        {groups.map((g) => (
          <div key={g.label}>
            <p className="px-1 pt-2 pb-1.5 text-xs text-[var(--txt-faint)]">{g.label}</p>
            <div className="space-y-1.5">
              {g.items.map(({ run, status }) => (
                <div
                  key={run.id}
                  onClick={() => onSelect(run.id)}
                  className={`group flex items-center gap-2.5 rounded-xl border px-3 py-2.5 cursor-pointer transition-colors ${
                    run.id === activeId
                      ? "border-[var(--bd)] bg-[var(--panel-2)]"
                      : "border-transparent bg-[var(--panel)] hover:bg-[var(--panel-2)]"
                  }`}
                >
                  <span className="shrink-0" aria-hidden>
                    {status === "running" ? (
                      <span className="block h-2 w-2 rounded-full bg-[var(--txt-dim)] animate-pulse" />
                    ) : status === "failed" ? (
                      <span className="block text-[13px] leading-none text-red-400">⊗</span>
                    ) : (
                      <span className="block text-[13px] leading-none text-[var(--txt-faint)]">✓</span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-[var(--txt)]">{runLabel(run)}</span>
                    <span className="block text-[11px] capitalize text-[var(--txt-faint)]">{status}</span>
                  </span>
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (await confirmDialog("Delete this run? This can't be undone.")) onDelete(run.id);
                    }}
                    className="shrink-0 opacity-0 group-hover:opacity-100 text-[var(--txt-faint)] hover:text-[var(--txt)] transition-opacity"
                    title="Delete run"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
        {!runs.length && (
          <p className="px-1 py-8 text-center text-xs text-[var(--txt-faint)]">
            No runs yet. This routine runs {scheduleLabel(routine).toLowerCase()}.
          </p>
        )}
      </div>
    </aside>
  );
}
