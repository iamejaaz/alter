(function () {
  const LS = window.__HARNESS_LS__ || {};
  const seed = String(JSON.stringify(LS).length) + ":" + String((window.__HARNESS_CHATS__ || []).length);
  if (localStorage.getItem("harness.seeded") !== seed) {
    localStorage.clear();
    for (const [k, v] of Object.entries(LS)) localStorage.setItem(k, v);
    localStorage.setItem("harness.seeded", seed);
  }
  const CHATS = JSON.stringify(window.__HARNESS_CHATS__ || []);
  const callbacks = new Map();
  let nextId = 1;
  const log = [];
  window.__HARNESS_LOG__ = log;
  const answers = {
    load_conversations: () => CHATS,
    save_conversations: () => null,
    app_version_info: () => ({ root: "/Users/frappe/projects/frappe/alter", head: "harness" }),
    update_status: () => ({ phase: "idle", text: "" }),
    update_now: () => "Checking for a new version.",
    list_claude_skills: () => [],
    claude_models: () => ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    claude_mcp_servers: () => [],
    peers_list: () => [],
    review_runs: (a) => {
      const runs = JSON.parse(localStorage.getItem("harness.reviews") || "[]");
      return a.name ? runs.find((r) => r.name === a.name) ?? null : runs;
    },
    review_shots: () => [],
    bridge_runs: () => [],
    bridge_info: () => ({ token: "mock-token", port: 8765 }),
    cli_status: (a) => ({ kind: a.kind, installed: true, path: "/usr/local/bin/" + a.kind, signedIn: true, version: "2.1.0", account: "user@example.com" }),
    agent_browser_status: () => ({ running: false, browser: "Chromium" }),
    fr_profiles: () => [],
    read_user_memory: () => "",
    take_routine_results: () => [],
    test_connection: () => "Connected · 1.2 s",
    codex_check: () => "Codex ready",
    pane_snapshot: () => {
      throw "not_running";
    },
    stream_chat: (a) => fakeModel(a),
    cancel_chat: (a) => {
      cancelled.add(a.id);
      return null;
    },
    run_command: (a) => `$ ${a.command}\nok (harness)`,
    read_file: (a) => `contents of ${a.path} (harness)`,
    list_dir: () => ["README.md", "src", "package.json"],
    list_tree: () => "src/\n  App.tsx\n  main.tsx",
    search_files: () => "src/App.tsx:12: example match",
    which_command: (a) => `/usr/local/bin/${a.name ?? "tool"}`,
    write_file: (a) => `wrote ${a.path}`,
    complete_once: (a) => (/\?\s*$/.test(String(a.prompt || "").trim()) ? "Yes, go ahead" : "NONE"),
  };

  // A scripted model for stream_chat. The last user message picks the scenario:
  // "demo stream", "demo plan", "demo ask", "demo risky", "demo tools", "demo offer", "demo error", "demo empty".
  const cancelled = new Set();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const chunk = (delta, finish) => "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish ?? null }] });
  const LONG = [
    "Here is a longer answer, streamed slowly so the running state can be checked.\n\n",
    "## What changed\n\n",
    "- The export button now saves to the folder you picked.\n",
    "- Long links like https://example.com/a/really/long/path/that/keeps/going/without/spaces wrap.\n\n",
    "```python\n",
    ...Array.from({ length: 30 }, (_, i) => `print("line ${i + 1}")\n`),
    "```\n\n",
    "| Step | Result |\n| --- | --- |\n| build | passed |\n| tests | passed |\n\n",
    "**Checked:** the build passes. **Not checked:** the mobile layout.",
  ];
  const toolCall = (name, args) => chunk({ tool_calls: [{ index: 0, id: "call_" + name + "_" + Date.now(), type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  const SCENARIOS = {
    plan: [
      { tool: ["update_plan", { items: [{ text: "Read the failing test", status: "done" }, { text: "Fix the date parser", status: "in_progress" }, { text: "Run the tests", status: "pending" }] }] },
      { tool: ["update_plan", { items: [{ text: "Read the failing test", status: "done" }, { text: "Fix the date parser", status: "done" }, { text: "Run the tests", status: "done" }] }] },
      { text: ["All three steps are done. The date parser now handles ISO weeks."] },
    ],
    ask: [{ tool: ["ask_user", { question: "Which branch should I base the fix on?", options: ["develop", "version-16-hotfix", "version-15-hotfix"] }] }, { text: ["Got it, using that branch."] }],
    risky: [{ tool: ["run_command", { command: "rm -rf build && git push --force origin main" }] }, { text: ["Done."] }],
    tools: [
      { tool: ["list_dir", { path: "." }] },
      { tool: ["read_file", { path: "README.md" }] },
      { tool: ["search_files", { pattern: "export", path: "src" }] },
      { tool: ["run_command", { command: "npm test" }] },
      { text: ["I listed the folder, read the README, searched for exports and ran the tests. Everything passes."] },
    ],
    stream: [{ text: LONG, delay: 180 }],
    offer: [{ text: ["The login redirect is fixed. I can also add a test for it. Should I add it?"] }],
    error: "error",
    empty: [{ text: [] }],
  };
  async function fakeModel(a) {
    const body = JSON.parse(a.body || "{}");
    const msgs = body.messages || [];
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const said = typeof lastUser?.content === "string" ? lastUser.content : (lastUser?.content || []).map((c) => c.text || "").join(" ");
    const key = (said.match(/demo (\w+)/i) || [])[1]?.toLowerCase();
    const script = SCENARIOS[key] ?? [{ text: ["This is the UI harness. Type demo stream, demo plan, demo ask, demo risky, demo tools, demo error or demo empty to see a scenario."] }];
    if (script === "error") {
      await sleep(600);
      throw "HTTP 502 — " + JSON.stringify({ error: { message: "upstream unavailable", type: "api_error" } });
    }
    const since = msgs.length - 1 - [...msgs].reverse().findIndex((m) => m.role === "user");
    const step = msgs.slice(since).filter((m) => m.role === "tool").length;
    const at = script[Math.min(step, script.length - 1)];
    const ch = callbacks.get(a.onChunk?.id);
    let index = 0;
    const send = (line) => ch && ch({ message: line, index: index++ });
    cancelled.delete(a.id);
    await sleep(400);
    if (at.tool) {
      send(toolCall(at.tool[0], at.tool[1]));
      send(chunk({}, "tool_calls"));
    } else {
      for (const piece of at.text) {
        if (cancelled.has(a.id)) break;
        send(chunk({ content: piece }));
        await sleep(at.delay ?? 60);
      }
      send(chunk({}, "stop"));
    }
    send("data: [DONE]");
    return null;
  }
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb, once) {
      const id = nextId++;
      callbacks.set(id, cb);
      window["_" + id] = cb;
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc(p) {
      return p;
    },
    async invoke(cmd, args) {
      log.push(cmd);
      if (cmd.startsWith("plugin:event|listen")) return nextId++;
      if (cmd.startsWith("plugin:")) return null;
      const f = answers[cmd];
      if (!f) return null;
      return f(args || {});
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
})();
