import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileChange } from "../lib/store";
import { confirmDialog } from "../lib/confirm";

type Line = { t: " " | "+" | "-"; s: string };

function diffLines(a: string[], b: string[]): Line[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const x = a.slice(pre, a.length - suf);
  const y = b.slice(pre, b.length - suf);
  const mid: Line[] = [];
  if (x.length * y.length > 4_000_000) {
    x.forEach((s) => mid.push({ t: "-", s }));
    y.forEach((s) => mid.push({ t: "+", s }));
  } else {
    const n = x.length;
    const m = y.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        mid.push({ t: " ", s: x[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) mid.push({ t: "-", s: x[i++] });
      else mid.push({ t: "+", s: y[j++] });
    }
    while (i < n) mid.push({ t: "-", s: x[i++] });
    while (j < m) mid.push({ t: "+", s: y[j++] });
  }
  return [
    ...a.slice(0, pre).map((s) => ({ t: " " as const, s })),
    ...mid,
    ...a.slice(a.length - suf).map((s) => ({ t: " " as const, s })),
  ];
}

function hunks(lines: Line[], ctx = 3): (Line | null)[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.t !== " ") for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) keep[k] = true;
  });
  const out: (Line | null)[] = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out.length && out[out.length - 1] !== null) out.push(null);
  });
  return out;
}

export default function ChangesPanel({
  changes,
  onClose,
  onReverted,
}: {
  changes: FileChange[];
  onClose: () => void;
  onReverted: (path: string) => void;
}) {
  const [sel, setSel] = useState<FileChange | null>(changes[changes.length - 1] ?? null);
  const [data, setData] = useState<{ before: string | null; after: string | null; now: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!sel) return;
    setData(null);
    setErr(null);
    Promise.all([
      sel.created ? Promise.resolve(null) : invoke<string | null>("snapshot_load", { key: `${sel.key}-before` }),
      invoke<string | null>("snapshot_load", { key: `${sel.key}-after` }),
      invoke<string | null>("file_read_full", { path: sel.path }),
    ])
      .then(([before, after, now]) => setData({ before, after, now }))
      .catch((e) => setErr(String(e)));
  }, [sel]);

  const drifted = !!data && data.now !== data.after;
  const lines = data ? hunks(diffLines((data.before ?? "").split("\n"), (data.after ?? "").split("\n"))) : [];
  const added = lines.filter((l) => l?.t === "+").length;
  const removed = lines.filter((l) => l?.t === "-").length;

  const revert = async () => {
    if (!sel || !data) return;
    const what = sel.created ? "delete this file Alter created" : "restore the version from before Alter edited it";
    const warn = drifted ? "\n\nThe file changed after Alter wrote it. Reverting also discards those later edits." : "";
    if (!(await confirmDialog(`Revert ${sel.path}?\n\nThis will ${what}.${warn}`))) return;
    try {
      if (sel.created) await invoke("file_remove", { path: sel.path });
      else if (data.before !== null) await invoke("write_file", { path: sel.path, content: data.before });
      onReverted(sel.path);
      setSel(null);
    } catch (e) {
      setErr(String(e));
    }
  };

  const name = (p: string) => p.split("/").pop() ?? p;

  return (
    <aside className="w-[45%] min-w-[360px] shrink-0 flex flex-col border-l border-[var(--bd-soft)] bg-[var(--bg)]">
      <div className="flex items-center gap-2 h-12 px-4 shrink-0 border-b border-[var(--bd-soft)]">
        <span className="flex-1 text-sm font-medium text-[var(--txt)]">Changes in this chat</span>
        <button
          onClick={onClose}
          className="rounded-lg hover:bg-[var(--panel-2)] px-2 py-1.5 text-[var(--txt-dim)] transition-colors"
          title="Close"
        >
          ×
        </button>
      </div>
      <div className="shrink-0 max-h-48 overflow-auto border-b border-[var(--bd-soft)] py-1">
        {changes.length === 0 && <p className="px-4 py-2 text-[12px] text-[var(--txt-faint)]">No files changed yet.</p>}
        {[...changes].reverse().map((c) => (
          <button
            key={c.path}
            onClick={() => setSel(c)}
            className={`flex w-full items-center gap-2 px-4 py-1.5 text-left text-[12px] transition-colors ${
              sel?.path === c.path ? "bg-[var(--panel-2)] text-[var(--txt)]" : "text-[var(--txt-dim)] hover:bg-[var(--panel)]"
            }`}
            title={c.path}
          >
            <span className="w-14 shrink-0 text-[11px] text-[var(--txt-faint)]">{c.created ? "New" : "Modified"}</span>
            <span className="truncate font-mono">{name(c.path)}</span>
            <span className="ml-auto truncate text-[11px] text-[var(--txt-faint)]">{c.path.replace(/\/[^/]*$/, "")}</span>
          </button>
        ))}
      </div>
      {sel && (
        <div className="flex items-center gap-3 px-4 py-2 shrink-0 border-b border-[var(--bd-soft)] text-[12px]">
          <span className="truncate font-mono text-[var(--txt)]">{name(sel.path)}</span>
          {data && (
            <span className="text-[var(--txt-faint)]">
              +{added} −{removed}
            </span>
          )}
          {drifted && <span className="text-amber-400">{data?.now === null ? "Deleted since" : "Changed since"} Alter wrote it</span>}
          <button
            onClick={revert}
            disabled={!data}
            className="ml-auto rounded-md border border-[var(--bd)] px-2.5 py-1 text-[var(--txt)] hover:bg-[var(--panel-2)] disabled:opacity-50"
          >
            Revert
          </button>
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {err && <p className="px-4 py-2 text-[12px] text-red-400">{err}</p>}
        {sel && data && (
          <pre className="py-2 text-[12px] leading-[1.5] font-mono">
            {lines.map((l, i) =>
              l === null ? (
                <div key={i} className="px-4 text-[var(--txt-faint)]">
                  ⋯
                </div>
              ) : (
                <div
                  key={i}
                  className={`px-4 whitespace-pre-wrap break-all ${
                    l.t === "+"
                      ? "bg-emerald-500/10 text-emerald-300"
                      : l.t === "-"
                        ? "bg-red-500/10 text-red-300"
                        : "text-[var(--txt-dim)]"
                  }`}
                >
                  {l.t === " " ? " " : l.t} {l.s}
                </div>
              )
            )}
          </pre>
        )}
      </div>
    </aside>
  );
}
