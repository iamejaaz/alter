import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { open } from "@tauri-apps/plugin-dialog";
import { isCodexUrl, isLocalAgentUrl, MemoryItem, Project, PROVIDER_PRESETS, Settings, Skill, newId } from "../lib/store";
import { listen } from "@tauri-apps/api/event";
import { cliLogin, cliLoginTerminal, cliStatus, CliStatus, codexCheck, testConnection } from "../lib/api";
import { Chevron, IconBookmark, IconFolder, IconLifebuoy, IconPlug, IconPuzzle, IconSettings, IconSparkles } from "./Icons";
import SkillsPage from "./SkillsPage";
import MemoryImport from "./MemoryImport";
import ProjectsEditor from "./ProjectsEditor";
import Switch from "./Switch";
import { confirmDialog } from "../lib/confirm";

function LocalAgentCard({ kind }: { kind: "claude" | "codex" }) {
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [live, setLive] = useState<{ ok: boolean; msg: string } | "checking" | null>(null);
  const [signing, setSigning] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const name = kind === "claude" ? "Claude Code" : "Codex";
  const load = async () => {
    setSigning(false);
    const s = await cliStatus(kind).catch(() => null);
    setStatus(s);
    if (kind === "codex" && s?.installed) {
      setLive("checking");
      await codexCheck()
        .then((msg) => setLive({ ok: true, msg }))
        .catch((e) => setLive({ ok: false, msg: e instanceof Error ? e.message : String(e) }));
    }
  };
  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    let un: (() => void) | undefined;
    void listen<{ kind: string; url: string }>("alter://cli-login-url", (e) => {
      if (e.payload.kind === kind) setLoginUrl(e.payload.url);
    }).then((u) => (un = u));
    return () => {
      window.removeEventListener("focus", onFocus);
      un?.();
    };
  }, [kind]);
  const signIn = async () => {
    setSigning(true);
    setProblem(null);
    setLoginUrl(null);
    try {
      await cliLogin(kind);
      await load();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSigning(false);
    }
  };
  const expired = kind === "codex" && live !== "checking" && live !== null && !live.ok;
  const signedIn = status?.signedIn !== false && !expired;
  return (
    <div className="rounded-lg border border-[var(--bd-soft)] px-3 py-2.5 space-y-1.5">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-[13px] text-[var(--txt)]">{name} on this Mac</p>
        {status?.installed && (
          <button
            onClick={signIn}
            disabled={signing}
            className={`rounded-md border px-2.5 py-1 text-[12px] disabled:opacity-60 ${
              signedIn ? "border-[var(--bd)] text-[var(--txt)] hover:bg-[var(--panel-2)]" : "border-[var(--txt-dim)] bg-[var(--panel-2)] text-[var(--txt)]"
            }`}
          >
            {signing ? "Waiting for your browser…" : signedIn ? "Sign in again" : "Sign in"}
          </button>
        )}
      </div>
      {!status ? (
        <p className="text-[11px] text-[var(--txt-faint)]">Checking…</p>
      ) : !status.installed ? (
        <p className="text-[11px] text-red-400">
          {kind === "claude"
            ? "Claude Code isn't installed. Install it from claude.com/code, then come back here and sign in."
            : "Codex isn't installed. Install the Codex app from openai.com/codex, then come back here and sign in."}
        </p>
      ) : (
        <p className="text-[11px] text-[var(--txt-dim)]">
          <span className={signedIn ? (live === "checking" ? "text-[var(--txt-dim)]" : "text-green-400") : "text-red-400"}>
            {status.signedIn === false
              ? "Not signed in"
              : expired
                ? "Login expired"
                : live === "checking"
                  ? "Checking the login…"
                  : status.account
                    ? `Signed in · ${status.account}`
                    : "Signed in"}
          </span>
          {" · "}
          {status.version}
        </p>
      )}
      {signing && (
        <p className="text-[11px] text-[var(--txt-dim)]">
          Finish signing in in your browser, then come back here.
          {loginUrl && (
            <>
              {" "}
              <button onClick={() => void invoke("open_external", { url: loginUrl })} className="underline hover:text-[var(--txt)]">
                Open the sign in page
              </button>{" "}
              if it didn't open.
            </>
          )}
        </p>
      )}
      {problem && (
        <p className="text-[11px] text-red-400">
          {problem}{" "}
          <button onClick={() => void cliLoginTerminal(kind)} className="underline hover:text-red-300">
            Sign in from Terminal instead
          </button>
        </p>
      )}
      <p className="text-[11px] text-[var(--txt-faint)]">
        Runs the <span className="font-mono">{kind}</span> CLI with your {kind === "claude" ? "Claude" : "ChatGPT"} plan, so there is no key or URL here.
      </p>
    </div>
  );
}

