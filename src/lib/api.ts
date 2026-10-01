import { invoke, Channel } from "@tauri-apps/api/core";
import { isClaudeCodeUrl, isCodexUrl, MemoryItem, PlanItem, Message, Mode, Settings, Skill, ToolCall } from "./store";
import { TOOL_DEFINITIONS } from "./tools";

const MODE_NOTES: Record<Mode, string> = {
  auto: "",
  ask: "",
  plan: "\n\nYou are in PLAN mode. Do not use any tools or take any actions. Instead, lay out a clear, numbered plan of the steps you would take, then stop and wait for the user to approve.",
  chat: "",
};

export const ALTER_IDENTITY =
  "You are Alter, a desktop AI companion app created by Ejaaz. Your identity is Alter: when asked who you are, who made you, or what you are, say you are Alter, built by Ejaaz. You run on a configurable underlying engine and model, and you may name them when asked what powers you, but you never introduce yourself as that engine, its provider, or a CLI. Your name and creator are always Alter and Ejaaz.";

const BASE_PROMPT = `${ALTER_IDENTITY} You are the user's second self — sharp, warm, concise. Answer directly, skip filler, use markdown when it helps.

Talk like a smart friend texting back, not like a report. Default to SHORT — most answers are 1-4 sentences. Say the thing, stop. No preamble ("Great question", "Sure, here's…"), no restating what they asked, no summary of what you just said, no bulleted essay for something simple. Plain words over jargon. Match length to the question: a simple ask gets a couple of lines; only go long when the task genuinely needs it — real code, multiple steps, or they explicitly ask for detail. When you do explain, get to the point first, details after, only if they help. Never pad to sound thorough.

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
  prompt +=
    "\n\nYou have no terminal, no git or GitHub access, and no sub-agents here. Only when a request truly needs one of those to be done, such as reading or acting on real PRs, running commands or tests, or committing, say in one short line that it needs Claude Code and end your reply with [needs-claude-code]. Writing or drafting text about PRs, code or GitHub needs none of that, so just do it.";
  if (mode !== "chat")
    prompt +=
      "\n\nFor a task with three or more real steps, call update_plan first with the steps, then call it again as each step starts, finishes or gets blocked. Skip it for questions and quick tasks.";
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

// Turn stored chat messages into API history. Step messages that carry real tool
// calls and outputs are expanded into the assistant(tool_calls) → tool(result)
// pairs providers expect, so later turns know what the tools actually returned.
export function buildHistory(messages: Message[], withTools: boolean): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const images = (m.attachments ?? []).filter((a) => a.kind === "image" && a.dataUrl);
      if (images.length) {
        const content = [
          { type: "text", text: m.content || "(see attached image)" },
          ...images.map((a) => ({ type: "image_url", image_url: { url: a.dataUrl } })),
        ];
        out.push({ role: "user", content: content as unknown as string });
      } else if (m.content) {
        out.push({ role: "user", content: m.content });
      }
      continue;
    }
    if (m.role === "assistant") {
      if (m.content) out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role !== "tool" || !withTools || !m.tool_calls?.length || !m.toolResults?.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === "assistant" && !prev.tool_calls) {
      prev.tool_calls = m.tool_calls;
    } else {
      out.push({ role: "assistant", content: "", tool_calls: m.tool_calls });
    }
    for (const r of m.toolResults) out.push({ role: "tool", content: r.output, tool_call_id: r.id });
  }
  return out;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  rawTail?: string;
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
  const bodyFor = (effort: string | undefined) =>
    JSON.stringify({
      model: settings.model,
      messages,
      stream: true,
      ...(effort ? { reasoning_effort: effort } : {}),
      ...(useTools ? { tools: TOOL_DEFINITIONS } : {}),
    });

  let full = "";
  let finishReason: string | undefined;
  let rawTail = "";
  const toolCalls: ToolCall[] = [];

  const handleLine = (line: string) => {
    const data = line.replace(/^data: /, "").trim();
    if (!data || data === "[DONE]") return;
    rawTail = (rawTail + data).slice(-600);
    try {
      const json = JSON.parse(data);
      const choice = json.choices?.[0] ?? {};
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? choice.message ?? {};
      const text = delta.content ?? delta.refusal;
      const piece = Array.isArray(text) ? text.map((t: { text?: string }) => t.text ?? "").join("") : text;
      if (piece) {
        full += piece;
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

  const run = (effort: string | undefined) => {
    const channel = new Channel<string>();
    channel.onmessage = handleLine;
    return invoke("stream_chat", { id: cancelId, url, apiKey: settings.apiKey, body: bodyFor(effort), onChunk: channel });
  };

  const onAbort = () => {
    void invoke("cancel_chat", { id: cancelId }).catch(() => {});
  };
  signal.addEventListener("abort", onAbort);

  try {
    try {
      await run(settings.effort);
    } catch (e) {
      const rejectsEffort = !full && settings.effort && /reasoning_effort/i.test(String(e));
      if (!rejectsEffort) throw e;
      await run("none");
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  return { content: full, toolCalls: toolCalls.filter(Boolean), finishReason, rawTail };
}

export interface CliStatus {
  kind: string;
  installed: boolean;
  path: string;
  version: string;
  signedIn: boolean | null;
  account: string;
  loginCommand: string;
}

export const cliStatus = (kind: "claude" | "codex") => invoke<CliStatus>("cli_status", { kind });
export const cliLogin = (kind: "claude" | "codex") => invoke<string>("cli_login", { kind });
export const cliLoginTerminal = (kind: "claude" | "codex") => invoke<void>("cli_login_terminal", { kind });
export const codexCheck = () => invoke<string>("codex_check");

export async function testConnection(settings: Settings): Promise<string> {
  if (isClaudeCodeUrl(settings.baseUrl)) {
    const s = await cliStatus("claude");
    if (!s.installed) throw new Error("Claude Code isn't installed. Install it from claude.com/code, then click Sign in.");
    if (s.signedIn === false) throw new Error("Claude Code is installed but not signed in. Click Sign in.");
    return `Claude Code ready · ${s.version}${s.account ? ` · ${s.account}` : ""}`;
  }
  if (isCodexUrl(settings.baseUrl)) {
    const s = await cliStatus("codex");
    if (!s.installed) throw new Error("Codex isn't installed. Install the Codex app or the codex CLI, then click Sign in.");
    return invoke<string>("codex_check");
  }
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
    case "Agent":
      return `Agent: ${clip(input.description ?? input.subagent_type, 48)}`;
    default:
      return name;
  }
}

// Claude Code (local): drive the `claude` CLI headlessly. Returns the final
// answer plus the session id, so follow-up turns can --resume the same session.
export function claudeClose(convId: string): void {
  void invoke("claude_close", { convId }).catch(() => {});
}

export function claudeInterrupt(convId: string): void {
  void invoke("claude_interrupt", { convId }).catch(() => {});
}

const codexCommand = (item: Record<string, unknown>): string => {
  const actions = Array.isArray(item.commandActions) ? (item.commandActions as { command?: string }[]) : [];
  return String(actions[0]?.command ?? item.command ?? "").replace(/^\/bin\/(ba|z)?sh -lc ['"]?|['"]$/g, "");
};

const codexChanges = (item: Record<string, unknown>): { path: string; kind: string }[] =>
  (Array.isArray(item.changes) ? (item.changes as { path?: string; kind?: { type?: string } | string }[]) : []).map((c) => ({
    path: String(c.path ?? ""),
    kind: typeof c.kind === "string" ? c.kind : String(c.kind?.type ?? "update"),
  }));

const codexLabel = (item: Record<string, unknown>): string | null => {
  const clip = (v: unknown, n = 60) => {
    const t = String(v ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  };
  switch (item.type) {
    case "commandExecution":
      return `Bash: ${clip(codexCommand(item))}`;
    case "fileChange":
      return (
        codexChanges(item)
          .map((c) => `${c.kind === "add" ? "Write" : c.kind === "delete" ? "Delete" : "Edit"} ${c.path.split("/").slice(-2).join("/")}`)
          .join("\n") || "Edit files"
      );
    case "mcpToolCall":
      return `${item.server ?? "mcp"}.${item.tool ?? "tool"}`;
    case "webSearch":
      return `Search "${clip(item.query, 48)}"`;
    default:
      return null;
  }
};

export async function codexChat(
  prompt: string,
  images: { mediaType: string; data: string }[],
  cwd: string | null,
  convId: string,
  threadId: string | null,
  model: string | null,
  effort: string | null,
  permissionMode: string | null,
  onDelta: (text: string) => void,
  onActivity: (label: string) => void,
  signal: AbortSignal,
  onThread?: (id: string) => void,
  onPlan?: (items: PlanItem[]) => void,
  onAsk?: (ask: ToolAsk | null, cancelledId?: string) => void
): Promise<{ content: string; threadId: string | null; tokens: number | null }> {
  let streamed = "";
  let base = "";
  let current = "";
  let last = "";
  let thread = threadId;
  let tokens: number | null = null;
  const shown = new Set<string>();
  const items = new Map<string, Record<string, unknown>>();
  const smoother = makeSmoother(onDelta);
  const reply = (message: Record<string, unknown>) => void invoke("agent_reply", { convId, message }).catch(() => {});

  const say = (id: string, text: string, append: boolean) => {
    if (id !== current) {
      base = streamed ? streamed + "\n\n" : "";
      current = id;
    }
    streamed = append ? streamed + text : base + text;
    last = streamed;
    smoother.push(streamed);
  };

  const ask = (ev: { id: number | string; method: string; params?: Record<string, unknown> }) => {
    const p = ev.params ?? {};
    const item = items.get(String(p.itemId ?? "")) ?? {};
    const common = { id: String(ev.id), rpcId: ev.id, engine: "codex" as const, description: typeof p.reason === "string" ? p.reason : undefined };
    if (ev.method === "item/commandExecution/requestApproval") {
      return onAsk?.({
        ...common,
        tool: "Bash",
        input: { command: codexCommand({ ...item, ...p }) },
        suggestions: [{ type: "addRules", decision: "acceptForSession" }],
      });
    }
    if (ev.method === "item/fileChange/requestApproval") {
      const changes = codexChanges(item);
      return onAsk?.({
        ...common,
        tool: changes.length === 1 && changes[0].kind === "add" ? "Write" : "Edit",
        input: { file_path: changes.map((c) => c.path).join("\n") || String(p.grantRoot ?? "files in this folder") },
        suggestions: [{ type: "setMode", decision: "acceptForSession" }],
      });
    }
    if (ev.method === "item/tool/requestUserInput" && Array.isArray(p.questions)) {
      const questions = (p.questions as { id: string; question: string; header?: string; options?: { label: string; description?: string }[] | null }[]).map((q) => ({
        id: q.id,
        question: q.question,
        header: q.header,
        options: q.options ?? [],
      }));
      return onAsk?.({ ...common, tool: "AskUserQuestion", input: {}, suggestions: [], questions });
    }
    reply({ id: ev.id, error: { code: -32601, message: "Alter does not support this request." } });
  };

  const channel = new Channel<string>();
  channel.onmessage = (line: string) => {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "alter_thread" && ev.thread_id) {
        thread = String(ev.thread_id);
        onThread?.(thread);
        return;
      }
      const p = (ev.params ?? {}) as Record<string, unknown>;
      if (ev.id !== undefined && typeof ev.method === "string") {
        if (onAsk) ask(ev);
        else reply({ id: ev.id, error: { code: -32601, message: "No one is available to approve this." } });
        return;
      }
      switch (ev.method) {
        case "serverRequest/resolved":
          onAsk?.(null, String(p.requestId));
          return;
        case "thread/tokenUsage/updated": {
          const u = (p.tokenUsage as { last?: { inputTokens?: number; outputTokens?: number } } | undefined)?.last;
          if (u) tokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
          return;
        }
        case "turn/plan/updated":
          if (Array.isArray(p.plan))
            onPlan?.(
              (p.plan as { step?: string; status?: string }[]).map((t) => ({
                text: String(t.step ?? ""),
                status: t.status === "completed" ? "done" : t.status === "inProgress" ? "in_progress" : "pending",
              }))
            );
          return;
        case "item/agentMessage/delta":
          if (typeof p.delta === "string") say(String(p.itemId ?? ""), p.delta, String(p.itemId ?? "") === current);
          return;
        case "item/started":
        case "item/completed": {
          const item = p.item as Record<string, unknown> | undefined;
          if (!item || typeof item !== "object") return;
          const id = String(item.id ?? "");
          if (id) items.set(id, item);
          if (item.type === "agentMessage") {
            if (ev.method === "item/completed" && typeof item.text === "string") say(id, item.text, false);
            return;
          }
          const atStart = item.type === "commandExecution" || item.type === "mcpToolCall" || item.type === "webSearch";
          if (atStart !== (ev.method === "item/started")) return;
          if (item.status === "declined") return;
          if (id && shown.has(id)) return;
          const label = codexLabel(item);
          if (!label) return;
          if (id) shown.add(id);
          if (streamed) onDelta(streamed);
          for (const l of label.split("\n")) onActivity(l);
          streamed = "";
          base = "";
          current = "";
          smoother.reset();
          return;
        }
      }
    } catch {
      /* ignore non-JSON lines */
    }
  };

  const onAbort = () => void invoke("cancel_chat", { id: convId }).catch(() => {});
  signal.addEventListener("abort", onAbort);
  try {
    await invoke("codex_chat", { prompt, images, cwd, convId, sessionId: threadId, model, effort, permissionMode, identity: ALTER_IDENTITY, onChunk: channel });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  await smoother.finish();
  return { content: streamed || last, threadId: thread, tokens };
}

export interface AgentRun {
  id: string;
  desc: string;
  type: string;
  status: "running" | "completed" | "failed" | "stopped";
  step?: string;
  tools?: number;
  summary?: string;
}

const agentStatus = (s: unknown): AgentRun["status"] =>
  s === "completed" ? "completed" : s === "failed" || s === "error" ? "failed" : s === "killed" || s === "stopped" || s === "cancelled" ? "stopped" : "running";

export interface AskQuestion {
  id?: string;
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}
export interface ToolAsk {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  description?: string;
  suggestions: Record<string, unknown>[];
  questions?: AskQuestion[];
  engine?: "codex";
  rpcId?: number | string;
}

const codexAnswer = (ask: ToolAsk, a: Record<string, unknown>): Record<string, unknown> => {
  if (ask.questions) {
    const given = ((a.updatedInput as { answers?: Record<string, string> } | undefined)?.answers ?? {}) as Record<string, string>;
    const answers: Record<string, { answers: string[] }> = {};
    for (const q of ask.questions) if (given[q.question]) answers[q.id ?? q.question] = { answers: [given[q.question]] };
    return { answers };
  }
  if (a.behavior !== "allow") return { decision: "decline" };
  const rule = (a.updatedPermissions as { decision?: unknown }[] | undefined)?.[0]?.decision;
  return { decision: rule ?? "accept" };
};

export function answerAsk(convId: string, ask: ToolAsk, response: Record<string, unknown>) {
  const message =
    ask.engine === "codex"
      ? { id: ask.rpcId, result: codexAnswer(ask, response) }
      : { type: "control_response", response: { subtype: "success", request_id: ask.id, response } };
  return invoke("agent_reply", { convId, message }).catch(() => {});
}

export async function claudeCodeChat(
  prompt: string,
  images: { mediaType: string; data: string }[],
  cwd: string | null,
  convId: string,
  sessionId: string | null,
  model: string | null,
  effort: string | null,
  permissionMode: string | null,
  onDelta: (text: string) => void,
  onActivity: (label: string) => void,
  signal: AbortSignal,
  onSession?: (sid: string) => void,
  onPr?: (url: string) => void,
  onAgents?: (agents: AgentRun[]) => void,
  onAsk?: (ask: ToolAsk | null, cancelledId?: string) => void
): Promise<{ content: string; sessionId: string | null; costUsd: number | null; tokens: number | null }> {
  let streamed = ""; // text of the current segment (reset at each tool boundary)
  let result = ""; // authoritative final answer from the result event
  let sid: string | null = sessionId;
  let costUsd: number | null = null;
  let tokens: number | null = null;
  let pending: { name: string; input: string } | null = null; // tool call being built
  // A PR the chat OPENED, not one it merely read about: only the output of a
  // `gh pr create` counts, so reviewing twenty PRs never fills the bar.
  let sawCreate = false;
  let interrupted = false;
  const smoother = makeSmoother(onDelta);
  const agents = new Map<string, AgentRun>();

  const channel = new Channel<string>();
  channel.onmessage = (line: string) => {
    try {
      const ev = JSON.parse(line);
      if (ev.session_id && ev.session_id !== sid) {
        sid = ev.session_id;
        onSession?.(sid!);
      }

      if (ev.type === "control_request" && ev.request?.subtype === "can_use_tool") {
        const r = ev.request;
        const input = r.input && typeof r.input === "object" ? r.input : {};
        const ask: ToolAsk = {
          id: String(ev.request_id),
          tool: String(r.tool_name ?? "tool"),
          input,
          description: typeof r.description === "string" ? r.description : undefined,
          suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
          questions: r.tool_name === "AskUserQuestion" && Array.isArray(input.questions) ? input.questions : undefined,
        };
        if (onAsk) onAsk(ask);
        else void answerAsk(convId, ask, { behavior: "deny", message: "No one is available to approve this." });
        return;
      }
      if (ev.type === "control_cancel_request") {
        onAsk?.(null, String(ev.request_id));
        return;
      }

      if (ev.type === "system" && typeof ev.subtype === "string" && ev.subtype.startsWith("task_") && ev.task_id) {
        const a: AgentRun = agents.get(ev.task_id) ?? { id: String(ev.task_id), desc: "", type: "", status: "running" };
        if (ev.subtype === "task_started") {
          a.desc = String(ev.description ?? a.desc);
          a.type = String(ev.subagent_type ?? "");
        } else if (ev.subtype === "task_progress") {
          a.step = String(ev.description ?? "").replace(/^Running\s+/, "");
          if (typeof ev.usage?.tool_uses === "number") a.tools = ev.usage.tool_uses;
        } else if (ev.subtype === "task_updated" && ev.patch?.status) {
          a.status = agentStatus(ev.patch.status);
        } else if (ev.subtype === "task_notification") {
          a.status = agentStatus(ev.status);
          if (typeof ev.summary === "string") a.summary = ev.summary;
          if (typeof ev.usage?.tool_uses === "number") a.tools = ev.usage.tool_uses;
        }
        agents.set(ev.task_id, a);
        onAgents?.([...agents.values()].map((x) => ({ ...x })));
        if (ev.subtype === "task_notification") {
          if (streamed) onDelta(streamed);
          onActivity(`Agent ${a.status === "completed" ? "finished" : a.status}: ${a.desc || a.type || "agent"}`);
          streamed = "";
          smoother.reset();
        }
        return;
      }
      if (ev.parent_tool_use_id) return;

      // Backend watchdog: a long silence is surfaced as a step, never as a kill —
      // a slow tool call (a big test run) can legitimately go quiet for minutes.
      if (ev.type === "alter_stalled") {
        onActivity(`Still working — no output for ${Math.round(Number(ev.idle_secs) || 0)}s (Stop if it's stuck)`);
        return;
      }

      // Soft interrupt: freeze what streamed so far as a step boundary; the
      // session keeps it, so the next message continues from here.
      if (ev.type === "alter_interrupted") {
        interrupted = true;
        if (streamed) onDelta(streamed);
        onActivity("Interrupted");
        streamed = "";
        smoother.reset();
        return;
      }

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
        const label = toolLabel(pending.name, parsed);
        if (/\bgh\b[^\n]*\bpr\s+create\b/.test(String(parsed.command ?? ""))) sawCreate = true;
        onActivity(label);
        pending = null;
        streamed = "";
        smoother.reset();
        return;
      }

      // What `gh pr create` printed: the URL of the PR that was just opened.
      if (ev.type === "user" && sawCreate && Array.isArray(ev.message?.content)) {
        for (const item of ev.message.content) {
          if (item?.type !== "tool_result") continue;
          const text =
            typeof item.content === "string"
              ? item.content
              : Array.isArray(item.content)
                ? item.content.map((c: { text?: string }) => c.text ?? "").join("\n")
                : "";
          const m = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
          if (m) {
            sawCreate = false;
            onPr?.(m[0]);
          }
        }
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
        if (typeof ev.total_cost_usd === "number") costUsd = ev.total_cost_usd;
        const u = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        if (u) tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
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
        if ((!streamed || denials.length) && !interrupted) {
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
    await invoke("claude_code", { prompt, images, cwd, convId, sessionId, model, effort, permissionMode, identity: ALTER_IDENTITY, onChunk: channel });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  await smoother.finish(); // let the last burst finish typing out
  return { content: streamed || result, sessionId: sid, costUsd, tokens };
}
