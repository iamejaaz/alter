import { useEffect, useState } from "react";
import { Conversation, Project, Routine } from "../lib/store";
import { confirmDialog } from "../lib/confirm";
import Logo from "./Logo";
import { IconClock, IconPlus, IconSearch, IconSettings } from "./Icons";

export interface BackgroundRun {
  runId: string;
  label: string;
  url?: string;
  kind?: string;
  startedAt: number;
  done: boolean;
  error?: string | null;
  step?: string;
}

interface Props {
  backgroundRuns?: BackgroundRun[];
  onOpenRun?: (runId: string) => void;
  onStopRun?: (runId: string) => void;
  onDismissRun?: (runId?: string) => void;
  conversations: Conversation[];
  activeId: string | null;
  routines: Routine[];
  streamingIds: string[];
  scheduledIds?: string[];
  jobs?: Record<string, { since: number; step?: string }>;
  projects: Project[];
  activeProjectId: string | null;
  onSelectProject: (id: string | null) => void;
  onNewProject: () => void;
  onMoveToProject: (id: string, projectId: string | null) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onNewIn?: (projectId: string | null, folder?: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string) => void;
  onToggleMute: (id: string) => void;
  onOpenSettings: () => void;
  onOpenRoutines: () => void;
  onOpenRuns: (routineId: string) => void;
  onOpenPalette?: () => void;
}

const since = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