export type SettingsTab = "general" | "connections" | "projects" | "memory" | "support" | "extension" | "skills";

const NAV: { heading: string; items: { id: SettingsTab; label: string; icon: JSX.Element }[] }[] = [
  {
    heading: "Settings",
    items: [
      { id: "general", label: "General", icon: <IconSettings /> },
      { id: "connections", label: "Connections", icon: <IconPlug /> },
      { id: "projects", label: "Projects", icon: <IconFolder /> },
      { id: "memory", label: "Memory", icon: <IconBookmark /> },
    ],
  },
  {
    heading: "Agents",
    items: [
      { id: "support", label: "Support agent", icon: <IconLifebuoy /> },
      { id: "extension", label: "Browser extension", icon: <IconPuzzle /> },
    ],
  },
  { heading: "Customize", items: [{ id: "skills", label: "Skills", icon: <IconSparkles /> }] },
];

const field =
  "w-full rounded-lg bg-[var(--input)] border border-[var(--bd)] px-2.5 py-1.5 text-[13px] focus:outline-none focus:border-[var(--txt-faint)]";
const action =
  "shrink-0 rounded-lg border border-[var(--bd)] bg-[var(--panel)] px-3 py-1.5 text-[13px] text-[var(--txt)] hover:bg-[var(--panel-2)] disabled:opacity-40 transition-colors";

