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

mod bridge;
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

// Open an http(s) link in the user's default browser (never inside the app webview).
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http(s) links can be opened.".into());
    }
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", &url]);
        c
    };
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

// If the working folder is a git repo with an open PR for the current branch,
// return its {number,title,url} JSON (empty string otherwise) via `gh`.
#[tauri::command]
fn git_pr(cwd: String) -> Result<String, String> {
    use std::process::Command;
    if cwd.is_empty() {
        return Ok(String::new());
    }
    let out = Command::new("gh")
        .args(["pr", "view", "--json", "number,title,url"])
        .current_dir(&cwd)
        .output();
    match out {
        Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).trim().to_string()),
        _ => Ok(String::new()), // no PR, not a repo, or gh unavailable
    }
}

// Generate a short chat title from the first message (HTTP providers).
#[tauri::command]
async fn quick_complete(url: String, api_key: String, model: String, prompt: String) -> Result<String, String> {
    let client = http_client()?;
    let base = url.trim_end_matches('/');
    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 24,
        "stream": false
    });
    let resp = client
        .post(format!("{}/chat/completions", base))
        .bearer_auth(&api_key)
        .timeout(std::time::Duration::from_secs(20))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let text = resp.text().await.unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string())
}

// Generate a short chat title via a cheap Claude Code (haiku) call.
#[tauri::command]
fn claude_title(text: String) -> Result<String, String> {
    use std::process::Command;
    let snippet: String = text.chars().take(500).collect();
    let prompt = format!(
        "Generate a 3-6 word title in Title Case (no quotes, no trailing punctuation) for a chat that starts with this message. Reply with ONLY the title.\n\nMessage: {snippet}"
    );
    let out = Command::new("claude")
        .arg("-p")
        .arg(&prompt)
        .arg("--model")
        .arg("haiku")
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// One-shot, non-streaming completion on a given connection — used to turn a
// natural-language routine description into structured JSON. Claude Code runs
// `claude -p`; everything else is an OpenAI-compatible call.
#[tauri::command]
async fn complete_once(
    base_url: String,
    api_key: String,
    model: String,
    system: String,
    prompt: String,
) -> Result<String, String> {
    if base_url.starts_with("claude-code") {
        let full = if system.is_empty() { prompt } else { format!("{system}\n\n{prompt}") };
        let mut cmd = tokio::process::Command::new("claude");
        cmd.arg("-p").arg(&full);
        if !model.is_empty() && model != "claude-code" {
            cmd.arg("--model").arg(&model);
        }
        let out = cmd.output().await.map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    } else {
        let client = http_client()?;
        let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
        let body = serde_json::json!({
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            "stream": false
        });
        let resp = client.post(&url).bearer_auth(&api_key).json(&body).send().await.map_err(|e| e.to_string())?;
        let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        v["choices"][0]["message"]["content"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| v["error"]["message"].as_str().unwrap_or("no response").to_string())
    }
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

#[derive(serde::Serialize)]
struct FrappeCreds {
    site: String,
    api_key: String,
    api_secret: String,
}

#[tauri::command]
fn import_frappe_credentials(profile: Option<String>) -> Result<FrappeCreds, String> {
    use std::process::Command;

    let base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config")
        });
    let raw = std::fs::read_to_string(base.join("frappe").join("config.json"))
        .map_err(|_| "No frappectl config found — run `fr auth login <url>` first.".to_string())?;
    let cfg: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("Couldn't parse frappectl config: {e}"))?;

    let name = match profile {
        Some(p) if !p.is_empty() => p,
        _ => cfg
            .get("default")
            .and_then(|v| v.as_str())
            .ok_or("No default frappectl profile set.")?
            .to_string(),
    };
    let entry = cfg
        .get("profiles")
        .and_then(|p| p.get(&name))
        .ok_or_else(|| format!("Profile '{name}' not found in frappectl config."))?;
    if entry.get("auth").and_then(|v| v.as_str()) == Some("oauth") {
        return Err(format!(
            "Profile '{name}' uses OAuth, not an API key — paste the key/secret manually."
        ));
    }
    let site = entry
        .get("site")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let read_secret = |service: &str| -> Option<String> {
        let out = Command::new("security")
            .args(["find-generic-password", "-w", "-s", service, "-a", &name])
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !s.is_empty()).then_some(s)
    };
    let secret = read_secret("frappectl")
        .or_else(|| read_secret("frappe-cli"))
        .ok_or("Couldn't read the credential from the macOS keychain (prompt cancelled?).")?;

    let (api_key, api_secret) = secret
        .split_once(':')
        .ok_or("Stored credential isn't in key:secret form.")?;
    Ok(FrappeCreds {
        site,
        api_key: api_key.to_string(),
        api_secret: api_secret.to_string(),
    })
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
    let settings = &state["settings"];
    let connections = settings["connections"].as_array().cloned().unwrap_or_default();
    let default_base = settings["baseUrl"].as_str().unwrap_or("").to_string();
    let default_key = settings["apiKey"].as_str().unwrap_or("").to_string();
    let default_model = settings["model"].as_str().unwrap_or("").to_string();

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

        // Resolve the connection this routine runs on (falls back to the default).
        let (base_url, api_key, mut model) = match r["connectionId"].as_str() {
            Some(cid) if !cid.is_empty() => connections
                .iter()
                .find(|c| c["id"].as_str() == Some(cid))
                .map(|c| {
                    (
                        c["baseUrl"].as_str().unwrap_or("").to_string(),
                        c["apiKey"].as_str().unwrap_or("").to_string(),
                        c["model"].as_str().unwrap_or("").to_string(),
                    )
                })
                .unwrap_or((default_base.clone(), default_key.clone(), default_model.clone())),
            _ => (default_base.clone(), default_key.clone(), default_model.clone()),
        };
        if let Some(m) = r["model"].as_str() {
            if !m.is_empty() {
                model = m.to_string();
            }
        }
        let is_cc = base_url.starts_with("claude-code");
        if base_url.is_empty() || (!is_cc && api_key.is_empty()) {
            continue;
        }

        let last = runs[id].as_u64().unwrap_or(0);
        if !routine_due(&r["schedule"], r["everyMinutes"].as_u64().unwrap_or(60), last, now) {
            continue;
        }

        let content = if is_cc {
            let full = format!("{system}\n\n{prompt}");
            let mut cmd = tokio::process::Command::new("claude");
            cmd.arg("-p").arg(&full);
            if !model.is_empty() && model != "claude-code" {
                cmd.arg("--model").arg(&model);
            }
            match cmd.output().await {
                Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
                Ok(o) => format!("(routine error: {})", String::from_utf8_lossy(&o.stderr).trim()),
                Err(e) => format!("(routine error running claude: {})", e),
            }
        } else {
            let body = serde_json::json!({
                "model": model,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
                "stream": false
            });
            let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
            match client.post(&url).bearer_auth(&api_key).json(&body).send().await {
                Ok(rp) => match rp.json::<serde_json::Value>().await {
                    Ok(j) => j["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string(),
                    Err(e) => format!("(routine error parsing response: {})", e),
                },
                Err(e) => format!("(routine error: {})", e),
            }
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

// Is a routine due now? interval → elapsed since last; daily/weekly → local
// wall-clock time reached today and not already run since today's target.
fn routine_due(sched: &serde_json::Value, every_minutes: u64, last: u64, now: u64) -> bool {
    use chrono::{Datelike, Local, TimeZone};
    let kind = sched.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    if kind == "daily" || kind == "weekly" {
        let time = sched.get("time").and_then(|t| t.as_str()).unwrap_or("09:00");
        let (hh, mm) = match time.split_once(':') {
            Some((h, m)) => (h.trim().parse::<u32>().unwrap_or(9), m.trim().parse::<u32>().unwrap_or(0)),
            None => (9, 0),
        };
        let now_dt = match Local.timestamp_millis_opt(now as i64).single() {
            Some(d) => d,
            None => return false,
        };
        if kind == "weekly" {
            let wd = now_dt.weekday().num_days_from_sunday() as u64; // 0=Sun
            let ok = sched
                .get("days")
                .and_then(|d| d.as_array())
                .map(|arr| arr.iter().any(|x| x.as_u64() == Some(wd)))
                .unwrap_or(false);
            if !ok {
                return false;
            }
        }
        let target = match now_dt.date_naive().and_hms_opt(hh, mm, 0) {
            Some(naive) => match Local.from_local_datetime(&naive).single() {
                Some(t) => t.timestamp_millis() as u64,
                None => return false,
            },
            None => return false,
        };
        now >= target && last < target
    } else {
        let every = if kind == "interval" {
            sched.get("everyMinutes").and_then(|e| e.as_u64()).unwrap_or(every_minutes)
        } else {
            every_minutes
        }
        .max(1);
        now.saturating_sub(last) >= every * 60_000
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
// Ship Alter's skills with the app: install them into ~/.claude/skills on first
// run so the headless `claude` the bridge drives (and any Claude Code session on
// this machine) can use them. Idempotent — never clobbers a user-edited copy.
fn install_bundled_skills() {
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return,
    };
    let dir = std::path::Path::new(&home).join(".claude/skills/frappe-support-diagnosis");
    if dir.join("SKILL.md").exists() {
        return;
    }
    let scripts = dir.join("scripts");
    if std::fs::create_dir_all(&scripts).is_err() {
        return;
    }
    let _ = std::fs::write(
        dir.join("SKILL.md"),
        include_str!("../../skills/frappe-support-diagnosis/SKILL.md"),
    );
    let files = [
        (scripts.join("find-code.sh"), include_str!("../../skills/frappe-support-diagnosis/scripts/find-code.sh")),
        (scripts.join("across-versions.sh"), include_str!("../../skills/frappe-support-diagnosis/scripts/across-versions.sh")),
    ];
    for (path, body) in &files {
        let _ = std::fs::write(path, body);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(path) {
                let mut perm = meta.permissions();
                perm.set_mode(0o755);
                let _ = std::fs::set_permissions(path, perm);
            }
        }
    }
}

pub fn run() {
    install_bundled_skills();
    tauri::Builder::default()
        .manage(browser::BrowserState::default())
        .manage(ChatCancel::default())
        .manage(ClaudeState::default())
        .manage(bridge::BridgeState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
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
            import_frappe_credentials,
            read_user_memory,
            append_user_memory,
            open_external,
            quick_complete,
            claude_title,
            complete_once,
            git_pr,
            bridge::bridge_info,
            bridge::bridge_sync,
            bridge::bridge_set_repro_root,
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
            bridge::start(app.handle().clone());

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

            // Global hotkey (⌘⇧Space) toggles Alter from anywhere.
            use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
            let toggle = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Space);
            app.global_shortcut().on_shortcut(toggle, |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    if let Some(w) = app.get_webview_window("main") {
                        let up = w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false);
                        if up {
                            let _ = w.hide();
                        } else {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                }
            })?;
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
