import { useState } from "react";
import { Project, newId } from "../lib/store";
import { pickFolder } from "../lib/tools";

interface Props {
  projects: Project[];
  onChange: (projects: Project[]) => void;
  initialSelectedId?: string | null;
}

export default function ProjectsEditor({ projects, onChange, initialSelectedId }: Props) {
  const [openId, setOpenId] = useState<string | null>(initialSelectedId ?? null);
  const editing = projects.find((p) => p.id === openId) ?? null;

  const upsert = (p: Project) => onChange(projects.map((x) => (x.id === p.id ? p : x)));
  const create = () => {
    const p: Project = { id: newId(), name: "New project" };
    onChange([...projects, p]);
    setOpenId(p.id);
  };
  const remove = (id: string) => {
    onChange(projects.filter((x) => x.id !== id));
    setOpenId(null);
  };

  if (!editing)
    return (
      <div className="space-y-2">
        <p className="text-[13px] text-[var(--txt-faint)]">
          A project groups chats under a working folder and shared instructions.
        </p>
        <div className="overflow-hidden rounded-lg border border-[var(--bd-soft)]">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => setOpenId(p.id)}
              className="flex w-full items-center gap-3 border-b border-[var(--bd-soft)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--panel)] transition-colors"
            >
              <span className="shrink-0 text-[13px] text-[var(--txt)]">{p.name}</span>
              <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-[var(--txt-faint)]">
                {p.folder ?? ""}
              </span>
              <span className="shrink-0 text-[11px] text-[var(--txt-faint)]">›</span>
            </button>
          ))}
          {!projects.length && (
            <p className="px-3 py-3 text-[13px] text-[var(--txt-faint)]">No projects yet.</p>
          )}
        </div>
        <button
          onClick={create}
          className="rounded-lg border border-[var(--bd)] px-3 py-1.5 text-[13px] text-[var(--txt)] hover:bg-[var(--panel-2)] transition-colors"
        >
          ＋ New project
        </button>
      </div>
    );

  return (
    <div className="space-y-3">
      <button
        onClick={() => setOpenId(null)}
        className="flex items-center gap-1.5 text-[13px] text-[var(--txt-dim)] hover:text-[var(--txt)] transition-colors"
      >
        ‹ Projects
      </button>
      <div>
        <label className="mb-1 block text-[11px] text-[var(--txt-dim)]">Name</label>
        <input
          value={editing.name}
          autoFocus
          onFocus={(e) => editing.name === "New project" && e.target.select()}
          onChange={(e) => upsert({ ...editing, name: e.target.value })}
          className="w-full rounded-lg border border-[var(--bd)] bg-[var(--input)] px-2.5 py-1.5 text-[13px] text-[var(--txt)] focus:outline-none focus:border-zinc-500"
        />
      </div>
      <div>
        <label className="mb-1 block text-[11px] text-[var(--txt-dim)]">Working folder</label>
        <div className="flex gap-2">
          <input
            value={editing.folder ?? ""}
            onChange={(e) => upsert({ ...editing, folder: e.target.value || undefined })}
            placeholder="/path/to/project"
            className="min-w-0 flex-1 rounded-lg border border-[var(--bd)] bg-[var(--input)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--txt)] focus:outline-none focus:border-zinc-500"
          />
          <button
            onClick={async () => {
              try {
                const dir = await pickFolder();
                if (dir) upsert({ ...editing, folder: dir });
              } catch {
                /* desktop only */
              }
            }}
            className="shrink-0 rounded-lg border border-[var(--bd)] px-2.5 text-[13px] text-[var(--txt)] hover:bg-[var(--panel-2)] transition-colors"
          >
            Browse
          </button>
        </div>
      </div>
      <div>
        <label className="mb-1 block text-[11px] text-[var(--txt-dim)]">
          Instructions — added to every chat in this project
        </label>
        <textarea
          value={editing.instructions ?? ""}
          onChange={(e) => upsert({ ...editing, instructions: e.target.value || undefined })}
          placeholder="e.g. This is the frappe monorepo. Prefer FrappeTestCase. Never add code comments."
          className="h-28 w-full resize-none rounded-lg border border-[var(--bd)] bg-[var(--input)] px-2.5 py-1.5 text-[13px] leading-[1.5] text-[var(--txt)] focus:outline-none focus:border-zinc-500"
        />
      </div>
      <button
        onClick={() => remove(editing.id)}
        className="text-[11px] text-red-400 hover:text-red-300"
      >
        Delete project
      </button>
    </div>
  );
}