function Row({ title, desc, control, children }: { title: string; desc?: React.ReactNode; control?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="border-b border-[var(--bd-soft)] py-4 last:border-b-0">
      <div className="flex items-center gap-6">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] text-[var(--txt)]">{title}</p>
          {desc && <p className="mt-0.5 text-[13px] leading-snug text-[var(--txt-faint)]">{desc}</p>}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

interface Props {
  settings: Settings;
  memories: MemoryItem[];
  projects: Project[];
  onProjectsChange: (projects: Project[]) => void;
  onSave: (s: Settings) => void;
  onDeleteMemory: (id: string) => void;
  onAddMemory: (text: string) => void;
  onEditMemory: (id: string, text: string) => void;
  onImportMemories: (texts: string[]) => void;
  skills: Skill[];
  onSkillsChange: (s: Skill[]) => void;
  onClose: () => void;
  initialTab?: SettingsTab;
  projectsInitialId?: string | null;
}

export default function SettingsPanel({ settings, memories, projects, onProjectsChange, onSave, onDeleteMemory, onAddMemory, onEditMemory, onImportMemories, skills, onSkillsChange, onClose, initialTab, projectsInitialId }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [newMemory, setNewMemory] = useState("");
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "connections");
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [light, setLight] = useState(() => document.documentElement.dataset.theme === "light");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [bridge, setBridge] = useState<{ port: number; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [memoryImport, setMemoryImport] = useState(false);

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
      setImportMsg({ ok: true, text: "Imported from frappectl." });
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
      setTestResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
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
  const deleteConnection = async (id: string) => {
    const remaining = conns.filter((c) => c.id !== id);
    if (remaining.length === 0) return;
    if (!(await confirmDialog(`Delete the connection "${conns.find((c) => c.id === id)?.name ?? ""}"?`))) return;
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
    name = name.replace(/ \(local\)$/, "");
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
  // Every change lands as it is made: there is no Save to forget and nothing
  // is lost to Esc or a tab switch.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    onSave({ ...draft, connections: syncedConnections() });
  }, [draft]);

  const title = NAV.flatMap((g) => g.items).find((i) => i.id === tab)?.label ?? "Settings";

  return (
    <div className="fixed inset-0 z-20 flex bg-[var(--bg)]">
      <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--bd-soft)] bg-[var(--sidebar)]">
        <div data-tauri-drag-region className="h-12 shrink-0" />
        <nav className="flex-1 overflow-y-auto px-2 pb-3">
          {NAV.map((g) => (
            <div key={g.heading}>
              <p className="px-2 pt-3 pb-1 text-xs text-[var(--txt-faint)]">{g.heading}</p>
              <div className="space-y-0.5">
                {g.items.map((it) => (
                  <button
                    key={it.id}
                    onClick={() => setTab(it.id)}
                    className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-[13px] transition-colors ${
                      tab === it.id
                        ? "bg-[var(--panel-2)] text-[var(--txt)]"
                        : "text-[var(--txt-dim)] hover:bg-[var(--panel)] hover:text-[var(--txt)]"
                    }`}
                  >
                    <span className="text-[var(--txt-faint)]">{it.icon}</span>
                    {it.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <div data-tauri-drag-region className="flex h-12 shrink-0 items-center justify-end px-4">
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[18px] leading-none text-[var(--txt-faint)] hover:bg-[var(--panel-2)] hover:text-[var(--txt)]"
            title="Close (Esc)"
            aria-label="Close settings"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-10 pb-12">
            {tab !== "skills" && <h1 className="mb-2 text-[17px] font-semibold text-[var(--txt)]">{title}</h1>}

            {tab === "general" && (
              <div>
                <Row title="Light theme" control={<Switch on={light} onChange={toggleTheme} />} />
                {autostart !== null && (
                  <Row
                    title="Launch at login"
                    desc="Start Alter in the background so routines and scheduled messages keep running."
                    control={<Switch on={!!autostart} onChange={() => void toggleAutostart()} />}
                  />
                )}
                <Row
                  title="Working folder for browser agents"
                  desc="Where PR review, support and fix runs start, usually your bench. Empty falls back to the develop repro bench, then your home folder."
                >
                  <div className="flex gap-2">
                    <input
                      value={draft.agentWorkdir ?? ""}
                      onChange={(e) => setDraft({ ...draft, agentWorkdir: e.target.value })}
                      placeholder="/path/to/frappe-bench"
                      className={`${field} min-w-0 flex-1 font-mono`}
                    />
                    <button
                      onClick={async () => {
                        const picked = await open({ directory: true, title: "Select the working folder" });
                        if (typeof picked === "string") setDraft({ ...draft, agentWorkdir: picked });
                      }}
                      className={action}
                    >
                      Choose…
                    </button>
                  </div>
                </Row>
              </div>
            )}

            {tab === "projects" && (
              <div className="pt-3">
                <ProjectsEditor projects={projects} onChange={onProjectsChange} initialSelectedId={projectsInitialId} />
        </div>
            )}

            {tab === "connections" && (
              <div className="pt-3">
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
                    onClick={() => void deleteConnection(activeId)}
                    className="rounded-lg border border-[var(--bd)] hover:bg-[var(--panel-2)] px-3 text-sm text-red-400"
                    title="Delete this connection"
                  >
                    Delete
                  </button>
                )}
              </div>
              <label className="mt-3 block text-xs text-[var(--txt-dim)] mb-1.5">Name</label>
              <input
                value={activeConn?.name ?? ""}
                onChange={(e) => renameConnection(e.target.value)}
                className="w-full rounded-lg bg-[var(--input)] border border-[var(--bd)] px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--txt-dim)] mb-1.5">Add a connection from a provider</label>
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
            {isLocalAgentUrl(draft.baseUrl) && <LocalAgentCard kind={isCodexUrl(draft.baseUrl) ? "codex" : "claude"} />}
            <div className={isLocalAgentUrl(draft.baseUrl) ? "hidden" : undefined}>
              <label className="block text-xs text-[var(--txt-dim)] mb-1.5">Base URL</label>
              <input
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                className="w-full rounded-lg bg-[var(--input)] border border-[var(--bd)] px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div className={isLocalAgentUrl(draft.baseUrl) ? "hidden" : undefined}>
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
            <div className={isLocalAgentUrl(draft.baseUrl) ? "hidden" : undefined}>
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
                disabled={testing || (!draft.apiKey && !isLocalAgentUrl(draft.baseUrl))}
                className="rounded-lg border border-[var(--bd)] hover:bg-[var(--panel-2)] disabled:opacity-40 px-3 py-1.5 text-xs text-[var(--txt)] transition-colors"
              >
                {testing ? "Testing…" : "Test connection"}
              </button>
              {!draft.apiKey && !isLocalAgentUrl(draft.baseUrl) && (
                <span className="ml-2 text-[11px] text-[var(--txt-faint)]">Enter an API key first.</span>
              )}
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
          </div>
        </div>
            )}

            {tab === "support" && (
              <div>
                <Row
                  title="Repro benches"
                  desc="Point each version at an existing bench folder. The support agent reproduces bugs there, develop first, then the customer's version."
                >
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
                </Row>
                <Row title="MariaDB root password" desc="Optional. Lets the agent create a missing repro site itself. Stored on this device.">
                  <input
                    type="password"
                    value={draft.mariadbRootPassword ?? ""}
                    onChange={(e) => setDraft({ ...draft, mariadbRootPassword: e.target.value })}
                    className={field}
                  />
                </Row>
                <Row
                  title="Frappe credentials"
                  desc={
                    <>
                      How the support agent signs in to your helpdesk. Without these, <code>fr</code> asks the macOS keychain on every run. Import reuses the key <code>fr</code> already has.
                    </>
                  }
                  control={
                    <button onClick={importCreds} disabled={importing} className={action}>
                      {importing ? "Importing…" : "Import from fr"}
                    </button>
                  }
                >
                  {importMsg && <p className={`mb-2 text-[12px] ${importMsg.ok ? "text-emerald-500" : "text-red-400"}`}>{importMsg.text}</p>}
                  <label className="block text-[12px] text-[var(--txt-dim)]">Site</label>
                  <input
                    value={draft.frappeSite ?? ""}
                    onChange={(e) => setDraft({ ...draft, frappeSite: e.target.value })}
                    placeholder="https://support.frappe.io"
                    className={`${field} mt-1`}
                  />
                  <label className="mt-2 block text-[12px] text-[var(--txt-dim)]">API key</label>
                  <input
                    value={draft.frappeApiKey ?? ""}
                    onChange={(e) => setDraft({ ...draft, frappeApiKey: e.target.value })}
                    className={`${field} mt-1 font-mono`}
                  />
                  <label className="mt-2 block text-[12px] text-[var(--txt-dim)]">API secret</label>
                  <input
                    type="password"
                    value={draft.frappeApiSecret ?? ""}
                    onChange={(e) => setDraft({ ...draft, frappeApiSecret: e.target.value })}
                    className={`${field} mt-1 font-mono`}
                  />
                </Row>
              </div>
            )}

            {tab === "extension" && (
              <div>
                <p className="pb-1 text-[13px] text-[var(--txt-faint)]">
                  The extension adds Review with Alter on GitHub and the support panel on Helpdesk. It talks to this app over 127.0.0.1 with a pairing token, so no keys ever reach the browser.
                </p>
                {bridge ? (
                  <Row
                    title="Pair the extension"
                    desc={`Load the extension folder in Chrome at chrome://extensions with Developer mode on, open its settings from the toolbar icon, then paste this token and save. Bridge on localhost:${bridge.port}.`}
                  >
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate rounded-lg bg-[var(--input)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--txt-dim)]">{bridge.token}</code>
                      <button
                        onClick={() => {
                          void navigator.clipboard.writeText(bridge.token);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        }}
                        className={action}
                      >
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </Row>
                ) : (
                  <Row title="Pair the extension" desc="The bridge only runs inside the desktop app." />
                )}
                <Row
                  title="Review bot"
                  desc="Reviews can also be posted by a bot account through the repo's post-review workflow. Leave it empty to post only as yourself."
                >
                  <label className="block text-[12px] text-[var(--txt-dim)]">GitHub account</label>
                  <input
                    value={draft.prBot ?? ""}
                    onChange={(e) => setDraft({ ...draft, prBot: e.target.value })}
                    placeholder="frappe-pr-bot"
                    className={`${field} mt-1 font-mono`}
                  />
                  <label className="mt-2 block text-[12px] text-[var(--txt-dim)]">Repos to watch for replies to the bot</label>
                  <input
                    value={draft.prRepos ?? ""}
                    onChange={(e) => setDraft({ ...draft, prRepos: e.target.value })}
                    placeholder="empty = every repo the bot reviewed"
                    className={`${field} mt-1 font-mono`}
                  />
                </Row>
              </div>
            )}

            {tab === "memory" && (
              <div>
                <p className="pb-1 text-[13px] text-[var(--txt-faint)]">
                  Facts Alter carries into every new conversation. What it picks up from chats is also appended to <code className="rounded bg-[var(--input)] px-1 text-xs">~/.claude/CLAUDE.md</code>, so Claude Code learns it too.
                </p>
                <Row
                  title="Import memory from other AI providers"
                  desc="Bring what another assistant knows about you into Alter. You get a prompt to run there, then paste its answer here."
                  control={
                    <button onClick={() => setMemoryImport(true)} className={action}>
                      Start import
                    </button>
                  }
                />
                <Row title="Add a memory" desc="Something Alter should always know.">
                  <div className="flex gap-2">
                    <input
                      value={newMemory}
                      onChange={(e) => setNewMemory(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && newMemory.trim()) {
                          onAddMemory(newMemory.trim());
                          setNewMemory("");
                        }
                      }}
                      placeholder="I prefer short answers"
                      className={`${field} min-w-0 flex-1`}
                    />
                    <button
                      onClick={() => {
                        if (!newMemory.trim()) return;
                        onAddMemory(newMemory.trim());
                        setNewMemory("");
                      }}
                      disabled={!newMemory.trim()}
                      className={action}
                    >
                      Remember
                    </button>
                  </div>
                </Row>
                <p className="pt-6 pb-1 text-[14px] font-medium text-[var(--txt)]">
                  Remembered{memories.length > 0 && <span className="ml-2 font-normal text-[var(--txt-faint)]">{memories.length}</span>}
                </p>
                {memories.length === 0 && (
                  <p className="py-8 text-center text-[13px] text-[var(--txt-faint)]">Nothing remembered yet. Add one above, import, or tell Alter something in a chat that should stick.</p>
                )}
                {memories.map((m) => (
                  <div key={m.id} className="group flex items-center gap-2 border-b border-[var(--bd-soft)] py-2 last:border-b-0">
                    <input
                      defaultValue={m.text}
                      onBlur={(e) => {
                        const t = e.target.value.trim();
                        if (t && t !== m.text) onEditMemory(m.id, t);
                        else e.target.value = m.text;
                      }}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                      className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--txt)] focus:outline-none"
                    />
                    <button
                      onClick={() => onDeleteMemory(m.id)}
                      className="shrink-0 rounded-md px-2 py-0.5 text-[12px] text-[var(--txt-faint)] opacity-0 hover:bg-[var(--panel-2)] hover:text-[var(--txt)] group-hover:opacity-100"
                    >
                      Forget
                    </button>
                  </div>
                ))}
              </div>
            )}

            {tab === "skills" && <SkillsPage embedded skills={skills} onChange={onSkillsChange} onBack={onClose} />}
          </div>
        </div>
      </section>
      {memoryImport && (
        <MemoryImport
          existing={memories.map((m) => m.text)}
          onClose={() => setMemoryImport(false)}
          onImport={(texts) => {
            onImportMemories(texts);
            setMemoryImport(false);
          }}
        />
      )}
    </div>
  );
}
