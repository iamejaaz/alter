import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface PrMeta {
  key: string;
  repo: string;
  number: number;
  title: string;
  branch: string;
  headSha: string;
  additions: number;
  deletions: number;
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  url: string;
  ci: "passing" | "failing" | "pending" | "none";
  ciPassed: number;
  ciTotal: number;
  threads: number;
}

interface Watch {
  autoFix?: boolean;
  autoMerge?: boolean;
  autoArchive?: boolean;
  fixedSha?: string;
}

const CI_DOT: Record<string, string> = {
  passing: "bg-green-500",
  failing: "bg-red-500",
  pending: "bg-amber-400 animate-pulse",
  none: "bg-[var(--txt-faint)]",
};

const CI_LABEL: Record<string, string> = {
  passing: "Passing",
  failing: "Failing",
  pending: "In progress",
  none: "No checks",
};

const loadWatch = (): Record<string, Watch> => {
  try {
    return JSON.parse(localStorage.getItem("alter.prWatch") || "{}");
  } catch {
    return {};
  }
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
  const [open, setOpen] = useState<string | null>(null);
  const [watch, setWatch] = useState<Record<string, Watch>>(loadWatch);
  // The poll reads these, and a stale closure would re-fire a fix that already ran.
  const watchRef = useRef(watch);
  watchRef.current = watch;
  const fixRef = useRef(onFixComments);
  fixRef.current = onFixComments;

  const setFlag = (key: string, patch: Watch) =>
    setWatch((prev) => {
      const next = { ...prev, [key]: { ...prev[key], ...patch } };
      localStorage.setItem("alter.prWatch", JSON.stringify(next));
      return next;
    });

  useEffect(() => {
    if (!keys.length) return setMetas([]);
    let live = true;
    const load = async () => {
      const rows = (await invoke<PrMeta[]>("pr_meta", { refs: keys }).catch(() => [])) as PrMeta[];
      if (!live) return;
      setMetas(rows);
      for (const p of rows) {
        const w = watchRef.current[p.key] ?? {};
        // Archive first: a merged PR has nothing left to fix.
        if (w.autoArchive && (p.state === "MERGED" || p.state === "CLOSED")) {
          onDismiss(p.key);
          continue;
        }
        // One run per head commit, so a fix that pushes cannot trigger itself again.
        const needsWork = p.ci === "failing" || p.threads > 0;
        if (w.autoFix && needsWork && w.fixedSha !== p.headSha && p.state === "OPEN") {
          setFlag(p.key, { fixedSha: p.headSha });
          fixRef.current(p);
        }
      }
    };
    void load();
    // Checks move on their own, so keep the dot honest while any run is open.
    const t = setInterval(load, 45000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [keys.join(",")]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  if (!metas.length) return null;
  const visible = expanded ? metas : metas.slice(-2);
  const hidden = metas.length - visible.length;

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {visible.map((p) => {
        const w = watch[p.key] ?? {};
        return (
          <div
            key={p.key}
            className="group relative flex items-center gap-3 rounded-[10px] border border-[var(--bd-soft)] bg-[var(--panel)] px-3 py-2 text-xs"
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
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpen(open === p.key ? null : p.key);
              }}
              className="flex shrink-0 items-center gap-1.5 rounded bg-[var(--composer)] px-1.5 py-0.5 text-[11px] text-[var(--txt-dim)] hover:text-[var(--txt)]"
              title={`${p.ciPassed}/${p.ciTotal} checks passed`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${CI_DOT[p.ci]}`} />
              CI
              <span className="text-[9px] text-[var(--txt-faint)]">▾</span>
            </button>
            <button
              onClick={() => onDismiss(p.key)}
              className="shrink-0 text-[var(--txt-faint)] opacity-0 transition-opacity hover:text-[var(--txt)] group-hover:opacity-100"
              title="Hide"
            >
              ×
            </button>

            {open === p.key && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute bottom-full right-2 z-20 mb-1.5 w-[280px] rounded-xl border border-[var(--bd)] bg-[var(--modal)] p-1.5 shadow-xl"
              >
                <div className="flex items-center gap-2 px-2 pt-1 pb-1.5">
                  <span className="flex-1 text-[var(--txt-faint)]">CI monitoring</span>
                  <button
                    onClick={() => void invoke("open_external", { url: `${p.url}/checks` }).catch(() => {})}
                    className="text-[var(--txt-faint)] hover:text-[var(--txt)]"
                    title="Open the checks on GitHub"
                  >
                    ↗
                  </button>
                </div>
                <div className="flex items-center gap-2 px-2 py-1 text-[var(--txt)]">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${CI_DOT[p.ci]}`} />
                  <span className="flex-1">{CI_LABEL[p.ci]}</span>
                  {p.ciTotal > 0 && <span className="tabular-nums text-[var(--txt-faint)]">{p.ciTotal}</span>}
                </div>
                {p.threads > 0 && (
                  <button
                    onClick={() => {
                      setOpen(null);
                      onFixComments(p);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-[var(--panel-2)]"
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                    <span className="flex-1 text-[var(--txt)]">Review comments</span>
                    <span className="tabular-nums text-[var(--txt-faint)]">{p.threads}</span>
                  </button>
                )}
                <div className="my-1.5 border-t border-[var(--bd-soft)]" />
                {(
                  [
                    ["autoFix", "Auto-fix CI & address comments"],
                    ["autoMerge", "Auto-merge when ready"],
                    ["autoArchive", "Auto-archive after PR merge or close"],
                  ] as [keyof Watch, string][]
                ).map(([flag, label]) => (
                  <label
                    key={flag}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-[var(--panel-2)]"
                  >
                    <input
                      type="checkbox"
                      checked={!!w[flag]}
                      onChange={(e) => {
                        setFlag(p.key, { [flag]: e.target.checked });
                        // GitHub owns the merge queue: turning the toggle on hands
                        // it the PR, so Alter never polls to merge.
                        if (flag === "autoMerge")
                          void invoke("pr_auto_merge", { pr: p.key, on: e.target.checked }).catch(() => {});
                      }}
                      className="h-3.5 w-3.5 shrink-0 accent-indigo-500"
                    />
                    <span className="text-[var(--txt)]">{label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
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
