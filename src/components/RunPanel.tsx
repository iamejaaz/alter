import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Markdown from "./Markdown";

interface Run {
  runId: string;
  label: string;
  url?: string;
  kind?: string;
  startedAt: number;
  endedAgoMs?: number | null;
  done: boolean;
  error?: string | null;
  text: string;
  steps: string[];
}

const dur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
};

function linkLabel(url: string) {
  if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url)) return "Open PR on GitHub";
  if (/github\.com\/[^/]+\/[^/]+\/issues\/\d+/.test(url)) return "Open issue on GitHub";
  if (/\/helpdesk\/tickets\/\d+/.test(url)) return "Open ticket";
  return "Open page";
}

function cleanResult(text: string) {
  return text.replace(/```json\s*\n[\s\S]*?\n```\s*$/i, "").trim();
}

export default function RunPanel({ runId, onClose, onStop }: { runId: string; onClose: () => void; onStop: (id: string) => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [gone, setGone] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    setRun(null);
    setGone(false);
    setStepsOpen(false);
    const load = async () => {
      const r = await invoke<Run | null>("bridge_run", { runId }).catch(() => null);
      if (!alive) return;
      if (!r) setGone(true);
      else setRun(r);
    };
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [runId]);

  const result = run ? cleanResult(run.text || "") : "";
  const took = run && run.done && run.endedAgoMs != null ? Date.now() - run.endedAgoMs - run.startedAt : null;
  const status = !run
    ? ""
    : !run.done
      ? `Running · ${dur(Date.now() - run.startedAt)}`
      : run.error
        ? "Stopped"
        : `Finished${took && took > 0 ? ` in ${dur(took)}` : ""}`;
  const btn = "rounded-lg border border-[var(--bd)] bg-[var(--panel)] px-2.5 py-1 text-[12px] text-[var(--txt)] hover:bg-[var(--panel-2)] transition-colors";

  return (
    <aside className="flex w-[45%] min-w-[380px] shrink-0 flex-col border-l border-[var(--bd-soft)] bg-[var(--bg)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--bd-soft)] px-4">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--txt)]" title={run?.label}>
          {run?.label || "Run"}
        </span>
        <button onClick={onClose} className="text-[18px] leading-none text-[var(--txt-faint)] hover:text-[var(--txt)]" title="Close" aria-label="Close run details">
          ×
        </button>
      </div>
      {gone ? (
        <p className="p-6 text-center text-[13px] text-[var(--txt-faint)]">This run is no longer in the list. Alter keeps finished runs for 12 hours and forgets them when it restarts.</p>
      ) : !run ? (
        <p className="p-6 text-center text-[13px] text-[var(--txt-faint)]">Loading…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--bd-soft)] px-4 py-2.5">
            <span className={`flex items-center gap-1.5 text-[12px] ${run.error ? "text-red-400" : "text-[var(--txt-dim)]"}`}>
              {!run.done ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--txt-dim)]" /> : <span>{run.error ? "✕" : "✓"}</span>}
              {status}
            </span>
            <span className="flex-1" />
            {!run.done && (
              <button onClick={() => onStop(run.runId)} className={btn}>
                Stop
              </button>
            )}
            {result && (
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(result);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className={btn}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            )}
            {run.url && (
              <button onClick={() => void invoke("open_external", { url: run.url })} className={btn}>
                {linkLabel(run.url)}
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {run.error && run.done && <p className="mb-3 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-[12px] text-red-300">{run.error}</p>}
            {result ? (
              <div className="text-[14px] leading-relaxed">
                <Markdown text={result} />
              </div>
            ) : (
              <p className="text-[13px] text-[var(--txt-faint)]">
                {run.done ? "It finished without a written result." : `Working. ${run.steps.length ? `Now: ${run.steps[run.steps.length - 1]}` : "Starting up."}`}
              </p>
            )}
            {run.steps.length > 0 && (
              <div className="mt-4 border-t border-[var(--bd-soft)] pt-3">
                <button onClick={() => setStepsOpen((v) => !v)} className="text-[12px] text-[var(--txt-dim)] hover:text-[var(--txt)]">
                  {stepsOpen ? "▾" : "▸"} What it did · {run.steps.length} {run.steps.length === 1 ? "step" : "steps"}
                </button>
                {stepsOpen && (
                  <ol className="mt-2 space-y-1">
                    {run.steps.map((s, i) => (
                      <li key={i} className="truncate font-mono text-[11px] text-[var(--txt-faint)]" title={s}>
                        {s}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
