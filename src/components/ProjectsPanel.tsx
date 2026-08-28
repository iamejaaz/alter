import { useState } from "react";
import { Project, newId } from "../lib/store";
import { pickFolder } from "../lib/tools";

interface Props {
  projects: Project[];
  onChange: (projects: Project[]) => void;
  onClose: () => void;
}

export default function ProjectsPanel({ projects, onChange, onClose }: Props) {
  const [editing, setEditing] = useState<Project | null>(projects[0] ?? null);

  const upsert = (p: Project) => {
    const exists = projects.some((x) => x.id === p.id);
    onChange(exists ? projects.map((x) => (x.id === p.id ? p : x)) : [...projects, p]);
    setEditing(p);
  };
  const create = () => {
    const p: Project = { id: newId(), name: "New project" };
    onChange([...projects, p]);
    setEditing(p);
  };
  const remove = (id: string) => {
    const rest = projects.filter((x) => x.id !== id);
    onChange(rest);
    setEditing(rest[0] ?? null);
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="flex h-[70vh] w-full max-w-2xl overflow-hidden rounded-xl border border-[var(--bd)] bg-[var(--modal)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-52 shrink-0 border-r border-[var(--bd-soft)] p-2">
          <button
            onClick={create}
            className="mb-2 w-full rounded-lg border border-[var(--bd)] px-3 py-2 text-sm text-[var(--txt)] hover:bg-[var(--panel-2)] transition-colors"
          >
            ＋ New project
          </button>
          <div className="space-y-0.5 overflow-y-auto">
            {projects.map((p) => (
              <button
                key={p.id}
                onClick={() => setEditing(p)}
                className={`block w-full truncate rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  editing?.id === p.id ? "bg-[var(--panel-2)] text-[var(--txt)]" : "text-[var(--txt-dim)] hover:bg-[var(--panel)]"
                }`}
              >
                {p.name}
              </button>
            ))}
            {projects.length === 0 && (
              <p className="px-3 py-2 text-xs text-[var(--txt-faint)]">No projects yet.</p>
            )}
          </div>
        </div>

        <div className="flex flex-1 flex-col p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-[var(--txt)]">Project</h2>
            <button onClick={onClose} className="text-[var(--txt-faint)] hover:text-[var(--txt)]">
              ×
            </button>
          </div>
          {editing ? (
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
              <div>
                <label className="mb-1.5 block text-xs text-[var(--txt-dim)]">Name</label>
                <input
                  value={editing.name}
                  onChange={(e) => upsert({ ...editing, name: e.target.value })}
                  className="w-full rounded-lg border border-[var(--bd)] bg-[var(--input)] px-3 py-2 text-sm text-[var(--txt)] focus:outline-none focus:border-zinc-500"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs text-[var(--txt-dim)]">Working folder</label>
                <div className="flex gap-2">
                  <input
                    value={editing.folder ?? ""}
                    onChange={(e) => upsert({ ...editing, folder: e.target.value || undefined })}
                    placeholder="/path/to/project"
                    className="flex-1 rounded-lg border border-[var(--bd)] bg-[var(--input)] px-3 py-2 font-mono text-xs text-[var(--txt)] focus:outline-none focus:border-zinc-500"
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
                    className="rounded-lg border border-[var(--bd)] px-3 text-sm text-[var(--txt)] hover:bg-[var(--panel-2)] transition-colors"
                  >
                    Browse
                  </button>
                </div>
              </div>
              <div className="flex flex-1 flex-col">
                <label className="mb-1.5 block text-xs text-[var(--txt-dim)]">
                  Instructions — added to every chat in this project
                </label>
                <textarea
                  value={editing.instructions ?? ""}
                  onChange={(e) => upsert({ ...editing, instructions: e.target.value || undefined })}
                  placeholder="e.g. This is the frappe monorepo. Prefer FrappeTestCase. Never add code comments."
                  className="min-h-[120px] flex-1 resize-none rounded-lg border border-[var(--bd)] bg-[var(--input)] px-3 py-2 text-sm text-[var(--txt)] focus:outline-none focus:border-zinc-500"
                />
              </div>
              <button
                onClick={() => remove(editing.id)}
                className="self-start text-xs text-red-400 hover:text-red-300"
              >
                Delete project
              </button>
            </div>
          ) : (
            <p className="text-sm text-[var(--txt-faint)]">Create a project to group chats under a folder and shared instructions.</p>
          )}
        </div>
      </div>
    </div>
  );
}
