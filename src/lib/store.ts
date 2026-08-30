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
  claudeSessionId?: string; // Claude Code (local) session, for conversation continuity
  connectionId?: string; // which connection this chat uses (per-chat, not global)
  model?: string; // resolved model for this chat (e.g. Claude Code sub-model)
  effort?: Effort;
  pinned?: boolean;
  costUsd?: number; // cumulative Claude Code spend for this chat
  lastTokens?: number; // context tokens reported on the last turn
  projectId?: string;
}

export interface Project {
  id: string;
  name: string;
  folder?: string;
  instructions?: string;
}

// Sentinel base URL that routes a connection to the local `claude` CLI instead of HTTP.
export const CLAUDE_CODE_URL = "claude-code://local";
export const isClaudeCodeUrl = (u: string) => u.startsWith("claude-code");

export type Mode = "auto" | "ask" | "plan" | "chat";

export interface Connection {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  mode?: Mode;
  effort?: Effort; // reasoning effort — Claude Code --effort / HTTP reasoning_effort
  connections?: Connection[];
  activeConnectionId?: string;
  reproRoot?: string; // optional: a folder holding per-version benches (convention)
  reproBenches?: Record<string, string>; // version -> existing bench folder (preferred)
}

export interface MemoryItem {
  id: string;
  text: string;
  createdAt: number;
}

export type Schedule =
  | { kind: "interval"; everyMinutes: number }
  | { kind: "daily"; time: string } // "HH:MM" local
  | { kind: "weekly"; time: string; days: number[] }; // 0=Sun … 6=Sat

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  everyMinutes: number; // legacy / interval fallback
  schedule?: Schedule;
  connectionId?: string; // run on the connection it was created with
  model?: string;
  lastRun: number | null;
  enabled: boolean;
}

export function scheduleLabel(r: Routine): string {
  const s = r.schedule;
  if (!s || s.kind === "interval") return `every ${s ? s.everyMinutes : r.everyMinutes}m`;
  if (s.kind === "daily") return `daily at ${s.time}`;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const d = [...s.days].sort((a, b) => a - b);
  const isWeekdays = d.length === 5 && d.every((x) => x >= 1 && x <= 5);
  return `${isWeekdays ? "weekdays" : d.map((x) => names[x]).join(", ")} at ${s.time}`;
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
  Gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    // gemini-flash-latest: free tier + vision. pro-preview needs billing.
    models: ["gemini-flash-latest", "gemini-3.1-pro-preview", "gemini-2.5-flash"],
  },
  OpenRouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    // Free models — they share rate-limit pools, so keep a couple as fallbacks.
    models: [
      "minimax/minimax-m2.7:free",
      "minimax/minimax-m3:free",
      "google/gemma-4-31b-it:free",
      "z-ai/glm-5.2:free",
    ],
  },
  "Frappe Gateway": {
    baseUrl: "https://grove.local.frappe.dev/v1",
    models: ["frappe/laguna-s-2.1-int4", "frappe/qwen3.5-4b"],
  },
  "Claude Code (local)": {
    baseUrl: CLAUDE_CODE_URL,
    models: ["claude-code"],
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
  loadSettings: () => {
    const s = load<Settings>("alter.settings", DEFAULT_SETTINGS);
    if (!s.connections || s.connections.length === 0) {
      const conn: Connection = {
        id: newId(),
        name: "Default",
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        model: s.model,
      };
      s.connections = [conn];
      s.activeConnectionId = conn.id;
    }
    if (!s.activeConnectionId || !s.connections.some((c) => c.id === s.activeConnectionId)) {
      s.activeConnectionId = s.connections[0].id;
    }
    // Heal stale labels: a Claude Code connection has one fixed identity, so its
    // name can never legitimately read like some other provider/model.
    s.connections = s.connections.map((c) =>
      isClaudeCodeUrl(c.baseUrl) && c.name !== "Claude Code" ? { ...c, name: "Claude Code", model: "claude-code" } : c
    );
    return s;
  },
  saveSettings: (s: Settings) => save("alter.settings", s),
  loadConversations: () => load<Conversation[]>("alter.conversations", []),
  saveConversations: (c: Conversation[]) => save("alter.conversations", c),
  loadMemories: () => load<MemoryItem[]>("alter.memories", []),
  saveMemories: (m: MemoryItem[]) => save("alter.memories", m),
  loadRoutines: () => load<Routine[]>("alter.routines", []),
  saveRoutines: (r: Routine[]) => save("alter.routines", r),
  loadSkills: () => {
    const s = load<Skill[]>("alter.skills", []);
    // One-time seed of starter skills built from Ejaaz's working preferences.
    if (s.length === 0 && !localStorage.getItem("alter.skillsSeeded")) {
      localStorage.setItem("alter.skillsSeeded", "1");
      return STARTER_SKILLS.map((k) => ({ ...k, id: newId() }));
    }
    return s;
  },
  saveSkills: (s: Skill[]) => save("alter.skills", s),
  loadProjects: () => load<Project[]>("alter.projects", []),
  saveProjects: (p: Project[]) => save("alter.projects", p),
};

export function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const STARTER_SKILLS: Omit<Skill, "id">[] = [
  {
    name: "PR description",
    description: "Write a short, clean PR description",
    instructions: [
      "Write a short PR description — no long paragraphs, no fluff, no preamble.",
      "Title needs a type prefix: feat: / fix: / refactor: / chore: etc.",
      "Never add AI/Claude attribution or Co-Authored-By footers.",
      "Keep exploit/vuln specifics out of public descriptions.",
      "Lead with the what and why in 1-2 lines; bullet the changes if needed. Link issues/PRs plainly.",
    ].join("\n"),
  },
  {
    name: "Commit message",
    description: "Terse conventional commit messages",
    instructions: [
      "Type-prefixed subject (feat:/fix:/refactor:/chore:), imperative, under ~70 chars.",
      "Body only if it adds signal — what changed and why, not how.",
      "No AI/Claude attribution, no Co-Authored-By.",
    ].join("\n"),
  },
  {
    name: "PR review",
    description: "Review a PR with a maintainer's lens",
    instructions: [
      "Judge with a maintainer's lens: cleanest mechanism, root cause fixed, no state residue — not just 'it works'.",
      "Comments: terse, @author-addressed, plain English, link references, no preamble/meta/praise-fluff.",
      "Explain an issue as a plain before/after user example (user does X → develop shows Y → PR shows worse Z); defer file/line/mechanism until needed.",
      "Scan test data/fixtures for real domains, emails, names, or keys — flag PII, expect example.com.",
      "No premature victory — progress is distance-to-parity with the real thing.",
    ].join("\n"),
  },
  {
    name: "Frappe desk UI",
    description: "Frappe/Espresso front-end conventions",
    instructions: [
      "No explanatory comments in code — keep it comment-free.",
      "Don't duplicate CSS — reuse existing classes; sweep for dead CSS after edits.",
      "Never hand-write inline SVGs — use frappe.utils.icon().",
      "Use Espresso components (es-button, es-badge with data-attributes) instead of bootstrap btn/badge.",
      "No blue / heavy black for accents — selection/hover use Espresso gray tokens.",
    ].join("\n"),
  },
];
