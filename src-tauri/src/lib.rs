#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.len() > 100_000 {
        return Ok(format!("{}\n[truncated]", &content[..100_000]));
    }
    Ok(content)
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<String, String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(format!("wrote {}", path))
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir() {
                format!("{}/", name)
            } else {
                name
            }
        })
        .collect();
    names.sort();
    Ok(names)
}

mod browser;

pub(crate) fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let bytes = html.as_bytes();
    let mut i = 0;
    let mut in_tag = false;
    let mut skip_until: Option<&[u8]> = None;
    let lower = html.to_lowercase();
    while i < bytes.len() {
        if let Some(close) = skip_until {
            if lower[i..].as_bytes().starts_with(close) {
                i += close.len();
                skip_until = None;
            } else {
                i += 1;
            }
            continue;
        }
        let c = bytes[i];
        if c == b'<' {
            if lower[i..].starts_with("<script") {
                skip_until = Some(b"</script>");
                i += 1;
                continue;
            }
            if lower[i..].starts_with("<style") {
                skip_until = Some(b"</style>");
                i += 1;
                continue;
            }
            in_tag = true;
        } else if c == b'>' {
            in_tag = false;
            out.push(' ');
        } else if !in_tag {
            out.push(c as char);
        }
        i += 1;
    }
    let mut text = String::new();
    let mut last_ws = true;
    for ch in out.chars() {
        if ch.is_whitespace() {
            if !last_ws {
                text.push(' ');
                last_ws = true;
            }
        } else {
            text.push(ch);
            last_ws = false;
        }
    }
    text.trim().to_string()
}

use std::collections::HashSet;
use std::sync::Mutex;

// Per-conversation cancellation: a set of conversation ids whose stream should stop.
// Keyed by id so stopping one chat never affects another running concurrently.
#[derive(Default)]
pub struct ChatCancel(pub Mutex<HashSet<String>>);

impl ChatCancel {
    fn request(&self, id: &str) {
        if let Ok(mut s) = self.0.lock() {
            s.insert(id.to_string());
        }
    }
    fn clear(&self, id: &str) {
        if let Ok(mut s) = self.0.lock() {
            s.remove(id);
        }
    }
    fn is_cancelled(&self, id: &str) -> bool {
        self.0.lock().map(|s| s.contains(id)).unwrap_or(false)
    }
}

// A warm, long-lived Claude Code process bound to one conversation/model/cwd.
// Kept alive between messages so follow-up turns skip the cold start + cache rebuild.
struct ClaudeProc {
    conv_id: String,
    model: String,
    cwd: String,
    effort: String,
    perm: String,
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    rx: tokio::sync::mpsc::UnboundedReceiver<String>,
}
#[derive(Default)]
pub struct ClaudeState(tokio::sync::Mutex<Option<ClaudeProc>>);

#[tauri::command]
fn cancel_chat(state: tauri::State<ChatCancel>, id: String) {
    state.request(&id);
}

#[tauri::command]
async fn stream_chat(
    state: tauri::State<'_, ChatCancel>,
    id: String,
    url: String,
    api_key: String,
    body: String,
    on_chunk: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    use futures_util::StreamExt;
    state.clear(&id);
    let client = http_client()?;
    let resp = client
        .post(&url)
        .bearer_auth(&api_key)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {} — {}", status.as_u16(), text.chars().take(400).collect::<String>()));
    }
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut idle: u32 = 0; // 100ms ticks with no data
    loop {
        if state.is_cancelled(&id) {
            break;
        }
        // Wait for the next chunk, but wake every 100ms to re-check the cancel
        // flag — otherwise Stop does nothing while the provider is "thinking".
        let next = match tokio::time::timeout(std::time::Duration::from_millis(100), stream.next()).await {
            Ok(c) => {
                idle = 0;
                c
            }
            Err(_) => {
                idle += 1;
                // 60s with no bytes at all → the provider is hung/overloaded.
                if idle > 600 {
                    return Err(
                        "No response from the model (timed out after 60s). It may be overloaded — try again or switch models."
                            .to_string(),
                    );
                }
                continue;
            }
        };
        let chunk = match next {
            Some(c) => c,
            None => break,
        };
        let bytes = chunk.map_err(|e| e.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(idx) = buffer.find('\n') {
            let line: String = buffer.drain(..=idx).collect();
            let _ = on_chunk.send(line);
        }
    }
    if !buffer.is_empty() {
        let _ = on_chunk.send(buffer);
    }
    Ok(())
}

