import { useState } from "react";
import { Routine, newId } from "../lib/store";

interface Props {
  routines: Routine[];
  onChange: (r: Routine[]) => void;
  onRunNow: (r: Routine) => void;
  onClose: () => void;
}

export default function RoutinesPanel({ routines, onChange, onRunNow, onClose }: Props) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [every, setEvery] = useState(60);

  const add = () => {
    if (!name.trim() || !prompt.trim()) return;
    onChange([
      ...routines,
      { id: newId(), name: name.trim(), prompt: prompt.trim(), everyMinutes: every, lastRun: null, enabled: true },
    ]);
    setName("");
    setPrompt("");
    setEvery(60);
  };

  const toggle = (id: string) =>
    onChange(routines.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  const remove = (id: string) => onChange(routines.filter((r) => r.id !== id));

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[560px] max-h-[80vh] overflow-y-auto rounded-xl border border-[var(--bd-soft)] bg-[var(--modal)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold">Routines</h2>
          <button onClick={onClose} className="text-[var(--txt-faint)] hover:text-[var(--txt)]">×</button>
        </div>
        <p className="text-xs text-[var(--txt-faint)] mb-4">
          Saved prompts that run automatically on a schedule while Alter is open. Each run starts a new conversation.
        </p>

        <div className="space-y-2 mb-5">
          {routines.length === 0 && <p className="text-sm text-[var(--txt-faint)]">No routines yet.</p>}
          {routines.map((r) => (
            <div key={r.id} className="rounded-lg border border-[var(--bd-soft)] bg-[var(--panel)] px-3 py-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggle(r.id)}
                  className={`h-4 w-8 rounded-full transition-colors ${r.enabled ? "bg-indigo-600" : "bg-zinc-700"}`}
                  title={r.enabled ? "Enabled" : "Paused"}
                >
                  <span
                    className={`block h-3 w-3 rounded-full bg-white transition-transform mt-0.5 ${
                      r.enabled ? "translate-x-4" : "translate-x-1"
                    }`}
                  />
                </button>
                <span className="text-sm font-medium flex-1 truncate">{r.name}</span>
                <span className="text-[11px] text-[var(--txt-faint)]">every {r.everyMinutes}m</span>
                <button onClick={() => onRunNow(r)} className="text-[11px] text-indigo-400 hover:text-indigo-300">
                  Run now
                </button>
                <button onClick={() => remove(r.id)} className="text-[var(--txt-faint)] hover:text-[var(--txt)]">×</button>
              </div>
              <p className="mt-1 text-xs text-[var(--txt-dim)] truncate">{r.prompt}</p>
              {r.lastRun && (
                <p className="mt-0.5 text-[10px] text-[var(--txt-faint)]">
                  last run {new Date(r.lastRun).toLocaleString()}
                </p>
              )}
            </div>
          ))}
        </div>

        <div className="space-y-2 border-t border-[var(--bd-soft)] pt-4">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Routine name (e.g. Daily standup)"
            className="w-full rounded-lg bg-[var(--input)] border border-[var(--bd)] px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
          />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Prompt to run (e.g. Summarize what I worked on today)"
            rows={2}
            className="w-full resize-none rounded-lg bg-[var(--input)] border border-[var(--bd)] px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
          />
          <div className="flex items-center gap-2">
            <label className="text-xs text-[var(--txt-dim)]">Every</label>
            <input
              type="number"
              min={1}
              value={every}
              onChange={(e) => setEvery(Math.max(1, Number(e.target.value)))}
              className="w-20 rounded-lg bg-[var(--input)] border border-[var(--bd)] px-2 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
            />
            <span className="text-xs text-[var(--txt-dim)]">minutes</span>
            <button
              onClick={add}
              className="ml-auto rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-medium"
            >
              Add routine
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
