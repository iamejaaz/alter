import { Conversation } from "../lib/store";

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
  return (
    <aside className="w-64 shrink-0 flex flex-col border-r border-zinc-800 bg-zinc-925 bg-zinc-900/50">
      <div className="p-3 flex items-center gap-2">
        <span className="text-lg font-semibold tracking-tight text-zinc-100">alter</span>
        <span className="text-[10px] uppercase tracking-widest text-zinc-500 mt-1">beta</span>
      </div>
      <button
        onClick={onNew}
        className="mx-3 mb-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 transition-colors px-3 py-2 text-sm font-medium text-left"
      >
        + New chat
      </button>
      <nav className="flex-1 overflow-y-auto px-2 space-y-0.5">
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`group flex items-center rounded-lg px-3 py-2 text-sm cursor-pointer ${
              c.id === activeId ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
            }`}
            onClick={() => onSelect(c.id)}
          >
            <span className="flex-1 truncate">{c.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(c.id);
              }}
              className="hidden group-hover:block text-zinc-500 hover:text-zinc-200 ml-2"
              title="Delete"
            >
              ×
            </button>
          </div>
        ))}
        {conversations.length === 0 && (
          <p className="px-3 py-2 text-xs text-zinc-600">No conversations yet.</p>
        )}
      </nav>
      <div className="flex gap-2 m-3">
        <button
          onClick={onOpenRoutines}
          className="flex-1 rounded-lg border border-zinc-800 hover:bg-zinc-800/60 transition-colors px-3 py-2 text-sm text-zinc-300 text-left"
        >
          Routines
        </button>
        <button
          onClick={onOpenSettings}
          className="flex-1 rounded-lg border border-zinc-800 hover:bg-zinc-800/60 transition-colors px-3 py-2 text-sm text-zinc-300 text-left"
        >
          Settings
        </button>
      </div>
    </aside>
  );
}
