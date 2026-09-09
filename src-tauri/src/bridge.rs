// Local HTTP bridge: lets a browser extension (or any local tool) run the
// user's configured models without holding any keys. Alter stays the brain —
// connections live here, resolved per-request by connectionId.

use std::io::Read;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

pub const BRIDGE_PORT: u16 = 8765;

#[derive(Clone, serde::Deserialize)]
pub struct BridgeConn {
    pub id: String,
    pub name: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    pub model: String,
}

impl BridgeConn {
    fn is_claude_code(&self) -> bool {
        self.base_url.starts_with("claude-code")
    }
}

#[derive(Default)]
pub struct BridgeState {
    pub conns: Mutex<Vec<BridgeConn>>,
    pub token: Mutex<String>,
    // runId -> pid of the live `claude` process, so a Stop can kill it (and its
    // tool subprocesses) instead of leaving it running after the panel closes.
    pub running: Arc<Mutex<std::collections::HashMap<String, u32>>>,
    // runId -> live agent progress the panel polls for (steps + final answer),
    // so the extension gets Claude-Code-style activity without needing the
    // service worker to consume a stream (which MV3 buffers).
    pub progress: Arc<Mutex<std::collections::HashMap<String, AgentProgress>>>,
    // Folder of per-version repro benches (Alter → Settings → Repro benches),
    // exposed to agents as ALTER_REPRO_ROOT so they can reproduce a bug.
    pub repro_root: Mutex<String>,
    // Shell `export …` lines for the repro env vars, prepended to the fr-assistant
    // Terminal launch (a fresh login shell that doesn't inherit the app env).
    pub repro_env: Mutex<String>,
}