// ---- Claude Code (local) mode ---------------------------------------------
// Drives the locally-installed `claude` CLI in headless mode so Alter can use
// the user's Claude Code subscription as a backend. Only ever runs the `claude`
// binary with fixed flags — never an arbitrary shell command.

// The user-level memory Claude Code loads for every session. Alter reads it so
// non-Claude models (Gemini/OpenRouter) share the same facts — train once.
#[tauri::command]
fn read_user_memory() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let path = std::path::Path::new(&home).join(".claude/CLAUDE.md");
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s.chars().take(8000).collect()),
        Err(_) => Ok(String::new()),
    }
}

#[tauri::command]
fn append_user_memory(fact: String) -> Result<(), String> {
    use std::io::Write;
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let dir = std::path::Path::new(&home).join(".claude");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("CLAUDE.md");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "\n- {}", fact.trim()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn claude_version() -> Result<String, String> {
    use std::process::Command;
    let out = Command::new("claude")
        .arg("--version")
        .output()
        .map_err(|e| format!("Couldn't run the `claude` CLI — is Claude Code installed and on your PATH? ({e})"))?;
    if out.status.success() {
        Ok(format!(
            "Claude Code ready — {}",
            String::from_utf8_lossy(&out.stdout).trim()
        ))
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[tauri::command]
async fn claude_code(
    cancel: tauri::State<'_, ChatCancel>,
    procs: tauri::State<'_, ClaudeState>,
    prompt: String,
    cwd: Option<String>,
    conv_id: String,
    session_id: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
    on_chunk: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::process::Command;
    cancel.clear(&conv_id);

    let model = model.unwrap_or_default();
    let cwd = cwd.unwrap_or_default();
    let effort = effort.unwrap_or_default();
    let perm = match permission_mode.as_deref() {
        Some(m @ ("default" | "acceptEdits" | "bypassPermissions" | "plan")) => m.to_string(),
        _ => "bypassPermissions".to_string(), // default: act freely on the user's own machine
    };
    let mut guard = procs.0.lock().await;

    // Reuse the warm process only if conversation, model, folder, effort and permission
    // mode all match and it hasn't died — otherwise spawn a fresh one.
    let reuse = match guard.as_mut() {
        Some(p) => {
            let alive = matches!(p.child.try_wait(), Ok(None));
            alive
                && p.conv_id == conv_id
                && p.model == model
                && p.cwd == cwd
                && p.effort == effort
                && p.perm == perm
        }
        None => false,
    };

    if !reuse {
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill().await;
        }
        let mut cmd = Command::new("claude");
        cmd.arg("-p")
            .arg("--input-format").arg("stream-json")
            .arg("--output-format").arg("stream-json")
            .arg("--verbose")
            .arg("--include-partial-messages") // stream tokens as they arrive
            .arg("--permission-mode").arg(&perm);
        if !model.is_empty() && model != "claude-code" {
            cmd.arg("--model").arg(&model);
        }
        if matches!(effort.as_str(), "low" | "medium" | "high" | "xhigh" | "max") {
            cmd.arg("--effort").arg(&effort);
        }
        // Resume prior context when respawning (model switch / returning to a chat).
        if let Some(sid) = session_id.as_ref().filter(|s| !s.is_empty()) {
            cmd.arg("--resume").arg(sid);
        }
        if !cwd.is_empty() {
            cmd.current_dir(&cwd);
        }
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| {
            format!("Couldn't start Claude Code — is the `claude` CLI installed and on your PATH? ({e})")
        })?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if tx.send(l).is_err() {
                    break;
                }
            }
        });
        *guard = Some(ClaudeProc {
            conv_id: conv_id.clone(),
            model: model.clone(),
            cwd: cwd.clone(),
            effort: effort.clone(),
            perm: perm.clone(),
            child,
            stdin,
            rx,
        });
    }

    // Send this turn's user message on the (possibly warm) process's stdin.
    {
        let p = guard.as_mut().unwrap();
        let mut msg = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": prompt }] }
        })
        .to_string();
        msg.push('\n');
        if p.stdin.write_all(msg.as_bytes()).await.is_err() || p.stdin.flush().await.is_err() {
            let _ = guard.take();
            return Err("Claude Code process closed — try again.".to_string());
        }
    }

    // Forward events as they arrive, until this turn's `result` event.
    loop {
        if cancel.is_cancelled(&conv_id) {
            if let Some(mut old) = guard.take() {
                let _ = old.child.kill().await;
            }
            break;
        }
        let p = guard.as_mut().unwrap();
        match tokio::time::timeout(std::time::Duration::from_millis(100), p.rx.recv()).await {
            Ok(Some(line)) => {
                let done = line.contains("\"type\":\"result\"");
                if !line.trim().is_empty() {
                    let _ = on_chunk.send(line);
                }
                if done {
                    break;
                }
            }
            Ok(None) => {
                let _ = guard.take();
                return Err(
                    "Claude Code stopped unexpectedly — check `claude` in a terminal (login / usage limits)."
                        .to_string(),
                );
            }
            Err(_) => continue, // 100ms tick — re-check cancel
        }
    }
    Ok(())
}

