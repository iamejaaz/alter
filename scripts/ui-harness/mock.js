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
    review_runs: () => [],
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
  };
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
