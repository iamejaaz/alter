import { useEffect, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import SettingsPanel from "./components/SettingsPanel";
import Markdown from "./components/Markdown";
import Logo from "./components/Logo";
import { buildSystemPrompt, extractMemories, streamChat } from "./lib/api";
import { describeToolCall, executeTool, pickFolder } from "./lib/tools";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Attachment,
  Conversation,
  MemoryItem,
  Message,
  PROVIDER_PRESETS,
  Routine,
  Settings,
  newId,
  storage,
} from "./lib/store";
import RoutinesPanel from "./components/RoutinesPanel";

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => storage.loadSettings());
  const [conversations, setConversations] = useState<Conversation[]>(() => storage.loadConversations());
  const [memories, setMemories] = useState<MemoryItem[]>(() => storage.loadMemories());
  const [routines, setRoutines] = useState<Routine[]>(() => storage.loadRoutines());
  const [showRoutines, setShowRoutines] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(conversations[0]?.id ?? null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [showSettings, setShowSettings] = useState(!storage.loadSettings().apiKey);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(() => localStorage.getItem("alter.folder"));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const active = conversations.find((c) => c.id === activeId) ?? null;

  useEffect(() => storage.saveConversations(conversations), [conversations]);
  useEffect(() => storage.saveMemories(memories), [memories]);
  useEffect(() => storage.saveRoutines(routines), [routines]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        setActiveId(null);
      }
      if (e.key === "Escape") setPreview(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages]);

  const updateConversation = (id: string, fn: (c: Conversation) => Conversation) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? fn(c) : c)));
  };

  const send = async (opts?: {
    text?: string;
    forceNew?: boolean;
    title?: string;
    historyOverride?: Message[];
  }) => {
    const text = (opts?.text ?? input).trim();
    const atts = opts?.text ? [] : attachments;
    if ((!text && atts.length === 0) || streaming) return;
    if (!settings.apiKey) {
      setShowSettings(true);
      return;
    }
    setError(null);
    if (!opts?.text) {
      setInput("");
      setAttachments([]);
    }

    let convId = opts?.forceNew ? null : activeId;
    if (!convId) {
      convId = newId();
      const conv: Conversation = {
        id: convId,
        title: opts?.title ?? text.slice(0, 40),
        messages: [],
        createdAt: Date.now(),
      };
      setConversations((prev) => [conv, ...prev]);
      setActiveId(convId);
    }

    const userMsg: Message = { role: "user", content: text, attachments: atts.length ? atts : undefined };
    const history = (opts?.historyOverride ?? conversations.find((c) => c.id === convId)?.messages ?? []).filter(
      (m) => (m.role === "user" || m.role === "assistant") && m.content
    );
    updateConversation(convId, (c) => ({
      ...c,
      title: c.messages.length === 0 ? opts?.title ?? text.slice(0, 40) : c.title,
      messages: [...c.messages, userMsg, { role: "assistant", content: "" }],
    }));

    const mode = settings.mode ?? "auto";
    const useTools = mode === "auto" || mode === "ask";
    const systemContent =
      buildSystemPrompt(memories, mode) + (folder ? `\n\nThe user's current working folder is: ${folder}` : "");

    const textFiles = atts
      .filter((a) => a.kind === "text")
      .map((a) => `\n\n--- Attached file: ${a.name} ---\n${a.text}`)
      .join("");
    const images = atts.filter((a) => a.kind === "image" && a.dataUrl);
    const apiText = text + textFiles;
    const apiUserMsg = images.length
      ? {
          role: "user",
          content: [
            { type: "text", text: apiText || "(see attached image)" },
            ...images.map((a) => ({ type: "image_url", image_url: { url: a.dataUrl } })),
          ],
        }
      : { role: "user", content: apiText };

    const payload = [
      { role: "system", content: systemContent },
      ...history,
      apiUserMsg,
    ] as unknown as Message[];

    setStreaming(true);
    abortRef.current = new AbortController();
    try {
      let full = "";
      for (let round = 0; round < 8; round++) {
        const result = await streamChat(
          settings,
          payload,
          (partial) => {
            updateConversation(convId!, (c) => ({
              ...c,
              messages: [...c.messages.slice(0, -1), { role: "assistant", content: partial }],
            }));
          },
          abortRef.current.signal,
          useTools
        );

        if (result.toolCalls.length === 0) {
          full = result.content;
          break;
        }

        payload.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
        const activity = result.toolCalls
          .map((tc) => `▸ ${describeToolCall(tc.function.name, tc.function.arguments)}`)
          .join("\n");
        updateConversation(convId, (c) => ({
          ...c,
          messages: [
            ...c.messages.slice(0, -1),
            ...(result.content ? [{ role: "assistant", content: result.content } as Message] : []),
            { role: "tool", content: activity } as Message,
            { role: "assistant", content: "" } as Message,
          ],
        }));

        for (const tc of result.toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }
          const output = await executeTool(tc.function.name, args, mode);
          payload.push({ role: "tool", content: output, tool_call_id: tc.id });
        }
      }
      const { clean, found } = extractMemories(full);
      updateConversation(convId, (c) => ({
        ...c,
        messages: [...c.messages.slice(0, -1), { role: "assistant", content: clean || full }],
      }));
      if (found.length) {
        setMemories((prev) => [
          ...prev,
          ...found
            .filter((f) => !prev.some((m) => m.text === f))
            .map((f) => ({ id: newId(), text: f, createdAt: Date.now() })),
        ]);
      }
    } catch (e: unknown) {
      if ((e as Error).name !== "AbortError") {
        setError((e as Error).message);
        updateConversation(convId, (c) => ({
          ...c,
          messages: c.messages.filter((m, i) => !(i === c.messages.length - 1 && m.role === "assistant" && !m.content)),
        }));
      }
    } finally {
      setStreaming(false);
    }
  };

  const stop = () => abortRef.current?.abort();

  const regenerate = () => {
    if (!active || streaming) return;
    const msgs = active.messages;
    let lastUser = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        lastUser = i;
        break;
      }
    }
    if (lastUser < 0) return;
    const prompt = msgs[lastUser].content;
    const prefix = msgs.slice(0, lastUser);
    updateConversation(active.id, (c) => ({ ...c, messages: prefix }));
    void send({ text: prompt, historyOverride: prefix });
  };

  const exportConversation = async () => {
    if (!active) return;
    const md =
      `# ${active.title}\n\n` +
      active.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => `**${m.role === "user" ? "You" : "Alter"}:**\n\n${m.content}`)
        .join("\n\n---\n\n");
    try {
      const path = await save({
        defaultPath: `${active.title}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (path) await invoke("write_file", { path, content: md });
    } catch {
      await navigator.clipboard.writeText(md);
      setError("Saved to clipboard (file dialog unavailable).");
    }
  };

  const chooseFolder = async () => {
    try {
      const dir = await pickFolder();
      if (dir) {
        setFolder(dir);
        localStorage.setItem("alter.folder", dir);
      }
    } catch {
      setError("Folder picker is only available in the desktop app (npm run dev).");
    }
  };

  const clearFolder = () => {
    setFolder(null);
    localStorage.removeItem("alter.folder");
  };

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    const next: Attachment[] = [];
    for (const f of Array.from(files)) {
      if (f.type.startsWith("image/")) {
        if (f.size > 8_000_000) {
          setError(`${f.name} is too large (max 8 MB).`);
          continue;
        }
        const dataUrl = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result as string);
          r.onerror = rej;
          r.readAsDataURL(f);
        });
        next.push({ id: newId(), kind: "image", name: f.name, dataUrl });
      } else {
        const text = (await f.text()).slice(0, 200_000);
        next.push({ id: newId(), kind: "text", name: f.name, text });
      }
    }
    setAttachments((prev) => [...prev, ...next]);
  };

  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  useEffect(() => {
    void invoke("save_routine_state", {
      state: JSON.stringify({ settings, memories, routines }),
    }).catch(() => {});
  }, [settings, memories, routines]);

  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const raw = await invoke<string>("take_routine_results");
        const results: { name: string; prompt: string; content: string; at: number }[] = JSON.parse(raw);
        if (!results.length) return;
        setConversations((prev) => [
          ...results.map((r) => ({
            id: newId(),
            title: `⏱ ${r.name}`,
            createdAt: r.at,
            messages: [
              { role: "user", content: r.prompt } as Message,
              { role: "assistant", content: r.content } as Message,
            ],
          })),
          ...prev,
        ]);
      } catch {
        /* not in desktop app */
      }
    }, 20_000);
    return () => clearInterval(timer);
  }, []);

  const deleteConversation = (id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
  };

  const modelOptions = Array.from(
    new Set([settings.model, ...Object.values(PROVIDER_PRESETS).flatMap((p) => p.models)])
  ).filter(Boolean);
  const tokenEstimate = active
    ? Math.round(active.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0) / 4)
    : 0;
  const setModel = (model: string) => {
    const s = { ...settings, model };
    setSettings(s);
    storage.saveSettings(s);
  };
  const suggestions = [
    "What can you do?",
    "Summarize the folder I attach",
    "Search the web for today's news",
  ];

  return (
    <div className="flex h-full bg-[#0c0c0e] text-zinc-100">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => setActiveId(null)}
        onDelete={deleteConversation}
        onOpenSettings={() => setShowSettings(true)}
        onOpenRoutines={() => setShowRoutines(true)}
      />

      <main className="flex-1 flex flex-col min-w-0">
        <header
          data-tauri-drag-region
          className="flex items-center gap-2 h-12 px-4 shrink-0 border-b border-white/[0.06]"
        >
          <span className="flex-1 truncate text-sm font-medium text-zinc-300 pointer-events-none">
            {active && active.messages.length > 0 ? active.title : ""}
          </span>
          {active && active.messages.length > 0 && (
            <>
              <button
                onClick={regenerate}
                disabled={streaming}
                className="rounded-lg hover:bg-white/[0.06] disabled:opacity-40 px-2.5 py-1.5 text-xs text-zinc-400 transition-colors"
                title="Regenerate last reply"
              >
                Regenerate
              </button>
              <button
                onClick={exportConversation}
                className="rounded-lg hover:bg-white/[0.06] px-2.5 py-1.5 text-xs text-zinc-400 transition-colors"
                title="Export as markdown"
              >
                Export
              </button>
            </>
          )}
        </header>

        <div className="flex-1 overflow-y-auto">
          {!active || active.messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-8">
              <Logo size={48} />
              <h1 className="mt-5 text-[28px] font-semibold tracking-tight text-zinc-100">Alter</h1>
              <p className="mt-2 text-[15px] text-zinc-500 max-w-md leading-relaxed">
                Your second self. It remembers what matters, reads your files, browses the web, and keeps working while you're away.
              </p>
              {settings.apiKey ? (
                <div className="mt-7 flex flex-wrap justify-center gap-2 max-w-lg">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      onClick={() => send({ text: s })}
                      className="rounded-full border border-white/10 bg-white/[0.03] hover:bg-white/[0.07] px-3.5 py-1.5 text-[13px] text-zinc-300 transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              ) : (
                <button
                  onClick={() => setShowSettings(true)}
                  className="mt-7 rounded-xl bg-indigo-600 hover:bg-indigo-500 px-5 py-2.5 text-sm font-medium shadow-lg shadow-indigo-950/40 transition-colors"
                >
                  Connect a model
                </button>
              )}
            </div>
          ) : (
            <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
              {active.messages.map((m, i) =>
                m.role === "tool" ? (
                  <div key={i} className="pl-11 space-y-1 animate-fade-up">
                    {m.content
                      .split("\n")
                      .filter(Boolean)
                      .map((line, j) => (
                        <div key={j} className="flex items-center gap-2 text-xs text-zinc-500">
                          <span className="h-1.5 w-1.5 rounded-full bg-indigo-400/60 shrink-0" />
                          <span className="font-mono truncate">{line.replace(/^▸\s*/, "")}</span>
                        </div>
                      ))}
                  </div>
                ) : m.role === "user" ? (
                  <div key={i} className="flex justify-end animate-fade-up">
                    <div className="max-w-[80%]">
                      {m.attachments && m.attachments.length > 0 && (
                        <div className="flex flex-wrap justify-end gap-2 mb-2">
                          {m.attachments.map((a) =>
                            a.kind === "image" ? (
                              <img
                                key={a.id}
                                src={a.dataUrl}
                                alt={a.name}
                                onClick={() => setPreview(a.dataUrl ?? null)}
                                className="h-24 w-24 rounded-lg object-cover border border-white/10 cursor-zoom-in hover:opacity-90 transition-opacity"
                              />
                            ) : (
                              <div
                                key={a.id}
                                className="flex items-center gap-1.5 rounded-lg bg-zinc-800/80 px-2.5 py-1.5 text-xs text-zinc-300"
                              >
                                <span>📄</span>
                                <span className="font-mono truncate max-w-[140px]">{a.name}</span>
                              </div>
                            )
                          )}
                        </div>
                      )}
                      {m.content && (
                        <div className="rounded-2xl rounded-br-md bg-zinc-800/80 px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
                          {m.content}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="group flex gap-3 animate-fade-up">
                    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/[0.04] border border-white/10">
                      <Logo size={15} />
                    </div>
                    <div className="min-w-0 flex-1">
                      {m.content ? (
                        <Markdown text={m.content} />
                      ) : (
                        <span className="inline-flex gap-1 text-zinc-500 py-1">
                          <span className="animate-bounce">●</span>
                          <span className="animate-bounce [animation-delay:150ms]">●</span>
                          <span className="animate-bounce [animation-delay:300ms]">●</span>
                        </span>
                      )}
                      {m.content && (
                        <button
                          onClick={() => navigator.clipboard.writeText(m.content)}
                          className="mt-1.5 text-[11px] text-zinc-600 hover:text-zinc-300 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          Copy
                        </button>
                      )}
                    </div>
                  </div>
                )
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="px-4 pb-4 pt-1">
          <div className="max-w-3xl mx-auto">
            {error && (
              <p className="mb-2 rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-300">
                {error}
              </p>
            )}
            <div className="rounded-2xl border border-white/10 bg-zinc-900/70 shadow-xl shadow-black/20 transition-colors focus-within:border-indigo-500/40">
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 px-3 pt-3">
                  {attachments.map((a) => (
                    <div key={a.id} className="relative group">
                      {a.kind === "image" ? (
                        <img
                          src={a.dataUrl}
                          alt={a.name}
                          onClick={() => setPreview(a.dataUrl ?? null)}
                          className="h-14 w-14 rounded-lg object-cover border border-white/10 cursor-zoom-in hover:opacity-90 transition-opacity"
                        />
                      ) : (
                        <div className="flex h-14 items-center gap-1.5 rounded-lg bg-white/[0.05] border border-white/10 px-2.5 text-xs text-zinc-300">
                          <span>📄</span>
                          <span className="font-mono truncate max-w-[100px]">{a.name}</span>
                        </div>
                      )}
                      <button
                        onClick={() => removeAttachment(a.id)}
                        className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-zinc-700 text-zinc-200 text-[10px] hover:bg-zinc-600"
                        title="Remove"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.txt,.md,.json,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.css,.html,.yaml,.yml,.toml,.csv,.log"
                className="hidden"
                onChange={(e) => {
                  void onFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <textarea
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={1}
                placeholder="Message Alter…"
                className="w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed focus:outline-none placeholder:text-zinc-500"
              />
              <div className="flex items-center gap-1 px-2.5 pb-2.5">
                <div className="relative">
                  <select
                    value={settings.mode ?? "auto"}
                    onChange={(e) => {
                      const s = { ...settings, mode: e.target.value as typeof settings.mode };
                      setSettings(s);
                      storage.saveSettings(s);
                    }}
                    className="appearance-none bg-transparent rounded-lg hover:bg-white/[0.06] pl-2 pr-6 py-1 text-xs text-zinc-300 focus:outline-none cursor-pointer transition-colors"
                    title="How Alter uses tools"
                  >
                    <option value="auto" className="bg-zinc-900">⚡ Auto</option>
                    <option value="ask" className="bg-zinc-900">✋ Ask first</option>
                    <option value="plan" className="bg-zinc-900">📋 Plan</option>
                    <option value="chat" className="bg-zinc-900">💬 Chat only</option>
                  </select>
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 text-[9px]">
                    ▾
                  </span>
                </div>
                <div className="relative">
                  <select
                    value={settings.model}
                    onChange={(e) => setModel(e.target.value)}
                    className="appearance-none bg-transparent rounded-lg hover:bg-white/[0.06] pl-2 pr-6 py-1 text-xs text-zinc-300 focus:outline-none cursor-pointer transition-colors max-w-[160px] truncate"
                    title="Model"
                  >
                    {modelOptions.map((m) => (
                      <option key={m} value={m} className="bg-zinc-900">
                        {m}
                      </option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 text-[9px]">
                    ▾
                  </span>
                </div>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1 rounded-lg hover:bg-white/[0.06] px-2 py-1 text-xs text-zinc-400 transition-colors"
                  title="Attach images or files"
                >
                  <span className="text-sm leading-none">📎</span>
                </button>
                {folder ? (
                  <div className="flex items-center gap-1.5 rounded-lg bg-white/[0.05] px-2 py-1 text-xs text-zinc-300 max-w-[160px]">
                    <span className="text-zinc-500">📁</span>
                    <span className="font-mono truncate">{folder.split("/").pop()}</span>
                    <button onClick={clearFolder} className="text-zinc-500 hover:text-zinc-200" title="Detach">
                      ×
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={chooseFolder}
                    className="flex items-center gap-1 rounded-lg hover:bg-white/[0.06] px-2 py-1 text-xs text-zinc-400 transition-colors"
                    title="Attach a working folder"
                  >
                    <span className="text-sm leading-none">＋</span> Folder
                  </button>
                )}
                <div className="flex-1" />
                {active && active.messages.length > 0 && (
                  <span className="text-[11px] text-zinc-600 tabular-nums mr-1">
                    ~{tokenEstimate >= 1000 ? (tokenEstimate / 1000).toFixed(1) + "k" : tokenEstimate}
                  </span>
                )}
                {streaming ? (
                  <button
                    onClick={stop}
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 hover:bg-white/[0.06] text-zinc-300 transition-colors"
                    title="Stop"
                  >
                    <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
                  </button>
                ) : (
                  <button
                    onClick={() => send()}
                    disabled={!input.trim() && attachments.length === 0}
                    className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:hover:bg-indigo-600 text-white transition-colors"
                    title="Send"
                  >
                    <span className="text-base leading-none">↑</span>
                  </button>
                )}
              </div>
            </div>
            <p className="mt-2 text-center text-[11px] text-zinc-600">
              Alter can read files, browse the web, and remember what matters.
            </p>
          </div>
        </div>
      </main>

      {preview && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/85 p-10 animate-fade-up"
          onClick={() => setPreview(null)}
        >
          <img
            src={preview}
            alt="preview"
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setPreview(null)}
            className="absolute top-5 right-5 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-zinc-200 text-lg"
            title="Close"
          >
            ×
          </button>
        </div>
      )}

      {showRoutines && (
        <RoutinesPanel
          routines={routines}
          onChange={setRoutines}
          onRunNow={(r) => {
            setShowRoutines(false);
            void send({ text: r.prompt, forceNew: true, title: `⏱ ${r.name}` });
          }}
          onClose={() => setShowRoutines(false)}
        />
      )}

      {showSettings && (
        <SettingsPanel
          settings={settings}
          memories={memories}
          onSave={(s) => {
            setSettings(s);
            storage.saveSettings(s);
          }}
          onDeleteMemory={(id) => setMemories((prev) => prev.filter((m) => m.id !== id))}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