#[tauri::command]
async fn test_connection(url: String, api_key: String, model: String) -> Result<String, String> {
    let client = http_client()?;
    let base = url.trim_end_matches('/');

    // If a model is set, actually try a tiny chat completion — this catches
    // models that list fine but 404 / are unavailable on real requests.
    if !model.trim().is_empty() {
        let body = serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
            "stream": false
        });
        let resp = client
            .post(format!("{}/chat/completions", base))
            .bearer_auth(&api_key)
            .timeout(std::time::Duration::from_secs(25))
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("HTTP {} — {}", status.as_u16(), text.chars().take(400).collect::<String>()));
        }
        if text.contains("\"error\"") && !text.contains("\"choices\"") {
            return Err(text.chars().take(400).collect::<String>());
        }
        return Ok(format!("Connected — \"{}\" responded.", model));
    }

    // No model set: just verify the endpoint lists models.
    let models_url = format!("{}/models", base);
    let resp = client
        .get(&models_url)
        .bearer_auth(&api_key)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {} — {}", status.as_u16(), text.chars().take(300).collect::<String>()));
    }
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::json!({}));
    let models: Vec<String> = json["data"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(String::from)).collect())
        .unwrap_or_default();
    if models.is_empty() {
        Ok("Connected. (No model list returned.)".into())
    } else {
        Ok(format!("Connected. {} models: {}", models.len(), models.join(", ")))
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36")
        .build()
        .map_err(|e| e.to_string())
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
}

fn slice_between<'a>(s: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let i = s.find(start)? + start.len();
    let rest = &s[i..];
    let j = rest.find(end)?;
    Some(&rest[..j])
}

#[tauri::command]
async fn fetch_url(url: String) -> Result<String, String> {
    let client = http_client()?;
    let resp = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let mut text = html_to_text(&body);
    if text.len() > 12_000 {
        text.truncate(12_000);
        text.push_str("\n[truncated]");
    }
    Ok(format!("HTTP {} — {}\n\n{}", status.as_u16(), url, text))
}

fn ddg_real_url(href: &str) -> String {
    let cleaned = href.replace("&amp;", "&");
    if let Some(start) = cleaned.find("uddg=") {
        let rest = &cleaned[start + 5..];
        let enc = rest.split('&').next().unwrap_or(rest);
        return urlencoding::decode(enc).map(|s| s.into_owned()).unwrap_or_else(|_| enc.to_string());
    }
    if cleaned.starts_with("//") {
        format!("https:{}", cleaned)
    } else {
        cleaned
    }
}

