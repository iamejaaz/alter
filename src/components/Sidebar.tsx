import { useState } from "react";
import { Conversation, Project, Routine } from "../lib/store";
import { confirmDialog } from "../lib/confirm";
import Logo from "./Logo";
import { IconClock, IconPlus, IconSearch, IconSettings, IconSparkles } from "./Icons";

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  routines: Routine[];
  streamingIds: string[];
  projects: Project[];
  activeProjectId: string | null;
  onSelectProject: (id: string | null) => void;
  onManageProjects: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string) => void;
  onOpenSettings: () => void;
  onOpenRoutines: () => void;
  onOpenSkills: () => void;
  onOpenPalette?: () => void;
}

export default function Sidebar({
  conversations,
  activeId,
  routines,
  streamingIds,
  projects,
  activeProjectId,
  onSelectProject,
  onManageProjects,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onTogglePin,
  onOpenSettings,
  onOpenRoutines,
  onOpenSkills,
  onOpenPalette,
}: Props) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
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
  const sections = q
    ? [{ label: `Results (${filtered.length})`, items: filtered }]
    : [
        ...(pinned.length ? [{ label: "Pinned", items: pinned }] : []),
        ...(rest.length ? [{ label: "Recent", items: rest }] : []),
      ];
  // Every routine shows, even with no run yet, so the sidebar is the routine list.
  const routineRows = routines.map((r) => ({ routine: r, runs: runsByRoutine.get(r.id) ?? [] }));

  // A run under its routine: the title only repeats the routine name, so show when
  // it ran instead — "Today at 10:40 AM", "Yesterday at …", else "Sep 19 at …".
  const runLabel = (c: Conversation) => {
    const d = new Date(c.createdAt);
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const days = Math.floor((midnight.getTime() - d.getTime()) / 86400000) + 1;
    if (days <= 0) return `Today at ${time}`;
    if (days === 1) return `Yesterday at ${time}`;
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
  };

  const renderRun = (c: Conversation) => {
    const running = streamingIds.includes(c.id);
    return (
    <div
      key={c.id}
      className={`group flex items-center rounded-lg px-2 py-1 text-xs cursor-pointer transition-colors ${
        c.id === activeId
          ? "bg-[var(--panel-2)] text-[var(--txt)]"
          : "text-[var(--txt-faint)] hover:bg-[var(--panel)] hover:text-[var(--txt)]"
      }`}
      onClick={() => onSelect(c.id)}
      title={running ? "Running" : "Completed"}
    >
      {running && <span className="mr-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--txt-dim)] animate-pulse" />}
      <span className="flex-1 truncate">{runLabel(c)}</span>
      <button
        onClick={async (e) => {
          e.stopPropagation();
          if (await confirmDialog(`Delete this run? This can't be undone.`)) onDelete(c.id);
        }}
        className="opacity-0 group-hover:opacity-100 text-[var(--txt-faint)] hover:text-[var(--txt)] ml-1.5 transition-opacity"
        title="Delete run"
      >
        ×
      </button>
    </div>
    );
  };

  const renderChat = (c: Conversation) => (
    <div
      key={c.id}
      className={`group flex items-center rounded-lg px-2 py-1.5 text-sm cursor-pointer transition-colors ${
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
        <span className="flex-1 truncate">
          {c.pinned && <span className="mr-1.5 text-[var(--txt-faint)]">★</span>}
          {c.title}
        </span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin(c.id);
        }}
        className="ml-2 text-[11px] opacity-0 group-hover:opacity-100 text-[var(--txt-faint)] hover:text-[var(--txt)] transition-opacity"
        title={c.pinned ? "Unpin" : "Pin to top"}
      >
        {c.pinned ? "unpin" : "☆"}
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          startRename(c);
        }}
        className="opacity-0 group-hover:opacity-100 text-[var(--txt-faint)] hover:text-[var(--txt)] ml-1.5 transition-opacity"
        title="Rename"
      >
        ✎
      </button>
      <button
        onClick={async (e) => {
          e.stopPropagation();
          if (await confirmDialog(`Delete "${c.title}"? This can't be undone.`)) onDelete(c.id);
        }}
        className="opacity-0 group-hover:opacity-100 text-[var(--txt-faint)] hover:text-[var(--txt)] ml-1.5 transition-opacity"
        title="Delete"
      >
        ×
      </button>
    </div>
  );

  return (
    <aside className="w-64 shrink-0 flex flex-col border-r border-[var(--bd-soft)] bg-[var(--sidebar)]">
      <div data-tauri-drag-region className="h-12 flex items-end px-4 pb-1 pl-20">
        <div className="flex items-center gap-2 pointer-events-none">
          <Logo size={18} />
          <span className="text-[15px] font-semibold tracking-tight text-[var(--txt)]">Alter</span>
        </div>
      </div>

      <div className="space-y-2 px-3 pt-2 pb-2">
        <div className="flex items-center gap-1">
          <div className="relative flex-1">
            <select
              value={activeProjectId ?? ""}
              onChange={(e) => onSelectProject(e.target.value || null)}
              className="w-full appearance-none rounded-lg border border-[var(--bd)] bg-[var(--panel)] px-2.5 py-1.5 pr-6 text-sm text-[var(--txt)] focus:outline-none cursor-pointer"
              title="Project"
            >
              <option value="">All chats</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id} className="bg-[var(--modal)]">
                  {p.name}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--txt-faint)]">▾</span>
          </div>
          <button
            onClick={onManageProjects}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--txt-faint)] hover:bg-[var(--panel-2)] hover:text-[var(--txt)] transition-colors"
            title="Manage projects"
          >
            <IconSettings />
          </button>
        </div>
        <button
          onClick={onNew}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-[var(--panel)] hover:bg-[var(--panel-2)] border border-[var(--bd)] px-3 py-1.5 text-sm text-[var(--txt)] transition-colors"
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
            className="w-full rounded-lg bg-[var(--panel)] border border-[var(--bd)] pl-8 pr-3 py-1.5 text-sm text-[var(--txt)] placeholder:text-[var(--txt-faint)] focus:outline-none focus:border-[var(--txt-faint)]"
          />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {!q && routineRows.length > 0 && (
          <div>
            <p className="px-2 pt-3 pb-1 text-xs text-[var(--txt-faint)]">Routines</p>
            <div className="space-y-0.5">
              {routineRows.map(({ routine, runs }) => {
                const open = expanded.has(routine.id);
                const activeHere = runs.some((x) => x.id === activeId);
                return (
                  <div key={routine.id}>
                    <div
                      className={`group flex items-center rounded-lg px-2 py-1.5 text-sm cursor-pointer transition-colors ${
                        activeHere && !open
                          ? "bg-[var(--panel-2)] text-[var(--txt)]"
                          : "text-[var(--txt-dim)] hover:bg-[var(--panel)] hover:text-[var(--txt)]"
                      }`}
                      onClick={() => (runs[0] ? onSelect(runs[0].id) : onOpenRoutines())}
                      title={runs.length ? `${runs.length} run${runs.length > 1 ? "s" : ""} · newest first` : "No runs yet"}
                    >
                      <span
                        className={`mr-2 h-1.5 w-1.5 shrink-0 rounded-full ${
                          routine.enabled ? "bg-[var(--txt-dim)]" : "border border-[var(--txt-faint)]"
                        }`}
                      />
                      <span className="flex-1 truncate">{routine.name}</span>
                      {runs.length > 0 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              next.has(routine.id) ? next.delete(routine.id) : next.add(routine.id);
                              return next;
                            });
                          }}
                          className="ml-1.5 text-[10px] text-[var(--txt-faint)] hover:text-[var(--txt)] transition-colors"
                          title={open ? "Hide runs" : `Show ${runs.length} run${runs.length > 1 ? "s" : ""}`}
                        >
                          {open ? "▾" : `${runs.length} ▸`}
                        </button>
                      )}
                    </div>
                    {open && <div className="ml-3 border-l border-[var(--bd-soft)] pl-1 space-y-0.5">{runs.map(renderRun)}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {sections.map((s) => (
          <div key={s.label}>
            <p className="px-2 pt-3 pb-1 text-xs text-[var(--txt-faint)]">{s.label}</p>
            <div className="space-y-0.5">{s.items.map(renderChat)}</div>
          </div>
        ))}
        {conversations.length === 0 && <p className="px-2 py-6 text-center text-xs text-[var(--txt-faint)]">No chats yet</p>}
        {conversations.length > 0 && filtered.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-[var(--txt-faint)]">No chats match</p>
        )}
      </nav>

      <div className="border-t border-[var(--bd-soft)] px-2 py-2">
        <div className="space-y-0.5">
          {[
            { label: "Skills", icon: <IconSparkles />, run: onOpenSkills },
            { label: "Routines", icon: <IconClock />, run: onOpenRoutines },
            { label: "Settings", icon: <IconSettings />, run: onOpenSettings },
          ].map((it) => (
            <button
              key={it.label}
              onClick={it.run}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-[var(--txt-dim)] hover:bg-[var(--panel-2)] hover:text-[var(--txt)] transition-colors"
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
