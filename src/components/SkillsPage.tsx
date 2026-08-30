import { useState } from "react";
import { Skill, newId } from "../lib/store";
import { confirmDialog } from "../lib/confirm";

interface Props {
  skills: Skill[];
  onChange: (s: Skill[]) => void;
  onBack: () => void;
}

export default function SkillsPage({ skills, onChange, onBack }: Props) {
  const [editing, setEditing] = useState<string | null | "new">(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");

  const openNew = () => {
    setEditing("new");
    setName("");
    setDescription("");
    setInstructions("");
  };
  const openEdit = (s: Skill) => {
    setEditing(s.id);
    setName(s.name);
    setDescription(s.description);
    setInstructions(s.instructions);
  };

  const save = () => {
    if (!name.trim() || !instructions.trim()) return;
    const id = editing && editing !== "new" ? editing : newId();
    const skill: Skill = { id, name: name.trim(), description: description.trim(), instructions: instructions.trim() };
    onChange(skills.some((s) => s.id === id) ? skills.map((s) => (s.id === id ? skill : s)) : [...skills, skill]);
    setEditing(null);
  };

  const remove = async (s: Skill) => {
    if (await confirmDialog(`Delete skill "${s.name}"?`)) {
      onChange(skills.filter((x) => x.id !== s.id));
      if (editing === s.id) setEditing(null);
    }
  };

  const input = "w-full rounded-lg bg-[var(--input)] border border-[var(--bd)] px-3 py-2 text-sm focus:outline-none focus:border-indigo-500";
  const form = editing !== null;

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-[var(--bg)]">
      <header className="flex items-center gap-2 px-6 py-4 border-b border-[var(--bd-soft)]">
        <button onClick={form ? () => setEditing(null) : onBack} className="text-[var(--txt-faint)] hover:text-[var(--txt)] text-sm">←</button>
        <h1 className="text-sm font-semibold">Skills{form ? " / " : ""}</h1>
        {form && <span className="text-sm text-[var(--txt-dim)]">{editing === "new" ? "New skill" : "Edit"}</span>}
        {!form && (
          <button onClick={openNew} className="ml-auto rounded-lg bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 text-sm font-medium">New skill</button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-6">
          {!form ? (
            <>
              <p className="text-xs text-[var(--txt-faint)] mb-4">
                Reusable instruction sets. Alter sees each skill's name + description and loads the full instructions when a request matches.
              </p>
              <div className="space-y-2">
                {skills.length === 0 && <p className="text-sm text-[var(--txt-faint)]">No skills yet.</p>}
                {skills.map((s) => (
                  <div key={s.id} className="rounded-xl border border-[var(--bd-soft)] bg-[var(--panel)] px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium flex-1 truncate">{s.name}</span>
                      <button onClick={() => openEdit(s)} className="text-[11px] text-indigo-400 hover:text-indigo-300">Edit</button>
                      <button onClick={() => remove(s)} className="text-[var(--txt-faint)] hover:text-[var(--txt)]">×</button>
                    </div>
                    {s.description && <p className="mt-1 text-xs text-[var(--txt-dim)] line-clamp-2">{s.description}</p>}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="text-xs text-[var(--txt-dim)]">Name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Commit messages" className={`${input} mt-1`} />
              </div>
              <div>
                <label className="text-xs text-[var(--txt-dim)]">Description <span className="text-[var(--txt-faint)]">(when to use it)</span></label>
                <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line — used to decide when this skill applies" className={`${input} mt-1`} />
              </div>
              <div>
                <label className="text-xs text-[var(--txt-dim)]">Instructions</label>
                <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Full instructions Alter should follow when this skill is used…" rows={12} className={`${input} mt-1 resize-none font-mono`} />
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setEditing(null)} className="rounded-lg px-3 py-2 text-sm text-[var(--txt-dim)] hover:text-[var(--txt)]">Cancel</button>
                <button onClick={save} disabled={!name.trim() || !instructions.trim()} className="ml-auto rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-medium disabled:opacity-50">
                  {editing === "new" ? "Add skill" : "Save changes"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