#[tauri::command]
async fn web_search(query: String) -> Result<String, String> {
    let client = http_client()?;
    let resp = client
        .get("https://html.duckduckgo.com/html/")
        .query(&[("q", &query)])
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let html = resp.text().await.map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    let mut idx = 0;
    while let Some(pos) = html[idx..].find("class=\"result__a\"") {
        let base = idx + pos;
        idx = base + 17;
        let block = &html[base..(base + 3000).min(html.len())];
        let href = slice_between(block, "href=\"", "\"").unwrap_or("");
        let url = ddg_real_url(href);
        if url.is_empty() || url.contains("duckduckgo.com") {
            continue;
        }
        let title = slice_between(block, ">", "</a>")
            .map(|t| decode_entities(&html_to_text(t)))
            .unwrap_or_default();
        let snippet = slice_between(&html[base..], "class=\"result__snippet\"", "</a>")
            .and_then(|s| s.find('>').map(|p| &s[p + 1..]))
            .map(|t| decode_entities(&html_to_text(t)))
            .unwrap_or_default();
        if title.is_empty() {
            continue;
        }
        let mut entry = format!("{}\n{}", title, url);
        if !snippet.is_empty() {
            entry.push_str(&format!("\n{}", snippet.chars().take(300).collect::<String>()));
        }
        results.push(entry);
        if results.len() >= 6 {
            break;
        }
    }

    if results.is_empty() {
        Ok(format!("No results for \"{}\".", query))
    } else {
        Ok(results.join("\n\n"))
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
fn save_routine_state(app: tauri::AppHandle, state: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("state.json"), state).map_err(|e| e.to_string())
}

#[tauri::command]
fn take_routine_results(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("results.json");
    let content = std::fs::read_to_string(&path).unwrap_or_else(|_| "[]".into());
    let _ = std::fs::write(&path, "[]");
    Ok(content)
}

async fn run_due_routines(dir: &std::path::Path) {
    let state_raw = match std::fs::read_to_string(dir.join("state.json")) {
        Ok(s) => s,
        Err(_) => return,
    };
    let state: serde_json::Value = match serde_json::from_str(&state_raw) {
        Ok(v) => v,
        Err(_) => return,
    };
    let api_key = state["settings"]["apiKey"].as_str().unwrap_or("");
    let base_url = state["settings"]["baseUrl"].as_str().unwrap_or("");
    let model = state["settings"]["model"].as_str().unwrap_or("");
    if api_key.is_empty() || base_url.is_empty() {
        return;
    }
    let memory_facts: Vec<String> = state["memories"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["text"].as_str().map(|s| format!("- {}", s))).collect())
        .unwrap_or_default();
    let system = if memory_facts.is_empty() {
        "You are Alter, running a scheduled routine. Answer concisely.".to_string()
    } else {
        format!(
            "You are Alter, running a scheduled routine. Answer concisely.\n\nWhat you know about the user:\n{}",
            memory_facts.join("\n")
        )
    };

    let runs_raw = std::fs::read_to_string(dir.join("runs.json")).unwrap_or_else(|_| "{}".into());
    let mut runs: serde_json::Value = serde_json::from_str(&runs_raw).unwrap_or(serde_json::json!({}));
    let now = now_millis();

    let routines = match state["routines"].as_array() {
        Some(r) => r.clone(),
        None => return,
    };
    let client = match http_client() {
        Ok(c) => c,
        Err(_) => return,
    };

    for r in routines {
        if !r["enabled"].as_bool().unwrap_or(false) {
            continue;
        }
        let id = r["id"].as_str().unwrap_or("");
        let name = r["name"].as_str().unwrap_or("Routine");
        let prompt = r["prompt"].as_str().unwrap_or("");
        let every = r["everyMinutes"].as_u64().unwrap_or(60).max(1);
        let last = runs[id].as_u64().unwrap_or(0);
        if now.saturating_sub(last) < every * 60_000 {
            continue;
        }
        let body = serde_json::json!({
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            "stream": false
        });
        let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
        let resp = client.post(&url).bearer_auth(api_key).json(&body).send().await;
        let content = match resp {
            Ok(r) => match r.json::<serde_json::Value>().await {
                Ok(j) => j["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string(),
                Err(e) => format!("(routine error parsing response: {})", e),
            },
            Err(e) => format!("(routine error: {})", e),
        };
        runs[id] = serde_json::json!(now);

        let results_raw = std::fs::read_to_string(dir.join("results.json")).unwrap_or_else(|_| "[]".into());
        let mut results: serde_json::Value = serde_json::from_str(&results_raw).unwrap_or(serde_json::json!([]));
        if let Some(arr) = results.as_array_mut() {
            arr.push(serde_json::json!({
                "name": name, "prompt": prompt, "content": content, "at": now
            }));
        }
        let _ = std::fs::write(dir.join("results.json"), results.to_string());
        let _ = std::fs::write(dir.join("runs.json"), runs.to_string());
    }
}

fn walk(dir: &std::path::Path, prefix: &str, depth: usize, out: &mut Vec<String>) {
    if depth == 0 || out.len() > 2000 {
        return;
    }
    let mut entries: Vec<_> = match std::fs::read_dir(dir) {
        Ok(e) => e.filter_map(|x| x.ok()).collect(),
        Err(_) => return,
    };
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        let is_dir = e.path().is_dir();
        out.push(format!("{}{}{}", prefix, name, if is_dir { "/" } else { "" }));
        if is_dir {
            walk(&e.path(), &format!("{}  ", prefix), depth - 1, out);
        }
    }
}

