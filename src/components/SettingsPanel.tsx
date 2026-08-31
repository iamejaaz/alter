import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { open } from "@tauri-apps/plugin-dialog";
import { isClaudeCodeUrl, MemoryItem, PROVIDER_PRESETS, Settings, newId } from "../lib/store";
import { testConnection } from "../lib/api";
import { Chevron } from "./Icons";

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
  const [light, setLight] = useState(() => document.documentElement.dataset.theme === "light");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [bridge, setBridge] = useState<{ port: number; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const importCreds = async () => {
    setImporting(true);
    setImportMsg(null);
    try {
      const c = await invoke<{ site: string; api_key: string; api_secret: string }>(
        "import_frappe_credentials",
        {}
      );
      setDraft((d) => ({
        ...d,
        frappeSite: c.site || d.frappeSite,
        frappeApiKey: c.api_key,
        frappeApiSecret: c.api_secret,
      }));
      setImportMsg({ ok: true, text: "Imported from frappectl — Save to keep." });
    } catch (e) {
      setImportMsg({ ok: false, text: typeof e === "string" ? e : "Import failed." });
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => {
    void invoke<{ port: number; token: string }>("bridge_info").then(setBridge).catch(() => {});
  }, []);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const msg = await testConnection(draft);
      setTestResult({ ok: true, msg });
    } catch (e) {
      setTestResult({ ok: false, msg: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const toggleTheme = () => {
    const next = !light;
    setLight(next);
    if (next) {
      document.documentElement.dataset.theme = "light";
      localStorage.setItem("alter.theme", "light");
    } else {
      delete document.documentElement.dataset.theme;
      localStorage.setItem("alter.theme", "dark");
    }
  };

  useEffect(() => {
    isEnabled()
      .then(setAutostart)
      .catch(() => setAutostart(null));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  const conns = draft.connections ?? [];
  const activeId = draft.activeConnectionId ?? conns[0]?.id;
  const activeConn = conns.find((c) => c.id === activeId);
  const syncedConnections = () =>
    conns.map((c) =>
      c.id === activeId ? { ...c, baseUrl: draft.baseUrl, apiKey: draft.apiKey, model: draft.model } : c
    );

  const selectConnection = (id: string) => {
    const synced = syncedConnections();
    const target = synced.find((c) => c.id === id);
    if (!target) return;
    setDraft({ ...draft, connections: synced, activeConnectionId: id, baseUrl: target.baseUrl, apiKey: target.apiKey, model: target.model });
    setTestResult(null);
  };
  const addConnection = () => {
    const synced = syncedConnections();
    const conn = { id: newId(), name: "New connection", baseUrl: "", apiKey: "", model: "" };
    setDraft({ ...draft, connections: [...synced, conn], activeConnectionId: conn.id, baseUrl: "", apiKey: "", model: "" });
    setTestResult(null);
  };
  const deleteConnection = (id: string) => {
    const remaining = conns.filter((c) => c.id !== id);
    if (remaining.length === 0) return;
    const next = remaining[0];
    setDraft({ ...draft, connections: remaining, activeConnectionId: next.id, baseUrl: next.baseUrl, apiKey: next.apiKey, model: next.model });
  };
  const renameConnection = (name: string) => {
    setDraft({ ...draft, connections: conns.map((c) => (c.id === activeId ? { ...c, name } : c)) });
  };
  // A preset spins up its own connection (or fills the current empty one) so it
  // never overwrites a configured connection like a gateway or Claude Code.
  const applyPreset = (name: string) => {
    const preset = PROVIDER_PRESETS[name];
    if (!preset) return;
    const [baseUrl, model] = [preset.baseUrl, preset.models[0]];
    if (!draft.baseUrl && !draft.model) {
      setDraft({
        ...draft,
        baseUrl,
        model,
        connections: conns.map((c) => (c.id === activeId ? { ...c, name, baseUrl, model } : c)),
      });
    } else {
      const conn = { id: newId(), name, baseUrl, apiKey: "", model };
      setDraft({ ...draft, connections: [...syncedConnections(), conn], activeConnectionId: conn.id, baseUrl, apiKey: "", model });
    }
    setTestResult(null);
  };
  const save = () => {
    onSave({ ...draft, connections: syncedConnections() });
    onClose();
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-[var(--bg)]">
      <header className="flex items-center gap-2 px-6 py-4 border-b border-[var(--bd-soft)]">
        <button onClick={onClose} className="text-[var(--txt-faint)] hover:text-[var(--txt)] text-sm">←</button>
        <h1 className="text-sm font-semibold">Settings</h1>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-6">

        <div className="flex gap-1 mb-4 rounded-lg bg-[var(--panel)] p-1 w-fit">
          {(["connection", "memory"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1 rounded-md text-sm capitalize ${
                tab === t ? "bg-zinc-700 text-[var(--txt)]" : "text-[var(--txt-dim)] hover:text-[var(--txt)]"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "connection" && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-[var(--txt-dim)] mb-1.5">Connection</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <select
                    value={activeId}
                    onChange={(e) => selectConnection(e.target.value)}
                    className="appearance-none w-full rounded-lg bg-[var(--input)] border border-[var(--bd)] pl-3 pr-8 py-2 text-sm focus:outline-none focus:border-indigo-500 cursor-pointer"
                  >
                    {conns.map((c) => (
                      <option key={c.id} value={c.id} className="bg-[var(--modal)]">
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <Chevron />
                </div>
                <button
                  onClick={addConnection}
                  className="rounded-lg border border-[var(--bd)] hover:bg-[var(--panel-2)] px-3 text-sm text-[var(--txt)]"
                  title="Add a new connection"
                >
                  ＋
                </button>
                {conns.length > 1 && (
                  <button
                    onClick={() => deleteConnection(activeId)}
                    className="rounded-lg border border-[var(--bd)] hover:bg-[var(--panel-2)] px-3 text-sm text-red-400"
                    title="Delete this connection"
                  >
                    Delete
                  </button>
                )}
              </div>
              <input
                value={activeConn?.name ?? ""}
                onChange={(e) => renameConnection(e.target.value)}
                placeholder="Connection name"
                className="mt-2 w-full rounded-lg bg-[var(--input)] border border-[var(--bd)] px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--txt-dim)] mb-1.5">Quick-fill from a provider</label>
              <div className="flex flex-wrap gap-2">
                {Object.keys(PROVIDER_PRESETS).map((name) => (
                  <button
                    key={name}
                    onClick={() => applyPreset(name)}
                    className="rounded-lg border border-[var(--bd)] px-3 py-1.5 text-sm text-[var(--txt)] transition-colors hover:border-zinc-500"
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
            {isClaudeCodeUrl(draft.baseUrl) && (
              <p className="rounded-lg border border-indigo-900/40 bg-indigo-500/10 px-3 py-2 text-[11px] text-indigo-300">
                Uses your local Claude Code (your subscription) — no API key or model needed. Make sure{" "}
                <span className="font-mono">claude</span> is installed and you're logged in. Attach a folder to let it work in that project.
              </p>
            )}
            <div>
              <label className="block text-xs text-[var(--txt-dim)] mb-1.5">Base URL</label>
              <input
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                className="w-full rounded-lg bg-[var(--input)] border border-[var(--bd)] px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--txt-dim)] mb-1.5">Model</label>
              <input
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                list="model-suggestions"
                className="w-full rounded-lg bg-[var(--input)] border border-[var(--bd)] px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
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
              <label className="block text-xs text-[var(--txt-dim)] mb-1.5">API key</label>
              <input
                type="password"
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                placeholder="sk-..."
                className="w-full rounded-lg bg-[var(--input)] border border-[var(--bd)] px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              />
              <p className="mt-1.5 text-[11px] text-[var(--txt-faint)]">Stored only on this device.</p>
            </div>
            <div>
              <button
                onClick={runTest}
                disabled={testing || (!draft.apiKey && !isClaudeCodeUrl(draft.baseUrl))}
                className="rounded-lg border border-[var(--bd)] hover:bg-[var(--panel-2)] disabled:opacity-40 px-3 py-1.5 text-xs text-[var(--txt)] transition-colors"
              >
                {testing ? "Testing…" : "Test connection"}
              </button>
              {testResult && (
                <p
                  className={`mt-2 text-[11px] rounded-lg px-3 py-2 break-words ${
                    testResult.ok
                      ? "bg-green-500/10 text-green-400 border border-green-900/40"
                      : "bg-red-500/10 text-red-400 border border-red-900/40"
                  }`}
                >
                  {testResult.msg}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-[var(--bd-soft)] px-3 py-2">
              <button
                onClick={toggleTheme}
                className={`h-4 w-8 rounded-full transition-colors ${light ? "bg-indigo-600" : "bg-zinc-700"}`}
              >
                <span
                  className={`block h-3 w-3 rounded-full bg-white transition-transform mt-0.5 ${
                    light ? "translate-x-4" : "translate-x-1"
                  }`}
                />
              </button>
              <p className="text-sm text-[var(--txt)]">Light theme</p>
            </div>
            {autostart !== null && (
              <div className="flex items-center gap-2 rounded-lg border border-[var(--bd-soft)] px-3 py-2">
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
                  <p className="text-sm text-[var(--txt)]">Launch at login</p>
                  <p className="text-[11px] text-[var(--txt-faint)]">Start Alter in the background so routines keep running.</p>
                </div>
              </div>
            )}
            {bridge && (
              <div className="rounded-lg border border-[var(--bd-soft)] px-3 py-2">
                <p className="text-sm text-[var(--txt)]">Browser bridge</p>
                <p className="mb-2 text-[11px] text-[var(--txt-faint)]">
                  Pair the Alter browser extension so it can use your models. Runs on localhost:{bridge.port}.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded-md bg-[var(--input)] px-2 py-1.5 font-mono text-xs text-[var(--txt-dim)]">
                    {bridge.token}
                  </code>
                  <button
                    onClick={() => {
                      void navigator.clipboard.writeText(bridge.token);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                    className="rounded-md border border-[var(--bd)] px-3 py-1.5 text-xs text-[var(--txt)] hover:bg-[var(--panel-2)] transition-colors"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            )}
            <div className="rounded-lg border border-[var(--bd-soft)] px-3 py-2">
              <p className="text-sm text-[var(--txt)]">Repro benches</p>
              <p className="mb-2 text-[11px] text-[var(--txt-faint)]">
                Point each version at an existing bench folder. The support agent reproduces bugs there — develop first, then the customer's version.
              </p>
              <div className="space-y-1.5">
                {["develop", "version-16", "version-15"].map((ver) => {
                  const path = draft.reproBenches?.[ver] || "";
                  const setPath = (p: string) =>
                    setDraft({ ...draft, reproBenches: { ...(draft.reproBenches ?? {}), [ver]: p } });
                  return (
                    <div key={ver} className="flex items-center gap-2">
                      <span className="w-20 shrink-0 text-xs text-[var(--txt-dim)]">{ver}</span>
                      <code className="flex-1 truncate rounded-md bg-[var(--input)] px-2 py-1.5 font-mono text-xs text-[var(--txt-dim)]">
                        {path || "not set"}
                      </code>
                      <button
                        onClick={async () => {
                          const picked = await open({ directory: true, title: `Select the ${ver} bench folder` });
                          if (typeof picked === "string") setPath(picked);
                        }}
                        className="rounded-md border border-[var(--bd)] px-3 py-1.5 text-xs text-[var(--txt)] hover:bg-[var(--panel-2)] transition-colors"
                      >
                        Choose…
                      </button>
                      {path && (
                        <button onClick={() => setPath("")} className="text-xs text-[var(--txt-faint)] hover:text-[var(--txt)]">
                          ×
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <label className="mt-3 block text-[11px] text-[var(--txt-faint)]">
                MariaDB root password <span className="text-[var(--txt-faint)]">(optional — lets the agent auto-create a missing repro site; stored locally)</span>
              </label>
              <input
                type="password"
                value={draft.mariadbRootPassword ?? ""}
                onChange={(e) => setDraft({ ...draft, mariadbRootPassword: e.target.value })}
                placeholder="leave blank to create sites yourself"
                className="mt-1 w-full rounded-md bg-[var(--input)] border border-[var(--bd)] px-2 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="rounded-lg border border-[var(--bd-soft)] px-3 py-2">
              <div className="flex items-center justify-between">
                <p className="text-sm text-[var(--txt)]">Frappe credentials</p>
                <button
                  onClick={importCreds}
                  disabled={importing}
                  className="rounded-md border border-[var(--bd)] px-2 py-0.5 text-[11px] text-[var(--txt-dim)] hover:text-[var(--txt)] disabled:opacity-50"
                >
                  {importing ? "Importing…" : "Import from fr"}
                </button>
              </div>
              <p className="mb-2 text-[11px] text-[var(--txt-faint)]">
                Set these so the support agent's <code>fr</code> reads credentials from the environment instead of the macOS keychain (which prompts for a password every run). Stored locally. <b>Import from fr</b> pulls the token <code>fr</code> already stored — no rotation, reuses your existing key.
              </p>
              {importMsg && (
                <p className={`mb-2 text-[11px] ${importMsg.ok ? "text-emerald-500" : "text-red-400"}`}>{importMsg.text}</p>
              )}
              <input
                value={draft.frappeSite ?? ""}
                onChange={(e) => setDraft({ ...draft, frappeSite: e.target.value })}
                placeholder="Site URL (e.g. https://support.frappe.io)"
                className="w-full rounded-md bg-[var(--input)] border border-[var(--bd)] px-2 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
              />
              <input
                value={draft.frappeApiKey ?? ""}
                onChange={(e) => setDraft({ ...draft, frappeApiKey: e.target.value })}
                placeholder="API key"
                className="mt-1.5 w-full rounded-md bg-[var(--input)] border border-[var(--bd)] px-2 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
              />
              <input
                type="password"
                value={draft.frappeApiSecret ?? ""}
                onChange={(e) => setDraft({ ...draft, frappeApiSecret: e.target.value })}
                placeholder="API secret"
                className="mt-1.5 w-full rounded-md bg-[var(--input)] border border-[var(--bd)] px-2 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-[var(--txt-dim)] hover:text-[var(--txt)]">
                Cancel
              </button>
              <button
                onClick={save}
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
              <p className="text-sm text-[var(--txt-faint)]">
                Nothing yet. Tell Alter something about yourself — lasting facts get remembered automatically.
              </p>
            )}
            {memories.map((m) => (
              <div key={m.id} className="group flex items-start gap-2 rounded-lg bg-[var(--panel)] px-3 py-2">
                <p className="flex-1 text-sm text-[var(--txt)]">{m.text}</p>
                <button
                  onClick={() => onDeleteMemory(m.id)}
                  className="hidden group-hover:block text-[var(--txt-faint)] hover:text-[var(--txt)]"
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
    </div>
  );
}
