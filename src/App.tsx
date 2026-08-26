import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import SettingsPanel from "./components/SettingsPanel";
import Markdown from "./components/Markdown";
import Logo from "./components/Logo";
import ArtifactPanel, { Artifact as ArtifactType } from "./components/ArtifactPanel";
import { Chevron, IconArrowUp, IconFolder, IconMic, IconPaperclip } from "./components/Icons";

function extractArtifacts(content: string): ArtifactType[] {
  const arts: ArtifactType[] = [];
  const re = /```(html|svg)\s*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) arts.push({ lang: m[1].toLowerCase(), code: m[2].trim() });
  return arts;
}
import { buildSystemPrompt, extractMemories, streamChat } from "./lib/api";
import { describeToolCall, executeTool, pickFolder } from "./lib/tools";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { extractPdfText } from "./lib/pdf";
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
  const [artifact, setArtifact] = useState<ArtifactType | null>(null);
  const [listening, setListening] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const speechSupported =
    typeof window !== "undefined" &&
    // @ts-expect-error vendor-prefixed
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  const toggleMic = () => {
    // @ts-expect-error vendor-prefixed
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = "en-US";
    const base = input;
    rec.onresult = (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      setInput((base ? base + " " : "") + t);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  };
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
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
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
    atBottomRef.current = true;
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
      buildSystemPrompt(memories, mode) +
      (folder
        ? `\n\nThe user's attached working folder is: ${folder}\nThis is "this folder" / "this project" / "here". When asked about it, immediately call list_tree on it and read key files (README, package.json, main source) to answer — do not ask the user to confirm the path.`
        : "");

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
    const MAX_ROUNDS = 6;
    try {
      let full = "";
      let finished = false;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (abortRef.current.signal.aborted) break;
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

        if (result.content) full = result.content;

        if (result.toolCalls.length === 0 || abortRef.current.signal.aborted) {
          full = result.content;
          finished = true;
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
          if (abortRef.current.signal.aborted) break;
          const output = await executeTool(tc.function.name, args, mode);
          payload.push({ role: "tool", content: output, tool_call_id: tc.id });
        }
      }
      if (!finished && !full && !abortRef.current.signal.aborted) {
        full = "I took several steps but couldn't wrap this up. Try narrowing the question, or attach the specific folder you mean.";
      }
      const { clean, found } = extractMemories(full);
      updateConversation(convId, (c) => {
        const msgs = c.messages.slice(0, -1);
        if (clean || full) msgs.push({ role: "assistant", content: clean || full });
        return { ...c, messages: msgs };
      });
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

  const editMessage = (idx: number) => {
    if (!active || streaming) return;
    const m = active.messages[idx];
    if (m.role !== "user") return;
    updateConversation(active.id, (c) => ({ ...c, messages: c.messages.slice(0, idx) }));
    setInput(m.content);
    if (m.attachments) setAttachments(m.attachments);
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
      } else if (f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")) {
        try {
          const text = await extractPdfText(f);
          next.push({ id: newId(), kind: "text", name: f.name, text: text.slice(0, 200_000) });
        } catch {
          setError(`Could not read ${f.name}.`);
        }
      } else {
        const text = (await f.text()).slice(0, 200_000);
        next.push({ id: newId(), kind: "text", name: f.name, text });
      }
    }
    setAttachments((prev) => [...prev, ...next]);
  };

  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of Array.from(items)) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      void onFiles(dt.files);
    }
  };

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
  const applyMode = (mode: NonNullable<Settings["mode"]>) => {
    const s = { ...settings, mode };
    setSettings(s);
    storage.saveSettings(s);
  };

  const slashCommands = [
    { cmd: "/new", desc: "Start a new chat", run: () => setActiveId(null) },
    {
      cmd: "/clear",
      desc: "Delete this conversation",
      run: () => active && window.confirm(`Delete "${active.title}"?`) && deleteConversation(active.id),
    },
    { cmd: "/auto", desc: "Auto — act freely, writes confirm", run: () => applyMode("auto") },
    { cmd: "/ask", desc: "Ask before every action", run: () => applyMode("ask") },
    { cmd: "/plan", desc: "Plan only, no actions", run: () => applyMode("plan") },
    { cmd: "/chat", desc: "Chat only, no tools", run: () => applyMode("chat") },
    { cmd: "/folder", desc: "Attach a working folder", run: () => void chooseFolder() },
    { cmd: "/attach", desc: "Attach images or files", run: () => fileInputRef.current?.click() },
    { cmd: "/routines", desc: "Open routines", run: () => setShowRoutines(true) },
    { cmd: "/settings", desc: "Open settings", run: () => setShowSettings(true) },
  ];
  const showSlash = input.startsWith("/") && !input.includes(" ") && !input.includes("\n");
  const slashMatches = showSlash
    ? slashCommands.filter((c) => c.cmd.startsWith(input.toLowerCase()))
    : [];
  const runSlash = (c: (typeof slashCommands)[number]) => {
    setInput("");
    setSlashIdx(0);
    c.run();
  };
  const suggestions = [
    "What can you do?",
    "Summarize the folder I attach",
    "Search the web for today's news",
  ];

  return (
    <div className="flex h-full bg-[var(--bg)] text-[var(--txt)]">
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
          className="flex items-center gap-2 h-12 px-4 shrink-0 border-b border-[var(--bd-soft)]"
        >
          <span className="flex-1 truncate text-sm font-medium text-[var(--txt)] pointer-events-none">
            {active && active.messages.length > 0 ? active.title : ""}
          </span>
          {active && active.messages.length > 0 && (
            <>
              <button
                onClick={regenerate}
                disabled={streaming}
                className="rounded-lg hover:bg-[var(--panel-2)] disabled:opacity-40 px-2.5 py-1.5 text-xs text-[var(--txt-dim)] transition-colors"
                title="Regenerate last reply"
              >
                Regenerate
              </button>
              <button
                onClick={exportConversation}
                className="rounded-lg hover:bg-[var(--panel-2)] px-2.5 py-1.5 text-xs text-[var(--txt-dim)] transition-colors"
                title="Export as markdown"
              >
                Export
              </button>
            </>
          )}
        </header>

        <div
          ref={scrollRef}
          onWheel={(e) => {
            if (e.deltaY < 0) atBottomRef.current = false;
          }}
          onTouchMove={() => {
            const el = scrollRef.current;
            if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          }}
          onScroll={() => {
            const el = scrollRef.current;
            if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          }}
          className="flex-1 overflow-y-auto"
        >
          {!active || active.messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-8">
              <Logo size={48} />
              <h1 className="mt-5 text-[28px] font-semibold tracking-tight text-[var(--txt)]">Alter</h1>
              <p className="mt-2 text-[15px] text-[var(--txt-faint)] max-w-md leading-relaxed">
                Your second self. It remembers what matters, reads your files, browses the web, and keeps working while you're away.
              </p>
              {settings.apiKey ? (
                <div className="mt-7 flex flex-wrap justify-center gap-2 max-w-lg">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      onClick={() => send({ text: s })}
                      className="rounded-full border border-[var(--bd)] bg-[var(--panel)] hover:bg-[var(--panel-2)] px-3.5 py-1.5 text-[13px] text-[var(--txt)] transition-colors"
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
                        <div key={j} className="flex items-center gap-2 text-xs text-[var(--txt-faint)]">
                          <span className="h-1.5 w-1.5 rounded-full bg-indigo-400/60 shrink-0" />
                          <span className="font-mono truncate">{line.replace(/^▸\s*/, "")}</span>
                        </div>
                      ))}
                  </div>
                ) : m.role === "user" ? (
                  <div key={i} className="group flex justify-end animate-fade-up">
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
                                className="h-24 w-24 rounded-lg object-cover border border-[var(--bd)] cursor-zoom-in hover:opacity-90 transition-opacity"
                              />
                            ) : (
                              <div
                                key={a.id}
                                className="flex items-center gap-1.5 rounded-lg bg-[var(--user-bubble)] px-2.5 py-1.5 text-xs text-[var(--txt)]"
                              >
                                <span>📄</span>
                                <span className="font-mono truncate max-w-[140px]">{a.name}</span>
                              </div>
                            )
                          )}
                        </div>
                      )}
                      {m.content && (
                        <div className="rounded-2xl rounded-br-md bg-[var(--user-bubble)] px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
                          {m.content}
                        </div>
                      )}
                      <div className="flex justify-end">
                        <button
                          onClick={() => editMessage(i)}
                          className="mt-1 text-[11px] text-[var(--txt-faint)] hover:text-[var(--txt)] opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          Edit
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="group flex gap-3 animate-fade-up">
                    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--panel)] border border-[var(--bd)]">
                      <Logo size={15} />
                    </div>
                    <div className="min-w-0 flex-1">
                      {m.content ? (
                        <Markdown text={m.content} />
                      ) : (
                        <span className="inline-flex gap-1 text-[var(--txt-faint)] py-1">
                          <span className="animate-bounce">●</span>
                          <span className="animate-bounce [animation-delay:150ms]">●</span>
                          <span className="animate-bounce [animation-delay:300ms]">●</span>
                        </span>
                      )}
                      {m.content && (
                        <div className="mt-1.5 flex items-center gap-3">
                          <button
                            onClick={() => navigator.clipboard.writeText(m.content)}
                            className="text-[11px] text-[var(--txt-faint)] hover:text-[var(--txt)] opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            Copy
                          </button>
                          {extractArtifacts(m.content).map((a, k) => (
                            <button
                              key={k}
                              onClick={() => setArtifact(a)}
                              className="flex items-center gap-1 rounded-md border border-[var(--bd)] bg-[var(--panel)] px-2 py-0.5 text-[11px] text-[var(--txt)] hover:bg-[var(--panel-2)] transition-colors"
                            >
                              ⧉ Preview {a.lang}
                            </button>
                          ))}
                        </div>
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
            <div className="rounded-2xl border border-[var(--bd)] bg-[var(--composer)] shadow-xl shadow-black/20 transition-colors focus-within:border-indigo-500/40">
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 px-3 pt-3">
                  {attachments.map((a) => (
                    <div key={a.id} className="relative group">
                      {a.kind === "image" ? (
                        <img
                          src={a.dataUrl}
                          alt={a.name}
                          onClick={() => setPreview(a.dataUrl ?? null)}
                          className="h-14 w-14 rounded-lg object-cover border border-[var(--bd)] cursor-zoom-in hover:opacity-90 transition-opacity"
                        />
                      ) : (
                        <div className="flex h-14 items-center gap-1.5 rounded-lg bg-[var(--panel)] border border-[var(--bd)] px-2.5 text-xs text-[var(--txt)]">
                          <span>📄</span>
                          <span className="font-mono truncate max-w-[100px]">{a.name}</span>
                        </div>
                      )}
                      <button
                        onClick={() => removeAttachment(a.id)}
                        className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-zinc-700 text-[var(--txt)] text-[10px] hover:bg-zinc-600"
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
                accept="image/*,.pdf,.txt,.md,.json,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.css,.html,.yaml,.yml,.toml,.csv,.log"
                className="hidden"
                onChange={(e) => {
                  void onFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              {slashMatches.length > 0 && (
                <div className="mx-2 mt-2 rounded-xl border border-[var(--bd)] bg-[var(--modal)] shadow-xl overflow-hidden">
                  {slashMatches.map((c, k) => (
                    <button
                      key={c.cmd}
                      onMouseEnter={() => setSlashIdx(k)}
                      onClick={() => runSlash(c)}
                      className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                        k === slashIdx % slashMatches.length ? "bg-[var(--panel-2)]" : "hover:bg-[var(--panel)]"
                      }`}
                    >
                      <span className="text-sm font-medium text-[var(--txt)] w-24">{c.cmd}</span>
                      <span className="text-xs text-[var(--txt-dim)]">{c.desc}</span>
                    </button>
                  ))}
                </div>
              )}
              <textarea
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setSlashIdx(0);
                  e.target.style.height = "auto";
                  e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
                }}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (slashMatches.length > 0) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setSlashIdx((i) => (i + 1) % slashMatches.length);
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length);
                      return;
                    }
                    if (e.key === "Enter" || e.key === "Tab") {
                      e.preventDefault();
                      runSlash(slashMatches[slashIdx % slashMatches.length]);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setInput("");
                      return;
                    }
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={1}
                placeholder="Message Alter…  (/ for commands)"
                className="w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed focus:outline-none placeholder:text-[var(--txt-faint)]"
              />
              <div className="flex items-center gap-0.5 px-2 pb-2">
                <div className="relative">
                  <select
                    value={settings.mode ?? "auto"}
                    onChange={(e) => {
                      const s = { ...settings, mode: e.target.value as typeof settings.mode };
                      setSettings(s);
                      storage.saveSettings(s);
                    }}
                    className="appearance-none bg-transparent rounded-lg hover:bg-[var(--panel-2)] pl-2 pr-6 py-1.5 text-xs font-medium text-[var(--txt-dim)] hover:text-[var(--txt)] focus:outline-none cursor-pointer transition-colors"
                    title="How Alter uses tools"
                  >
                    <option value="auto" className="bg-[var(--modal)]">Auto</option>
                    <option value="ask" className="bg-[var(--modal)]">Ask first</option>
                    <option value="plan" className="bg-[var(--modal)]">Plan</option>
                    <option value="chat" className="bg-[var(--modal)]">Chat only</option>
                  </select>
                  <Chevron />
                </div>
                <div className="relative">
                  <select
                    value={settings.model}
                    onChange={(e) => setModel(e.target.value)}
                    className="appearance-none bg-transparent rounded-lg hover:bg-[var(--panel-2)] pl-2 pr-6 py-1.5 text-xs font-medium text-[var(--txt-dim)] hover:text-[var(--txt)] focus:outline-none cursor-pointer transition-colors max-w-[200px] truncate"
                    title={settings.model}
                  >
                    {modelOptions.map((m) => (
                      <option key={m} value={m} className="bg-[var(--modal)]">
                        {m.includes("/") ? m.split("/").pop() : m}
                      </option>
                    ))}
                  </select>
                  <Chevron />
                </div>

                <div className="mx-1 h-5 w-px bg-[var(--bd)]" />

                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--panel-2)] text-[var(--txt-dim)] hover:text-[var(--txt)] transition-colors"
                  title="Attach images or files"
                >
                  <IconPaperclip />
                </button>
                {speechSupported && (
                  <button
                    onClick={toggleMic}
                    className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
                      listening ? "bg-red-500/15 text-red-400" : "hover:bg-[var(--panel-2)] text-[var(--txt-dim)] hover:text-[var(--txt)]"
                    }`}
                    title={listening ? "Stop dictation" : "Dictate"}
                  >
                    <IconMic />
                  </button>
                )}
                {folder ? (
                  <div className="flex items-center gap-1.5 rounded-lg bg-[var(--panel)] pl-2 pr-1 py-1.5 text-xs text-[var(--txt)] max-w-[160px]">
                    <IconFolder />
                    <span className="font-mono truncate">{folder.split("/").pop()}</span>
                    <button onClick={clearFolder} className="text-[var(--txt-faint)] hover:text-[var(--txt)] px-0.5" title="Detach">
                      ×
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={chooseFolder}
                    className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--panel-2)] text-[var(--txt-dim)] hover:text-[var(--txt)] transition-colors"
                    title="Attach a working folder"
                  >
                    <IconFolder />
                  </button>
                )}
                <div className="flex-1" />
                {active && active.messages.length > 0 && (
                  <span className="text-[11px] text-[var(--txt-faint)] tabular-nums mr-1.5">
                    ~{tokenEstimate >= 1000 ? (tokenEstimate / 1000).toFixed(1) + "k" : tokenEstimate}
                  </span>
                )}
                {streaming ? (
                  <button
                    onClick={stop}
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--bd)] hover:bg-[var(--panel-2)] text-[var(--txt)] transition-colors"
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
                    <IconArrowUp />
                  </button>
                )}
              </div>
            </div>
            <p className="mt-2 text-center text-[11px] text-[var(--txt-faint)]">
              Alter can read files, browse the web, and remember what matters.
            </p>
          </div>
        </div>
      </main>

      {artifact && <ArtifactPanel artifact={artifact} onClose={() => setArtifact(null)} />}

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
            className="absolute top-5 right-5 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-[var(--txt)] text-lg"
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
