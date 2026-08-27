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
  useTools = true
): Promise<ChatResult> {
  const url = settings.baseUrl.replace(/\/$/, "") + "/chat/completions";
  const body = JSON.stringify({
    model: settings.model,
    messages,
    stream: true,
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
    void invoke("cancel_chat").catch(() => {});
  };
  signal.addEventListener("abort", onAbort);

  try {
    await invoke("stream_chat", { url, apiKey: settings.apiKey, body, onChunk: channel });
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

// Claude Code (local): drive the `claude` CLI headlessly. Returns the final
// answer plus the session id, so follow-up turns can --resume the same session.
export async function claudeCodeChat(
  prompt: string,
  cwd: string | null,
  convId: string,
  sessionId: string | null,
  model: string | null,
  onDelta: (text: string) => void,
  signal: AbortSignal
): Promise<{ content: string; sessionId: string | null }> {
  let streamed = ""; // accumulated intermediate assistant text
  let result = ""; // authoritative final answer from the result event
  let sid: string | null = sessionId;

  const channel = new Channel<string>();
  channel.onmessage = (line: string) => {
    try {
      const ev = JSON.parse(line);
      if (ev.session_id) sid = ev.session_id;

      // Live token stream (from --include-partial-messages).
      if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
        const d = ev.event.delta;
        if (d?.type === "text_delta" && typeof d.text === "string") {
          streamed += d.text;
          onDelta(streamed);
        }
        return;
      }

      // Fallback: a whole assistant message (if partial streaming is unavailable).
      if (ev.type === "assistant" && Array.isArray(ev.message?.content) && !streamed) {
        const text = ev.message.content
          .filter((c: { type: string }) => c.type === "text")
          .map((c: { text: string }) => c.text)
          .join("");
        if (text) onDelta(text);
      }

      // Final answer — only paint it if nothing streamed (else keep what the user watched).
      if (ev.type === "result" && typeof ev.result === "string") {
        result = ev.result;
        if (!streamed) onDelta(result);
      }
    } catch {
      /* ignore non-JSON lines */
    }
  };

  const onAbort = () => void invoke("cancel_chat").catch(() => {});
  signal.addEventListener("abort", onAbort);
  try {
    await invoke("claude_code", { prompt, cwd, convId, sessionId, model, onChunk: channel });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return { content: streamed || result, sessionId: sid };
}