#[derive(Default, Clone, serde::Serialize)]
pub struct AgentProgress {
    steps: Vec<String>,
    text: String,
    done: bool,
    error: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

#[derive(serde::Serialize)]
struct ConnInfo {
    id: String,
    name: String,
    #[serde(rename = "isClaudeCode")]
    is_claude_code: bool,
}

#[derive(serde::Deserialize)]
struct RunReq {
    #[serde(rename = "connectionId")]
    connection_id: String,
    system: Option<String>,
    prompt: String,
    #[serde(rename = "includeMemory", default)]
    include_memory: bool,
    // Read-only agent mode: Claude Code runs with a fixed read-only tool
    // allowlist (see AGENT_ALLOWED_TOOLS) in the server-configured workdir. No
    // write tools, no arbitrary shell, no permission bypass.
    #[serde(default)]
    agent: bool,
    // Optional per-request model override (e.g. force Sonnet to conserve limits).
    #[serde(default)]
    model: Option<String>,
    // Client-supplied id so a Stop can target this exact run.
    #[serde(rename = "runId", default)]
    run_id: Option<String>,
    // Agent tool profile: "pr" = bounded write allowlist for creating a PR;
    // anything else = the read-only support/review allowlist.
    #[serde(default)]
    mode: Option<String>,
}

// fr read subcommands the agent may run WITHOUT asking, and the write ones that
// are hard-denied. Claude Code matches Bash rules by literal prefix, so a global
// flag like `-s <profile>` injected before the subcommand (fr -s x doc get …)
// won't match `Bash(fr doc get:*)` — we emit each verb in the bare form and the
// site-flag forms the agent actually uses so reads never stall on approval.
const FR_READ_VERBS: &[&str] = &[
    "query", "guide", "doc get", "doc list", "doctype", "report run",
    "method search", "method list", "method show", "file download", "auth whoami", "auth list",
];
const FR_WRITE_VERBS: &[&str] = &[
    "doc create", "doc update", "doc delete", "doc submit", "doc cancel", "doc amend",
    "method call", "api", "file upload", "update", "assistant", "auth login", "auth logout",
    "auth default", "auth configure",
];
// The helpdesk site the support agent works against: Alter → Settings → Frappe
// credentials (exported as FRAPPE_SITE), falling back to support.frappe.io.
fn agent_site() -> String {
    let raw = std::env::var("FRAPPE_SITE").unwrap_or_default();
    let host = raw.trim().trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/');
    if host.is_empty() { "support.frappe.io".to_string() } else { host.to_string() }
}

fn fr_rules(verbs: &[&str]) -> Vec<String> {
    let site = agent_site();
    verbs
        .iter()
        .flat_map(|v| {
            [
                format!("Bash(fr {v}:*)"),
                format!("Bash(fr -s {site} {v}:*)"),
                format!("Bash(fr --site {site} {v}:*)"),
            ]
        })
        .collect()
}

fn agent_allowed_tools() -> String {
    let mut t: Vec<String> = ["Read", "Grep", "Glob", "WebFetch", "Skill"].iter().map(|s| s.to_string()).collect();
    for d in ["//private/tmp/**", "//tmp/**", "//private/var/folders/**", "//var/folders/**"] {
        t.push(format!("Write({d})"));
    }
    t.extend(fr_rules(FR_READ_VERBS));
    // `git -C <app> show …` is how the agent reads app repos (the bench root isn't
    // one), and a global flag before the subcommand can't match a `git show`
    // prefix rule — so allow git broadly and keep it read-only via the skill's
    // rules. The real boundary (no site mutation) is fr/network, gated separately.
    t.push("Bash(git:*)".to_string());
    for g in ["gh pr view", "gh pr list", "gh issue view", "gh issue list", "gh search"] {
        t.push(format!("Bash({g}:*)"));
    }
    // The ONE bench-exec hole: the repro helper, by its installed absolute path.
    // It runs a repro script on a LOCAL disposable bench (rollback, no residue) —
    // the only way a read-only triage run can actually confirm a bug. Live-site
    // writes stay blocked (fr writes are disallowed separately); this reaches the
    // user's throwaway benches only. Scoped to this exact command, nothing else.
    let rel = ".claude/skills/frappe-support-diagnosis/scripts/repro.sh";
    t.push(format!("Bash(~/{rel}:*)"));
    // The read-only context bundle (ticket + thread + apps), same skill folder.
    let ctx = ".claude/skills/frappe-support-diagnosis/scripts/context.py";
    t.push(format!("Bash(~/{ctx}:*)"));
    t.push(format!("Bash(python3 ~/{ctx}:*)"));
    if let Some(home) = std::env::var_os("HOME") {
        let abs = std::path::Path::new(&home).join(rel);
        t.push(format!("Bash({}:*)", abs.display()));
        let abs_ctx = std::path::Path::new(&home).join(ctx);
        t.push(format!("Bash({}:*)", abs_ctx.display()));
        t.push(format!("Bash(python3 {}:*)", abs_ctx.display()));
    }
    t.join(" ")
}

// `git:*` is allowed broadly (see above), so deny every subcommand that writes,
// pushes, or can execute code (`git -c alias…`, `git config`). Deny rules win.
fn git_write_denies() -> Vec<String> {
    [
        "git push", "git config", "git -c", "git reset", "git checkout", "git switch", "git clean",
        "git rebase", "git commit", "git merge", "git stash", "git branch -D", "git branch -d",
        "git branch -m", "git tag -d", "git remote", "git filter-branch", "git gc", "git worktree",
        "git am", "git apply", "git cherry-pick", "git revert", "git restore", "git rm", "git mv",
        "git add", "git submodule", "git update-ref", "git reflog expire", "git prune",
    ]
    .iter()
    .map(|g| format!("Bash({g}:*)"))
    .collect()
}

fn agent_disallowed_tools() -> String {
    let mut t = fr_rules(FR_WRITE_VERBS);
    t.extend(git_write_denies());
    t.join(" ")
}

// Allowlist for VERIFYING a PR on a throwaway repro bench: fetch + checkout the
// PR branch, run bench (migrate / tests / console), inspect with git/gh. No
// `git push` — verification only. Runs against a repro bench, not the user's work.
fn verify_allowed_tools() -> String {
    let mut t: Vec<String> = ["Read", "Grep", "Glob", "WebFetch"].iter().map(|s| s.to_string()).collect();
    t.push("Bash(git:*)".to_string());
    t.push("Bash(bench:*)".to_string());
    for g in ["gh pr view", "gh pr diff", "gh pr checkout", "gh pr checks", "gh pr list", "gh issue view"] {
        t.push(format!("Bash({g}:*)"));
    }
    t.join(" ")
}

// Bounded write allowlist for PREPARING a diagnosed fix: edit files, branch,
// commit — and STOP. Deliberately NO `git push` and NO `gh pr create`: the fix
// lands on a local branch for the user to review; pushing/opening the PR is a
// separate, explicit step (pr_push_allowed_tools). No bypassPermissions, no rm.
fn pr_allowed_tools() -> String {
    let mut t: Vec<String> = ["Read", "Grep", "Glob", "Edit", "Write", "WebFetch"].iter().map(|s| s.to_string()).collect();
    for g in [
        "git fetch", "git status", "git diff", "git log", "git show", "git branch",
        "git checkout", "git switch", "git add", "git commit", "git restore",
    ] {
        t.push(format!("Bash({g}:*)"));
    }
    t.join(" ")
}

// The explicit second step: push the already-prepared local branch to the fork
// and open the PR. Only the push + gh-pr verbs plus reads to compose the PR.
fn pr_push_allowed_tools() -> String {
    let mut t: Vec<String> = ["Read", "Grep", "Glob"].iter().map(|s| s.to_string()).collect();
    for g in [
        "git status", "git diff", "git log", "git show", "git branch", "git push",
        "gh pr create", "gh pr view", "gh pr list", "gh repo view",
    ] {
        t.push(format!("Bash({g}:*)"));
    }
    t.join(" ")
}

// Where browser-triggered agents run: Alter → Settings → Agent working folder
// (exported as ALTER_AGENT_WORKDIR), else the home directory.
fn agent_workdir() -> String {
    std::env::var("ALTER_AGENT_WORKDIR")
        .ok()
        .filter(|d| !d.is_empty())
        .or_else(|| std::env::var("ALTER_REPRO_DEVELOP").ok().filter(|d| !d.is_empty()))
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_default()
}

fn without_section(md: &str, heading: &str) -> String {
    let mut out = String::new();
    let mut skipping = false;
    for line in md.lines() {
        if line.starts_with("## ") {
            skipping = line.starts_with(heading);
        }
        if !skipping {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn shared_memory() -> String {
    std::env::var("HOME")
        .ok()
        .and_then(|home| std::fs::read_to_string(std::path::Path::new(&home).join(".claude/CLAUDE.md")).ok())
        .map(|s| s.chars().take(8000).collect())
        .unwrap_or_default()
}

// Fold in the user's ~/.claude/CLAUDE.md so models get the same standing
// preferences Claude Code already loads on its own.
fn build_system(include_memory: bool, system: Option<&str>) -> String {
    let base = system.unwrap_or("");
    if !include_memory {
        return base.to_string();
    }
    let mem = shared_memory();
    if mem.is_empty() {
        base.to_string()
    } else {
        format!("User's standing preferences (from ~/.claude/CLAUDE.md — authoritative):\n{mem}\n\n{base}")
    }
}

fn push_step(progress: &Mutex<std::collections::HashMap<String, AgentProgress>>, rid: &str, s: String) {
    if let Some(p) = progress.lock().unwrap_or_else(|e| e.into_inner()).get_mut(rid) {
        if !p.done {
            p.steps.push(s);
        }
    }
}

fn finish_progress(
    progress: &Mutex<std::collections::HashMap<String, AgentProgress>>,
    rid: &str,
    text: Option<String>,
    err: Option<String>,
) {
    let mut map = progress.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = map.get_mut(rid) {
        if p.done {
            return;
        }
        if let Some(t) = text {
            // The final answer is usually the last narration step too — drop the dup.
            if p.steps.last().map(|s| s.as_str()) == Some(t.as_str()) {
                p.steps.pop();
            }
            p.text = t;
        }
        if let Some(e) = err {
            p.error = Some(e);
        }
        p.done = true;
    }
}

// Spawn a Claude Code agent run in the background, parsing its stream-json into a
// per-run progress record the panel polls. Reads run auto (allowlist); the run
// lives in its own process group so Stop can kill it.
fn spawn_agent_run(
    mut conn: BridgeConn,
    system: String,
    prompt: String,
    run_id: String,
    mode: Option<String>,
    repro_root: String,
    running: Arc<Mutex<std::collections::HashMap<String, u32>>>,
    progress: Arc<Mutex<std::collections::HashMap<String, AgentProgress>>>,
    max_turns: Option<u32>,
    resume: Option<String>,
) {
    let is_pr = mode.as_deref() == Some("pr");
    let is_pr_push = mode.as_deref() == Some("pr-push");
    let is_verify = mode.as_deref() == Some("verify");
    progress.lock().unwrap_or_else(|e| e.into_inner()).insert(run_id.clone(), AgentProgress::default());
    let full = if system.is_empty() { prompt } else { format!("{system}\n\n{prompt}") };
    let mut cmd = std::process::Command::new("claude");
    cmd.arg("-p")
        .arg(&full)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose");
    if !conn.model.is_empty() && conn.model != "claude-code" {
        cmd.arg("--model").arg(std::mem::take(&mut conn.model));
    }
    let dir = agent_workdir();
    if !dir.is_empty() && std::path::Path::new(&dir).is_dir() {
        cmd.current_dir(&dir);
    }
    if let Some(sid) = resume.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--resume").arg(sid);
    }
    if is_pr {
        cmd.arg("--allowedTools").arg(pr_allowed_tools());
    } else if is_pr_push {
        cmd.arg("--allowedTools").arg(pr_push_allowed_tools());
    } else if is_verify {
        cmd.arg("--allowedTools").arg(verify_allowed_tools());
    } else {
        cmd.arg("--allowedTools").arg(agent_allowed_tools());
        cmd.arg("--disallowedTools").arg(agent_disallowed_tools());
    }
    cmd.arg("--permission-mode").arg("default");
    // Safety net only: the prompt's tool budget is the real limit. A run that
    // hits this ends with what it has instead of looping.
    if let Some(n) = max_turns {
        cmd.arg("--max-turns").arg(n.to_string());
    }
    if !repro_root.is_empty() {
        cmd.env("ALTER_REPRO_ROOT", &repro_root);
    }
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    std::thread::spawn(move || {
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                finish_progress(&progress, &run_id, None, Some(format!("can't run claude: {e}")));
                return;
            }
        };
        running.lock().unwrap_or_else(|e| e.into_inner()).insert(run_id.clone(), child.id());
        // Drain stderr on its own thread so a full pipe can't deadlock stdout.
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        if let Some(mut err) = child.stderr.take() {
            let sb = stderr_buf.clone();
            std::thread::spawn(move || {
                let mut s = String::new();
                let _ = err.read_to_string(&mut s);
                *sb.lock().unwrap_or_else(|e| e.into_inner()) = s;
            });
        }
        let mut final_text = String::new();
        if let Some(out) = child.stdout.take() {
            use std::io::BufRead;
            for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                let v: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(sid) = v["session_id"].as_str() {
                    let mut map = progress.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(p) = map.get_mut(&run_id) {
                        if p.session_id.is_none() {
                            p.session_id = Some(sid.to_string());
                        }
                    }
                }
                match v["type"].as_str().unwrap_or("") {
                    "assistant" => {
                        if let Some(content) = v["message"]["content"].as_array() {
                            for item in content {
                                match item["type"].as_str().unwrap_or("") {
                                    "text" => {
                                        let txt = item["text"].as_str().unwrap_or("");
                                        if !txt.trim().is_empty() {
                                            push_step(&progress, &run_id, txt.trim().to_string());
                                            final_text = txt.to_string();
                                        }
                                    }
                                    "tool_use" => {
                                        let label = tool_label(item["name"].as_str().unwrap_or("tool"), &item["input"]);
                                        push_step(&progress, &run_id, format!("\u{25B8} {label}"));
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                    "result" => {
                        let is_err = v["is_error"].as_bool().unwrap_or(false);
                        let r = v["result"].as_str().unwrap_or("").to_string();
                        if is_err {
                            let msg = if r.is_empty() { "the agent hit an error".to_string() } else { r };
                            finish_progress(&progress, &run_id, None, Some(msg));
                        } else {
                            finish_progress(&progress, &run_id, Some(r), None);
                        }
                    }
                    _ => {}
                }
            }
        }
        let _ = child.wait();
        running.lock().unwrap_or_else(|e| e.into_inner()).remove(&run_id);
        // No result event (killed, crashed, limit): close out sensibly.
        let mut map = progress.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = map.get_mut(&run_id) {
            if !p.done {
                let err = stderr_buf.lock().unwrap_or_else(|e| e.into_inner()).clone();
                if !final_text.trim().is_empty() {
                    if p.steps.last().map(|s| s.as_str()) == Some(final_text.trim()) {
                        p.steps.pop();
                    }
                    p.text = final_text.trim().to_string();
                } else if !err.trim().is_empty() {
                    p.error = Some(err.trim().to_string());
                } else {
                    p.error = Some("The agent stopped without an answer (it may have been stopped or hit the session limit).".to_string());
                }
                p.done = true;
            }
        }
    });
}

#[tauri::command]
pub fn bridge_info(state: State<BridgeState>) -> serde_json::Value {
    serde_json::json!({ "port": BRIDGE_PORT, "token": *state.token.lock().unwrap_or_else(|e| e.into_inner()) })
}

#[tauri::command]
pub fn bridge_sync(state: State<BridgeState>, connections: Vec<BridgeConn>) {
    *state.conns.lock().unwrap_or_else(|e| e.into_inner()) = connections;
}

#[tauri::command]
pub fn bridge_set_repro_root(
    state: State<BridgeState>,
    root: String,
    benches: std::collections::HashMap<String, String>,
    #[allow(non_snake_case)] mariadbPassword: String,
    #[allow(non_snake_case)] frappeSite: String,
    #[allow(non_snake_case)] frappeApiKey: String,
    #[allow(non_snake_case)] frappeApiSecret: String,
    #[allow(non_snake_case)] agentWorkdir: String,
) {
    // Set every repro var on the whole process env so in-process spawns (Alter
    // chat's claude_code, the bridge's agents) inherit them for free. The
    // fr-assistant Terminal launch (a fresh login shell) exports them from the
    // `repro_env` string below.
    let mut exports = String::new();
    let mut set = |k: &str, v: &str| {
        if !v.is_empty() {
            std::env::set_var(k, v);
            exports.push_str(&format!("export {}='{}'\n", k, v.replace('\'', "'\\''")));
        }
    };
    set("ALTER_REPRO_ROOT", &root);
    for (ver, path) in &benches {
        let key = format!("ALTER_REPRO_{}", ver.to_uppercase().replace('-', "_"));
        set(&key, path);
    }
    set("MYSQL_ROOT_PASSWORD", &mariadbPassword);
    set("FRAPPE_SITE", &frappeSite);
    set("FRAPPE_API_KEY", &frappeApiKey);
    set("FRAPPE_API_SECRET", &frappeApiSecret);
    if agentWorkdir.trim().is_empty() {
        std::env::remove_var("ALTER_AGENT_WORKDIR");
    } else {
        set("ALTER_AGENT_WORKDIR", agentWorkdir.trim());
    }
    *state.repro_root.lock().unwrap_or_else(|e| e.into_inner()) = root;
    *state.repro_env.lock().unwrap_or_else(|e| e.into_inner()) = exports;
}

// Reasoning models (e.g. laguna) wrap their thinking in <think>…</think>; the
// answer is whatever follows the final closing tag.
fn strip_think(s: &str) -> String {
    let tail = match s.rfind("</think>") {
        Some(i) => &s[i + "</think>".len()..],
        None => s,
    };
    tail.replace("<think>", "").trim().to_string()
}

fn gen_token() -> String {
    let mut buf = [0u8; 16];
    let ok = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .is_ok();
    if !ok || buf.iter().all(|b| *b == 0) {
        // Fallback entropy: std's RandomState is seeded from the OS per instance.
        use std::hash::{BuildHasher, Hasher};
        for chunk in buf.chunks_mut(8) {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u128(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0),
            );
            h.write_u32(std::process::id());
            let bytes = h.finish().to_le_bytes();
            chunk.copy_from_slice(&bytes[..chunk.len()]);
        }
    }
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

// Resolve a connection to a completion. HTTP → OpenAI-compatible call; Claude
// Code → one-shot `claude -p` (headless), so the extension gets your local
// subscription with no key.
async fn run_completion(
    conn: &BridgeConn,
    system: Option<&str>,
    prompt: &str,
    agent: bool,
    reg: Option<(&Mutex<std::collections::HashMap<String, u32>>, &str)>,
) -> Result<String, String> {
    if conn.is_claude_code() {
        let full = match system {
            Some(s) if !s.is_empty() => format!("{s}\n\n{prompt}"),
            _ => prompt.to_string(),
        };
        let mut cmd = std::process::Command::new("claude");
        cmd.arg("-p").arg(&full);
        if !conn.model.is_empty() && conn.model != "claude-code" {
            cmd.arg("--model").arg(&conn.model);
        }
        if agent {
            let dir = agent_workdir();
            if !dir.is_empty() && std::path::Path::new(&dir).is_dir() {
                cmd.current_dir(&dir);
            }
            cmd.arg("--allowedTools").arg(agent_allowed_tools());
            cmd.arg("--disallowedTools").arg(agent_disallowed_tools());
            cmd.arg("--permission-mode").arg("default");
        }
        // Spawn in its own process group so Stop can signal the whole tree
        // (claude + any tool subprocess), and register the pid for /cancel.
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let child = cmd.spawn().map_err(|e| e.to_string())?;
        if let Some((map, id)) = reg {
            map.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), child.id());
        }
        let waited = child.wait_with_output();
        if let Some((map, id)) = reg {
            map.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        }
        let out = waited.map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            // Claude prints limit/auth errors to stdout on some failures, so fall
            // back to stdout when stderr is empty — otherwise the caller only sees
            // a bare non-zero exit ("Bridge error 502").
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Err(if err.is_empty() { stdout } else { err })
        }
    } else {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?;
        let base = conn.base_url.trim_end_matches('/');
        let mut messages = Vec::new();
        if let Some(s) = system {
            if !s.is_empty() {
                messages.push(serde_json::json!({ "role": "system", "content": s }));
            }
        }
        messages.push(serde_json::json!({ "role": "user", "content": prompt }));
        let body = serde_json::json!({ "model": conn.model, "messages": messages, "max_tokens": 4000, "stream": false });
        let resp = client
            .post(format!("{}/chat/completions", base))
            .bearer_auth(&conn.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let text = resp.text().await.unwrap_or_default();
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        if let Some(c) = v["choices"][0]["message"]["content"].as_str() {
            Ok(c.trim().to_string())
        } else {
            Err(v["error"]["message"].as_str().unwrap_or("no response").to_string())
        }
    }
}

fn json_response(status: u16, body: String) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let mut r = tiny_http::Response::from_string(body).with_status_code(status);
    for (k, v) in [
        ("Content-Type", "application/json"),
    ] {
        if let Ok(h) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
            r.add_header(h);
        }
    }
    r
}

pub fn start(app: AppHandle) {
    // Load or mint the pairing token, persisted in the app data dir.
    let token = (|| {
        let dir = app.path().app_data_dir().ok()?;
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("bridge.token");
        if let Ok(t) = std::fs::read_to_string(&path) {
            let t = t.trim().to_string();
            if !t.is_empty() {
                return Some(t);
            }
        }
        let t = gen_token();
        let _ = std::fs::write(&path, &t);
        Some(t)
    })()
    .unwrap_or_else(gen_token);

    if let Some(state) = app.try_state::<BridgeState>() {
        *state.token.lock().unwrap_or_else(|e| e.into_inner()) = token.clone();
    }

    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", BRIDGE_PORT)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("bridge: failed to bind 127.0.0.1:{BRIDGE_PORT}: {e}");
                return;
            }
        };
        // One thread per request: a long streaming response must not block the
        // rest (posting, follow-ups, /connections) while it runs.
        for req in server.incoming_requests() {
            let app = app.clone();
            std::thread::spawn(move || serve(req, app));
        }
    });
}

