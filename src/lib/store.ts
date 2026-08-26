export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Attachment {
  id: string;
  kind: "image" | "text";
  name: string;
  dataUrl?: string;
  text?: string;
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  attachments?: Attachment[];
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
}

export type Mode = "auto" | "ask" | "plan" | "chat";

export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  mode?: Mode;
}

export interface MemoryItem {
  id: string;
  text: string;
  createdAt: number;
}

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  everyMinutes: number;
  lastRun: number | null;
  enabled: boolean;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
}

export const PROVIDER_PRESETS: Record<string, { baseUrl: string; models: string[] }> = {
  DeepSeek: {
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  Moonshot: {
    baseUrl: "https://api.moonshot.ai/v1",
    models: ["kimi-k2-turbo-preview", "moonshot-v1-8k"],
  },
  "Vercel AI Gateway": {
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    models: ["moonshotai/kimi-k3", "deepseek/deepseek-v3.2", "anthropic/claude-sonnet-5"],
  },
};

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: PROVIDER_PRESETS.DeepSeek.baseUrl,
  apiKey: "",
  model: "deepseek-chat",
  mode: "auto",
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

export const storage = {
  loadSettings: () => load<Settings>("alter.settings", DEFAULT_SETTINGS),
  saveSettings: (s: Settings) => save("alter.settings", s),
  loadConversations: () => load<Conversation[]>("alter.conversations", []),
  saveConversations: (c: Conversation[]) => save("alter.conversations", c),
  loadMemories: () => load<MemoryItem[]>("alter.memories", []),
  saveMemories: (m: MemoryItem[]) => save("alter.memories", m),
  loadRoutines: () => load<Routine[]>("alter.routines", []),
  saveRoutines: (r: Routine[]) => save("alter.routines", r),
  loadSkills: () => load<Skill[]>("alter.skills", []),
  saveSkills: (s: Skill[]) => save("alter.skills", s),
};

export function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
