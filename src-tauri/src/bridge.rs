// Local HTTP bridge: lets a browser extension (or any local tool) run the
// user's configured models without holding any keys. Alter stays the brain —
// connections live here, resolved per-request by connectionId.

use std::io::Read;
use std::sync::Mutex;
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
}

// The ONLY tools the support agent may use — read/inspect, never mutate.
// fr: only read-only subcommands (query/doc get/doctype/report/method/guide) —
// never `doc create/update/delete` or `api` (which can POST).
const AGENT_ALLOWED_TOOLS: &str = "Read Grep Glob WebFetch Bash(fr query:*) Bash(fr doc get:*) Bash(fr doctype:*) Bash(fr report:*) Bash(fr method:*) Bash(fr guide:*) Bash(git show:*) Bash(git log:*) Bash(git grep:*) Bash(git diff:*) Bash(gh pr view:*) Bash(gh pr list:*) Bash(gh issue view:*) Bash(gh issue list:*) Bash(gh search:*)";

fn agent_workdir() -> String {
    std::env::var("ALTER_AGENT_WORKDIR").unwrap_or_else(|_| {
        std::env::var("HOME")
            .map(|h| format!("{h}/projects/frappe/frappe-bench"))
            .unwrap_or_default()
    })
}

fn shared_memory() -> String {
    std::env::var("HOME")
        .ok()
        .and_then(|home| std::fs::read_to_string(std::path::Path::new(&home).join(".claude/CLAUDE.md")).ok())
        .map(|s| s.chars().take(8000).collect())
        .unwrap_or_default()
}

#[tauri::command]
pub fn bridge_info(state: State<BridgeState>) -> serde_json::Value {
    serde_json::json!({ "port": BRIDGE_PORT, "token": *state.token.lock().unwrap() })
}

#[tauri::command]
pub fn bridge_sync(state: State<BridgeState>, connections: Vec<BridgeConn>) {
    *state.conns.lock().unwrap() = connections;
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
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut buf);
    }
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

// Resolve a connection to a completion. HTTP → OpenAI-compatible call; Claude
// Code → one-shot `claude -p` (headless), so the extension gets your local
// subscription with no key.
async fn run_completion(conn: &BridgeConn, system: Option<&str>, prompt: &str, agent: bool) -> Result<String, String> {
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
            cmd.arg("--allowedTools").arg(AGENT_ALLOWED_TOOLS);
            cmd.arg("--permission-mode").arg("default");
        }
        let out = cmd.output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
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
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Headers", "authorization, content-type"),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
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
        *state.token.lock().unwrap() = token.clone();
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
        .map(|s| s.token.lock().unwrap().clone())
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

    if method == tiny_http::Method::Post && path == "/run-stream" {
        stream_run(req, &app, &body);
        return;
    }

    let response = handle(&app, &method, &path, &body);
    let _ = req.respond(json_response(response.0, response.1));
}