fn serve(mut req: tiny_http::Request, app: AppHandle) {
    let method = req.method().clone();
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();

    if method == tiny_http::Method::Options {
        let _ = req.respond(cors_empty(204));
        return;
    }

    let auth = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .map(|h| h.value.as_str().to_string())
        .unwrap_or_default();
    let expected = app
        .try_state::<BridgeState>()
        .map(|s| s.token.lock().unwrap_or_else(|e| e.into_inner()).clone())
        .unwrap_or_default();
    if expected.is_empty() || auth != format!("Bearer {expected}") {
        let _ = req.respond(json_response(401, "{\"error\":\"unauthorized\"}".into()));
        return;
    }

    let body = if method == tiny_http::Method::Get {
        String::new()
    } else {
        let mut b = String::new();
        let _ = req.as_reader().read_to_string(&mut b);
        b
    };

    let response = handle(&app, &method, &path, &body);
    let _ = req.respond(json_response(response.0, response.1));
}

fn tool_label(name: &str, input: &serde_json::Value) -> String {
    let arg = input["command"]
        .as_str()
        .or_else(|| input["file_path"].as_str())
        .or_else(|| input["pattern"].as_str())
        .or_else(|| input["url"].as_str())
        .or_else(|| input["query"].as_str())
        .unwrap_or("");
    let arg: String = arg.chars().take(80).collect();
    if arg.is_empty() {
        name.to_string()
    } else {
        format!("{name}: {arg}")
    }
}