export default function Sidebar({
  backgroundRuns = [],
  onOpenRun,
  onStopRun,
  onDismissRun,
  conversations,
  activeId,
  routines,
  streamingIds,
  scheduledIds = [],
  jobs = {},
  projects,
  activeProjectId,
  onSelectProject,
  onNewProject,
  onMoveToProject,
  onSelect,
  onNew,
  onNewIn,
  onDelete,
  onRename,
  onTogglePin,
  onToggleMute,
  onOpenSettings,
  onOpenRoutines,
  onOpenRuns,
  onOpenPalette,
}: Props) {
  const [query, setQuery] = useState("");
  const [, setTick] = useState(0);
  const running = Object.keys(jobs).length > 0;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [running]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; up: boolean; moving: boolean } | null>(null);
  const menuItem =
    "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-[var(--panel-2)]";
  const startRename = (c: Conversation) => {
    setEditingId(c.id);
    setDraftTitle(c.title);
  };
  const commitRename = () => {
    if (editingId) {
      const t = draftTitle.trim();
      if (t) onRename(editingId, t);
    }
    setEditingId(null);
  };
  const q = query.trim().toLowerCase();
  const scoped = activeProjectId
    ? conversations.filter((c) => c.projectId === activeProjectId)
    : conversations;
  const matched = q
    ? scoped.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.messages.some((m) => m.content?.toLowerCase().includes(q))
      )
    : scoped;
  const filtered = [...matched].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  // A routine's runs belong under the routine, not loose in Recent — one row per
  // routine instead of one per run. Chats made before `routineId` existed are
  // matched by the "⏱ <name>" title they were given.
  const routineOf = (c: Conversation) =>
    routines.find((r) => (c.routineId ? r.id === c.routineId : c.title === `⏱ ${r.name}`)) ?? null;
  const runsByRoutine = new Map<string, Conversation[]>();
  const loose: Conversation[] = [];
  for (const c of filtered) {
    const r = routineOf(c);
    if (r) runsByRoutine.set(r.id, [...(runsByRoutine.get(r.id) ?? []), c]);
    else loose.push(c);
  }
  const pinned = loose.filter((c) => c.pinned);
  const rest = loose.filter((c) => !c.pinned);
  type Section = { key: string; label: string; items: Conversation[]; projectId?: string | null; folder?: string };
  const groups: Section[] = [];
  const other: Conversation[] = [];
  for (const c of rest) {
    const project = projects.find((p) => p.id === c.projectId) ?? (c.folder ? projects.find((p) => p.folder === c.folder) : undefined);
    const dir = project?.folder ?? c.folder;
    if (!project && !dir) {
      other.push(c);
      continue;
    }
    const key = project ? `p:${project.id}` : `f:${dir}`;
    const g = groups.find((x) => x.key === key);
    if (g) g.items.push(c);
    else
      groups.push({
        key,
        label: project?.name ?? dir!.replace(/\/+$/, "").split("/").pop()!,
        items: [c],
        projectId: project?.id ?? null,
        folder: dir ?? "",
      });
  }
  const flat: Section[] = rest.length ? [{ key: "recent", label: "Recent", items: rest }] : [];
  const grouped: Section[] = [...groups, ...(other.length ? [{ key: "other", label: "Other chats", items: other }] : [])];
  const sections: Section[] = q
    ? [{ key: "results", label: `Results (${filtered.length})`, items: filtered }]
    : [
        ...(pinned.length ? [{ key: "pinned", label: "Pinned", items: pinned }] : []),
        ...(activeProjectId || !groups.length ? flat : grouped),
      ];
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("alter.collapsedGroups") || "[]");
    } catch {
      return [];
    }
  });
  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      try {
        localStorage.setItem("alter.collapsedGroups", JSON.stringify(next));
      } catch {}
      return next;
    });
  // Every routine shows, even with no run yet, so the sidebar is the routine list.
  const routineRows = routines.map((r) => ({ routine: r, runs: runsByRoutine.get(r.id) ?? [] }));

  const longJob = (id: string) => !!jobs[id] && Date.now() - jobs[id].since >= 10000;
  const renderChat = (c: Conversation) => (
    <div
      key={c.id}
      className={`group relative flex min-h-7 items-center rounded-lg px-2 py-0.5 text-[13px] cursor-pointer transition-colors ${
        c.id === activeId
          ? "bg-[var(--panel-2)] text-[var(--txt)]"
          : "text-[var(--txt-dim)] hover:bg-[var(--panel)] hover:text-[var(--txt)]"
      }`}
      onClick={() => editingId !== c.id && onSelect(c.id)}
      onDoubleClick={() => startRename(c)}
    >
      {editingId === c.id ? (
        <input
          autoFocus
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setEditingId(null);
          }}
          className="flex-1 min-w-0 bg-transparent border-b border-[var(--bd)] focus:border-zinc-500 text-[var(--txt)] focus:outline-none"
        />
      ) : (
        <>
          {streamingIds.includes(c.id) && (
            <span
              className={`mr-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--txt-dim)] animate-pulse ${longJob(c.id) ? "self-start mt-[7px]" : ""}`}
              title="Running"
            />
          )}
          <span className="min-w-0 flex-1">
            <span className={`block truncate ${c.unread && c.id !== activeId ? "font-medium text-[var(--txt)]" : ""}`}>
              {c.pinned && <span className="mr-1.5 text-[var(--txt-faint)]">★</span>}
              {c.title}
            </span>
            {longJob(c.id) && (
              <span className="block truncate pb-0.5 text-[11px] leading-tight text-[var(--txt-faint)]" title={jobs[c.id].step}>
                {jobs[c.id].step || "Thinking"} · {since(jobs[c.id].since)}
              </span>
            )}
          </span>
          {scheduledIds.includes(c.id) && (
            <span className="ml-1 shrink-0 scale-75 text-[var(--txt-faint)]" title="Has a message scheduled to send later">
              <IconClock />
            </span>
          )}
          {c.unread && c.id !== activeId && !streamingIds.includes(c.id) && (
            <span className="ml-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--txt)]" title="New reply" />
          )}
        </>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          const up = r.bottom + 240 > window.innerHeight;
          setMenu((cur) =>
            cur?.id === c.id ? null : { id: c.id, x: r.right, y: up ? window.innerHeight - r.top + 4 : r.bottom + 4, up, moving: false }
          );
        }}
        className={`ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--txt-faint)] hover:bg-[var(--panel-2)] hover:text-[var(--txt)] transition-opacity ${
          menu?.id === c.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        title="More"
        aria-label={`More actions for ${c.title}`}
      >
        ⋮
      </button>
      {menu?.id === c.id && (
        <>
          <div className="fixed inset-0 z-30" onClick={(e) => { e.stopPropagation(); setMenu(null); }} />
          <div
            className="fixed z-40 w-48 -translate-x-full rounded-lg border border-[var(--bd)] bg-[var(--modal)] py-1 shadow-2xl"
            style={menu.up ? { left: menu.x, bottom: menu.y } : { left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {menu.moving ? (
              <>
                <button onClick={() => setMenu({ ...menu, moving: false })} className={`${menuItem} text-[var(--txt-dim)]`}>
                  ‹ Move to project
                </button>
                <div className="my-1 border-t border-[var(--bd-soft)]" />
                {[{ id: null as string | null, name: "No project" }, ...projects].map((p) => (
                  <button
                    key={p.id ?? "none"}
                    onClick={() => { onMoveToProject(c.id, p.id); setMenu(null); }}
                    className={`${menuItem} ${(c.projectId ?? null) === p.id ? "text-[var(--txt)]" : "text-[var(--txt-dim)]"}`}
                  >
                    <span className="truncate">{p.name}</span>
                    {(c.projectId ?? null) === p.id && <span className="text-[var(--txt-faint)]">✓</span>}
                  </button>
                ))}
              </>
            ) : (
              <>
                <button onClick={() => { onTogglePin(c.id); setMenu(null); }} className={`${menuItem} text-[var(--txt)]`}>
                  {c.pinned ? "Unpin" : "Pin"}
                </button>
                <button onClick={() => { startRename(c); setMenu(null); }} className={`${menuItem} text-[var(--txt)]`}>
                  Rename
                </button>
                <button onClick={() => { onToggleMute(c.id); setMenu(null); }} className={`${menuItem} text-[var(--txt)]`}>
                  {c.muted ? "Unmute notifications" : "Mute notifications"}
                </button>
                <div className="my-1 border-t border-[var(--bd-soft)]" />
                <button onClick={() => setMenu({ ...menu, moving: true })} className={`${menuItem} text-[var(--txt)]`}>
                  Move to project
                  <span className="text-[var(--txt-faint)]">›</span>
                </button>
                <div className="my-1 border-t border-[var(--bd-soft)]" />
                <button
                  onClick={async () => {
                    setMenu(null);
                    if (await confirmDialog(`Delete "${c.title}"? This can't be undone.`)) onDelete(c.id);
                  }}
                  className={`${menuItem} text-red-400`}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <aside className="w-64 shrink-0 flex flex-col border-r border-[var(--bd-soft)] bg-[var(--sidebar)]">
      <div data-tauri-drag-region className="h-12 flex items-end px-4 pb-1 pl-20">
        <div className="flex items-center gap-2 pointer-events-none">
          <Logo size={18} />
          <span className="text-base font-semibold tracking-tight text-[var(--txt)]">Alter</span>
        </div>
      </div>

      <div className="space-y-2 px-3 pt-2 pb-2">
        <div className="flex items-center gap-1">
          <div className="relative flex-1">
            <select
              value={activeProjectId ?? ""}
              onChange={(e) => {
                if (e.target.value === "__new__") onNewProject();
                else onSelectProject(e.target.value || null);
              }}
              className="h-7 w-full appearance-none rounded-lg border border-[var(--bd)] bg-[var(--panel)] px-2 pr-6 text-[13px] text-[var(--txt)] focus:outline-none cursor-pointer"
              title="Project"
            >
              <option value="">All chats</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id} className="bg-[var(--modal)]">
                  {p.name}
                </option>
              ))}
              <option value="__new__" className="bg-[var(--modal)]">＋ New project…</option>
            </select>
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--txt-faint)]">▾</span>
          </div>
        </div>
        <button
          onClick={onNew}
          className="flex h-7 w-full items-center justify-center gap-2 rounded-lg bg-[var(--panel)] hover:bg-[var(--panel-2)] border border-[var(--bd)] px-3 text-[13px] text-[var(--txt)] transition-colors"
        >
          <IconPlus />
          New chat
        </button>
        <div className="relative">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--txt-faint)]">
            <IconSearch />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            className="h-7 w-full rounded-lg bg-[var(--panel)] border border-[var(--bd)] pl-8 pr-2 text-[13px] text-[var(--txt)] placeholder:text-[var(--txt-faint)] focus:outline-none focus:border-[var(--txt-faint)]"
          />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {!q && backgroundRuns.length > 0 && (
          <div>
            <div className="group flex items-center px-2 pt-3 pb-1 text-xs leading-[1.15] text-[var(--txt-faint)]">
              <span className="flex-1">
                {backgroundRuns.some((r) => !r.done) ? `Running now · ${backgroundRuns.filter((r) => !r.done).length}` : "Recent runs"}
              </span>
              {backgroundRuns.some((r) => r.done) && (
                <button onClick={() => onDismissRun?.()} className="hidden hover:text-[var(--txt)] group-hover:block">
                  Clear
                </button>
              )}
            </div>
            <div className="space-y-0.5">
              {backgroundRuns.map((r) => (
                <div
                  key={r.runId}
                  className="group flex min-h-7 items-center gap-2 rounded-lg px-2 py-1 text-[13px] cursor-pointer text-[var(--txt-dim)] hover:bg-[var(--panel)] hover:text-[var(--txt)]"
                  onClick={() => onOpenRun?.(r.runId)}
                  title={r.error || r.step || r.label}
                >
                  <span className="flex w-2 shrink-0 justify-center">
                    {!r.done ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--txt-dim)] animate-pulse" />
                    ) : (
                      <span className={`text-[10px] ${r.error ? "text-red-400" : "text-[var(--txt-faint)]"}`}>{r.error ? "✕" : "✓"}</span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate ${r.done ? "" : "text-[var(--txt)]"}`}>{r.label}</span>
                    {!r.done && <span className="block truncate text-[11px] text-[var(--txt-faint)]">{r.step || "Starting"}</span>}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-[var(--txt-faint)] group-hover:hidden">{since(r.startedAt)}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (r.done) onDismissRun?.(r.runId);
                      else onStopRun?.(r.runId);
                    }}
                    className="hidden shrink-0 text-[11px] text-[var(--txt-faint)] hover:text-[var(--txt)] group-hover:block"
                  >
                    {r.done ? "Remove" : "Stop"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {!q && routineRows.length > 0 && (
          <div>
            <p className="px-2 pt-3 pb-1 text-xs leading-[1.15] text-[var(--txt-faint)]">Routines</p>
            <div className="space-y-0.5">
              {routineRows.map(({ routine, runs }) => {
                const activeHere = runs.some((x) => x.id === activeId);
                const running = runs.some((x) => streamingIds.includes(x.id));
                return (
                  <div
                    key={routine.id}
                    className={`group flex h-7 items-center rounded-lg px-2 text-[13px] cursor-pointer transition-colors ${
                      activeHere
                        ? "bg-[var(--panel-2)] text-[var(--txt)]"
                        : "text-[var(--txt-dim)] hover:bg-[var(--panel)] hover:text-[var(--txt)]"
                    }`}
                    onClick={() => onOpenRuns(routine.id)}
                    title={`${runs.length ? `${runs.length} run${runs.length > 1 ? "s" : ""}` : "No runs yet"}${routine.enabled ? "" : " · paused"}`}
                  >
                    {/* A dot means running, nothing else — a permanent one would read
                        as "this is going" on a routine that is merely scheduled. */}
                    {running && <span className="mr-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--txt-dim)] animate-pulse" />}
                    <span className={`flex-1 truncate ${routine.enabled ? "" : "opacity-50"}`}>{routine.name}</span>
                    {runs.length > 0 && (
                      <span className="ml-1.5 text-[10px] text-[var(--txt-faint)]">{runs.length}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {sections.map((s) => {
          const folded = collapsed.includes(s.key) && !s.items.some((c) => c.id === activeId);
          return (
            <div key={s.key}>
              <div className="group flex items-center px-2 pt-3 pb-1 text-xs leading-[1.15] text-[var(--txt-faint)]">
                <button
                  onClick={() => toggleGroup(s.key)}
                  className="min-w-0 flex-1 truncate text-left hover:text-[var(--txt)]"
                  title={s.folder || s.label}
                >
                  {s.label}
                  {folded && <span className="ml-1.5">{s.items.length}</span>}
                </button>
                {s.folder !== undefined && onNewIn && (
                  <button
                    onClick={() => onNewIn(s.projectId ?? null, s.folder || undefined)}
                    className="shrink-0 opacity-0 hover:text-[var(--txt)] group-hover:opacity-100 transition-opacity"
                    title={`New chat in ${s.label}`}
                    aria-label={`New chat in ${s.label}`}
                  >
                    <IconPlus />
                  </button>
                )}
              </div>
              {!folded && <div className="space-y-0.5">{s.items.map(renderChat)}</div>}
            </div>
          );
        })}
        {conversations.length === 0 && <p className="px-2 py-6 text-center text-xs text-[var(--txt-faint)]">No chats yet</p>}
        {conversations.length > 0 && filtered.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-[var(--txt-faint)]">No chats match</p>
        )}
      </nav>

      <div className="border-t border-[var(--bd-soft)] px-2 py-2">
        <div className="space-y-0.5">
          {[
            { label: "Routines", icon: <IconClock />, run: onOpenRoutines },
            { label: "Settings", icon: <IconSettings />, run: onOpenSettings },
          ].map((it) => (
            <button
              key={it.label}
              onClick={it.run}
              className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-[13px] text-[var(--txt-dim)] hover:bg-[var(--panel-2)] hover:text-[var(--txt)] transition-colors"
            >
              <span className="text-[var(--txt-faint)]">{it.icon}</span>
              {it.label}
            </button>
          ))}
        </div>
        {onOpenPalette && (
          <button
            onClick={onOpenPalette}
            className="mt-1 flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs text-[var(--txt-faint)] hover:bg-[var(--panel-2)] hover:text-[var(--txt)] transition-colors"
          >
            <span>Command palette</span>
            <kbd className="rounded border border-[var(--bd)] px-1 font-sans text-[10px]">⌘K</kbd>
          </button>
        )}
      </div>
    </aside>
  );
}
