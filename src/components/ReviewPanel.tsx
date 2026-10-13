import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ReviewRun } from "../lib/store";
import { useSideWidth } from "../lib/useSideWidth";
import Markdown from "./Markdown";

interface Props {
  runs: ReviewRun[];
  selected: string | null;
  detail: ReviewRun | null;
  error: string | null;
  onSelect: (name: string | null) => void;
  onDiscuss: (run: ReviewRun) => void;
  onClose: () => void;
}

const at = (s?: string) => (s ? new Date(s.replace(" ", "T")).getTime() : 0);

export const live = (r: ReviewRun) => r.status === "running" || r.status === "queued";

function took(r: ReviewRun, now: number) {
  const start = at(r.started);
  if (!start) return "";
  const sec = Math.max(0, Math.round(((r.finished ? at(r.finished) : now) - start) / 1000));
  return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export function verdictLabel(v?: string) {
  return v === "READY" ? "Ready" : v === "NEEDS CHANGES" ? "Needs changes" : v === "NEEDS HUMAN JUDGMENT" ? "Your call" : "";
}

function postedLine(r: ReviewRun) {
  if (r.posted) return `Posted as ${r.post_event === "REQUEST_CHANGES" ? "request changes" : "a comment"}`;
  if (r.post_error) return `Not posted: ${r.post_error}`;
  if (r.status === "done") return "Not posted";
  return "";
}

type Draft = { body?: string; comments?: { path?: string; line?: number; body?: string }[] };

function parseDraft(s?: string): Draft | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as Draft;
  } catch {
    return null;
  }
}

const open = (url?: string) => url && void invoke("open_external", { url });

function StatusMark({ r }: { r: ReviewRun }) {
  if (live(r)) return <span className="mx-auto block h-1.5 w-1.5 rounded-full bg-[var(--txt-dim)] animate-pulse" />;
  if (r.status === "failed" || r.status === "unfinished") return <span className="block text-[11px] leading-none text-red-400">⊗</span>;
  return <span className="block text-[11px] leading-none text-[var(--txt-faint)]">✓</span>;
}

