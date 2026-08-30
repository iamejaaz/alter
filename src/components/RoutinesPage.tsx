import { useState } from "react";
import { Routine, Schedule, Connection, newId, scheduleLabel } from "../lib/store";
import { confirmDialog } from "../lib/confirm";

interface Props {
  routines: Routine[];
  connections: Connection[];
  activeConnectionId?: string;
  onChange: (r: Routine[]) => void;
  onRunNow: (r: Routine) => void;
  onBack: () => void;
  parseRoutine: (description: string) => Promise<Partial<Routine> | null>;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Draft = {
  id?: string;
  name: string;
  prompt: string;
  kind: Schedule["kind"];
  everyMinutes: number;
  time: string;
  days: number[];
  connectionId: string;
};

const emptyDraft = (connectionId: string): Draft => ({
  name: "",
  prompt: "",
  kind: "daily",
  everyMinutes: 60,
  time: "09:00",
  days: [1, 2, 3, 4, 5],
  connectionId,
});

export default function RoutinesPage({
  routines,
  connections,
  activeConnectionId,
  onChange,
  onRunNow,
  onBack,
  parseRoutine,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft(activeConnectionId ?? connections[0]?.id ?? ""));
  const [desc, setDesc] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");

  const openNew = () => {
    setDraft(emptyDraft(activeConnectionId ?? connections[0]?.id ?? ""));
    setDesc("");
    setGenError("");
    setCreating(true);
  };
  const openEdit = (r: Routine) => {
    const s = r.schedule;
    setDraft({
      id: r.id,
      name: r.name,
      prompt: r.prompt,
      kind: s?.kind ?? "interval",
      everyMinutes: s?.kind === "interval" ? s.everyMinutes : r.everyMinutes || 60,
      time: s && s.kind !== "interval" ? s.time : "09:00",
      days: s?.kind === "weekly" ? s.days : [1, 2, 3, 4, 5],
      connectionId: r.connectionId ?? activeConnectionId ?? connections[0]?.id ?? "",
    });
    setDesc("");
    setGenError("");
    setCreating(true);
  };

  const generate = async () => {
    if (!desc.trim()) return;
    setGenerating(true);
    setGenError("");
    try {
      const parsed = await parseRoutine(desc.trim());
      if (!parsed) {
        setGenError("Couldn't read a routine from that — try naming the task and a time.");
        return;
      }
      const s = parsed.schedule;
      setDraft((d) => ({
        ...d,
        name: parsed.name || d.name,
        prompt: parsed.prompt || d.prompt,
        kind: s?.kind ?? d.kind,
        everyMinutes: s?.kind === "interval" ? s.everyMinutes : d.everyMinutes,
        time: s && s.kind !== "interval" ? s.time : d.time,
        days: s?.kind === "weekly" ? s.days : d.days,
      }));
    } catch (e) {
      setGenError(String((e as Error)?.message || e));
    } finally {
      setGenerating(false);
    }
  };

  const buildSchedule = (d: Draft): Schedule =>
    d.kind === "interval"
      ? { kind: "interval", everyMinutes: Math.max(1, d.everyMinutes) }
      : d.kind === "daily"
      ? { kind: "daily", time: d.time }
      : { kind: "weekly", time: d.time, days: d.days.length ? d.days : [1, 2, 3, 4, 5] };

  const save = () => {
    if (!draft.name.trim() || !draft.prompt.trim()) return;
    const schedule = buildSchedule(draft);
    const conn = connections.find((c) => c.id === draft.connectionId);
    const routine: Routine = {
      id: draft.id ?? newId(),
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      everyMinutes: schedule.kind === "interval" ? schedule.everyMinutes : 60,
      schedule,
      connectionId: draft.connectionId || undefined,
      model: conn?.model,
      lastRun: routines.find((r) => r.id === draft.id)?.lastRun ?? null,
      enabled: routines.find((r) => r.id === draft.id)?.enabled ?? true,
    };
    onChange(draft.id ? routines.map((r) => (r.id === draft.id ? routine : r)) : [...routines, routine]);
    setCreating(false);
  };

  const toggle = (id: string) => onChange(routines.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  const remove = async (r: Routine) => {
    if (await confirmDialog(`Delete routine "${r.name}"?`)) onChange(routines.filter((x) => x.id !== r.id));
  };

  const toggleDay = (day: number) =>
    setDraft((d) => ({ ...d, days: d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day] }));

  const input = "w-full rounded-lg bg-[var(--input)] border border-[var(--bd)] px-3 py-2 text-sm focus:outline-none focus:border-indigo-500";

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-[var(--bg)]">
      <header className="flex items-center gap-2 px-6 py-4 border-b border-[var(--bd-soft)]">
        <button onClick={creating ? () => setCreating(false) : onBack} className="text-[var(--txt-faint)] hover:text-[var(--txt)] text-sm">
          ←
        </button>
        <h1 className="text-sm font-semibold">Routines{creating ? " / " : ""}</h1>
        {creating && <span className="text-sm text-[var(--txt-dim)]">{draft.id ? "Edit" : "New routine"}</span>}
        {!creating && (
          <button onClick={openNew} className="ml-auto rounded-lg bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 text-sm font-medium">
            New routine
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-6">
          {!creating ? (
            <div className="space-y-2">
              {routines.length === 0 && (
                <p className="text-sm text-[var(--txt-faint)]">No routines yet. Create one — or just tell Alter in chat, e.g. “every weekday at 9am, summarize my open support tickets.”</p>
              )}
              {routines.map((r) => (
                <div key={r.id} className="rounded-xl border border-[var(--bd-soft)] bg-[var(--panel)] px-4 py-3">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => toggle(r.id)}
                      className={`h-4 w-8 rounded-full transition-colors flex-none ${r.enabled ? "bg-indigo-600" : "bg-zinc-700"}`}
                      title={r.enabled ? "Enabled" : "Paused"}
                    >
                      <span className={`block h-3 w-3 rounded-full bg-white transition-transform mt-0.5 ${r.enabled ? "translate-x-4" : "translate-x-1"}`} />
                    </button>
                    <span className="text-sm font-medium flex-1 truncate">{r.name}</span>
                    <span className="text-[11px] text-[var(--txt-faint)]">{scheduleLabel(r)}</span>
                    <button onClick={() => onRunNow(r)} className="text-[11px] text-indigo-400 hover:text-indigo-300">Run now</button>
                    <button onClick={() => openEdit(r)} className="text-[11px] text-[var(--txt-dim)] hover:text-[var(--txt)]">Edit</button>
                    <button onClick={() => remove(r)} className="text-[var(--txt-faint)] hover:text-[var(--txt)]">×</button>
                  </div>
                  <p className="mt-1.5 text-xs text-[var(--txt-dim)] line-clamp-2">{r.prompt}</p>
                  {r.lastRun && <p className="mt-1 text-[10px] text-[var(--txt-faint)]">last run {new Date(r.lastRun).toLocaleString()}</p>}
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-5">
              <div className="rounded-xl border border-dashed border-[var(--bd)] p-4">
                <label className="text-xs text-[var(--txt-dim)]">Describe it in plain English</label>
                <div className="flex gap-2 mt-2">
                  <input
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && generate()}
                    placeholder="every weekday at 9am, summarize my open support tickets"
                    className={input}
                  />
                  <button
                    onClick={generate}
                    disabled={generating || !desc.trim()}
                    className="rounded-lg bg-[var(--panel)] border border-[var(--bd)] px-4 text-sm font-medium hover:bg-[var(--input)] disabled:opacity-50 whitespace-nowrap"
                  >
                    {generating ? "Generating…" : "Generate"}
                  </button>
                </div>
                {genError && <p className="mt-2 text-xs text-red-400">{genError}</p>}
              </div>

              <div>
                <label className="text-xs text-[var(--txt-dim)]">Name</label>
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Daily ticket digest" className={`${input} mt-1`} />
              </div>
              <div>
                <label className="text-xs text-[var(--txt-dim)]">Instructions</label>
                <textarea
                  value={draft.prompt}
                  onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                  placeholder="What Alter should do each run…"
                  rows={4}
                  className={`${input} mt-1 resize-none`}
                />
              </div>

              <div>
                <label className="text-xs text-[var(--txt-dim)]">Schedule</label>
                <div className="mt-1 flex gap-1 rounded-lg bg-[var(--panel)] p-1 w-fit">
                  {(["interval", "daily", "weekly"] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setDraft({ ...draft, kind: k })}
                      className={`rounded-md px-3 py-1 text-xs capitalize ${draft.kind === k ? "bg-indigo-600 text-white" : "text-[var(--txt-dim)] hover:text-[var(--txt)]"}`}
                    >
                      {k}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-2 text-sm">
                  {draft.kind === "interval" && (
                    <>
                      <span className="text-[var(--txt-dim)] text-xs">Every</span>
                      <input
                        type="number"
                        min={1}
                        value={draft.everyMinutes}
                        onChange={(e) => setDraft({ ...draft, everyMinutes: Math.max(1, Number(e.target.value)) })}
                        className="w-20 rounded-lg bg-[var(--input)] border border-[var(--bd)] px-2 py-1.5"
                      />
                      <span className="text-[var(--txt-dim)] text-xs">minutes</span>
                    </>
                  )}
                  {draft.kind !== "interval" && (
                    <>
                      <span className="text-[var(--txt-dim)] text-xs">At</span>
                      <input
                        type="time"
                        value={draft.time}
                        onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                        className="rounded-lg bg-[var(--input)] border border-[var(--bd)] px-2 py-1.5"
                      />
                    </>
                  )}
                </div>
                {draft.kind === "weekly" && (
                  <div className="mt-2 flex gap-1">
                    {DAYS.map((d, i) => (
                      <button
                        key={i}
                        onClick={() => toggleDay(i)}
                        className={`rounded-md px-2 py-1 text-xs ${draft.days.includes(i) ? "bg-indigo-600 text-white" : "bg-[var(--panel)] text-[var(--txt-dim)] hover:text-[var(--txt)]"}`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {connections.length > 0 && (
                <div>
                  <label className="text-xs text-[var(--txt-dim)]">Run on</label>
                  <div className="relative mt-1">
                    <select
                      value={draft.connectionId}
                      onChange={(e) => setDraft({ ...draft, connectionId: e.target.value })}
                      className={`${input} appearance-none pr-9 cursor-pointer`}
                    >
                      {connections.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--txt-faint)] text-[10px]">▼</span>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button onClick={() => setCreating(false)} className="rounded-lg px-3 py-2 text-sm text-[var(--txt-dim)] hover:text-[var(--txt)]">Cancel</button>
                <button onClick={save} disabled={!draft.name.trim() || !draft.prompt.trim()} className="ml-auto rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-medium disabled:opacity-50">
                  {draft.id ? "Save changes" : "Create routine"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
