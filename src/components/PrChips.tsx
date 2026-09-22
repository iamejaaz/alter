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
}

const CI_DOT: Record<string, string> = {
  passing: "bg-green-500",
  failing: "bg-red-500",
  pending: "bg-amber-400 animate-pulse",
  none: "bg-[var(--txt-faint)]",
};

export default function PrChips({ keys, onDismiss }: { keys: string[]; onDismiss: (key: string) => void }) {
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
          className="group flex items-center gap-3 rounded-xl border border-[var(--bd)] bg-[var(--panel)] px-3 py-2 text-xs"
        >
          <button
            onClick={() => void invoke("open_external", { url: p.url }).catch(() => {})}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
            title={p.title}
          >
            <span className={p.state === "MERGED" ? "text-violet-400" : p.isDraft ? "text-[var(--txt-faint)]" : "text-green-400"}>
              ⑃
            </span>
            <span className="font-medium text-[var(--txt)]">#{p.number}</span>
            <span className="text-[var(--txt-faint)]">{p.repo.split("/")[1]}</span>
            <span className="truncate text-[var(--txt-dim)]">{p.branch}</span>
          </button>
          <span className="shrink-0 rounded-md bg-[var(--composer)] px-2 py-1 font-mono">
            <span className="text-green-400">+{p.additions}</span>{" "}
            <span className="text-red-400">−{p.deletions}</span>
          </span>
          {p.ciTotal > 0 && (
            <button
              onClick={() => void invoke("open_external", { url: `${p.url}/checks` }).catch(() => {})}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--composer)] px-2 py-1 text-[var(--txt-dim)] hover:text-[var(--txt)]"
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
