import { useEffect, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import SettingsPanel from "./components/SettingsPanel";
import Markdown from "./components/Markdown";
import { buildSystemPrompt, extractMemories, streamChat } from "./lib/api";
import { describeToolCall, executeTool, pickFolder } from "./lib/tools";
import { Conversation, MemoryItem, Message, Routine, Settings, newId, storage } from "./lib/store";
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
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const active = conversations.find((c) => c.id === activeId) ?? null;

  useEffect(() => storage.saveConversations(conversations), [conversations]);
  useEffect(() => storage.saveMemories(memories), [memories]);
  useEffect(() => storage.saveRoutines(routines), [routines]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages]);

  const updateConversation = (id: string, fn: (c: Conversation) => Conversation) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? fn(c) : c)));
  };

  const send = async (opts?: { text?: string; forceNew?: boolean; title?: string }) => {
    const text = (opts?.text ?? input).trim();
    if (!text || streaming) return;
    if (!settings.apiKey) {
      setShowSettings(true);
      return;
    }
    setError(null);
    if (!opts?.text) setInput("");

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

    const userMsg: Message = { role: "user", content: text };
    const history = (conversations.find((c) => c.id === convId)?.messages ?? []).filter(
      (m) => (m.role === "user" || m.role === "assistant") && m.content
    );
    updateConversation(convId, (c) => ({
      ...c,
      title: c.messages.length === 0 ? opts?.title ?? text.slice(0, 40) : c.title,
      messages: [...c.messages, userMsg, { role: "assistant", content: "" }],
    }));

    const systemContent =
      buildSystemPrompt(memories) + (folder ? `\n\nThe user's current working folder is: ${folder}` : "");
    const payload: Message[] = [{ role: "system", content: systemContent }, ...history, userMsg];

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
          abortRef.current.signal
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
          const output = await executeTool(tc.function.name, args);
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

  useEffect(() => {
    const timer = setInterval(() => {
      if (streaming || !settings.apiKey) return;
      const now = Date.now();
      const due = routines.find(
        (r) => r.enabled && (r.lastRun == null || now - r.lastRun >= r.everyMinutes * 60_000)
      );
      if (!due) return;
      setRoutines((prev) => prev.map((r) => (r.id === due.id ? { ...r, lastRun: now } : r)));
      void send({ text: due.prompt, forceNew: true, title: `⏱ ${due.name}` });
    }, 30_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routines, streaming, settings, memories, folder]);

  const deleteConversation = (id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
  };

  return (
    <div className="flex h-full">
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
        <div className="flex-1 overflow-y-auto">
          {!active || active.messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-8">
              <h1 className="text-2xl font-semibold text-zinc-200">Alter</h1>
              <p className="mt-2 text-sm text-zinc-500 max-w-sm">
                Your second self. It remembers what matters — tell it something lasting and it keeps it across chats.
              </p>
              {!settings.apiKey && (
                <button
                  onClick={() => setShowSettings(true)}
                  className="mt-5 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-medium"
                >
                  Connect a model
                </button>
              )}
            </div>
          ) : (
            <div className="max-w-3xl mx-auto px-6 py-6 space-y-4">
              {active.messages.map((m, i) =>
                m.role === "tool" ? (
                  <div key={i} className="flex justify-start">
                    <div className="max-w-[80%] rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs font-mono text-zinc-400 whitespace-pre-wrap">
                      {m.content}
                    </div>
                  </div>
                ) : (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ${
                      m.role === "user"
                        ? "bg-indigo-600 text-white rounded-br-sm"
                        : "bg-zinc-800 text-zinc-100 rounded-bl-sm"
                    }`}
                  >
                    {m.content ? (
                      m.role === "assistant" ? (
                        <Markdown text={m.content} />
                      ) : (
                        m.content
                      )
                    ) : (
                      <span className="inline-flex gap-1">
                        <span className="animate-bounce">·</span>
                        <span className="animate-bounce [animation-delay:120ms]">·</span>
                        <span className="animate-bounce [animation-delay:240ms]">·</span>
                      </span>
                    )}
                    {m.role === "assistant" && m.content && (
                      <button
                        onClick={() => navigator.clipboard.writeText(m.content)}
                        className="mt-1.5 block text-[11px] text-zinc-500 hover:text-zinc-300"
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

        {error && (
          <div className="mx-auto mb-2 max-w-3xl w-full px-6">
            <p className="rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300">{error}</p>
          </div>
        )}

        <div className="border-t border-zinc-800 p-4">
          <div className="max-w-3xl mx-auto mb-2 flex items-center gap-2">
            {folder ? (
              <div className="flex items-center gap-2 rounded-lg bg-zinc-800/60 px-2.5 py-1 text-xs text-zinc-300">
                <span className="text-zinc-500">folder:</span>
                <span className="font-mono truncate max-w-[280px]">{folder}</span>
                <button onClick={clearFolder} className="text-zinc-500 hover:text-zinc-200" title="Detach">
                  ×
                </button>
              </div>
            ) : (
              <button
                onClick={chooseFolder}
                className="rounded-lg border border-zinc-800 hover:bg-zinc-800/60 px-2.5 py-1 text-xs text-zinc-400"
              >
                + Attach folder
              </button>
            )}
          </div>
          <div className="max-w-3xl mx-auto flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder="Message Alter…"
              className="flex-1 resize-none rounded-xl bg-zinc-800 border border-zinc-700 px-4 py-3 text-sm focus:outline-none focus:border-indigo-500 placeholder:text-zinc-500"
            />
            {streaming ? (
              <button
                onClick={stop}
                className="rounded-xl border border-zinc-700 hover:bg-zinc-800 px-4 py-3 text-sm text-zinc-300"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={() => send()}
                disabled={!input.trim()}
                className="rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 px-4 py-3 text-sm font-medium"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </main>

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
