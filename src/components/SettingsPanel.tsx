import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { open } from "@tauri-apps/plugin-dialog";
import { isCodexUrl, isLocalAgentUrl, MemoryItem, Project, PROVIDER_PRESETS, Routine, Settings, Skill, newId } from "../lib/store";
import { listen } from "@tauri-apps/api/event";
import { cliInstallTerminal, cliLogin, cliLoginTerminal, cliSetPath, cliStatus, CliStatus, codexCheck, testConnection } from "../lib/api";
import { IconBlocks, IconBookmark, IconClock, IconFolder, IconLifebuoy, IconPlug, IconPuzzle, IconSettings, IconSparkles } from "./Icons";
import SkillsPage from "./SkillsPage";
import RoutinesPage from "./RoutinesPage";
import ConnectorsPage from "./ConnectorsPage";
import MemoryImport from "./MemoryImport";
import Row, { action, field } from "./SettingsRow";
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
  const [installing, setInstalling] = useState<string | null>(null);
  const locate = async () => {
    setProblem(null);
    const picked = await open({
      title: `Choose the ${kind} program, or the app that contains it`,
      defaultPath: "/Applications",
    }).catch(() => null);
    if (typeof picked !== "string") return;
    try {
      await cliSetPath(kind, picked);
      setInstalling(null);
      await load();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };
  const expired = kind === "codex" && live !== "checking" && live !== null && !live.ok;
  const signedIn = status?.signedIn !== false && !expired;
  return (
    <div className="space-y-1 border-b border-[var(--bd-soft)] py-4">
      <div className="flex items-center gap-6">
        <p className="flex-1 text-[14px] text-[var(--txt)]">{name} on this Mac</p>
        {status && !status.installed && (
          <>
            <button
              onClick={async () => {
                setProblem(null);
                try {
                  const cmd = await cliInstallTerminal(kind);
                  setInstalling(cmd);
                } catch (e) {
                  setProblem(e instanceof Error ? e.message : String(e));
                }
              }}
              className={`${action} border-[var(--txt-dim)] bg-[var(--panel-2)]`}
            >
              Install
            </button>
            <button onClick={() => void locate()} className={action}>
              Locate…
            </button>
          </>
        )}
        {status?.installed && (
          <button
            onClick={signIn}
            disabled={signing}
            className={`${action} ${signedIn ? "" : "border-[var(--txt-dim)] bg-[var(--panel-2)]"}`}
          >
            {signing ? "Waiting for your browser…" : signedIn ? "Sign in again" : "Sign in"}
          </button>
        )}
      </div>
      {!status ? (
        <p className="text-[13px] text-[var(--txt-faint)]">Checking…</p>
      ) : !status.installed ? (
        <p className="text-[13px] text-red-400">
          {name} isn't installed, or Alter can't find it. It looked in your shell's PATH, the usual install folders and inside {kind === "codex" ? "Codex and ChatGPT" : "Claude"} apps in Applications.{" "}
          <span className="text-[var(--txt-dim)]">
            Install opens Terminal on {kind === "claude" ? "Anthropic's installer" : "npm install -g @openai/codex"}. If it is installed somewhere else, use Locate and pick the {kind} file or the app.
          </span>
        </p>
      ) : (
        <p className="text-[13px] text-[var(--txt-dim)]">
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
      {installing && status && !status.installed && (
        <p className="text-[13px] text-[var(--txt-dim)]">
          Installing in Terminal with <code className="text-[12px]">{installing}</code>. When it finishes, come back here. Alter checks again when you switch to it.
        </p>
      )}
      {status?.installed && status.path && <p className="truncate font-mono text-[12px] text-[var(--txt-faint)]" title={status.path}>{status.path}</p>}
      {signing && (
        <p className="text-[13px] text-[var(--txt-dim)]">
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
        <p className="text-[13px] text-red-400">
          {problem}{" "}
          <button onClick={() => void cliLoginTerminal(kind)} className="underline hover:text-red-300">
            Sign in from Terminal instead
          </button>
        </p>
      )}
      <p className="text-[13px] text-[var(--txt-faint)]">
        Runs the <span className="font-mono">{kind}</span> CLI with your {kind === "claude" ? "Claude" : "ChatGPT"} plan, so there is no key or URL here.
      </p>
    </div>
  );
}

export type SettingsTab = "general" | "connections" | "projects" | "memory" | "support" | "extension" | "skills" | "routines" | "connectors";

const NAV: { heading: string; items: { id: SettingsTab; label: string; icon: React.ReactNode }[] }[] = [
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
  {
    heading: "Customize",
    items: [
      { id: "skills", label: "Skills", icon: <IconSparkles /> },
      { id: "routines", label: "Routines", icon: <IconClock /> },
      { id: "connectors", label: "Connectors", icon: <IconBlocks /> },
    ],
  },
];


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
  routines: Routine[];
  onRoutinesChange: (r: Routine[]) => void;
  onRunRoutine: (r: Routine) => void;
  parseRoutine: (description: string) => Promise<Partial<Routine> | null>;
  onClose: () => void;
  initialTab?: SettingsTab;
  projectsInitialId?: string | null;
}

const QUICK_ADD_HIDDEN = ["DeepSeek", "Gemini"];

export default function SettingsPanel({ settings, memories, projects, onProjectsChange, onSave, onDeleteMemory, onAddMemory, onEditMemory, onImportMemories, skills, onSkillsChange, routines, onRoutinesChange, onRunRoutine, parseRoutine, onClose, initialTab, projectsInitialId }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [newMemory, setNewMemory] = useState("");
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "connections");
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [light, setLight] = useState(() => document.documentElement.dataset.theme === "light");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [form, setForm] = useState<{ id: string; name: string; baseUrl: string; apiKey: string; model: string; isNew: boolean } | null>(null);
  const [bridge, setBridge] = useState<{ port: number; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [memoryImport, setMemoryImport] = useState(false);
  const [browserNote, setBrowserNote] = useState<string | null>(null);
  const [browserApp, setBrowserApp] = useState<string | null>(null);
  const [version, setVersion] = useState<{ root: string; head: string } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateNote, setUpdateNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    void invoke<{ root: string; head: string }>("app_version_info").then(setVersion).catch(() => {});
  }, []);
  const runUpdate = async () => {
    setUpdating(true);
    setUpdateNote(null);
    try {
      const u = await invoke<{ ok: boolean; error?: string; updated?: boolean; head?: string; commits?: string[]; backend?: boolean; extension?: boolean; skills?: boolean; switchedFrom?: string }>("app_update");
      const moved = u.switchedFrom ? ` Switched from the branch ${u.switchedFrom} to master, which is kept as it was.` : "";
      if (!u.ok) setUpdateNote({ ok: false, text: u.error ?? "Update failed." });
      else if (!u.updated) setUpdateNote({ ok: true, text: `Already up to date (${u.head}).${moved}` });
      else {
        const n = u.commits?.length ?? 0;
        const after = [
          u.backend ? "the app restarts itself in dev, or rebuild it" : "",
          u.extension ? "reload the extension (its popup has Update too)" : "",
          u.skills ? "restart Alter to install the new skills" : "",
        ].filter(Boolean);
        setUpdateNote({ ok: true, text: `Updated to ${u.head}, ${n} new commit${n === 1 ? "" : "s"}.${moved}${after.length ? ` Next: ${after.join(", ")}.` : ""}` });
      }
      void invoke<{ root: string; head: string }>("app_version_info").then(setVersion).catch(() => {});
    } catch (e) {
      setUpdateNote({ ok: false, text: String(e) });
    } finally {
      setUpdating(false);
    }
  };
  useEffect(() => {
    void invoke<{ browser: string | null }>("agent_browser_status")
      .then((s) => setBrowserApp(s.browser))
      .catch(() => {});
  }, []);

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
      const msg = await testConnection(form ? { ...draft, baseUrl: form.baseUrl, apiKey: form.apiKey, model: form.model } : draft);
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
  const openForm = (f: { id: string; name: string; baseUrl: string; apiKey: string; model: string }, isNew: boolean) => {
    setForm({ id: f.id, name: f.name, baseUrl: f.baseUrl, apiKey: f.apiKey, model: f.model, isNew });
    setTestResult(null);
  };
  const addConnection = () => openForm({ id: newId(), name: "", baseUrl: "", apiKey: "", model: "" }, true);
  const saveForm = (makeDefault = false) => {
    if (!form) return;
    const conn = { id: form.id, name: form.name.trim() || form.model || "Connection", baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim(), model: form.model.trim() };
    const synced = syncedConnections();
    const next = form.isNew ? [...synced, conn] : synced.map((c) => (c.id === conn.id ? { ...c, ...conn } : c));
    const top = makeDefault || conn.id === activeId ? conn : null;
    setDraft({
      ...draft,
      connections: next,
      ...(top ? { activeConnectionId: top.id, baseUrl: top.baseUrl, apiKey: top.apiKey, model: top.model } : {}),
    });
    setForm(null);
  };
  const deleteConnection = async (id: string) => {
    const remaining = syncedConnections().filter((c) => c.id !== id);
    if (remaining.length === 0) return;
    if (!(await confirmDialog(`Delete the connection "${conns.find((c) => c.id === id)?.name ?? ""}"? Chats that used it keep their history.`))) return;
    setForm(null);
    if (id !== activeId) {
      setDraft({ ...draft, connections: remaining });
      return;
    }
    const next = remaining[0];
    setDraft({ ...draft, connections: remaining, activeConnectionId: next.id, baseUrl: next.baseUrl, apiKey: next.apiKey, model: next.model });
  };
  // A preset spins up its own connection (or fills the current empty one) so it
  // never overwrites a configured connection like a gateway or Claude Code.
  const applyPreset = (name: string) => {
    const preset = PROVIDER_PRESETS[name];
    if (!preset) return;
    const [baseUrl, model] = [preset.baseUrl, preset.models[0]];
    name = name.replace(/ \(local\)$/, "");
    openForm({ id: newId(), name, baseUrl, apiKey: "", model }, true);
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
            {tab !== "skills" && tab !== "routines" && tab !== "connectors" && <h1 className="mb-2 text-[17px] font-semibold text-[var(--txt)]">{title}</h1>}

            {tab === "general" && (
              <div>
                <Row
                  title="Update Alter"
                  desc={
                    <>
                      Pulls the latest code with git into {version ? <code className="text-[12px]">{version.root}</code> : "Alter's folder"}
                      {version?.head ? `, now at ${version.head}` : ""}.
                      {updateNote && <span className={`mt-1 block ${updateNote.ok ? "text-[var(--txt-dim)]" : "text-red-400"}`}>{updateNote.text}</span>}
                    </>
                  }
                  control={
                    <button onClick={() => void runUpdate()} disabled={updating} className={action}>
                      {updating ? "Updating…" : "Update"}
                    </button>
                  }
                />
                <Row title="Light theme" control={<Switch on={light} onChange={toggleTheme} />} />
                {autostart !== null && (
                  <Row
                    title="Launch at login"
                    desc="Start Alter in the background so routines and scheduled messages keep running."
                    control={<Switch on={!!autostart} onChange={() => void toggleAutostart()} />}
                  />
                )}
                <Row
                  title="Agent browser"
                  desc={
                    <>
                      A {browserApp ?? "Chrome"} window Alter's agents can drive, with its own profile that stays signed in. It uses your default browser when it is Chromium based. Sign in to a site there once, then ask a chat to work on it. Agents never type passwords.
                      {browserNote && <span className="mt-1 block text-[var(--txt-dim)]">{browserNote}</span>}
                    </>
                  }
                  control={
                    <div className="flex items-center gap-3">
                      {draft.agentBrowser !== false && (
                        <button
                          onClick={async () => {
                            setBrowserNote(null);
                            try {
                              await invoke("agent_browser_open");
                            } catch (e) {
                              setBrowserNote(String(e));
                            }
                          }}
                          className={action}
                        >
                          Open browser
                        </button>
                      )}
                      <Switch on={draft.agentBrowser !== false} onChange={() => setDraft({ ...draft, agentBrowser: draft.agentBrowser === false })} />
                    </div>
                  }
                />
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
              <div>
                <ProjectsEditor projects={projects} onChange={onProjectsChange} initialSelectedId={projectsInitialId} />
        </div>
            )}

            {tab === "connections" && (() => {
              const editing = form;
              if (!editing)
                return (
                  <div>
                    <p className="pb-2 text-[13px] text-[var(--txt-faint)]">
                      Where Alter sends your messages. New chats use the default, and each chat remembers its own.
                    </p>
                    {conns.map((c) => {
                      const on = c.id === activeId;
                      return (
                        <div key={c.id} className="group flex items-center gap-3 border-b border-[var(--bd-soft)] last:border-b-0">
                          <button onClick={() => openForm(syncedConnections().find((x) => x.id === c.id) ?? c, false)} className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left">
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-2">
                                <span className="truncate text-[14px] text-[var(--txt)]">{c.name}</span>
                                {on && <span className="shrink-0 rounded-md bg-[var(--panel-2)] px-1.5 py-px text-[11px] text-[var(--txt-dim)]">Default</span>}
                              </span>
                              <span className="mt-0.5 block truncate text-[12px] text-[var(--txt-faint)]">
                                {isLocalAgentUrl(c.baseUrl) ? "Runs on this Mac with your plan" : `${c.model || "no model"} · ${c.baseUrl.replace(/^https?:\/\//, "") || "no URL"}`}
                              </span>
                            </span>
                          </button>
                          {!on && (
                            <button
                              onClick={() => selectConnection(c.id)}
                              className="shrink-0 rounded-md px-2 py-0.5 text-[12px] text-[var(--txt-faint)] opacity-0 hover:bg-[var(--panel-2)] hover:text-[var(--txt)] focus:opacity-100 group-hover:opacity-100"
                            >
                              Make default
                            </button>
                          )}
                          <span className="shrink-0 text-[var(--txt-faint)] group-hover:text-[var(--txt)]">›</span>
                        </div>
                      );
                    })}
                    <Row title="Add a connection" desc="Start from a provider, or add your own OpenAI compatible endpoint.">
                      <div className="flex flex-wrap gap-2">
                        {Object.keys(PROVIDER_PRESETS).filter((name) => !QUICK_ADD_HIDDEN.includes(name)).map((name) => (
                          <button key={name} onClick={() => applyPreset(name)} className={action}>
                            {name.replace(/ \(local\)$/, "")}
                          </button>
                        ))}
                        <button onClick={addConnection} className={action}>
                          Custom
                        </button>
                      </div>
                    </Row>
                  </div>
                );
              const isDefault = editing.id === activeId;
              const saved = syncedConnections().find((c) => c.id === editing.id);
              const dirty =
                editing.isNew || !saved || saved.name !== editing.name || saved.baseUrl !== editing.baseUrl || saved.apiKey !== editing.apiKey || saved.model !== editing.model;
              return (
                <div>
                  <button
                    onClick={() => setForm(null)}
                    className="mt-1 flex items-center gap-1.5 text-[13px] text-[var(--txt-dim)] hover:text-[var(--txt)] transition-colors"
                  >
                    ‹ All connections
                  </button>
                  <Row
                    title="Name"
                    control={<input value={editing.name} placeholder={editing.model || "My connection"} onChange={(e) => setForm({ ...editing, name: e.target.value })} className={`${field} w-72`} />}
                  />
                  {isLocalAgentUrl(editing.baseUrl) ? (
                    <LocalAgentCard kind={isCodexUrl(editing.baseUrl) ? "codex" : "claude"} />
                  ) : (
                    <>
                      <Row
                        title="Base URL"
                        control={
                          <input
                            value={editing.baseUrl}
                            onChange={(e) => setForm({ ...editing, baseUrl: e.target.value })}
                            placeholder="https://api.example.com/v1"
                            className={`${field} w-72 font-mono`}
                          />
                        }
                      />
                      <Row
                        title="Model"
                        control={
                          <>
                            <input
                              value={editing.model}
                              onChange={(e) => setForm({ ...editing, model: e.target.value })}
                              list="model-suggestions"
                              className={`${field} w-72 font-mono`}
                            />
                            <datalist id="model-suggestions">
                              {Object.values(PROVIDER_PRESETS)
                                .flatMap((p) => p.models)
                                .map((m) => (
                                  <option key={m} value={m} />
                                ))}
                            </datalist>
                          </>
                        }
                      />
                      <Row
                        title="API key"
                        desc="Stored only on this device."
                        control={
                          <input
                            type="password"
                            value={editing.apiKey}
                            onChange={(e) => setForm({ ...editing, apiKey: e.target.value })}
                            placeholder="sk-..."
                            className={`${field} w-72 font-mono`}
                          />
                        }
                      />
                    </>
                  )}
                  <Row
                    title="Test connection"
                    desc={
                      testResult ? (
                        <span className={testResult.ok ? "text-green-400" : "text-red-400"}>{testResult.msg}</span>
                      ) : !editing.apiKey && !isLocalAgentUrl(editing.baseUrl) ? (
                        "Enter an API key first."
                      ) : (
                        "Sends one small request to check it answers."
                      )
                    }
                    control={
                      <button onClick={runTest} disabled={testing || (!editing.apiKey && !isLocalAgentUrl(editing.baseUrl))} className={action}>
                        {testing ? "Testing…" : "Test"}
                      </button>
                    }
                  />
                  <Row
                    title="Default"
                    desc={isDefault ? "New chats use this connection." : "Use this connection for new chats."}
                    control={
                      isDefault ? (
                        <span className="text-[12px] text-[var(--txt-faint)]">Default</span>
                      ) : (
                        <button onClick={() => (editing.isNew || dirty ? saveForm(true) : selectConnection(editing.id))} className={action}>
                          {editing.isNew || dirty ? "Save and make default" : "Make default"}
                        </button>
                      )
                    }
                  />
                  {!editing.isNew && conns.length > 1 && (
                    <Row
                      title="Delete connection"
                      desc="Chats that used it keep their history."
                      control={
                        <button onClick={() => void deleteConnection(editing.id)} className={`${action} text-red-400`}>
                          Delete
                        </button>
                      }
                    />
                  )}
                  <div className="flex items-center justify-end gap-2 pt-4">
                    <button onClick={() => setForm(null)} className="rounded-lg px-3 py-1.5 text-[13px] text-[var(--txt-dim)] hover:text-[var(--txt)]">
                      Cancel
                    </button>
                    <button onClick={() => saveForm()} disabled={!dirty} className={`${action} bg-[var(--panel-2)]`}>
                      {editing.isNew ? "Add connection" : "Save"}
                    </button>
                  </div>
                </div>
              );
            })()}

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
            {tab === "connectors" && (
              <ConnectorsPage
                connectors={draft.connectors ?? []}
                onChange={(connectors) => setDraft({ ...draft, connectors })}
                browserOn={draft.agentBrowser !== false}
                onBrowser={(on) => setDraft({ ...draft, agentBrowser: on })}
              />
            )}
            {tab === "routines" && (
              <RoutinesPage
                routines={routines}
                connections={settings.connections ?? []}
                activeConnectionId={settings.activeConnectionId}
                onChange={onRoutinesChange}
                onRunNow={onRunRoutine}
                parseRoutine={parseRoutine}
              />
            )}
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