// A Read that pulls bytes from a channel — lets tiny_http write the response
// incrementally as the model produces tokens (chunked transfer, i.e. streaming).
struct ChannelReader {
    rx: std::sync::mpsc::Receiver<Vec<u8>>,
    buf: Vec<u8>,
    pos: usize,
}
impl std::io::Read for ChannelReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.buf.len() {
            match self.rx.recv() {
                Ok(b) if !b.is_empty() => {
                    self.buf = b;
                    self.pos = 0;
                }
                _ => return Ok(0), // sender closed → EOF
            }
        }
        let n = std::cmp::min(out.len(), self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

fn stream_run(req: tiny_http::Request, app: &AppHandle, body: &str) {
    let parsed: RunReq = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            let _ = req.respond(json_response(400, "{\"error\":\"bad request\"}".into()));
            return;
        }
    };
    let conn = app
        .try_state::<BridgeState>()
        .and_then(|s| s.conns.lock().unwrap().iter().find(|c| c.id == parsed.connection_id).cloned());
    let mut conn = match conn {
        Some(c) => c,
        None => {
            let _ = req.respond(json_response(404, "{\"error\":\"unknown connectionId\"}".into()));
            return;
        }
    };
    if let Some(m) = parsed.model.as_deref() {
        if !m.is_empty() {
            conn.model = m.to_string();
        }
    }
    let mut system = parsed.system.unwrap_or_default();
    if parsed.include_memory {
        let mem = shared_memory();
        if !mem.is_empty() {
            system = format!(
                "User's standing preferences (from ~/.claude/CLAUDE.md — authoritative):\n{mem}\n\n{system}"
            );
        }
    }
    let prompt = parsed.prompt;
    let agent = parsed.agent;

    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        if conn.is_claude_code() {
            produce_claude(&conn, &system, &prompt, agent, &tx);
        } else {
            tauri::async_runtime::block_on(produce_http(&conn, &system, &prompt, &tx));
        }
        // tx drops here → ChannelReader hits EOF and tiny_http closes the response.
    });

    let reader = ChannelReader { rx, buf: Vec::new(), pos: 0 };
    let mut headers = Vec::new();
    for (k, v) in [
        ("Content-Type", "text/plain; charset=utf-8"),
        ("Access-Control-Allow-Origin", "*"),
        ("Cache-Control", "no-cache"),
        ("X-Accel-Buffering", "no"),
    ] {
        if let Ok(h) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
            headers.push(h);
        }
    }
    let resp = tiny_http::Response::new(tiny_http::StatusCode(200), headers, reader, None, None);
    let _ = req.respond(resp);
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

fn produce_claude(conn: &BridgeConn, system: &str, prompt: &str, agent: bool, tx: &std::sync::mpsc::Sender<Vec<u8>>) {
    let full = if system.is_empty() { prompt.to_string() } else { format!("{system}\n\n{prompt}") };
    let mut cmd = std::process::Command::new("claude");
    cmd.arg("-p")
        .arg(&full)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--verbose");
    if !conn.model.is_empty() && conn.model != "claude-code" {
        cmd.arg("--model").arg(&conn.model);
    }
    if agent {
        // Read-only allowlist + fixed server-side workdir. No write tools, no
        // arbitrary shell, no permission bypass — a browser-triggered call
        // cannot mutate anything or escape the allowed commands.
        let dir = agent_workdir();
        if !dir.is_empty() && std::path::Path::new(&dir).is_dir() {
            cmd.current_dir(&dir);
        }
        cmd.arg("--allowedTools").arg(AGENT_ALLOWED_TOOLS);
        cmd.arg("--permission-mode").arg("default");
    }
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(format!("[Alter: can't run claude — {e}]").into_bytes());
            return;
        }
    };
    if let Some(out) = child.stdout.take() {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(out);
        let mut streamed = false;
        let mut tool: Option<(String, String)> = None; // (name, accumulated input json)
        for line in reader.lines().map_while(Result::ok) {
            let v: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v["type"] == "stream_event" {
                let ev = &v["event"];
                let et = ev["type"].as_str().unwrap_or("");
                match et {
                    "content_block_start" if ev["content_block"]["type"] == "tool_use" => {
                        let name = ev["content_block"]["name"].as_str().unwrap_or("tool").to_string();
                        tool = Some((name, String::new()));
                    }
                    "content_block_delta" if ev["delta"]["type"] == "text_delta" => {
                        if let Some(t) = ev["delta"]["text"].as_str() {
                            streamed = true;
                            if tx.send(t.as_bytes().to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                    "content_block_delta" if ev["delta"]["type"] == "input_json_delta" => {
                        if let (Some((_, acc)), Some(p)) = (tool.as_mut(), ev["delta"]["partial_json"].as_str()) {
                            acc.push_str(p);
                        }
                    }
                    "content_block_stop" => {
                        if let Some((name, acc)) = tool.take() {
                            let input: serde_json::Value = serde_json::from_str(&acc).unwrap_or(serde_json::Value::Null);
                            let label = tool_label(&name, &input);
                            // Emit a visible step marker the extension renders as an activity line.
                            let _ = tx.send(format!("\u{0001}▸ {label}\u{0001}").into_bytes());
                        }
                    }
                    _ => {}
                }
            } else if v["type"] == "result" && !streamed {
                if let Some(t) = v["result"].as_str() {
                    let _ = tx.send(t.as_bytes().to_vec());
                }
            }
        }
    }
    let _ = child.wait();
}

async fn produce_http(conn: &BridgeConn, system: &str, prompt: &str, tx: &std::sync::mpsc::Sender<Vec<u8>>) {
    use futures_util::StreamExt;
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(300)).build() {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(format!("[Alter: {e}]").into_bytes());
            return;
        }
    };
    let base = conn.base_url.trim_end_matches('/');
    let mut messages = Vec::new();
    if !system.is_empty() {
        messages.push(serde_json::json!({ "role": "system", "content": system }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": prompt }));
    let body = serde_json::json!({ "model": conn.model, "messages": messages, "max_tokens": 4000, "stream": true });
    let resp = match client.post(format!("{base}/chat/completions")).bearer_auth(&conn.api_key).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = tx.send(format!("[Alter: {e}]").into_bytes());
            return;
        }
    };
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(_) => break,
        };
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(idx) = buf.find('\n') {
            let line = buf[..idx].trim().to_string();
            buf.drain(..=idx);
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data == "[DONE]" {
                    return;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(t) = v["choices"][0]["delta"]["content"].as_str() {
                        if !t.is_empty() && tx.send(t.as_bytes().to_vec()).is_err() {
                            return;
                        }
                    }
                }
            }
        }
    }
}