fn cors_empty(status: u16) -> tiny_http::Response<std::io::Empty> {
    tiny_http::Response::empty(status)
}

// ---- Support prompts live in the skill (prompts.json); the bridge renders them
// so every surface (helpdesk panel, Alter chat, terminal) uses the same text.
fn skill_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join(".claude/skills/frappe-support-diagnosis"))
}

fn load_prompts() -> Result<serde_json::Value, String> {
    let p = skill_dir().ok_or("no HOME")?.join("prompts.json");
    let raw = std::fs::read_to_string(&p).map_err(|_| "prompts.json not installed — install the support skill".to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("prompts.json invalid: {e}"))
}

fn join_lines(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Array(a) => a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" "),
        serde_json::Value::String(s) => s.clone(),
        _ => String::new(),
    }
}

fn fill(t: &str, vars: &[(&str, &str)]) -> String {
    let mut out = t.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("{{{k}}}"), v);
    }
    out
}

// context.py output, cached briefly so the panel card and the agent start
// share one run instead of hitting the helpdesk twice.
static CTX_CACHE: std::sync::OnceLock<Mutex<std::collections::HashMap<String, (std::time::Instant, String)>>> = std::sync::OnceLock::new();
const CTX_TTL_SECS: u64 = 600;

fn ticket_context(ticket: &str) -> Result<String, String> {
    let cache = CTX_CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    if let Some((at, json)) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(ticket) {
        if at.elapsed().as_secs() < CTX_TTL_SECS {
            return Ok(json.clone());
        }
    }
    let script = skill_dir().ok_or("no HOME")?.join("scripts/context.py");
    if !script.is_file() {
        return Err("context script not installed".into());
    }
    let out = std::process::Command::new("python3")
        .arg(&script)
        .arg(ticket)
        .arg("--json")
        .current_dir(agent_workdir())
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stdout).chars().take(300).collect());
    }
    let json = String::from_utf8_lossy(&out.stdout).to_string();
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(ticket.to_string(), (std::time::Instant::now(), json.clone()));
    Ok(json)
}

