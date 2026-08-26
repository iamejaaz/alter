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
      name: "browser_open",
      description:
        "Open a URL in a real automated browser and return the page's title, URL, and readable text. Use for pages that need JavaScript or interaction (fetch_url is lighter for static pages). First use may download a browser engine.",
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
      name: "browser_click",
      description: "Click a link or button in the open browser by its visible text, then return the resulting page text.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Visible text of the link or button" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_type",
      description: "Type text into an input in the open browser, identified by a CSS selector (e.g. input[name=q]).",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector for the input" },
          text: { type: "string", description: "Text to type" },
        },
        required: ["selector", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "which_command",
      description:
        "Check whether a command-line tool is installed by locating its executable across the whole PATH and common bin directories. Use this to answer 'is X installed' / 'do I have X' — do not guess by listing a few folders.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Plain command name, e.g. 'git' or 'frappectl'" } },
        required: ["name"],
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

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  mode: "auto" | "ask" | "plan" | "chat" = "auto"
): Promise<string> {
  if (mode === "ask" && name !== "write_file") {
    const ok = window.confirm(`Alter wants to run ${name}:\n${JSON.stringify(args, null, 2)}\n\nAllow?`);
    if (!ok) return "User denied this action.";
  }
  if (name === "write_file") {
    const path = String(args.path ?? "");
    const next = String(args.content ?? "");
    let existing: string | null = null;
    try {
      existing = await invoke<string>("read_file", { path });
    } catch {
      existing = null;
    }
    const summary =
      existing === null
        ? `Create new file (${next.split("\n").length} lines).`
        : `Overwrite existing file: ${existing.split("\n").length} → ${next.split("\n").length} lines.`;
    const preview = next.split("\n").slice(0, 12).join("\n");
    const ok = window.confirm(`Alter wants to write:\n${path}\n\n${summary}\n\nPreview:\n${preview}\n\nAllow?`);
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
