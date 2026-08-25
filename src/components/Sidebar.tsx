import { useState } from "react";
import { Conversation } from "../lib/store";
import Logo from "./Logo";

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
  onOpenRoutines: () => void;
}

export default function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onOpenSettings,
  onOpenRoutines,
}: Props) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q
    ? conversations.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.messages.some((m) => m.content?.toLowerCase().includes(q))
      )
    : conversations;

  return (
    <aside className="w-64 shrink-0 flex flex-col border-r border-white/[0.06] bg-black/20">
      <div data-tauri-drag-region className="h-12 flex items-end px-4 pb-1 pl-20">
        <div className="flex items-center gap-2 pointer-events-none">
          <Logo size={18} />
          <span className="text-[15px] font-semibold tracking-tight text-zinc-100">Alter</span>
        </div>
      </div>

      <div className="px-3 pt-2 pb-3">
        <button
          onClick={onNew}
          className="w-full flex items-center gap-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 px-3 py-2 text-sm text-zinc-200 transition-colors"
        >
          <span className="text-base leading-none text-zinc-400">＋</span>
          New chat
        </button>
        {conversations.length > 3 && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            className="mt-2 w-full rounded-lg bg-white/[0.04] border border-white/10 px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500/40"
          />
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2">
        {conversations.length > 0 && (
          <p className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wider text-zinc-600">
            {q ? `Results (${filtered.length})` : "Recent"}
          </p>
        )}
        <div className="space-y-0.5">
          {filtered.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center rounded-lg px-2.5 py-2 text-sm cursor-pointer transition-colors ${
                c.id === activeId
                  ? "bg-white/[0.07] text-zinc-100"
                  : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
              }`}
              onClick={() => onSelect(c.id)}
            >
              <span className="flex-1 truncate">{c.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(c.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-zinc-200 ml-2 transition-opacity"
                title="Delete"
              >
                ×
              </button>
            </div>
          ))}
          {conversations.length === 0 && (
            <p className="px-2.5 py-2 text-xs text-zinc-600">No conversations yet.</p>
          )}
          {conversations.length > 0 && filtered.length === 0 && (
            <p className="px-2.5 py-2 text-xs text-zinc-600">No matches.</p>
          )}
        </div>
      </nav>

      <div className="flex gap-1 p-2 border-t border-white/[0.06]">
        <button
          onClick={onOpenRoutines}
          className="flex-1 rounded-lg hover:bg-white/[0.06] px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200 text-left transition-colors"
        >
          Routines
        </button>
        <button
          onClick={onOpenSettings}
          className="flex-1 rounded-lg hover:bg-white/[0.06] px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200 text-left transition-colors"
        >
          Settings
        </button>
      </div>
    </aside>
  );
}