fn handle(app: &AppHandle, method: &tiny_http::Method, path: &str, body: &str) -> (u16, String) {
    let state = match app.try_state::<BridgeState>() {
        Some(s) => s,
        None => return (500, "{\"error\":\"no state\"}".into()),
    };

    match (method, path) {
        (tiny_http::Method::Get, "/connections") => {
            let list: Vec<ConnInfo> = state
                .conns
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .map(|c| ConnInfo {
                    id: c.id.clone(),
                    name: if c.is_claude_code() { "Claude Code".into() } else { c.name.clone() },
                    is_claude_code: c.is_claude_code(),
                })
                .collect();
            (200, serde_json::to_string(&list).unwrap_or_else(|_| "[]".into()))
        }
        (tiny_http::Method::Get, "/repro-info") => {
            // Which repro benches are configured (so the extension can gate the
            // Verify-on-bench action). Read the same env the agents get.
            let mut versions: Vec<String> = Vec::new();
            for v in ["develop", "version-16", "version-15"] {
                let key = format!("ALTER_REPRO_{}", v.to_uppercase().replace('-', "_"));
                if std::env::var(&key).map(|s| !s.is_empty()).unwrap_or(false) {
                    versions.push(v.to_string());
                }
            }
            let has_root = std::env::var("ALTER_REPRO_ROOT").map(|s| !s.is_empty()).unwrap_or(false);
            let configured = has_root || !versions.is_empty();
            (200, serde_json::json!({ "configured": configured, "versions": versions }).to_string())
        }
        (tiny_http::Method::Post, "/ticket-context") => {
            #[derive(serde::Deserialize)]
            struct C {
                ticket: String,
            }
            let req: C = match serde_json::from_str(body) {
                Ok(r) => r,
                Err(e) => return (400, format!("{{\"error\":\"bad request: {e}\"}}")),
            };
            let ticket = req.ticket.trim().to_string();
            if ticket.is_empty() || !ticket.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return (400, "{\"error\":\"bad ticket id\"}".into());
            }
            match ticket_context(&ticket) {
                Ok(json) => (200, json),
                Err(e) => (500, serde_json::json!({ "error": e }).to_string()),
            }
        }
        (tiny_http::Method::Post, "/support") => {
            // Thin surface API: {ticket, verb, connectionId, ...}. The bridge renders
            // the skill's prompts, attaches the context bundle, and starts the run.
            // render_only returns the text instead (handoff into a chat/terminal).
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct S {
                ticket: String,
                verb: String,
                #[serde(default)]
                connection_id: String,
                #[serde(default)]
                site: String,
                #[serde(default)]
                voice: String,
                #[serde(default)]
                transcript: String,
                #[serde(default)]
                question: String,
                #[serde(default)]
                resume: Option<String>,
                #[serde(default)]
                model: Option<String>,
                #[serde(default)]
                run_id: Option<String>,
                #[serde(default)]
                include_memory: bool,
                #[serde(default)]
                render_only: bool,
            }
            let req: S = match serde_json::from_str(body) {
                Ok(r) => r,
                Err(e) => return (400, format!("{{\"error\":\"bad request: {e}\"}}")),
            };
            let ticket = req.ticket.trim().to_string();
            if ticket.is_empty() || !ticket.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return (400, "{\"error\":\"bad ticket id\"}".into());
            }
            let prompts = match load_prompts() {
                Ok(p) => p,
                Err(e) => return (500, serde_json::json!({ "error": e }).to_string()),
            };
            let site = if req.site.is_empty() { agent_site() } else { req.site.clone() };
            let resuming = req.resume.as_deref().map(|s| !s.is_empty()).unwrap_or(false) && matches!(req.verb.as_str(), "followup" | "deepen");
            let transcript = if resuming { "" } else { req.transcript.as_str() };
            let skill = skill_dir().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
            let vars: Vec<(&str, &str)> = vec![("ticket", &ticket), ("site", &site), ("voice", &req.voice), ("transcript", transcript), ("question", &req.question), ("skill", &skill)];
            let (system, mut prompt, mode): (String, String, Option<String>) = match req.verb.as_str() {
                "summarize" | "diagnose" | "draft" | "deepen" => (
                    fill(&join_lines(&prompts["system"]), &vars),
                    fill(prompts["verbs"][req.verb.as_str()].as_str().unwrap_or(""), &vars),
                    None,
                ),
                "pr" => (fill(&join_lines(&prompts["pr"]["system"]), &vars), fill(prompts["pr"]["prompt"].as_str().unwrap_or(""), &vars), Some("pr".into())),
                "pr_push" => (fill(&join_lines(&prompts["pr_push"]["system"]), &vars), fill(prompts["pr_push"]["prompt"].as_str().unwrap_or(""), &vars), Some("pr-push".into())),
                "handoff" => {
                    let key = if req.transcript.trim().is_empty() { "fresh" } else { "continue" };
                    (String::new(), fill(prompts["handoff"][key].as_str().unwrap_or(""), &vars), None)
                }
                _ => return (400, "{\"error\":\"unknown verb\"}".into()),
            };
            if prompt.is_empty() {
                return (500, "{\"error\":\"prompt missing in prompts.json\"}".into());
            }
            // Attach the context bundle to the read verbs (deepen/pr carry the transcript instead).
            if !resuming && matches!(req.verb.as_str(), "summarize" | "diagnose" | "draft" | "deepen" | "followup") {
                if let Ok(json) = ticket_context(&ticket) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
                        if let Some(md) = v["markdown"].as_str() {
                            let header = prompts["context_header"].as_str().unwrap_or("TICKET CONTEXT:\n");
                            let md = if req.verb == "diagnose" { without_section(md, "## Bot output") } else { md.to_string() };
                            prompt = format!("{prompt}\n\n{header}{md}");
                        }
                    }
                }
            }
            if req.render_only {
                return (200, serde_json::json!({ "system": system, "prompt": prompt }).to_string());
            }
            let conn = state.conns.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|c| c.id == req.connection_id).cloned();
            let mut conn = match conn {
                Some(c) => c,
                None => return (404, "{\"error\":\"unknown connectionId\"}".into()),
            };
            if !conn.is_claude_code() {
                return (400, "{\"error\":\"the support agent needs the Claude Code connection (it uses tools)\"}".into());
            }
            if let Some(m) = req.model.as_deref() {
                if !m.is_empty() {
                    conn.model = m.to_string();
                }
            }
            let system = if resuming { String::new() } else { build_system(req.include_memory, Some(&system)) };
            let run_id = req.run_id.clone().unwrap_or_else(gen_token);
            state.progress.lock().unwrap_or_else(|e| e.into_inner()).retain(|_, p| !p.done);
            let repro_root = state.repro_root.lock().unwrap_or_else(|e| e.into_inner()).clone();
            let max_turns = prompts["budgets"][req.verb.as_str()].as_u64().map(|n| n as u32);
            spawn_agent_run(conn, system, prompt, run_id.clone(), mode, repro_root, state.running.clone(), state.progress.clone(), max_turns, if resuming { req.resume.clone() } else { None });
            (200, serde_json::json!({ "ok": true, "runId": run_id }).to_string())
        }
        (tiny_http::Method::Post, "/run") => {
            let req: RunReq = match serde_json::from_str(body) {
                Ok(r) => r,
                Err(e) => return (400, format!("{{\"error\":\"bad request: {e}\"}}")),
            };
            let conn = state.conns.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|c| c.id == req.connection_id).cloned();
            let mut conn = match conn {
                Some(c) => c,
                None => return (404, "{\"error\":\"unknown connectionId\"}".into()),
            };
            if conn.is_claude_code() {
                if let Some(m) = req.model.as_deref() {
                    if !m.is_empty() {
                        conn.model = m.to_string();
                    }
                }
            }
            let system = build_system(req.include_memory, req.system.as_deref());
            let reg = req.run_id.as_deref().map(|id| (&*state.running, id));
            let result = tauri::async_runtime::block_on(run_completion(&conn, Some(&system), &req.prompt, req.agent, reg));
            match result {
                Ok(content) => (200, serde_json::json!({ "content": strip_think(&content) }).to_string()),
                Err(e) => (502, serde_json::json!({ "error": e }).to_string()),
            }
        }
        (tiny_http::Method::Post, "/gh-checks") => {
            #[derive(serde::Deserialize)]
            struct C {
                repo: String,
                num: String,
            }
            let req: C = match serde_json::from_str(body) {
                Ok(r) => r,
                Err(_) => return (400, "{\"error\":\"bad request\"}".into()),
            };
            // `gh pr checks` exits non-zero when checks fail/pending — capture stdout regardless.
            match std::process::Command::new("gh")
                .args(["pr", "checks", &req.num, "-R", &req.repo])
                .output()
            {
                Ok(out) => {
                    let text = String::from_utf8_lossy(&out.stdout);
                    (200, serde_json::json!({ "output": text.trim() }).to_string())
                }
                Err(_) => (200, serde_json::json!({ "output": "" }).to_string()),
            }
        }
        (tiny_http::Method::Post, "/gh") => {
            #[derive(serde::Deserialize)]
            struct GhReq {
                repo: String,
                num: String,
                body: String,
                event: String,
            }
            let req: GhReq = match serde_json::from_str(body) {
                Ok(r) => r,
                Err(e) => return (400, format!("{{\"error\":\"bad request: {e}\"}}")),
            };
            // Post via the user's own `gh` auth — no GitHub token in the browser.
            let args: Vec<String> = match req.event.as_str() {
                "comment" => vec!["pr".into(), "comment".into(), req.num, "-R".into(), req.repo, "--body".into(), req.body],
                "request_changes" => vec!["pr".into(), "review".into(), req.num, "-R".into(), req.repo, "--request-changes".into(), "--body".into(), req.body],
                "approve" => vec!["pr".into(), "review".into(), req.num, "-R".into(), req.repo, "--approve".into(), "--body".into(), req.body],
                _ => return (400, "{\"error\":\"bad event\"}".into()),
            };
            match std::process::Command::new("gh").args(&args).output() {
                Ok(out) if out.status.success() => (
                    200,
                    serde_json::json!({ "ok": true, "output": String::from_utf8_lossy(&out.stdout).trim() }).to_string(),
                ),
                Ok(out) => (
                    502,
                    serde_json::json!({ "error": String::from_utf8_lossy(&out.stderr).trim() }).to_string(),
                ),
                Err(e) => (500, serde_json::json!({ "error": format!("can't run gh: {e}") }).to_string()),
            }
        }
        (tiny_http::Method::Post, "/agent-start") => {
            let req: RunReq = match serde_json::from_str(body) {
                Ok(r) => r,
                Err(e) => return (400, format!("{{\"error\":\"bad request: {e}\"}}")),
            };
            let conn = state.conns.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|c| c.id == req.connection_id).cloned();
            let mut conn = match conn {
                Some(c) => c,
                None => return (404, "{\"error\":\"unknown connectionId\"}".into()),
            };
            if !conn.is_claude_code() {
                return (400, "{\"error\":\"the support agent needs the Claude Code connection (it uses tools)\"}".into());
            }
            if let Some(m) = req.model.as_deref() {
                if !m.is_empty() {
                    conn.model = m.to_string();
                }
            }
            let system = build_system(req.include_memory, req.system.as_deref());
            let run_id = req.run_id.clone().unwrap_or_else(gen_token);
            state.progress.lock().unwrap_or_else(|e| e.into_inner()).retain(|_, p| !p.done);
            let repro_root = state.repro_root.lock().unwrap_or_else(|e| e.into_inner()).clone();
            spawn_agent_run(conn, system, req.prompt, run_id.clone(), req.mode, repro_root, state.running.clone(), state.progress.clone(), None, None);
            (200, serde_json::json!({ "ok": true, "runId": run_id }).to_string())
        }
        (tiny_http::Method::Post, "/agent-poll") => {
            #[derive(serde::Deserialize)]
            struct P {
                #[serde(rename = "runId")]
                run_id: String,
            }
            let req: P = match serde_json::from_str(body) {
                Ok(r) => r,
                Err(_) => return (400, "{\"error\":\"bad request\"}".into()),
            };
            let snap = state.progress.lock().unwrap_or_else(|e| e.into_inner()).get(&req.run_id).cloned();
            match snap {
                Some(p) => (200, serde_json::to_string(&p).unwrap_or_else(|_| "{}".into())),
                None => (200, serde_json::json!({ "steps": [], "text": "", "done": true, "error": "run not found" }).to_string()),
            }
        }
        (tiny_http::Method::Post, "/cancel") => {
            #[derive(serde::Deserialize)]
            struct C {
                #[serde(rename = "runId")]
                run_id: String,
            }
            let req: C = match serde_json::from_str(body) {
                Ok(r) => r,
                Err(_) => return (400, "{\"error\":\"bad request\"}".into()),
            };
            let pid = state.running.lock().unwrap_or_else(|e| e.into_inner()).get(&req.run_id).copied();
            match pid {
                Some(pid) => {
                    kill_group(pid);
                    (200, "{\"ok\":true}".into())
                }
                None => (200, "{\"ok\":true,\"note\":\"already finished\"}".into()),
            }
        }
        (tiny_http::Method::Post, "/fr-write") => {
            #[derive(serde::Deserialize)]
            struct Set {
                field: String,
                value: String,
            }
            #[derive(serde::Deserialize)]
            struct W {
                verb: String,
                doctype: String,
                name: String,
                #[serde(default)]
                sets: Vec<Set>,
            }
            let req: W = match serde_json::from_str(body) {
                Ok(r) => r,
                Err(e) => return (400, format!("{{\"error\":\"bad request: {e}\"}}")),
            };
            // Fixed command shapes only — the caller fills slots, never a free
            // command string. This is the human-approved write the agent proposed.
            // `-s` is required: fr refuses to pick a profile non-interactively.
            let mut args: Vec<String> = match req.verb.as_str() {
                "update" => {
                    if req.sets.is_empty() {
                        return (400, "{\"error\":\"update needs at least one field\"}".into());
                    }
                    vec!["-s".into(), agent_site(), "doc".into(), "update".into(), req.doctype, req.name]
                }
                "submit" | "cancel" | "delete" => {
                    vec!["-s".into(), agent_site(), "doc".into(), req.verb.clone(), req.doctype, req.name]
                }
                _ => return (400, "{\"error\":\"unsupported verb\"}".into()),
            };
            if req.verb == "update" {
                for s in &req.sets {
                    args.push("--set".into());
                    args.push(format!("{}={}", s.field, s.value));
                }
            }
            let mut c = std::process::Command::new("fr");
            c.args(&args);
            let dir = agent_workdir();
            if !dir.is_empty() && std::path::Path::new(&dir).is_dir() {
                c.current_dir(&dir);
            }
            match c.output() {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    if out.status.success() {
                        (200, serde_json::json!({ "ok": true, "output": stdout }).to_string())
                    } else {
                        let err = if !stderr.is_empty() { stderr } else { stdout };
                        (502, serde_json::json!({ "error": err }).to_string())
                    }
                }
                Err(e) => (500, serde_json::json!({ "error": format!("can't run fr: {e}") }).to_string()),
            }
        }
        (tiny_http::Method::Post, "/open-chat") => {
            #[derive(serde::Deserialize)]
            struct O {
                prompt: String,
                #[serde(default)]
                title: Option<String>,
                #[serde(rename = "connectionId", default)]
                connection_id: Option<String>,
                #[serde(default)]
                model: Option<String>,
            }
            let req: O = match serde_json::from_str(body) {
                Ok(r) => r,
                Err(e) => return (400, format!("{{\"error\":\"bad request: {e}\"}}")),
            };
            use tauri::Emitter;
            let _ = app.emit(
                "alter://open-chat",
                serde_json::json!({ "prompt": req.prompt, "title": req.title, "connectionId": req.connection_id, "model": req.model }),
            );
            if let Some(w) = app
                .get_webview_window("main")
                .or_else(|| app.webview_windows().into_values().next())
            {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            (200, "{\"ok\":true}".into())
        }
        (tiny_http::Method::Post, "/assistant") => {
            #[derive(serde::Deserialize)]
            struct A {
                task: String,
            }
            let req: A = match serde_json::from_str(body) {
                Ok(r) => r,
                Err(e) => return (400, format!("{{\"error\":\"bad request: {e}\"}}")),
            };
            let task = req.task.trim();
            if task.is_empty() {
                return (400, "{\"error\":\"empty task\"}".into());
            }
            let repro_env = state.repro_env.lock().unwrap_or_else(|e| e.into_inner()).clone();
            match launch_fr_assistant(task, &repro_env) {
                Ok(_) => (200, "{\"ok\":true}".into()),
                Err(e) => (500, serde_json::json!({ "error": e }).to_string()),
            }
        }
        _ => (404, "{\"error\":\"not found\"}".into()),
    }
}

