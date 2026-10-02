import { useState } from "react";
import { Project, newId } from "../lib/store";
import { pickFolder } from "../lib/tools";
import { confirmDialog } from "../lib/confirm";
import Row, { action, field } from "./SettingsRow";

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
  const remove = async (p: Project) => {
    if (!(await confirmDialog(`Delete the project "${p.name}"? Its chats are kept.`))) return;
    onChange(projects.filter((x) => x.id !== p.id));
    setOpenId(null);
  };

  if (!editing)
    return (
      <div>
        <Row
          title="New project"
          desc="A project groups chats under a working folder and shared instructions."
          control={
            <button onClick={create} className={action}>
              New project
            </button>
          }
        />
        {projects.map((p) => (
          <button
            key={p.id}
            onClick={() => setOpenId(p.id)}
            className="group flex w-full items-center gap-6 border-b border-[var(--bd-soft)] py-3.5 text-left last:border-b-0"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] text-[var(--txt)]">{p.name}</span>
              <span className="mt-0.5 block truncate font-mono text-[12px] text-[var(--txt-faint)]">
                {p.folder ?? "No folder"}
              </span>
            </span>
            <span className="shrink-0 text-[var(--txt-faint)] group-hover:text-[var(--txt)]">›</span>
          </button>
        ))}
        {!projects.length && <p className="py-8 text-center text-[13px] text-[var(--txt-faint)]">No projects yet.</p>}
      </div>
    );

  return (
    <div>
      <button
        onClick={() => setOpenId(null)}
        className="mt-1 flex items-center gap-1.5 text-[13px] text-[var(--txt-dim)] hover:text-[var(--txt)] transition-colors"
      >
        ‹ All projects
      </button>
      <Row
        title="Name"
        control={
          <input
            value={editing.name}
            autoFocus
            onFocus={(e) => editing.name === "New project" && e.target.select()}
            onChange={(e) => upsert({ ...editing, name: e.target.value })}
            className={`${field} w-72`}
          />
        }
      />
      <Row title="Working folder" desc="Chats in this project run here, and the sidebar groups them under it.">
        <div className="flex gap-2">
          <input
            value={editing.folder ?? ""}
            onChange={(e) => upsert({ ...editing, folder: e.target.value || undefined })}
            placeholder="/path/to/project"
            className={`${field} min-w-0 flex-1 font-mono`}
          />
          <button
            onClick={async () => {
              try {
                const dir = await pickFolder();
                if (dir) upsert({ ...editing, folder: dir });
              } catch {}
            }}
            className={action}
          >
            Choose…
          </button>
        </div>
      </Row>
      <Row title="Instructions" desc="Added to every chat in this project.">
        <textarea
          value={editing.instructions ?? ""}
          onChange={(e) => upsert({ ...editing, instructions: e.target.value || undefined })}
          placeholder="This is the frappe monorepo. Prefer FrappeTestCase."
          className={`${field} h-32 resize-none leading-[1.5]`}
        />
      </Row>
      <Row
        title="Delete project"
        desc="Its chats are kept."
        control={
          <button onClick={() => void remove(editing)} className={`${action} text-red-400`}>
            Delete
          </button>
        }
      />
    </div>
  );
}
