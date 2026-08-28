import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import SettingsPanel from "./components/SettingsPanel";
import Markdown from "./components/Markdown";
import Logo from "./components/Logo";
import ArtifactPanel, { Artifact as ArtifactType } from "./components/ArtifactPanel";
import CommandPalette, { Command } from "./components/CommandPalette";
import { Chevron, IconArrowUp, IconFolder, IconMic, IconPaperclip } from "./components/Icons";

function extractArtifacts(content: string): ArtifactType[] {
  const arts: ArtifactType[] = [];
  const re = /```(html|svg)\s*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) arts.push({ lang: m[1].toLowerCase(), code: m[2].trim() });
  return arts;
}

// Collapse a run of tool-step lines into one expandable block (collapsed by default).
function ToolSteps({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  if (lines.length === 0) return null;
  const summary = lines[lines.length - 1];
  return (
    <div className="pl-11 animate-fade-up">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 text-xs text-[var(--txt-faint)] hover:text-[var(--txt-dim)] transition-colors max-w-full"
      >
        <span className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        {open ? (
          <span>{lines.length} step{lines.length > 1 ? "s" : ""}</span>
        ) : (
          <span className="font-mono truncate">
            {summary}
            {lines.length > 1 ? `  · +${lines.length - 1}` : ""}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 space-y-1 border-l border-[var(--bd-soft)] ml-[3px] pl-3">
          {lines.map((l, j) => (
            <div key={j} className="flex items-start gap-2 text-xs text-[var(--txt-faint)]">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-400/60 shrink-0 mt-1.5" />
              <span className="font-mono break-all">{l}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type RenderItem = { kind: "tools"; lines: string[]; key: string } | { kind: "msg"; m: Message; i: number };

// Merge consecutive tool messages so their steps render as one collapsible group.
function groupMessages(messages: Message[]): RenderItem[] {
  const items: RenderItem[] = [];
  messages.forEach((m, i) => {
    if (m.role === "tool") {
      const lines = m.content.split("\n").filter(Boolean).map((l) => l.replace(/^▸\s*/, ""));
      const last = items[items.length - 1];
      if (last && last.kind === "tools") last.lines.push(...lines);
      else items.push({ kind: "tools", lines, key: `t${i}` });
    } else {
      items.push({ kind: "msg", m, i });
    }
  });
  return items;
}
import { buildSystemPrompt, ChatResult, claudeCodeChat, extractMemories, streamChat } from "./lib/api";
import { describeToolCall, executeTool, pickFolder } from "./lib/tools";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { extractPdfText } from "./lib/pdf";
import { confirmDialog } from "./lib/confirm";
import {
  Attachment,
  Conversation,
  MemoryItem,
  Message,
  Routine,
  Settings,
  Skill,
  isClaudeCodeUrl,
  newId,
  storage,
} from "./lib/store";
import RoutinesPanel from "./components/RoutinesPanel";
import SkillsPanel from "./components/SkillsPanel";
import ConfirmHost from "./components/ConfirmHost";

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => storage.loadSettings());
  const [conversations, setConversations] = useState<Conversation[]>(() => storage.loadConversations());
  const [memories, setMemories] = useState<MemoryItem[]>(() => storage.loadMemories());
  const [routines, setRoutines] = useState<Routine[]>(() => storage.loadRoutines());
  const [showRoutines, setShowRoutines] = useState(false);
  const [skills, setSkills] = useState<Skill[]>(() => storage.loadSkills());
  const [showSkills, setShowSkills] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(conversations[0]?.id ?? null);
  const [input, setInput] = useState("");
  const [streamingIds, setStreamingIds] = useState<string[]>([]); // conversations currently generating
  const [queued, setQueued] = useState<Record<string, string[]>>({}); // messages typed while a turn runs
  const [showSettings, setShowSettings] = useState(!storage.loadSettings().apiKey);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [sharedMemory, setSharedMemory] = useState(""); // ~/.claude/CLAUDE.md — shared with Claude Code
  const [pr, setPr] = useState<{ number: number; title: string; url: string } | null>(null);
  const [folder, setFolder] = useState<string | null>(() => localStorage.getItem("alter.folder"));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<ArtifactType | null>(null);
  const [listening, setListening] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [showPalette, setShowPalette] = useState(false);
  const [theme, setTheme] = useState<"system" | "light" | "dark">(
    () => (localStorage.getItem("alter.theme") as "system" | "light" | "dark") || "system"
  );
  const abortsRef = useRef<Record<string, AbortController>>({}); // one per streaming conversation
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
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
    rec.onerror = (e: { error?: string }) => {
      setListening(false);
      setError(
        e?.error === "not-allowed" || e?.error === "service-not-allowed"
          ? "Microphone access is blocked. Allow it in System Settings › Privacy & Security › Microphone."
          : "Voice dictation isn't supported in this app's webview yet."
      );
    };
    recognitionRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
      setError("Voice dictation isn't supported in this app's webview yet.");
    }
  };
  const bottomRef = useRef<HTMLDivElement>(null);

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const activeStreaming = !!activeId && streamingIds.includes(activeId);

  useEffect(() => {
    void invoke<string>("read_user_memory").then(setSharedMemory).catch(() => {});
  }, []);
  // Collapse the auto-grown composer back to one line once it's emptied (after send).
  useEffect(() => {
    if (input === "" && composerRef.current) composerRef.current.style.height = "auto";
  }, [input]);
  useEffect(() => {
    localStorage.setItem("alter.theme", theme);
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () =>
      document.documentElement.setAttribute("data-theme", theme === "system" ? (mq.matches ? "light" : "dark") : theme);
    apply();
    if (theme !== "system") return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
  // Opening a chat restores the model/connection it was last using — each chat
  // remembers its own, instead of sharing one global selection.
  useEffect(() => {
    if (!activeId) return;
    const conv = conversations.find((c) => c.id === activeId);
    if (!conv?.connectionId) return;
    const conn = (settings.connections ?? []).find((c) => c.id === conv.connectionId);
    if (!conn) return;
    setSettings((s) => {
      const next = {
        ...s,
        activeConnectionId: conn.id,
        baseUrl: conn.baseUrl,
        apiKey: conn.apiKey,
        model: conv.model ?? conn.model,
        effort: conv.effort,
      };
      storage.saveSettings(next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);
  // Surface the open PR for the working folder's branch (like Claude Code shows above the input).
  useEffect(() => {
    if (!folder) {
      setPr(null);
      return;
    }
    void invoke<string>("git_pr", { cwd: folder })
      .then((raw) => setPr(raw ? JSON.parse(raw) : null))
      .catch(() => setPr(null));
  }, [folder]);
  // Open http(s) links in the default browser, never inside the app webview.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a") as HTMLAnchorElement | null;
      if (a && /^https?:\/\//i.test(a.href)) {
        e.preventDefault();
        void invoke("open_external", { url: a.href }).catch(() => {});
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  useEffect(() => storage.saveConversations(conversations), [conversations]);
  useEffect(() => storage.saveMemories(memories), [memories]);
  useEffect(() => storage.saveRoutines(routines), [routines]);
  useEffect(() => storage.saveSkills(skills), [skills]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        setActiveId(null);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
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

  // Generate a concise chat title from the first message (like Claude Code does),
  // instead of using the raw first 40 characters.
  const generateTitle = async (cid: string, firstMessage: string) => {
    try {
      let title = "";
      if (isClaudeCodeUrl(settings.baseUrl)) {
        title = await invoke<string>("claude_title", { text: firstMessage });
      } else if (settings.apiKey) {
        title = await invoke<string>("quick_complete", {
          url: settings.baseUrl.replace(/\/$/, ""),
          apiKey: settings.apiKey,
          model: settings.model,
          prompt: `Generate a 3-6 word title in Title Case (no quotes, no trailing punctuation) for a chat that starts with this message. Reply with ONLY the title.\n\nMessage: ${firstMessage.slice(0, 500)}`,
        });
      }
      title = title
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<\/?think>/gi, "");
      title = (title.split("\n").map((s) => s.trim()).find(Boolean) ?? "")
        .replace(/^["']|["'.]$/g, "")
        .trim()
        .slice(0, 60);
      if (title) updateConversation(cid, (c) => ({ ...c, title }));
    } catch {
      /* keep the fallback title */
    }
  };

  // Errors that mean "this provider is busy/down — try another connection"
  const isRetryable = (msg: string) =>
    /\b(429|500|502|503|529)\b/.test(msg) ||
    /rate.?limit|temporarily|unavailable|overloaded|provider returned error|upstream|capacity|try again|no instances|timed out|timeout|no response/i.test(
      msg
    );
  const connLabel = (s: Settings) => {
    const list = s.connections ?? settings.connections ?? [];
    const c = list.find((x) => x.id === s.activeConnectionId);
    if (c && isClaudeCodeUrl(c.baseUrl)) return "Claude Code";
    const model = s.model.includes("/") ? s.model.split("/").pop() : s.model;
    return c && c.name !== "Default" ? `${c.name} · ${model}` : model || "model";
  };
  // Turn raw provider errors into plain-English guidance.
  const humanizeError = (raw: string): string => {
    if (/thought_signature/i.test(raw))
      return "This Gemini model needs a special tool-call format Alter can't send. Reload the app — Gemini now runs tool-free (still reads images and writes code), or use a non-Gemini connection for file/web tools.";
    if (/image input|support image|no endpoints.*image/i.test(raw))
      return "This model can't read images — it's text-only. Switch to a vision model (e.g. google/gemma-4-31b-it:free or minimax/minimax-m3:free), then resend.";
    if (/\b429\b|rate.?limit|temporarily|overloaded|upstream|shared_pool/i.test(raw))
      return "The model is rate-limited right now. Try again in a moment, switch to another connection, or add your own OpenRouter key for higher limits.";
    if (/\b401\b|invalid.?api|unauthor|no auth/i.test(raw))
      return "The API key was rejected. Check the key for this connection in Settings.";
    if (/\b404\b/.test(raw))
      return "That model id wasn't found on this provider. Check the model slug in Settings.";
    return raw.length > 240 ? raw.slice(0, 240) + "…" : raw;
  };

  const send = async (opts?: {
    text?: string;
    forceNew?: boolean;
    title?: string;
    historyOverride?: Message[];
    targetConvId?: string; // internal: drain a queued message into this conversation
  }) => {
    const text = (opts?.text ?? input).trim();
    const atts = opts?.text ? [] : attachments;
    if (!text && atts.length === 0) return;
    const targetId = opts?.targetConvId ?? (opts?.forceNew ? null : activeId);
    // If that conversation is mid-generation, queue this message to auto-send when it finishes.
    if (!opts?.targetConvId && targetId && streamingIds.includes(targetId)) {
      setQueued((q) => ({ ...q, [targetId]: [...(q[targetId] || []), text] }));
      if (!opts?.text) {
        setInput("");
        setAttachments([]);
      }
      return;
    }
    if (!settings.apiKey && !isClaudeCodeUrl(settings.baseUrl)) {
      setShowSettings(true);
      return;
    }
    setError(null);
    setInfo(null);
    atBottomRef.current = true;
    if (!opts?.text) {
      setInput("");
      setAttachments([]);
    }

    let convId = opts?.targetConvId ?? (opts?.forceNew ? null : activeId);
    let freshConv = false;
    if (!convId) {
      convId = newId();
      freshConv = true;
      const conv: Conversation = {
        id: convId,
        title: opts?.title ?? text.slice(0, 40),
        messages: [],
        createdAt: Date.now(),
        connectionId: settings.activeConnectionId,
        model: settings.model,
        effort: settings.effort,
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
    // Gemini reasoning models require a proprietary "thought_signature" round-trip that
    // the OpenAI tool format can't carry, so they error on multi-turn tool use.
    // Run them tool-free — they're excellent as chat + vision + coding models.
    const isGemini = /generativelanguage\.googleapis\.com/i.test(settings.baseUrl);
    const useTools = (mode === "auto" || mode === "ask") && !isGemini;
    const systemContent =
      buildSystemPrompt(memories, mode, skills) +
      (folder
        ? `\n\nThe user's attached working folder is: ${folder}\nThis is "this folder" / "this project" / "here". When asked about it, immediately call list_tree on it and read key files (README, package.json, main source) to answer — do not ask the user to confirm the path.`
        : "") +
      (sharedMemory
        ? `\n\nShared memory (from the user's ~/.claude/CLAUDE.md — the same facts Claude Code uses; treat as authoritative background):\n${sharedMemory}`
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

    // One AbortController per conversation so multiple chats can generate at once.
    const controller = new AbortController();
    abortsRef.current[convId] = controller;
    setStreamingIds((ids) => (ids.includes(convId!) ? ids : [...ids, convId!]));
    const endStream = () => {
      setStreamingIds((ids) => ids.filter((x) => x !== convId));
      delete abortsRef.current[convId!];
    };

    // Claude Code (local): drive the `claude` CLI instead of an HTTP provider.
    // Claude Code is its own agent (own tools + folder access), so Alter just
    // sends the user's message and shows the reply — no HTTP, no Alter tool loop.
    if (isClaudeCodeUrl(settings.baseUrl)) {
      try {
        const prior = conversations.find((c) => c.id === convId)?.claudeSessionId ?? null;
        // Teach-once: inject Alter's remembered facts into a new Claude Code session,
        // so what you told Alter applies here too (Claude Code already loads its own
        // CLAUDE.md + memory automatically).
        let ccPrompt = apiText;
        if (!prior && memories.length > 0) {
          const facts = memories.map((m) => `- ${m.text}`).join("\n");
          ccPrompt = `<context note="Things I've told you before — keep these in mind; don't reply to this block">\n${facts}\n</context>\n\n${apiText}`;
        }
        const { content, sessionId } = await claudeCodeChat(
          ccPrompt,
          folder,
          convId,
          prior,
          settings.model,
          settings.effort ?? null,
          // Map Alter's mode to Claude Code's permission mode.
          { auto: "bypassPermissions", ask: "acceptEdits", plan: "plan", chat: "default" }[
            settings.mode ?? "auto"
          ],
          (partial) =>
            updateConversation(convId!, (c) => ({
              ...c,
              messages: [...c.messages.slice(0, -1), { role: "assistant", content: partial }],
            })),
          (label) =>
            updateConversation(convId!, (c) => {
              const msgs = [...c.messages];
              const last = msgs[msgs.length - 1];
              const step = { role: "tool", content: `▸ ${label}` } as Message;
              if (last && last.role === "assistant" && !last.content) {
                // No text yet — slot the step in above the live (empty) bubble.
                msgs.splice(msgs.length - 1, 0, step);
              } else {
                // Freeze the streamed text, add the step, open a fresh bubble.
                msgs.push(step, { role: "assistant", content: "" } as Message);
              }
              return { ...c, messages: msgs };
            }),
          controller.signal
        );
        updateConversation(convId, (c) => ({
          ...c,
          claudeSessionId: sessionId ?? c.claudeSessionId,
          messages: [
            ...c.messages.slice(0, -1),
            ...(content ? [{ role: "assistant", content } as Message] : []),
          ],
        }));
        if (freshConv && !opts?.title) void generateTitle(convId, text);
      } catch (e: unknown) {
        const msg = typeof e === "string" ? e : (e as Error)?.message ?? String(e);
        if (!/abort/i.test(msg) && (e as Error)?.name !== "AbortError") {
          setError(humanizeError(msg));
          updateConversation(convId, (c) => ({
            ...c,
            messages: c.messages.filter(
              (m, i) => !(i === c.messages.length - 1 && m.role === "assistant" && !m.content)
            ),
          }));
        }
      } finally {
        endStream();
      }
      return;
    }

    const MAX_ROUNDS = 6;
    // Try the active connection first, then every other saved connection as a fallback.
    const fallbacks: Settings[] = [
      settings,
      ...(settings.connections ?? [])
        .filter((c) => c.id !== settings.activeConnectionId)
        .map((c) => ({ ...settings, baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model, activeConnectionId: c.id })),
    ];
    let activeSettings = settings;
    const writePartial = (partial: string) =>
      updateConversation(convId!, (c) => ({
        ...c,
        messages: [...c.messages.slice(0, -1), { role: "assistant", content: partial }],
      }));
    const deadline = Date.now() + 90_000; // hard cap: stop tool-looping after 90s
    try {
      let full = "";
      let finished = false;
      let cappedOut = false;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (controller.signal.aborted) break;
        if (Date.now() > deadline) {
          cappedOut = true;
          break;
        }
        let result: ChatResult;
        if (round === 0 && fallbacks.length > 1) {
          // First reply: walk connections until one actually starts responding.
          let chosen: ChatResult | null = null;
          for (let fi = 0; fi < fallbacks.length; fi++) {
            const cand = fallbacks[fi];
            let gotContent = false;
            try {
              chosen = await streamChat(
                cand,
                payload,
                (partial) => {
                  gotContent = true;
                  writePartial(partial);
                },
                controller.signal,
                useTools,
                convId
              );
              activeSettings = cand;
              if (fi > 0) {
                setInfo(`${connLabel(fallbacks[0])} was unavailable — switched to ${connLabel(cand)}.`);
                setSettings(cand);
                storage.saveSettings(cand);
              }
              break;
            } catch (e) {
              const m = typeof e === "string" ? e : (e as Error)?.message ?? String(e);
              const aborted =
                controller.signal.aborted || (e as Error)?.name === "AbortError" || /abort/i.test(m);
              // Only fall through on a retryable provider error before any text streamed.
              if (aborted || gotContent || !isRetryable(m) || fi === fallbacks.length - 1) throw e;
            }
          }
          result = chosen!;
        } else {
          result = await streamChat(activeSettings, payload, writePartial, controller.signal, useTools, convId);
        }

        if (result.content) full = result.content;

        if (result.toolCalls.length === 0 || controller.signal.aborted) {
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
          if (controller.signal.aborted) break;
          if (Date.now() > deadline) {
            cappedOut = true;
            break;
          }
          let output: string;
          if (tc.function.name === "use_skill") {
            const wanted = String(args.name ?? "").toLowerCase();
            const skill = skills.find((s) => s.name.toLowerCase() === wanted);
            output = skill
              ? `Skill "${skill.name}" instructions — follow these:\n\n${skill.instructions}`
              : `No skill named "${args.name}". Available: ${skills.map((s) => s.name).join(", ") || "none"}.`;
          } else {
            output = await executeTool(tc.function.name, args, mode);
          }
          payload.push({ role: "tool", content: output, tool_call_id: tc.id });
        }
        if (cappedOut) break;
      }
      if (!full && !controller.signal.aborted) {
        if (cappedOut) {
          full =
            "Stopped — the model kept running tools for over 90 seconds without finishing. Try a sharper request, or switch to a stronger model.";
        } else if (images.length) {
          full =
            "I couldn't get a response for that image. The current model is likely text-only — switch to a vision-capable model (check the gateway's /v1/models) to analyze images.";
        } else if (!finished) {
          full = "I took several steps but couldn't wrap this up. Try narrowing the question, or attach the specific folder you mean.";
        } else {
          full = "(The model returned an empty response.)";
        }
      }
      const { clean, found } = extractMemories(full);
      updateConversation(convId, (c) => {
        const msgs = c.messages.slice(0, -1);
        if (clean || full) msgs.push({ role: "assistant", content: clean || full });
        return { ...c, messages: msgs };
      });
      if (freshConv && !opts?.title) void generateTitle(convId, text);
      if (found.length) {
        const fresh = found.filter((f) => !memories.some((m) => m.text === f));
        setMemories((prev) => [
          ...prev,
          ...fresh
            .filter((f) => !prev.some((m) => m.text === f))
            .map((f) => ({ id: newId(), text: f, createdAt: Date.now() })),
        ]);
        // Also persist to the shared memory file so Claude Code (everywhere) learns it too.
        for (const f of fresh) void invoke("append_user_memory", { fact: f }).catch(() => {});
        if (fresh.length) setSharedMemory((s) => s + fresh.map((f) => `\n- ${f}`).join(""));
      }
    } catch (e: unknown) {
      const msg = typeof e === "string" ? e : (e as Error)?.message ?? String(e);
      if (!/abort/i.test(msg) && (e as Error)?.name !== "AbortError") {
        setError(humanizeError(msg));
        updateConversation(convId, (c) => ({
          ...c,
          messages: c.messages.filter((m, i) => !(i === c.messages.length - 1 && m.role === "assistant" && !m.content)),
        }));
      }
    } finally {
      endStream();
    }
  };

  const stop = () => {
    if (activeId) abortsRef.current[activeId]?.abort();
  };

  // Auto-send queued messages once their conversation finishes generating.
  useEffect(() => {
    const entry = Object.entries(queued).find(([cid, msgs]) => msgs.length && !streamingIds.includes(cid));
    if (!entry) return;
    const [cid, msgs] = entry;
    const [next, ...rest] = msgs;
    setQueued((q) => ({ ...q, [cid]: rest }));
    void send({ text: next, targetConvId: cid });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamingIds, queued]);

  const regenerate = () => {
    if (!active || activeStreaming) return;
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
    if (!active || activeStreaming) return;
    const m = active.messages[idx];
    if (m.role !== "user") return;
    updateConversation(active.id, (c) => ({ ...c, messages: c.messages.slice(0, idx) }));
    setInput(m.content);
    if (m.attachments) setAttachments(m.attachments);
  };

  // Fork a new chat from this turn, leaving the original untouched.
  const branchFrom = (idx: number) => {
    if (!active) return;
    const m = active.messages[idx];
    if (m.role !== "user") return;
    const conv: Conversation = {
      id: newId(),
      title: `${active.title} ↳`,
      messages: active.messages.slice(0, idx),
      createdAt: Date.now(),
      connectionId: active.connectionId,
      model: active.model,
      effort: active.effort,
    };
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
    setInput(m.content);
    if (m.attachments) setAttachments(m.attachments);
  };

  const conversationMarkdown = (c: Conversation) =>
    `# ${c.title}\n\n` +
    c.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `**${m.role === "user" ? "You" : "Alter"}:**\n\n${m.content}`)
      .join("\n\n---\n\n");

  const copyConversation = async () => {
    if (!active) return;
    await navigator.clipboard.writeText(conversationMarkdown(active));
    setInfo("Chat copied as Markdown.");
  };

  const exportConversation = async () => {
    if (!active) return;
    const md = conversationMarkdown(active);
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
    // If it's mid-generation, stop that stream so it doesn't orphan.
    abortsRef.current[id]?.abort();
    delete abortsRef.current[id];
    setStreamingIds((ids) => ids.filter((x) => x !== id));
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
  };

  const tokenEstimate = active
    ? Math.round(active.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0) / 4)
    : 0;
  const connections = settings.connections ?? [];
  const switchConnection = (id: string) => {
    const conn = connections.find((c) => c.id === id);
    if (!conn) return;
    const s = { ...settings, activeConnectionId: id, baseUrl: conn.baseUrl, apiKey: conn.apiKey, model: conn.model };
    setSettings(s);
    storage.saveSettings(s);
    if (activeId) updateConversation(activeId, (c) => ({ ...c, connectionId: id, model: conn.model }));
  };
  const applyMode = (mode: NonNullable<Settings["mode"]>) => {
    const s = { ...settings, mode };
    setSettings(s);
    storage.saveSettings(s);
  };
  // For Claude Code mode: change the model on the active connection (respawns warm on next send).
  const setClaudeModel = (model: string) => {
    const conns2 = (settings.connections ?? []).map((c) =>
      c.id === settings.activeConnectionId ? { ...c, model } : c
    );
    const s = { ...settings, model, connections: conns2 };
    setSettings(s);
    storage.saveSettings(s);
    if (activeId) updateConversation(activeId, (c) => ({ ...c, model }));
  };
  const CLAUDE_MODELS = [
    { id: "claude-code", label: "Default" },
    { id: "opus", label: "Opus 5" },
    { id: "sonnet", label: "Sonnet 5" },
    { id: "haiku", label: "Haiku" },
  ];
  const claudeCodeActive = isClaudeCodeUrl(settings.baseUrl);
  const setEffort = (effort: string) => {
    const e = effort ? (effort as NonNullable<Settings["effort"]>) : undefined;
    const s = { ...settings, effort: e };
    setSettings(s);
    storage.saveSettings(s);
    if (activeId) updateConversation(activeId, (c) => ({ ...c, effort: e }));
  };

  const slashCommands = [
    { cmd: "/new", desc: "Start a new chat", run: () => setActiveId(null) },
    {
      cmd: "/clear",
      desc: "Delete this conversation",
      run: async () => {
        if (active && (await confirmDialog(`Delete "${active.title}"?`))) deleteConversation(active.id);
      },
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
  // Ghost-text autocomplete: complete from a recent message that starts with the current input.
  const ghost = (() => {
    const val = input;
    if (val.trim().length < 2 || val.includes("\n") || val.startsWith("/")) return "";
    const lower = val.toLowerCase();
    for (const c of conversations) {
      for (const m of c.messages) {
        if (m.role === "user" && m.content.length > val.length && m.content.toLowerCase().startsWith(lower)) {
          return m.content.slice(val.length);
        }
      }
    }
    return "";
  })();
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

  const paletteCommands: Command[] = [
    { id: "new", label: "New chat", hint: "⌘N", section: "Actions", run: () => setActiveId(null) },
    { id: "settings", label: "Open settings", section: "Actions", run: () => setShowSettings(true) },
    { id: "routines", label: "Open routines", section: "Actions", run: () => setShowRoutines(true) },
    { id: "skills", label: "Open skills", section: "Actions", run: () => setShowSkills(true) },
    { id: "folder", label: "Attach a working folder", section: "Actions", run: () => void chooseFolder() },
    ...(active
      ? [
          { id: "export", label: "Export chat as Markdown…", section: "Actions", run: () => void exportConversation() },
          { id: "copymd", label: "Copy chat as Markdown", section: "Actions", run: () => void copyConversation() },
        ]
      : []),
    ...(["auto", "ask", "plan", "chat"] as const).map((m) => ({
      id: `mode-${m}`,
      label: `Mode: ${m}`,
      section: "Mode",
      run: () => applyMode(m),
    })),
    ...(["system", "light", "dark"] as const).map((t) => ({
      id: `theme-${t}`,
      label: `Theme: ${t}`,
      hint: theme === t ? "current" : undefined,
      section: "Theme",
      run: () => setTheme(t),
    })),
    ...connections.map((c) => ({
      id: `conn-${c.id}`,
      label: isClaudeCodeUrl(c.baseUrl) ? "Claude Code" : c.name,
      hint: c.id === settings.activeConnectionId ? "current" : undefined,
      section: "Connections",
      run: () => switchConnection(c.id),
    })),
    ...(claudeCodeActive
      ? CLAUDE_MODELS.map((m) => ({
          id: `cm-${m.id}`,
          label: `Claude model: ${m.label}`,
          hint: settings.model === m.id ? "current" : undefined,
          section: "Claude model",
          run: () => setClaudeModel(m.id),
        }))
      : []),
    ...conversations.map((c) => ({
      id: `chat-${c.id}`,
      label: c.title,
      section: "Chats",
      run: () => setActiveId(c.id),
    })),
  ];

  return (
    <div className="flex h-full bg-[var(--bg)] text-[var(--txt)]">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => setActiveId(null)}
        onDelete={deleteConversation}
        onRename={(id, title) => updateConversation(id, (c) => ({ ...c, title }))}
        onTogglePin={(id) => updateConversation(id, (c) => ({ ...c, pinned: !c.pinned }))}
        onOpenSettings={() => setShowSettings(true)}
        onOpenRoutines={() => setShowRoutines(true)}
        onOpenSkills={() => setShowSkills(true)}
      />

      <main className="flex-1 flex flex-col min-w-0">
        <header
          data-tauri-drag-region
          className="flex items-center gap-2 h-12 px-4 shrink-0 border-b border-[var(--bd-soft)]"
        >
          <span className="truncate text-sm font-medium text-[var(--txt)] pointer-events-none max-w-[40%]">
            {active && active.messages.length > 0 ? active.title : ""}
          </span>
          {/* Working folder lives here (like Claude Code shows the cwd after the title). */}
          {folder ? (
            <div className="flex items-center gap-1.5 rounded-lg bg-[var(--panel)] pl-2 pr-1 py-1 text-xs text-[var(--txt-dim)] max-w-[240px]">
              <IconFolder />
              <span className="font-mono truncate">{folder.split("/").pop()}</span>
              <button onClick={clearFolder} className="text-[var(--txt-faint)] hover:text-[var(--txt)] px-0.5" title="Detach folder">
                ×
              </button>
            </div>
          ) : (
            <button
              onClick={chooseFolder}
              className="flex items-center gap-1.5 rounded-lg hover:bg-[var(--panel-2)] px-2 py-1 text-xs text-[var(--txt-faint)] hover:text-[var(--txt)] transition-colors"
              title="Attach a working folder"
            >
              <IconFolder />
              <span>Add folder</span>
            </button>
          )}
          <div className="flex-1" />
          {active && active.messages.length > 0 && (
            <>
              <button
                onClick={regenerate}
                disabled={activeStreaming}
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
              {settings.apiKey || isClaudeCodeUrl(settings.baseUrl) ? (
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
              {groupMessages(active.messages).map((item) =>
                item.kind === "tools" ? (
                  <ToolSteps key={item.key} lines={item.lines} />
                ) : ((m, i) =>
                  m.role === "user" ? (
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
                      <div className="flex justify-end gap-3">
                        <button
                          onClick={() => branchFrom(i)}
                          className="mt-1 text-[11px] text-[var(--txt-faint)] hover:text-[var(--txt)] opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Fork a new chat from here (keeps this one)"
                        >
                          Branch
                        </button>
                        <button
                          onClick={() => editMessage(i)}
                          className="mt-1 text-[11px] text-[var(--txt-faint)] hover:text-[var(--txt)] opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Edit this message (replaces the rest of this chat)"
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
                ))(item.m, item.i)
              )}
              {activeId &&
                (queued[activeId] || []).map((q, k) => (
                  <div key={`q${k}`} className="flex justify-end animate-fade-up">
                    <div className="max-w-[80%] rounded-2xl rounded-br-md border border-dashed border-[var(--bd)] px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-[var(--txt-dim)]">
                      <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-[var(--txt-faint)]">Queued</span>
                      {q}
                    </div>
                  </div>
                ))}
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
            {info && (
              <p className="mb-2 flex items-center gap-2 rounded-lg border border-[var(--bd)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--txt-dim)]">
                <span className="text-indigo-400">↻</span>
                {info}
              </p>
            )}
            {pr && (
              <a
                href={pr.url}
                className="mb-2 flex items-center gap-2 rounded-lg border border-[var(--bd)] bg-[var(--panel)] px-3 py-1.5 text-xs text-[var(--txt-dim)] hover:text-[var(--txt)] hover:border-zinc-600 transition-colors w-fit"
                title={pr.url}
              >
                <span className="text-green-400">⑃</span>
                <span className="font-medium">#{pr.number}</span>
                <span className="truncate max-w-[420px]">{pr.title}</span>
              </a>
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
              <div className="relative">
                {ghost && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 px-4 pt-3.5 pb-1 text-[15px] leading-relaxed whitespace-pre-wrap break-words"
                  >
                    <span className="invisible">{input}</span>
                    <span className="text-[var(--txt-faint)]">{ghost}</span>
                  </div>
                )}
                <textarea
                ref={composerRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setSlashIdx(0);
                  e.target.style.height = "auto";
                  e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
                }}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (ghost && e.key === "Tab" && slashMatches.length === 0) {
                    e.preventDefault();
                    setInput((v) => v + ghost);
                    return;
                  }
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
                placeholder="Type / for commands"
                className="relative w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed focus:outline-none placeholder:text-[var(--txt-faint)]"
              />
              </div>
              <div className="flex items-center gap-0.5 px-2 pb-2 text-xs">
                {/* Left: mode + attach + mic */}
                <div className="relative">
                  <select
                    value={settings.mode ?? "auto"}
                    onChange={(e) => {
                      const s = { ...settings, mode: e.target.value as typeof settings.mode };
                      setSettings(s);
                      storage.saveSettings(s);
                    }}
                    className="appearance-none bg-transparent rounded-md hover:bg-[var(--panel-2)] pl-1.5 pr-5 py-1 font-medium text-[var(--txt-dim)] hover:text-[var(--txt)] focus:outline-none cursor-pointer transition-colors"
                    title="How Alter uses tools / permissions"
                  >
                    <option value="auto" className="bg-[var(--modal)]">Auto</option>
                    <option value="ask" className="bg-[var(--modal)]">Ask first</option>
                    <option value="plan" className="bg-[var(--modal)]">Plan</option>
                    <option value="chat" className="bg-[var(--modal)]">Chat only</option>
                  </select>
                  <Chevron />
                </div>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--panel-2)] text-[var(--txt-faint)] hover:text-[var(--txt)] transition-colors"
                  title="Attach images or files"
                >
                  <IconPaperclip />
                </button>
                {speechSupported && (
                  <button
                    onClick={toggleMic}
                    className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                      listening ? "bg-red-500/15 text-red-400" : "hover:bg-[var(--panel-2)] text-[var(--txt-faint)] hover:text-[var(--txt)]"
                    }`}
                    title={listening ? "Stop dictation" : "Dictate"}
                  >
                    <IconMic />
                  </button>
                )}

                {/* model · (claude model) · effort · tokens — grouped next to the tools */}
                <div className="relative">
                  <select
                    value={settings.activeConnectionId ?? ""}
                    onChange={(e) => switchConnection(e.target.value)}
                    className="appearance-none bg-transparent rounded-md hover:bg-[var(--panel-2)] pl-1.5 pr-5 py-1 font-medium text-[var(--txt-dim)] hover:text-[var(--txt)] focus:outline-none cursor-pointer transition-colors max-w-[150px] truncate"
                    title={settings.model}
                  >
                    {connections.map((c) => {
                      const short = c.model ? (c.model.includes("/") ? c.model.split("/").pop() : c.model) : "(no model)";
                      const label = isClaudeCodeUrl(c.baseUrl)
                        ? "Claude Code"
                        : c.name === "Default"
                          ? short
                          : `${c.name} · ${short}`;
                      return (
                        <option key={c.id} value={c.id} className="bg-[var(--modal)]">
                          {label}
                        </option>
                      );
                    })}
                  </select>
                  <Chevron />
                </div>
                {claudeCodeActive && (
                  <div className="relative">
                    <select
                      value={CLAUDE_MODELS.some((m) => m.id === settings.model) ? settings.model : "claude-code"}
                      onChange={(e) => setClaudeModel(e.target.value)}
                      className="appearance-none bg-transparent rounded-md hover:bg-[var(--panel-2)] pl-1.5 pr-5 py-1 font-medium text-[var(--txt-dim)] hover:text-[var(--txt)] focus:outline-none cursor-pointer transition-colors"
                      title="Claude Code model"
                    >
                      {CLAUDE_MODELS.map((m) => (
                        <option key={m.id} value={m.id} className="bg-[var(--modal)]">
                          {m.label}
                        </option>
                      ))}
                    </select>
                    <Chevron />
                  </div>
                )}
                <div className="relative">
                  <select
                    value={settings.effort ?? ""}
                    onChange={(e) => setEffort(e.target.value)}
                    className="appearance-none bg-transparent rounded-md hover:bg-[var(--panel-2)] pl-1.5 pr-5 py-1 font-medium text-[var(--txt-dim)] hover:text-[var(--txt)] focus:outline-none cursor-pointer transition-colors"
                    title="Reasoning effort"
                  >
                    <option value="" className="bg-[var(--modal)]">Effort</option>
                    <option value="low" className="bg-[var(--modal)]">Low</option>
                    <option value="medium" className="bg-[var(--modal)]">Medium</option>
                    <option value="high" className="bg-[var(--modal)]">High</option>
                    <option value="xhigh" className="bg-[var(--modal)]">X-High</option>
                    <option value="max" className="bg-[var(--modal)]">Max</option>
                  </select>
                  <Chevron />
                </div>
                {activeStreaming && (
                  <span
                    className="mx-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-[var(--txt-faint)] border-t-transparent animate-spin"
                    title="Working…"
                  />
                )}
                {active && active.messages.length > 0 && (
                  <span className="text-[11px] text-[var(--txt-faint)] tabular-nums mx-1">
                    ~{tokenEstimate >= 1000 ? (tokenEstimate / 1000).toFixed(1) + "k" : tokenEstimate}
                  </span>
                )}

                <div className="flex-1" />

                {activeStreaming ? (
                  <button
                    onClick={stop}
                    className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--bd)] hover:bg-[var(--panel-2)] text-[var(--txt)] transition-colors ml-0.5"
                    title="Stop"
                  >
                    <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
                  </button>
                ) : (
                  <button
                    onClick={() => send()}
                    disabled={!input.trim() && attachments.length === 0}
                    className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:hover:bg-indigo-600 text-white transition-colors ml-0.5"
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

      {showPalette && <CommandPalette commands={paletteCommands} onClose={() => setShowPalette(false)} />}

      <ConfirmHost />

      {showSkills && <SkillsPanel skills={skills} onChange={setSkills} onClose={() => setShowSkills(false)} />}

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
