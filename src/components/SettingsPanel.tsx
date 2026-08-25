import { useEffect, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { MemoryItem, PROVIDER_PRESETS, Settings } from "../lib/store";

interface Props {
  settings: Settings;
  memories: MemoryItem[];
  onSave: (s: Settings) => void;
  onDeleteMemory: (id: string) => void;
  onClose: () => void;
}

export default function SettingsPanel({ settings, memories, onSave, onDeleteMemory, onClose }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [tab, setTab] = useState<"connection" | "memory">("connection");
  const [autostart, setAutostart] = useState<boolean | null>(null);

  useEffect(() => {
    isEnabled()
      .then(setAutostart)
      .catch(() => setAutostart(null));
  }, []);

  const toggleAutostart = async () => {
    try {
      if (autostart) {
        await disable();
        setAutostart(false);
      } else {
        await enable();
        setAutostart(true);
      }
    } catch {
      setAutostart(null);
    }
  };

  const applyPreset = (name: string) => {
    const preset = PROVIDER_PRESETS[name];
    if (preset) setDraft({ ...draft, baseUrl: preset.baseUrl, model: preset.models[0] });
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[520px] max-h-[80vh] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">Settings</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">×</button>
        </div>

        <div className="flex gap-1 mb-4 rounded-lg bg-zinc-800/60 p-1 w-fit">
          {(["connection", "memory"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1 rounded-md text-sm capitalize ${
                tab === t ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "connection" && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Provider preset</label>
              <div className="flex gap-2">
                {Object.keys(PROVIDER_PRESETS).map((name) => (
                  <button
                    key={name}
                    onClick={() => applyPreset(name)}
                    className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                      draft.baseUrl === PROVIDER_PRESETS[name].baseUrl
                        ? "border-indigo-500 text-indigo-300"
                        : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
                    }`}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Base URL</label>
              <input
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Model</label>
              <input
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                list="model-suggestions"
                className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              />
              <datalist id="model-suggestions">
                {Object.values(PROVIDER_PRESETS)
                  .flatMap((p) => p.models)
                  .map((m) => (
                    <option key={m} value={m} />
                  ))}
              </datalist>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">API key</label>
              <input
                type="password"
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                placeholder="sk-..."
                className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              />
              <p className="mt-1.5 text-[11px] text-zinc-500">Stored only on this device.</p>
            </div>
            {autostart !== null && (
              <div className="flex items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2">
                <button
                  onClick={toggleAutostart}
                  className={`h-4 w-8 rounded-full transition-colors ${autostart ? "bg-indigo-600" : "bg-zinc-700"}`}
                >
                  <span
                    className={`block h-3 w-3 rounded-full bg-white transition-transform mt-0.5 ${
                      autostart ? "translate-x-4" : "translate-x-1"
                    }`}
                  />
                </button>
                <div>
                  <p className="text-sm text-zinc-200">Launch at login</p>
                  <p className="text-[11px] text-zinc-500">Start Alter in the background so routines keep running.</p>
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">
                Cancel
              </button>
              <button
                onClick={() => {
                  onSave(draft);
                  onClose();
                }}
                className="rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-medium"
              >
                Save
              </button>
            </div>
          </div>
        )}

        {tab === "memory" && (
          <div className="space-y-2">
            {memories.length === 0 && (
              <p className="text-sm text-zinc-500">
                Nothing yet. Tell Alter something about yourself — lasting facts get remembered automatically.
              </p>
            )}
            {memories.map((m) => (
              <div key={m.id} className="group flex items-start gap-2 rounded-lg bg-zinc-800/60 px-3 py-2">
                <p className="flex-1 text-sm text-zinc-300">{m.text}</p>
                <button
                  onClick={() => onDeleteMemory(m.id)}
                  className="hidden group-hover:block text-zinc-500 hover:text-zinc-200"
                  title="Forget"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
