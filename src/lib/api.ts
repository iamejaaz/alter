import { MemoryItem, Message, Settings, ToolCall } from "./store";
import { TOOL_DEFINITIONS } from "./tools";

const BASE_PROMPT = `You are Alter, the user's second self — a sharp, warm, concise desktop companion. Answer directly, skip filler, use markdown when it helps.

You can explore the user's Mac with tools: list_tree (project layout), list_dir, search_files (grep for a string), read_file, and write_file. Use them when the user asks about their files, code, or wants something created or edited. Use absolute paths. If the user attached a working folder, treat it as the default place to look. Prefer list_tree and search_files to orient before reading individual files.

You can also access the web: web_search (find pages) and fetch_url (read a static page's text). Use them for current information, documentation, or anything you don't know. Search first, then fetch the most relevant URLs to read them.

For pages that need a real browser — JavaScript-rendered content, or clicking and typing — use browser_open (loads a URL and returns its text), browser_click (click a link/button by visible text), and browser_type (type into an input by CSS selector). Prefer the lighter fetch_url for simple static pages.

When the user shares a lasting fact, preference, or instruction about themselves or how you should behave, append it at the very end of your reply on its own line wrapped exactly like: <memory>the fact, stated briefly</memory>. Only save genuinely lasting things, never small talk. Do not mention that you saved a memory.`;

export function buildSystemPrompt(memories: MemoryItem[]): string {
  if (memories.length === 0) return BASE_PROMPT;
  const facts = memories.map((m) => `- ${m.text}`).join("\n");
  return `${BASE_PROMPT}\n\nWhat you remember about the user from past conversations:\n${facts}`;
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
  signal: AbortSignal
): Promise<ChatResult> {
  const url = settings.baseUrl.replace(/\/$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      stream: true,
      tools: TOOL_DEFINITIONS,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  const toolCalls: ToolCall[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.replace(/^data: /, "").trim();
      if (!data || data === "[DONE]") continue;
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
            toolCalls[idx] = {
              id: tc.id ?? "",
              type: "function",
              function: { name: "", arguments: "" },
            };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
      } catch {
        continue;
      }
    }
  }
  return { content: full, toolCalls: toolCalls.filter(Boolean) };
}
