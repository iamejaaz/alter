use std::path::PathBuf;
use std::process::{Command, Stdio};

fn home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_default()
}

pub fn find(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .collect();
    let h = home();
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(PathBuf::from(d));
    }
    for d in [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".volta/bin"] {
        dirs.push(h.join(d));
    }
    if let Some(p) = dirs.iter().map(|d| d.join(name)).find(|p| p.is_file()) {
        return Some(p);
    }
    if name == "codex" {
        for app in [PathBuf::from("/Applications/Codex.app"), h.join("Applications/Codex.app")] {
            let p = app.join("Contents/Resources/codex");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn output(bin: &PathBuf, args: &[&str]) -> Option<(bool, String)> {
    let o = Command::new(bin).args(args).stdin(Stdio::null()).output().ok()?;
    let mut text = String::from_utf8_lossy(&o.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&o.stderr));
    Some((o.status.success(), text.trim().to_string()))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    kind: String,
    installed: bool,
    path: String,
    version: String,
    signed_in: Option<bool>,
    account: String,
    login_command: String,
}

#[tauri::command]
pub fn cli_status(kind: String) -> CliStatus {
    let name = if kind == "codex" { "codex" } else { "claude" };
    let Some(bin) = find(name) else {
        return CliStatus {
            kind,
            installed: false,
            path: String::new(),
            version: String::new(),
            signed_in: None,
            account: String::new(),
            login_command: String::new(),
        };
    };
    let version = output(&bin, &["--version"]).map(|(_, t)| t.lines().next().unwrap_or("").to_string()).unwrap_or_default();
    let (signed_in, account, login) = if name == "claude" {
        let v = output(&bin, &["auth", "status", "--json"])
            .and_then(|(_, t)| serde_json::from_str::<serde_json::Value>(&t).ok());
        let signed = v.as_ref().and_then(|v| v.get("loggedIn")).and_then(|x| x.as_bool());
        let who = v
            .as_ref()
            .and_then(|v| v.get("email").or_else(|| v.get("authMethod")))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        (signed, who, "auth login")
    } else {
        let t = output(&bin, &["login", "status"]).map(|(_, t)| t).unwrap_or_default();
        let signed = if t.is_empty() { None } else { Some(t.to_lowercase().contains("logged in") && !t.to_lowercase().contains("not logged in")) };
        let who = t.lines().find(|l| l.to_lowercase().contains("logged in")).unwrap_or("").to_string();
        (signed, who, "login")
    };
    CliStatus {
        kind,
        installed: true,
        login_command: format!("'{}' {}", bin.display(), login),
        path: bin.display().to_string(),
        version,
        signed_in,
        account,
    }
}

#[tauri::command]
pub fn cli_login_terminal(kind: String) -> Result<(), String> {
    let name = if kind == "codex" { "codex" } else { "claude" };
    let bin = find(name).ok_or_else(|| format!("The {name} CLI isn't installed."))?;
    let sub = if name == "claude" { "auth login" } else { "login" };
    let script = format!("#!/bin/sh\nclear\necho 'Signing {name} in for Alter. Follow the prompts, then come back to Alter.'\n'{}' {sub}\n", bin.display());
    let path = std::env::temp_dir().join(format!("alter-{name}-login.sh"));
    std::fs::write(&path, script).map_err(|e| e.to_string())?;
    let osa = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"sh '{}'\"\nend tell",
        path.display().to_string().replace('"', "\\\"")
    );
    Command::new("osascript").arg("-e").arg(osa).output().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn cli_login(app: tauri::AppHandle, kind: String) -> Result<String, String> {
    use tauri::Emitter;
    use tokio::io::{AsyncBufReadExt, BufReader};
    let name = if kind == "codex" { "codex" } else { "claude" };
    let bin = find(name).ok_or_else(|| format!("The {name} CLI isn't installed."))?;
    let args: &[&str] = if name == "claude" { &["auth", "login", "--claudeai"] } else { &["login"] };
    let mut child = tokio::process::Command::new(&bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Couldn't start the {name} login ({e})"))?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let mut out = BufReader::new(child.stdout.take().ok_or("no output")?).lines();
    let mut err = BufReader::new(child.stderr.take().ok_or("no output")?).lines();
    let tx2 = tx.clone();
    tokio::spawn(async move {
        while let Ok(Some(l)) = out.next_line().await {
            let _ = tx.send(l);
        }
    });
    tokio::spawn(async move {
        while let Ok(Some(l)) = err.next_line().await {
            let _ = tx2.send(l);
        }
    });
    let mut tail = String::new();
    let mut sent_url = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(300);
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Err(_) => {
                let _ = child.kill().await;
                return Err("Sign in timed out after 5 minutes. Try again.".into());
            }
            Ok(None) => break,
            Ok(Some(line)) => {
                if !sent_url {
                    if let Some(url) = line.split_whitespace().find(|w| w.starts_with("https://")) {
                        sent_url = true;
                        let _ = app.emit("alter://cli-login-url", serde_json::json!({ "kind": kind, "url": url }));
                    }
                }
                if !line.trim().is_empty() {
                    tail = line;
                }
            }
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() {
        Ok(format!("Signed {name} in."))
    } else {
        Err(if tail.is_empty() { "Sign in didn't finish.".into() } else { tail })
    }
}

pub fn signin_hint(msg: &str) -> Option<String> {
    let m = msg.to_lowercase();
    (m.contains("sign in") || m.contains("log in") || m.contains("logged in") || m.contains("401") || m.contains("unauthorized") || m.contains("access token"))
        .then(|| "Codex isn't signed in, or its login expired. Sign in to continue.".to_string())
}

#[tauri::command]
pub async fn codex_check() -> Result<String, String> {
    let bin = find("codex").ok_or("Codex isn't installed. Install the Codex app or the codex CLI first.")?;
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(90),
        tokio::process::Command::new(&bin)
            .args(["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-c", "sandbox_mode=\"read-only\"", "Reply with the single word ok."])
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| "Codex didn't answer within 90 seconds.".to_string())?
    .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if kind == "error" || kind == "turn.failed" {
            let msg = v
                .get("message")
                .or_else(|| v.get("error").and_then(|e| e.get("message")))
                .and_then(|x| x.as_str())
                .unwrap_or("Codex failed.")
                .to_string();
            return Err(signin_hint(&msg).unwrap_or(msg));
        }
        if kind == "turn.completed" {
            let version = output(&bin, &["--version"]).map(|(_, t)| t).unwrap_or_default();
            return Ok(format!("Codex ready · {version} · signed in and answering"));
        }
    }
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    Err(signin_hint(&err).unwrap_or_else(|| err.lines().last().unwrap_or("Codex gave no answer.").to_string()))
}