fn cors_empty(status: u16) -> tiny_http::Response<std::io::Empty> {
    let mut r = tiny_http::Response::empty(status);
    for (k, v) in [
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Headers", "authorization, content-type"),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
    ] {
        if let Ok(h) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
            r.add_header(h);
        }
    }
    r
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
                .unwrap()
                .iter()
                .map(|c| ConnInfo {
                    id: c.id.clone(),
                    name: if c.is_claude_code() { "Claude Code".into() } else { c.name.clone() },
                    is_claude_code: c.is_claude_code(),
                })
                .collect();
            (200, serde_json::to_string(&list).unwrap_or_else(|_| "[]".into()))
        }
        (tiny_http::Method::Post, "/run") => {
            let req: RunReq = match serde_json::from_str(body) {
                Ok(r) => r,
                Err(e) => return (400, format!("{{\"error\":\"bad request: {e}\"}}")),
            };
            let conn = state.conns.lock().unwrap().iter().find(|c| c.id == req.connection_id).cloned();
            let mut conn = match conn {
                Some(c) => c,
                None => return (404, "{\"error\":\"unknown connectionId\"}".into()),
            };
            if let Some(m) = req.model.as_deref() {
                if !m.is_empty() {
                    conn.model = m.to_string();
                }
            }
            // Fold in the user's ~/.claude/CLAUDE.md so HTTP models get the same
            // standing preferences Claude Code already loads on its own.
            let system = match (req.include_memory, req.system.as_deref()) {
                (true, s) => {
                    let mem = shared_memory();
                    if mem.is_empty() {
                        s.unwrap_or("").to_string()
                    } else {
                        format!(
                            "User's standing preferences (from ~/.claude/CLAUDE.md — authoritative):\n{mem}\n\n{}",
                            s.unwrap_or("")
                        )
                    }
                }
                (false, s) => s.unwrap_or("").to_string(),
            };
            let result = tauri::async_runtime::block_on(run_completion(&conn, Some(&system), &req.prompt, req.agent));
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
        _ => (404, "{\"error\":\"not found\"}".into()),
    }
}
