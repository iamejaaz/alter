import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface PrMeta {
  key: string;
  repo: string;
  number: number;
  title: string;
  branch: string;
  additions: number;
  deletions: number;
  state: string;
  isDraft: boolean;
  url: string;
  ci: "passing" | "failing" | "pending" | "none";
  ciPassed: number;
  ciTotal: number;
  threads: number;
}

const CI_DOT: Record<string, string> = {
  passing: "bg-green-500",
  failing: "bg-red-500",
  pending: "bg-amber-400 animate-pulse",
  none: "bg-[var(--txt-faint)]",
};

export default function PrChips({
  keys,
  onDismiss,
  onFixComments,
}: {
  keys: string[];
  onDismiss: (key: string) => void;
  onFixComments: (pr: PrMeta) => void;
}) {
  const [metas, setMetas] = useState<PrMeta[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!keys.length) return setMetas([]);
    let live = true;
    const load = async () => {
      const rows = (await invoke<PrMeta[]>("pr_meta", { refs: keys }).catch(() => [])) as PrMeta[];
      if (live) setMetas(rows);
    };
    void load();
    // Checks move on their own, so keep the dot honest while any run is open.
    const t = setInterval(load, 45000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [keys.join(",")]);

  if (!metas.length) return null;
  const visible = expanded ? metas : metas.slice(-2);
  const hidden = metas.length - visible.length;

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {visible.map((p) => (
        <div
          key={p.key}
          className="group flex items-center gap-3 rounded-[10px] border border-[var(--bd-soft)] bg-[var(--panel)] px-3 py-2 text-xs"
        >
          <button
            onClick={() => void invoke("open_external", { url: p.url }).catch(() => {})}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
            title={p.title}
          >
            <span className={p.state === "MERGED" ? "text-violet-400" : p.isDraft ? "text-[var(--txt-faint)]" : "text-green-400"}>
              ⑃
            </span>
            <span className="font-semibold tabular-nums text-[var(--txt)]">#{p.number}</span>
            <span className="text-[var(--txt-faint)]">{p.repo.split("/")[1]}</span>
            <span className="truncate text-[var(--txt-dim)]">{p.branch}</span>
          </button>
          <span className="shrink-0 rounded bg-[var(--composer)] px-1.5 py-0.5 font-mono text-[11px] tabular-nums">
            <span className="text-green-400">+{p.additions}</span>{" "}
            <span className="text-red-400">−{p.deletions}</span>
          </span>
          {/* Open review threads are the whole point of the fix action, so the
              count is the button. */}
          {p.threads > 0 && (
            <button
              onClick={() => onFixComments(p)}
              className="flex shrink-0 items-center gap-1.5 rounded bg-[var(--composer)] px-1.5 py-0.5 text-[11px] text-[var(--txt-dim)] hover:bg-[var(--panel-2)] hover:text-[var(--txt)]"
              title={`${p.threads} open review thread${p.threads > 1 ? "s" : ""} — judge each and fix the valid ones`}
            >
              <span className="text-[10px]">💬</span>
              {p.threads}
              <span className="text-[var(--txt-faint)]">Fix</span>
            </button>
          )}
          {p.ciTotal > 0 && (
            <button
              onClick={() => void invoke("open_external", { url: `${p.url}/checks` }).catch(() => {})}
              className="flex shrink-0 items-center gap-1.5 rounded bg-[var(--composer)] px-1.5 py-0.5 text-[11px] text-[var(--txt-dim)] hover:text-[var(--txt)]"
              title={`${p.ciPassed}/${p.ciTotal} checks passed`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${CI_DOT[p.ci]}`} />
              CI
            </button>
          )}
          <button
            onClick={() => onDismiss(p.key)}
            className="shrink-0 text-[var(--txt-faint)] opacity-0 transition-opacity hover:text-[var(--txt)] group-hover:opacity-100"
            title="Hide"
          >
            ×
          </button>
        </div>
      ))}
      {(hidden > 0 || expanded) && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-fit text-xs text-[var(--txt-faint)] hover:text-[var(--txt)]"
        >
          {expanded ? "Show less" : `Show ${hidden} more`}
        </button>
      )}
    </div>
  );
}
