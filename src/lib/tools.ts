import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List entries of a directory on the user's computer. Directory names end with a slash.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute directory path" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tree",
      description:
        "Show a recursive tree of a directory (skips hidden files, node_modules, target). Use to understand a project's layout.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute directory path" },
          depth: { type: "number", description: "How many levels deep (default 3)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Search all text files under a directory for a string (case-insensitive) and return matching file:line: results. Like grep.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute directory to search" },
          query: { type: "string", description: "Text to search for" },
        },
        required: ["path", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web and return the top result titles and URLs. Use to find pages, then fetch_url to read them.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch a web page by URL and return its readable text. Use to read articles, docs, or search results.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Full http(s) URL" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the user's computer by absolute path.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute file path" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write a text file on the user's computer. Creates parent directories and overwrites existing content. The user is asked to approve before anything is written.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
];

export async function pickFolder(): Promise<string | null> {
  const result = await open({ directory: true, multiple: false });
  return typeof result === "string" ? result : null;
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === "write_file") {
    const ok = window.confirm(`Alter wants to write to:\n${args.path}\n\nAllow?`);
    if (!ok) return "User denied the write.";
  }
  try {
    const result = await invoke(name, args);
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (e) {
    return `Error: ${String(e)}`;
  }
}

export function describeToolCall(name: string, argsJson: string): string {
  try {
    const args = JSON.parse(argsJson) as { path?: string; query?: string; url?: string };
    if (args.query) return `${name}("${args.query}")`;
    if (args.url) return `${name}(${args.url})`;
    return `${name}(${args.path ?? ""})`;
  } catch {
    return name;
  }
}
