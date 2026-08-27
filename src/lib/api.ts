import { invoke, Channel } from "@tauri-apps/api/core";
import { isClaudeCodeUrl, MemoryItem, Message, Mode, Settings, Skill, ToolCall } from "./store";
import { TOOL_DEFINITIONS } from "./tools";

const MODE_NOTES: Record<Mode, string> = {
  auto: "",
  ask: "",
  plan: "\n\nYou are in PLAN mode. Do not use any tools or take any actions. Instead, lay out a clear, numbered plan of the steps you would take, then stop and wait for the user to approve.",
  chat: "",
};

const BASE_PROMPT = `You are Alter, a desktop AI companion app created by Ejaaz. Your identity is Alter — when asked who you are, who made you, or what you are, say you are Alter, built by Ejaaz. You run on a configurable underlying model, but you do not identify as that model's provider; if asked which model powers you, you may mention it, but your name and creator are always Alter and Ejaaz. You are the user's second self — sharp, warm, concise. Answer directly, skip filler, use markdown when it helps.

You can explore the user's Mac with tools: list_tree (project layout), list_dir, search_files (grep for a string), read_file, and write_file. Use them when the user asks about their files, code, or wants something created or edited. Use absolute paths. Prefer list_tree and search_files to orient before reading individual files.

To check whether a command-line tool is installed ("do I have X", "is X installed"), use which_command with the tool's name — it searches the whole PATH. Never answer this by listing a couple of directories and guessing.

Be proactive and agentic. When the user asks you to do something you have tools for, USE THE TOOLS IMMEDIATELY — do not ask for confirmation, do not restate a plan, do not ask them to confirm a path you already know. Act first, then explain what you found. Only ask a clarifying question if the request is genuinely ambiguous and no reasonable default exists.

When the user says "this folder", "this project", "this repo", "here", "the current directory", or similar, they mean the attached working folder (if one is set). Inspect it directly with list_tree/read_file to answer — never ask them to confirm which folder they mean when a working folder is attached.

You can also access the web: web_search (find pages) and fetch_url (read a static page's text). Use them for current information, documentation, or anything you don't know. Search first, then fetch the most relevant URLs to read them.

For pages that need a real browser — JavaScript-rendered content, or clicking and typing — use browser_open (loads a URL and returns its text), browser_click (click a link/button by visible text), and browser_type (type into an input by CSS selector). Prefer the lighter fetch_url for simple static pages.

When the user shares a lasting fact, preference, or instruction about themselves or how you should behave, append it at the very end of your reply on its own line wrapped exactly like: <memory>the fact, stated briefly</memory>. Only save genuinely lasting things, never small talk. Do not mention that you saved a memory.`;

export function buildSystemPrompt(memories: MemoryItem[], mode: Mode = "auto", skills: Skill[] = []): string {
  let prompt = BASE_PROMPT;
  if (memories.length > 0) {
    const facts = memories.map((m) => `- ${m.text}`).join("\n");
    prompt += `\n\nWhat you remember about the user from past conversations:\n${facts}`;
  }
  if (skills.length > 0) {
    const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    prompt += `\n\nThe user has these saved skills. When a request matches one, call use_skill with its exact name to load its full instructions, then follow them:\n${list}`;
  }
  return prompt + MODE_NOTES[mode];
}

export function extractMemories(text: string): { clean: string; found: string[] } {
  const found: string[] = [];
  const clean = text
    .replace(/<memory>([\s\S]*?)<\/memory>/g, (_, fact: string) => {
      const trimmed = fact.trim();
      if (trimmed) found.push(trimmed);
      return "";
    })
    .trim();
  return { clean, found };
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
}