export default function ReviewPanel({ runs, selected, detail, error, onSelect, onDiscuss, onClose }: Props) {
  const { width, startDrag } = useSideWidth("alter.reviewsWidth", 360, 260, 720);
  const [now, setNow] = useState(Date.now());
  const run = selected ? (detail?.name === selected ? detail : runs.find((r) => r.name === selected) ?? null) : null;
  useEffect(() => {
    if (!runs.some(live)) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [runs]);
  const draft = parseDraft(run?.draft);
  const groups = [
    { label: "Running", items: runs.filter(live) },
    { label: "Done", items: runs.filter((r) => !live(r)) },
  ].filter((g) => g.items.length);

  return (
    <aside className="relative shrink-0 flex flex-col border-l border-[var(--bd-soft)] bg-[var(--bg)]" style={{ width }}>
      <div onPointerDown={startDrag} className="absolute left-0 top-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-col-resize" title="Drag to resize" />
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--bd-soft)] pl-3 pr-2">
        {run && (
          <button onClick={() => onSelect(null)} className="shrink-0 text-[13px] text-[var(--txt-faint)] hover:text-[var(--txt)]" title="All reviews" aria-label="All reviews">
            ‹
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--txt)]">{run ? `${run.repo}#${run.pr}` : "PR reviews"}</span>
        <button
          onClick={onClose}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-[var(--txt-faint)] hover:bg-[var(--panel-2)] hover:text-[var(--txt)] transition-colors"
          title="Close"
          aria-label="Close reviews"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {error && <p className="mb-2 rounded-lg border border-red-900/60 bg-red-950/50 px-2.5 py-1.5 text-[12px] text-red-300">{error}</p>}

        {!run && !runs.length && !error && <p className="px-1 py-6 text-center text-[12px] text-[var(--txt-faint)]">No server reviews yet.</p>}

        {!run &&
          groups.map((g) => (
            <div key={g.label} className="mt-1">
              <p className="px-1 pb-1 text-[11px] text-[var(--txt-faint)]">{g.label}</p>
              {g.items.map((r) => (
                <div
                  key={r.name}
                  onClick={() => onSelect(r.name)}
                  className="group flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1.5 hover:bg-[var(--panel)]"
                >
                  <span className="mt-1 w-3 shrink-0 text-center" aria-hidden>
                    <StatusMark r={r} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-[var(--txt)]">
                      #{r.pr} {r.title}
                    </span>
                    <span className="block truncate text-[11px] text-[var(--txt-faint)]">
                      {live(r) ? r.current_step || "Starting" : [verdictLabel(r.verdict) || r.status, r.posted ? "posted" : "", took(r, now)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {live(r) && <span className="shrink-0 text-[11px] text-[var(--txt-faint)]">{took(r, now)}</span>}
                </div>
              ))}
            </div>
          ))}

        {run && (
          <div className="space-y-3 pb-4 text-[13px]">
            <div>
              <button onClick={() => open(run.url)} className="text-left text-[14px] text-[var(--txt)] hover:underline">
                {run.title || `PR #${run.pr}`}
              </button>
              <p className="mt-1 text-[12px] text-[var(--txt-faint)]">
                {[verdictLabel(run.verdict), run.status, took(run, now), run.cost_usd ? `$${run.cost_usd.toFixed(2)}` : ""].filter(Boolean).join(" · ")}
              </p>
              {live(run) && (
                <p className="mt-1.5 flex items-center gap-2 text-[12px] text-[var(--txt-dim)]">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--txt-dim)] animate-pulse" />
                  <span className="min-w-0 truncate">{run.current_step || "Starting"}</span>
                </p>
              )}
              {postedLine(run) && (
                <p className="mt-1 text-[12px] text-[var(--txt-dim)]">
                  {postedLine(run)}
                  {run.posted_url && (
                    <>
                      {" · "}
                      <button onClick={() => open(run.posted_url)} className="underline hover:text-[var(--txt)]">
                        open
                      </button>
                    </>
                  )}
                </p>
              )}
              <button
                onClick={() => onDiscuss(run)}
                className="mt-2 rounded-lg border border-[var(--bd)] bg-[var(--panel)] px-3 py-1 text-[12px] text-[var(--txt)] hover:bg-[var(--panel-2)]"
              >
                Discuss in a chat
              </button>
            </div>

            {run.result && (
              <section>
                <p className="pb-1 text-[11px] text-[var(--txt-faint)]">Result</p>
                <Markdown text={run.result} />
              </section>
            )}

            {draft && (draft.body?.trim() || draft.comments?.length) ? (
              <section>
                <p className="pb-1 text-[11px] text-[var(--txt-faint)]">{run.posted ? "Posted review" : "Review that would be posted"}</p>
                {draft.body?.trim() && (
                  <div className="mb-2 rounded-lg border border-[var(--bd-soft)] bg-[var(--panel)] px-2.5 py-2">
                    <Markdown text={draft.body} />
                  </div>
                )}
                {(draft.comments ?? []).map((c, k) => (
                  <div key={k} className="mb-2 rounded-lg border border-[var(--bd-soft)] bg-[var(--panel)] px-2.5 py-2">
                    <p className="mb-1 truncate font-mono text-[11px] text-[var(--txt-faint)]">
                      {c.path}
                      {c.line ? `:${c.line}` : ""}
                    </p>
                    <Markdown text={c.body ?? ""} />
                  </div>
                ))}
              </section>
            ) : null}

            {run.log_tail && (
              <details>
                <summary className="cursor-pointer text-[11px] text-[var(--txt-faint)] hover:text-[var(--txt)]">Steps</summary>
                <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--panel)] p-2 font-mono text-[11px] text-[var(--txt-dim)]">{run.log_tail}</pre>
              </details>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
