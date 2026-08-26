import { useEffect, useState } from "react";
import { Skill, newId } from "../lib/store";
import { confirmDialog } from "../lib/confirm";

interface Props {
  skills: Skill[];
  onChange: (s: Skill[]) => void;
  onClose: () => void;
}

export default function SkillsPanel({ skills, onChange, onClose }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const reset = () => {
    setEditing(null);
    setName("");
    setDescription("");
    setInstructions("");
  };

  const save = () => {
    if (!name.trim() || !instructions.trim()) return;
    const skill: Skill = {
      id: editing ?? newId(),
      name: name.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
    };
    onChange(editing ? skills.map((s) => (s.id === editing ? skill : s)) : [...skills, skill]);
    reset();
  };

  const edit = (s: Skill) => {
    setEditing(s.id);
    setName(s.name);
    setDescription(s.description);
    setInstructions(s.instructions);
  };

  const remove = async (s: Skill) => {
    if (await confirmDialog(`Delete skill "${s.name}"?`)) {
      onChange(skills.filter((x) => x.id !== s.id));
      if (editing === s.id) reset();
    }
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[600px] max-h-[85vh] overflow-y-auto rounded-xl border border-[var(--bd-soft)] bg-[var(--modal)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold">Skills</h2>
          <button onClick={onClose} className="text-[var(--txt-faint)] hover:text-[var(--txt)]">×</button>
        </div>
        <p className="text-xs text-[var(--txt-faint)] mb-4">
          Reusable instruction sets. Alter sees each skill's name + description, and loads the full instructions
          when a request matches — just like the skills you're used to.
        </p>

        <div className="space-y-2 mb-5">
          {skills.length === 0 && <p className="text-sm text-[var(--txt-faint)]">No skills yet.</p>}
          {skills.map((s) => (
            <div key={s.id} className="rounded-lg border border-[var(--bd-soft)] bg-[var(--panel)] px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium flex-1 truncate">{s.name}</span>
                <button onClick={() => edit(s)} className="text-[11px] text-indigo-400 hover:text-indigo-300">
                  Edit
                </button>
                <button onClick={() => remove(s)} className="text-[var(--txt-faint)] hover:text-[var(--txt)]">×</button>
              </div>
              {s.description && <p className="mt-1 text-xs text-[var(--txt-dim)] truncate">{s.description}</p>}
            </div>
          ))}
        </div>

        <div className="space-y-2 border-t border-[var(--bd-soft)] pt-4">
          <p className="text-xs font-medium text-[var(--txt-dim)]">{editing ? "Edit skill" : "New skill"}</p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. Commit messages)"
            className="w-full rounded-lg bg-[var(--input)] border border-[var(--bd)] px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="One-line description (when to use it)"
            className="w-full rounded-lg bg-[var(--input)] border border-[var(--bd)] px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
          />
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Full instructions Alter should follow when this skill is used…"
            rows={6}
            className="w-full resize-none rounded-lg bg-[var(--input)] border border-[var(--bd)] px-3 py-2 text-sm focus:outline-none focus:border-indigo-500 font-mono"
          />
          <div className="flex items-center gap-2">
            {editing && (
              <button onClick={reset} className="rounded-lg px-3 py-2 text-sm text-[var(--txt-dim)] hover:text-[var(--txt)]">
                Cancel
              </button>
            )}
            <button
              onClick={save}
              className="ml-auto rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-medium"
            >
              {editing ? "Update skill" : "Add skill"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