export async function streamChat(
  settings: Settings,
  messages: Message[],
  onDelta: (text: string) => void,
  signal: AbortSignal,
  useTools = true,
  cancelId = "default"
): Promise<ChatResult> {
  const url = settings.baseUrl.replace(/\/$/, "") + "/chat/completions";
  const body = JSON.stringify({
    model: settings.model,
    messages,
    stream: true,
    ...(settings.effort ? { reasoning_effort: settings.effort } : {}),
    ...(useTools ? { tools: TOOL_DEFINITIONS } : {}),
  });

  let full = "";
  const toolCalls: ToolCall[] = [];

  const handleLine = (line: string) => {
    const data = line.replace(/^data: /, "").trim();
    if (!data || data === "[DONE]") return;
    try {
      const json = JSON.parse(data);
      const delta = json.choices?.[0]?.delta ?? {};
      if (delta.content) {
        full += delta.content;
        onDelta(full);
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        if (!toolCalls[idx]) {
          toolCalls[idx] = { id: tc.id ?? "", type: "function", function: { name: "", arguments: "" } };
        }
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
      }
    } catch {
      /* ignore non-JSON keepalive lines */
    }
  };

  const channel = new Channel<string>();
  channel.onmessage = handleLine;

  const onAbort = () => {
    void invoke("cancel_chat", { id: cancelId }).catch(() => {});
  };
  signal.addEventListener("abort", onAbort);

  try {
    await invoke("stream_chat", { id: cancelId, url, apiKey: settings.apiKey, body, onChunk: channel });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  return { content: full, toolCalls: toolCalls.filter(Boolean) };
}

export async function testConnection(settings: Settings): Promise<string> {
  if (isClaudeCodeUrl(settings.baseUrl)) return invoke<string>("claude_version");
  const url = settings.baseUrl.replace(/\/$/, "");
  return invoke<string>("test_connection", { url, apiKey: settings.apiKey, model: settings.model });
}

// Typewriter smoothing: providers deliver text in uneven bursts (a 2-char token,
// then a 160-char sentence). This reveals whatever has arrived at a steady, readable
// pace via requestAnimationFrame, so the display types out smoothly regardless.
function makeSmoother(render: (text: string) => void) {
  let target = "";
  let shown = 0;
  let running = false;
  let ended = false;
  let resolveEnd: (() => void) | null = null;

  const tick = () => {
    const gap = target.length - shown;
    if (gap > 0) {
      const step = Math.min(40, Math.max(2, Math.ceil(gap / 8))); // catch up fast, stay smooth
      shown = Math.min(target.length, shown + step);
      render(target.slice(0, shown));
    }
    if (shown >= target.length) {
      running = false;
      if (ended && resolveEnd) {
        resolveEnd();
        resolveEnd = null;
      }
      return; // idle until next push (or done)
    }
    requestAnimationFrame(tick);
  };
  const ensure = () => {
    if (!running) {
      running = true;
      requestAnimationFrame(tick);
    }
  };
  return {
    push(full: string) {
      target = full;
      ensure();
    },
    reset() {
      target = "";
      shown = 0;
    },
    finish(): Promise<void> {
      ended = true;
      if (shown >= target.length) return Promise.resolve();
      ensure();
      return new Promise((res) => (resolveEnd = res));
    },
  };
}

// Turn a Claude Code tool call into a readable step line, e.g. "Bash: git status".
function toolLabel(name: string, input: Record<string, unknown>): string {
  const clip = (v: unknown, n = 60) => {
    const t = String(v ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  };
  const path = (p: unknown) => clip(String(p ?? "").split("/").slice(-2).join("/"), 48);
  switch (name) {
    case "Bash":
      return `Bash: ${clip(input.command)}`;
    case "Read":
      return `Read ${path(input.file_path)}`;
    case "Edit":
    case "MultiEdit":
      return `Edit ${path(input.file_path)}`;
    case "Write":
      return `Write ${path(input.file_path)}`;
    case "Grep":
      return `Grep "${clip(input.pattern, 40)}"`;
    case "Glob":
      return `Glob ${clip(input.pattern, 40)}`;
    case "WebFetch":
      return `Fetch ${clip(input.url, 48)}`;
    case "WebSearch":
      return `Search "${clip(input.query, 48)}"`;
    case "Task":
      return `Task: ${clip(input.description ?? input.subagent_type, 48)}`;
    default:
      return name;
  }
}

// Claude Code (local): drive the `claude` CLI headlessly. Returns the final
// answer plus the session id, so follow-up turns can --resume the same session.
export async function claudeCodeChat(
  prompt: string,
  cwd: string | null,
  convId: string,
  sessionId: string | null,
  model: string | null,
  effort: string | null,
  permissionMode: string | null,
  onDelta: (text: string) => void,
  onActivity: (label: string) => void,
  signal: AbortSignal
): Promise<{ content: string; sessionId: string | null }> {
  let streamed = ""; // text of the current segment (reset at each tool boundary)
  let result = ""; // authoritative final answer from the result event
  let sid: string | null = sessionId;
  let pending: { name: string; input: string } | null = null; // tool call being built
  const smoother = makeSmoother(onDelta);

  const channel = new Channel<string>();
  channel.onmessage = (line: string) => {
    try {
      const ev = JSON.parse(line);
      if (ev.session_id) sid = ev.session_id;

      if (ev.type === "stream_event" && ev.event?.type === "content_block_start") {
        const cb = ev.event.content_block;
        if (cb?.type === "tool_use" && cb.name) {
          // A tool call is starting — collect its streamed input, emit the step at stop.
          pending = { name: String(cb.name), input: "" };
        }
        return;
      }

      // Deltas: text tokens (streamed smoothly) or a tool's input JSON (accumulated).
      if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
        const d = ev.event.delta;
        if (d?.type === "text_delta" && typeof d.text === "string") {
          streamed += d.text;
          smoother.push(streamed);
        } else if (d?.type === "input_json_delta" && pending) {
          pending.input += d.partial_json ?? "";
        }
        return;
      }

      // A tool block finished — show it as a step with the real command/file.
      if (ev.type === "stream_event" && ev.event?.type === "content_block_stop" && pending) {
        if (streamed) onDelta(streamed); // fully paint the text before this tool
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(pending.input || "{}");
        } catch {
          /* partial/empty input */
        }
        onActivity(toolLabel(pending.name, parsed));
        pending = null;
        streamed = "";
        smoother.reset();
        return;
      }

      // Fallback: a whole assistant message (if partial streaming is unavailable).
      if (ev.type === "assistant" && Array.isArray(ev.message?.content) && !streamed) {
        const text = ev.message.content
          .filter((c: { type: string }) => c.type === "text")
          .map((c: { text: string }) => c.text)
          .join("");
        if (text) {
          streamed = text;
          smoother.push(streamed);
        }
      }

      // Final answer — only paint it if nothing streamed (else keep what the user watched).
      if (ev.type === "result" && typeof ev.result === "string") {
        result = ev.result;
        // Blocked by permissions (Ask/Plan modes) — tell the user how to allow it.
        const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
        if (denials.length) {
          const what = denials
            .map((d: { tool_name?: string; tool_input?: { command?: string; file_path?: string } }) =>
              d.tool_input?.command || d.tool_input?.file_path || d.tool_name || "a tool"
            )
            .slice(0, 3)
            .join(", ");
          result =
            `🔒 Claude needs permission to run: ${what}\n\n` +
            `Switch the mode to **Auto** (bottom-left) to let it act freely, then resend.`;
        }
        if (!streamed || denials.length) {
          streamed = result;
          smoother.push(streamed);
        }
      }
    } catch {
      /* ignore non-JSON lines */
    }
  };

  const onAbort = () => void invoke("cancel_chat", { id: convId }).catch(() => {});
  signal.addEventListener("abort", onAbort);
  try {
    await invoke("claude_code", { prompt, cwd, convId, sessionId, model, effort, permissionMode, onChunk: channel });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  await smoother.finish(); // let the last burst finish typing out
  return { content: streamed || result, sessionId: sid };
}