// Open a Terminal running `fr assistant claude` seeded with `task` — a full,
// interactive (permission-prompting) Frappe agent the user drives, distinct from
// the scoped headless agent. macOS only for now.
#[cfg(target_os = "macos")]
fn launch_fr_assistant(task: &str, repro_env: &str) -> Result<(), String> {
    let dir = agent_workdir();
    let esc_sh = |s: &str| s.replace('\'', "'\\''");
    let script = format!(
        "#!/bin/sh\n{}cd '{}' 2>/dev/null\nexec fr assistant claude -- '{}'\n",
        repro_env,
        esc_sh(&dir),
        esc_sh(task)
    );
    let path = std::env::temp_dir().join(format!("alter-handoff-{}.sh", gen_token()));
    std::fs::write(&path, script).map_err(|e| e.to_string())?;
    let p = path.to_string_lossy().replace('"', "\\\"");
    let osa = format!("tell application \"Terminal\"\nactivate\ndo script \"sh {p}\"\nend tell");
    std::process::Command::new("osascript")
        .arg("-e")
        .arg(osa)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn launch_fr_assistant(_task: &str, _repro_env: &str) -> Result<(), String> {
    Err("fr assistant handoff is only wired for macOS right now".into())
}

// Signal-terminate the process group led by `pid` (negative pid = the group), so
// the claude run and any tool it spawned all stop.
fn kill_group(pid: u32) {
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill")
            .arg("-TERM")
            .arg(format!("-{pid}"))
            .output();
    }
    #[cfg(not(unix))]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
}
