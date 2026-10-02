import { useState } from "react";
import { Routine, Schedule, Connection, newId, scheduleLabel } from "../lib/store";
import { confirmDialog } from "../lib/confirm";
import { Chevron } from "./Icons";
import Switch from "./Switch";
import Row, { action, field } from "./SettingsRow";

interface Props {
  routines: Routine[];
  connections: Connection[];
  activeConnectionId?: string;
  onChange: (r: Routine[]) => void;
  onRunNow: (r: Routine) => void;
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
        setGenError("Could not read a routine from that. Try naming the task and a time.");
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
    if (!(await confirmDialog(`Delete routine "${r.name}"?`))) return false;
    onChange(routines.filter((x) => x.id !== r.id));
    return true;
  };

  const toggleDay = (day: number) =>
    setDraft((d) => ({ ...d, days: d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day] }));

  const seg = (on: boolean) =>
    `rounded-md px-2.5 py-1 text-[12px] transition-colors ${on ? "bg-[var(--panel-2)] text-[var(--txt)]" : "text-[var(--txt-dim)] hover:text-[var(--txt)]"}`;

  if (!creating)
    return (
      <div>
        <div className="mb-2 flex items-center gap-2">
          <h1 className="flex-1 text-[17px] font-semibold text-[var(--txt)]">Routines</h1>
          <button onClick={openNew} className={action}>
            New routine
          </button>
        </div>
        <p className="pb-2 text-[13px] text-[var(--txt-faint)]">
          Prompts Alter runs on a schedule while it is open. Each run lands as its own chat under the routine in the sidebar. You can also create one by telling Alter in a chat, like "every weekday at 9am, summarize my open support tickets".
        </p>
        {routines.length === 0 && <p className="py-8 text-center text-[13px] text-[var(--txt-faint)]">No routines yet.</p>}
        {routines.map((r) => (
          <div key={r.id} className="group flex items-center gap-4 border-b border-[var(--bd-soft)] py-3.5 last:border-b-0">
            <button onClick={() => openEdit(r)} className="min-w-0 flex-1 text-left">
              <span className={`block truncate text-[14px] ${r.enabled ? "text-[var(--txt)]" : "text-[var(--txt-dim)]"}`}>{r.name}</span>
              <span className="mt-0.5 block truncate text-[13px] text-[var(--txt-faint)]">
                {scheduleLabel(r)}
                {r.enabled ? "" : " · paused"}
                {r.lastRun ? ` · last run ${new Date(r.lastRun).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : " · not run yet"}
              </span>
            </button>
            <button
              onClick={() => onRunNow(r)}
              className="shrink-0 rounded-md px-2 py-0.5 text-[12px] text-[var(--txt-faint)] opacity-0 hover:bg-[var(--panel-2)] hover:text-[var(--txt)] group-hover:opacity-100"
            >
              Run now
            </button>
            <Switch on={r.enabled} onChange={() => toggle(r.id)} title={r.enabled ? "Enabled" : "Paused"} />
          </div>
        ))}
      </div>
    );

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <button onClick={() => setCreating(false)} className="text-[var(--txt-faint)] hover:text-[var(--txt)]" aria-label="Back to routines">
          ←
        </button>
        <h1 className="text-[17px] font-semibold text-[var(--txt)]">{draft.id ? "Edit routine" : "New routine"}</h1>
      </div>
      <Row title="Describe it" desc="Write it in plain words and Alter fills in the rest. You can still change every field below.">
        <div className="flex gap-2">
          <input
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && generate()}
            placeholder="every weekday at 9am, summarize my open support tickets"
            className={`${field} min-w-0 flex-1`}
          />
          <button onClick={generate} disabled={generating || !desc.trim()} className={action}>
            {generating ? "Filling in…" : "Fill in"}
          </button>
        </div>
        {genError && <p className="mt-2 text-[12px] text-red-400">{genError}</p>}
      </Row>
      <Row
        title="Name"
        control={<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Daily ticket digest" className={`${field} w-72`} />}
      />
      <Row title="Instructions" desc="What Alter should do on each run.">
        <textarea value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} rows={5} className={`${field} resize-none leading-[1.5]`} />
      </Row>
      <Row
        title="Schedule"
        desc={scheduleLabel({ schedule: buildSchedule(draft), everyMinutes: draft.everyMinutes } as Routine)}
        control={
          <div className="flex gap-0.5 rounded-lg border border-[var(--bd)] p-0.5">
            {(
              [
                ["interval", "Every"],
                ["daily", "Daily"],
                ["weekly", "Weekly"],
              ] as const
            ).map(([k, text]) => (
              <button key={k} onClick={() => setDraft({ ...draft, kind: k })} className={seg(draft.kind === k)}>
                {text}
              </button>
            ))}
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--txt-dim)]">
          {draft.kind === "interval" ? (
            <>
              <span>Every</span>
              <input
                type="number"
                min={1}
                value={draft.everyMinutes}
                onChange={(e) => setDraft({ ...draft, everyMinutes: Math.max(1, Number(e.target.value)) })}
                className={`${field} w-20`}
              />
              <span>minutes</span>
            </>
          ) : (
            <>
              <span>At</span>
              <input type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} className={`${field} w-auto`} />
            </>
          )}
          {draft.kind === "weekly" && (
            <div className="ml-2 flex gap-0.5 rounded-lg border border-[var(--bd)] p-0.5">
              {DAYS.map((d, i) => (
                <button key={i} onClick={() => toggleDay(i)} className={seg(draft.days.includes(i))}>
                  {d}
                </button>
              ))}
            </div>
          )}
        </div>
      </Row>
      {connections.length > 0 && (
        <Row
          title="Run on"
          desc="The connection each run uses."
          control={
            <div className="relative w-72">
              <select value={draft.connectionId} onChange={(e) => setDraft({ ...draft, connectionId: e.target.value })} className={`${field} cursor-pointer appearance-none pr-8`}>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Chevron />
            </div>
          }
        />
      )}
      {draft.id && (
        <Row
          title="Delete routine"
          desc="Its past runs stay in the sidebar as normal chats."
          control={
            <button
              onClick={async () => {
                const r = routines.find((x) => x.id === draft.id);
                if (r && (await remove(r))) setCreating(false);
              }}
              className={`${action} text-red-400`}
            >
              Delete
            </button>
          }
        />
      )}
      <div className="flex items-center justify-end gap-2 pt-4">
        <button onClick={() => setCreating(false)} className="rounded-lg px-3 py-1.5 text-[13px] text-[var(--txt-dim)] hover:text-[var(--txt)]">
          Cancel
        </button>
        <button onClick={save} disabled={!draft.name.trim() || !draft.prompt.trim()} className={`${action} bg-[var(--panel-2)]`}>
          {draft.id ? "Save changes" : "Create routine"}
        </button>
      </div>
    </div>
  );
}
