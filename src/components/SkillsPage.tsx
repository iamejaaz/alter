import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { Skill, newId } from "../lib/store";
import { confirmDialog } from "../lib/confirm";

interface Props {
  skills: Skill[];
  onChange: (s: Skill[]) => void;
  onBack: () => void;
  embedded?: boolean;
}

interface Found {
  name: string;
  description: string;
  instructions: string;
}

export function parseSkillFile(raw: string, fallbackName: string): Found {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = (key: string) => {
    const line = m?.[1].match(new RegExp(`^${key}:\\s*(.*(?:\\n[ \\t]+.*)*)`, "m"))?.[1] ?? "";
    return line
      .replace(/^[>|][-+]?\s*\n?/, "")
      .replace(/\n\s+/g, " ")
      .trim()
      .replace(/^(['"])([\s\S]*)\1$/, "$2");
  };
  return {
    name: meta("name") || fallbackName,
    description: meta("description"),
    instructions: (m ? raw.slice(m[0].length) : raw).trim(),
  };
}

export default function SkillsPage({ skills, onChange, onBack, embedded }: Props) {
  const [editing, setEditing] = useState<string | null | "new">(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const has = (n: string) => skills.some((s) => s.name.toLowerCase() === n.toLowerCase());
  const add = (list: Found[]) => {
    const fresh = list.filter((f) => f.instructions && !has(f.name));
    if (fresh.length) onChange([...skills, ...fresh.map((f) => ({ id: newId(), ...f }))]);
    return fresh.length;
  };

  const scanClaudeCode = async () => {
    setNote(null);
    try {
      const dir = await join(await homeDir(), ".claude", "skills");
      const entries = await invoke<string[]>("list_dir", { path: dir });
      const out: Found[] = [];
      for (const e of entries.filter((x) => x.endsWith("/")).sort()) {
        const folder = e.slice(0, -1);
        try {
          const raw = await invoke<string>("read_file", { path: await join(dir, folder, "SKILL.md") });
          out.push(parseSkillFile(raw, folder));
        } catch {}
      }
      setFound(out);
      setPicked(out.filter((f) => !has(f.name)).map((f) => f.name));
    } catch {
      setNote("No Claude Code skills folder was found on this Mac.");
    }
  };

  const importFile = async () => {
    setNote(null);
    const path = await open({ title: "Choose a SKILL.md file", filters: [{ name: "Skill", extensions: ["md", "txt"] }] });
    if (typeof path !== "string") return;
    try {
      const raw = await invoke<string>("read_file", { path });
      const parts = path.split("/");
      const base = parts[parts.length - 1].replace(/\.[^.]+$/, "");
      const skill = parseSkillFile(raw, /^skill$/i.test(base) ? parts[parts.length - 2] ?? base : base);
      if (!skill.instructions) return setNote("That file is empty.");
      if (has(skill.name)) return setNote(`A skill named "${skill.name}" already exists.`);
      add([skill]);
      setNote(`Imported "${skill.name}".`);
    } catch (e) {
      setNote(`Could not read that file: ${String(e)}`);
    }
  };

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

  const input = "w-full rounded-lg bg-[var(--input)] border border-[var(--bd)] px-3 py-2 text-[13px] focus:outline-none focus:border-[var(--txt-faint)]";
  const action = "shrink-0 rounded-lg border border-[var(--bd)] bg-[var(--panel)] px-3 py-1.5 text-[13px] text-[var(--txt)] hover:bg-[var(--panel-2)] disabled:opacity-40 transition-colors";
  const form = editing !== null;

  const body = !form ? (
    <>
      <div className="mb-2 flex items-center gap-2">
        <h1 className="flex-1 text-[17px] font-semibold text-[var(--txt)]">Skills</h1>
        <button onClick={openNew} className={action}>
          New skill
        </button>
      </div>
      <p className="pb-1 text-[13px] text-[var(--txt-faint)]">
        Reusable instruction sets. Alter sees each skill's name and description and loads the full instructions when a request matches, or when you type its name after a slash.
      </p>
      <div className="flex items-center gap-6 border-b border-[var(--bd-soft)] py-4">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] text-[var(--txt)]">Import skills</p>
          <p className="mt-0.5 text-[13px] leading-snug text-[var(--txt-faint)]">
            Copy the skills Claude Code has on this Mac, or pick a SKILL.md file.
          </p>
          {note && <p className="mt-1 text-[12px] text-[var(--txt-dim)]">{note}</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          <button onClick={() => void scanClaudeCode()} className={action}>
            From Claude Code
          </button>
          <button onClick={() => void importFile()} className={action}>
            From a file
          </button>
        </div>
      </div>
      {skills.length === 0 && <p className="py-8 text-center text-[13px] text-[var(--txt-faint)]">No skills yet.</p>}
      {skills.map((s) => (
        <div key={s.id} className="group flex items-center gap-3 border-b border-[var(--bd-soft)] py-3 last:border-b-0">
          <button onClick={() => openEdit(s)} className="min-w-0 flex-1 text-left">
            <p className="truncate text-[14px] text-[var(--txt)]">{s.name}</p>
            {s.description && <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-[var(--txt-faint)]">{s.description}</p>}
          </button>
          <button onClick={() => openEdit(s)} className="shrink-0 rounded-md px-2 py-0.5 text-[12px] text-[var(--txt-faint)] opacity-0 hover:bg-[var(--panel-2)] hover:text-[var(--txt)] group-hover:opacity-100">
            Edit
          </button>
          <button onClick={() => void remove(s)} className="shrink-0 rounded-md px-2 py-0.5 text-[12px] text-[var(--txt-faint)] opacity-0 hover:bg-[var(--panel-2)] hover:text-[var(--txt)] group-hover:opacity-100">
            Delete
          </button>
        </div>
      ))}
    </>
  ) : (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={() => setEditing(null)} className="text-[var(--txt-faint)] hover:text-[var(--txt)]" aria-label="Back to skills">
          ←
        </button>
        <h1 className="text-[17px] font-semibold text-[var(--txt)]">{editing === "new" ? "New skill" : "Edit skill"}</h1>
      </div>
      <div>
        <label className="text-xs text-[var(--txt-dim)]">Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Commit messages" className={`${input} mt-1`} />
      </div>
      <div>
        <label className="text-xs text-[var(--txt-dim)]">
          Description <span className="text-[var(--txt-faint)]">(when to use it)</span>
        </label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line, used to decide when this skill applies" className={`${input} mt-1`} />
      </div>
      <div>
        <label className="text-xs text-[var(--txt-dim)]">Instructions</label>
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Full instructions Alter should follow when this skill is used…" rows={14} className={`${input} mt-1 resize-none font-mono`} />
      </div>
      <div className="flex items-center justify-end gap-2">
        <button onClick={() => setEditing(null)} className="rounded-lg px-3 py-1.5 text-[13px] text-[var(--txt-dim)] hover:text-[var(--txt)]">
          Cancel
        </button>
        <button onClick={save} disabled={!name.trim() || !instructions.trim()} className={`${action} bg-[var(--panel-2)]`}>
          {editing === "new" ? "Add skill" : "Save changes"}
        </button>
      </div>
    </div>
  );

  const picker = found && (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60" onClick={() => setFound(null)}>
      <div className="flex max-h-[80vh] w-[520px] max-w-[92vw] flex-col rounded-xl border border-[var(--bd)] bg-[var(--modal)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-4">
          <h2 className="text-[15px] font-semibold text-[var(--txt)]">Import from Claude Code</h2>
          <p className="mt-0.5 text-[13px] text-[var(--txt-faint)]">
            {found.length ? "These are copies. The originals in Claude Code stay as they are." : "Claude Code has no skills on this Mac yet."}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {found.map((f) => {
            const added = has(f.name);
            return (
              <label key={f.name} className={`flex items-start gap-3 border-b border-[var(--bd-soft)] py-2.5 last:border-b-0 ${added ? "opacity-50" : "cursor-pointer"}`}>
                <input
                  type="checkbox"
                  disabled={added}
                  checked={!added && picked.includes(f.name)}
                  onChange={() => setPicked((p) => (p.includes(f.name) ? p.filter((x) => x !== f.name) : [...p, f.name]))}
                  className="mt-1 accent-[var(--txt)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-[var(--txt)]">
                    {f.name}
                    {added && <span className="ml-2 text-[12px] text-[var(--txt-faint)]">already added</span>}
                  </span>
                  {f.description && <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-[var(--txt-faint)]">{f.description}</span>}
                </span>
              </label>
            );
          })}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--bd-soft)] px-5 py-3">
          <button onClick={() => setFound(null)} className="rounded-lg px-3 py-1.5 text-[13px] text-[var(--txt-dim)] hover:text-[var(--txt)]">
            Cancel
          </button>
          <button
            onClick={() => {
              const n = add(found.filter((f) => picked.includes(f.name)));
              setFound(null);
              setNote(`Imported ${n} ${n === 1 ? "skill" : "skills"} from Claude Code.`);
            }}
            disabled={!found.some((f) => picked.includes(f.name) && !has(f.name))}
            className={`${action} bg-[var(--panel-2)]`}
          >
            Import {found.filter((f) => picked.includes(f.name) && !has(f.name)).length || ""}
          </button>
        </div>
      </div>
    </div>
  );

  if (embedded)
    return (
      <>
        {body}
        {picker}
      </>
    );

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-[var(--bg)]">
      <header className="flex min-h-12 items-center gap-3 border-b border-[var(--bd-soft)] px-5">
        <button onClick={onBack} className="text-sm text-[var(--txt-faint)] hover:text-[var(--txt)]">
          ←
        </button>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-10 py-6">{body}</div>
      </div>
      {picker}
    </div>
  );
}