#[tauri::command]
fn which_command(name: String) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains(char::is_whitespace) {
        return Err("Pass a plain command name (no slashes or spaces).".into());
    }
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        for d in path.split(':').filter(|d| !d.is_empty()) {
            dirs.push(std::path::PathBuf::from(d));
        }
    }
    for common in [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        dirs.push(std::path::PathBuf::from(common));
    }
    if let Ok(home) = std::env::var("HOME") {
        for extra in [".local/bin", "bin", ".cargo/bin", ".pyenv/shims", ".volta/bin", "go/bin"] {
            dirs.push(std::path::Path::new(&home).join(extra));
        }
    }
    let mut seen = std::collections::HashSet::new();
    for dir in dirs {
        if !seen.insert(dir.clone()) {
            continue;
        }
        let candidate = dir.join(&name);
        if candidate.is_file() {
            return Ok(format!("{} is installed at {}", name, candidate.display()));
        }
    }
    Ok(format!(
        "{} was not found on PATH or common bin directories. (Note: tools inside an unactivated virtualenv or a shell alias won't be detected this way.)",
        name
    ))
}

#[tauri::command]
fn list_tree(path: String, depth: Option<usize>) -> Result<String, String> {
    let root = std::path::Path::new(&path);
    if !root.is_dir() {
        return Err(format!("{} is not a directory", path));
    }
    let mut out = Vec::new();
    walk(root, "", depth.unwrap_or(3), &mut out);
    Ok(out.join("\n"))
}

#[tauri::command]
fn search_files(path: String, query: String) -> Result<String, String> {
    let root = std::path::Path::new(&path);
    let mut hits = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if hits.len() > 200 {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.filter_map(|x| x.ok()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(content) = std::fs::read_to_string(&p) {
                for (i, line) in content.lines().enumerate() {
                    if line.to_lowercase().contains(&query.to_lowercase()) {
                        hits.push(format!("{}:{}: {}", p.display(), i + 1, line.trim()));
                        if hits.len() > 200 {
                            break;
                        }
                    }
                }
            }
        }
    }
    if hits.is_empty() {
        Ok(format!("No matches for \"{}\".", query))
    } else {
        Ok(hits.join("\n"))
    }
}

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(browser::BrowserState::default())
        .manage(ChatCancel::default())
        .manage(ClaudeState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            list_dir,
            list_tree,
            search_files,
            which_command,
            fetch_url,
            web_search,
            save_routine_state,
            take_routine_results,
            stream_chat,
            cancel_chat,
            test_connection,
            claude_code,
            claude_version,
            read_user_memory,
            append_user_memory,
            browser::browser_open,
            browser::browser_read,
            browser::browser_click,
            browser::browser_type,
            browser::browser_screenshot,
            browser::browser_close
        ])
        .setup(|app| {
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                tauri::async_runtime::spawn(async move {
                    loop {
                        run_due_routines(&dir).await;
                        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    }
                });
            }
            let show = MenuItem::with_id(app, "show", "Show Alter", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Alter — running in background")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
    // Warm Claude Code process is killed automatically via kill_on_drop.
}
