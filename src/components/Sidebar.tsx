import { useState } from "react";
import { Conversation, Project } from "../lib/store";
import { confirmDialog } from "../lib/confirm";
import Logo from "./Logo";

interface Props {
  conversations: Conversation[];
  activeId: string | null;
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
}

export default function Sidebar({
  conversations,
  activeId,
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
}: Props) {
  const [query, setQuery] = useState("");
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
  const pinned = filtered.filter((c) => c.pinned);
  const rest = filtered.filter((c) => !c.pinned);
  const sections = q
    ? [{ label: `Results (${filtered.length})`, items: filtered }]
    : [
        ...(pinned.length ? [{ label: "Pinned", items: pinned }] : []),
        ...(rest.length ? [{ label: "Recent", items: rest }] : []),
      ];

  const renderChat = (c: Conversation) => (
    <div
      key={c.id}
      className={`group flex items-center rounded-lg px-2.5 py-2 text-sm cursor-pointer transition-colors ${
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
        <span className="flex-1 truncate">{c.title}</span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin(c.id);
        }}
        className={`ml-2 transition-opacity ${
          c.pinned
            ? "text-[var(--txt-dim)] hover:text-[var(--txt)]"
            : "opacity-0 group-hover:opacity-100 text-[var(--txt-faint)] hover:text-[var(--txt)]"
        }`}
        title={c.pinned ? "Unpin" : "Pin to top"}
      >
        {c.pinned ? "★" : "☆"}
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

      <div className="px-3 pt-2 pb-3">
        <div className="mb-2 flex items-center gap-1">
          <div className="relative flex-1">
            <select
              value={activeProjectId ?? ""}
              onChange={(e) => onSelectProject(e.target.value || null)}
              className="w-full appearance-none rounded-lg border border-[var(--bd)] bg-[var(--panel)] px-2.5 py-1.5 pr-6 text-xs font-medium text-[var(--txt)] focus:outline-none cursor-pointer"
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
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--bd)] text-[var(--txt-dim)] hover:bg-[var(--panel-2)] hover:text-[var(--txt)] transition-colors"
            title="Manage projects"
          >
            ⚙
          </button>
        </div>
        <button
          onClick={onNew}
          className="w-full flex items-center gap-2 rounded-xl bg-[var(--panel)] hover:bg-[var(--panel-2)] border border-[var(--bd)] px-3 py-2 text-sm text-[var(--txt)] transition-colors"
        >
          <span className="text-base leading-none text-[var(--txt-dim)]">＋</span>
          New chat
        </button>
        {conversations.length > 3 && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            className="mt-2 w-full rounded-lg bg-[var(--panel)] border border-[var(--bd)] px-3 py-1.5 text-xs text-[var(--txt)] placeholder:text-[var(--txt-faint)] focus:outline-none focus:border-indigo-500/40"
          />
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2">
        {sections.map((s) => (
          <div key={s.label}>
            <p className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-[var(--txt-faint)]">
              {s.label}
            </p>
            <div className="space-y-0.5">{s.items.map(renderChat)}</div>
          </div>
        ))}
        {conversations.length === 0 && (
          <p className="px-2.5 py-2 text-xs text-[var(--txt-faint)]">No conversations yet.</p>
        )}
        {conversations.length > 0 && filtered.length === 0 && (
          <p className="px-2.5 py-2 text-xs text-[var(--txt-faint)]">No matches.</p>
        )}
      </nav>

      <div className="flex gap-1 p-2 border-t border-[var(--bd-soft)]">
        <button
          onClick={onOpenSkills}
          className="flex-1 rounded-lg hover:bg-[var(--panel-2)] px-2 py-2 text-sm text-[var(--txt-dim)] hover:text-[var(--txt)] text-center transition-colors"
        >
          Skills
        </button>
        <button
          onClick={onOpenRoutines}
          className="flex-1 rounded-lg hover:bg-[var(--panel-2)] px-2 py-2 text-sm text-[var(--txt-dim)] hover:text-[var(--txt)] text-center transition-colors"
        >
          Routines
        </button>
        <button
          onClick={onOpenSettings}
          className="flex-1 rounded-lg hover:bg-[var(--panel-2)] px-2 py-2 text-sm text-[var(--txt-dim)] hover:text-[var(--txt)] text-center transition-colors"
        >
          Settings
        </button>
      </div>
    </aside>
  );
}
