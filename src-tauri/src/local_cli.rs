use std::path::PathBuf;
use std::process::{Command, Stdio};

fn home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_default()
}

fn shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
    let mut child = Command::new(&shell)
        .args(["-ilc", "printf '__ALTER_PATH__%s__ALTER_PATH__' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    use std::io::Read;
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let start = out.find("__ALTER_PATH__")? + "__ALTER_PATH__".len();
    let end = out[start..].find("__ALTER_PATH__")? + start;
    Some(out[start..end].to_string())
}

fn versioned_bins(dir: PathBuf, suffix: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|rd| rd.flatten().map(|e| e.path().join(suffix)).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    v.sort();
    v.reverse();
    v
}

fn extra_dirs() -> Vec<PathBuf> {
    let h = home();
    let mut dirs: Vec<PathBuf> = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/opt/local/bin"].iter().map(PathBuf::from).collect();
    for d in [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".volta/bin", "Library/pnpm", ".yarn/bin", ".asdf/shims", ".local/share/mise/shims", ".cargo/bin", "bin"] {
        dirs.push(h.join(d));
    }
    dirs.extend(versioned_bins(h.join(".nvm/versions/node"), "bin"));
    dirs.extend(versioned_bins(h.join("Library/Application Support/fnm/node-versions"), "installation/bin"));
    dirs.extend(versioned_bins(h.join(".local/share/fnm/node-versions"), "installation/bin"));
    dirs.push(PathBuf::from("/usr/bin"));
    dirs.push(PathBuf::from("/bin"));
    dirs
}

pub fn fix_path() {
    let mut parts: Vec<String> = Vec::new();
    let mut add = |p: &str| {
        if !p.is_empty() && !parts.iter().any(|x| x == p) {
            parts.push(p.to_string());
        }
    };
    if let Some(sp) = shell_path() {
        sp.split(':').for_each(&mut add);
    }
    std::env::var("PATH").unwrap_or_default().split(':').for_each(&mut add);
    for d in extra_dirs().into_iter().filter(|d| d.is_dir()) {
        add(&d.display().to_string());
    }
    std::env::set_var("PATH", parts.join(":"));
}

fn overrides_file() -> PathBuf {
    home().join("Library/Application Support/com.ejaaz.alter/cli-paths.json")
}

fn override_for(name: &str) -> Option<PathBuf> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(overrides_file()).ok()?).ok()?;
    let p = PathBuf::from(v[name].as_str()?);
    p.is_file().then_some(p)
}

fn is_exec(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

fn search_bundle(dir: &std::path::Path, name: &str, depth: u8) -> Option<PathBuf> {
    let entries: Vec<PathBuf> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).collect();
    if let Some(p) = entries.iter().find(|p| p.file_name().map(|n| n == name).unwrap_or(false) && is_exec(p)) {
        return Some(p.clone());
    }
    if depth == 0 {
        return None;
    }
    let skip = ["node_modules", "Frameworks", "MacOS", "_CodeSignature"];
    let mut subdirs: Vec<PathBuf> = entries
        .into_iter()
        .filter(|p| p.is_dir() && !skip.iter().any(|s| p.file_name().map(|n| n == *s).unwrap_or(false)))
        .collect();
    subdirs.sort();
    subdirs.iter().find_map(|d| search_bundle(d, name, depth - 1))
}

fn find_in_apps(name: &str, keys: &[&str]) -> Option<PathBuf> {
    let h = home();
    for root in [PathBuf::from("/Applications"), h.join("Applications")] {
        let Ok(rd) = std::fs::read_dir(&root) else { continue };
        let mut apps: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                let n = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
                n.ends_with(".app") && keys.iter().any(|k| n.contains(k))
            })
            .collect();
        apps.sort();
        if let Some(p) = apps.iter().find_map(|a| search_bundle(&a.join("Contents"), name, 4)) {
            return Some(p);
        }
    }
    None
}

pub fn find(name: &str) -> Option<PathBuf> {
    if let Some(p) = override_for(name) {
        return Some(p);
    }
    let dirs: Vec<PathBuf> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .chain(extra_dirs())
        .collect();
    if let Some(p) = dirs.iter().map(|d| d.join(name)).find(|p| p.is_file()) {
        return Some(p);
    }
    match name {
        "codex" => find_in_apps("codex", &["codex", "chatgpt"]),
        "claude" => find_in_apps("claude", &["claude"]),
        _ => None,
    }
}

#[tauri::command]
pub fn cli_set_path(kind: String, path: Option<String>) -> Result<String, String> {
    let name = if kind == "codex" { "codex" } else { "claude" };
    let file = overrides_file();
    let mut v: serde_json::Value = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| serde_json::json!({}));
    match path.filter(|p| !p.trim().is_empty()) {
        None => {
            v.as_object_mut().map(|o| o.remove(name));
        }
        Some(p) => {
            let p = PathBuf::from(p.trim());
            let p = if p.extension().map(|e| e == "app").unwrap_or(false) {
                search_bundle(&p.join("Contents"), name, 4).ok_or(format!("No {name} program inside {}.", p.display()))?
            } else {
                p
            };
            if !is_exec(&p) {
                return Err(format!("{} is not a program Alter can run.", p.display()));
            }
            let ok = Command::new(&p).arg("--version").stdin(Stdio::null()).output().map(|o| o.status.success()).unwrap_or(false);
            if !ok {
                return Err(format!("{} did not answer --version, so it does not look like the {name} CLI.", p.display()));
            }
            v[name] = serde_json::Value::String(p.display().to_string());
        }
    }
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&file, v.to_string()).map_err(|e| e.to_string())?;
    Ok(find(name).map(|p| p.display().to_string()).unwrap_or_default())
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

fn install_command(name: &str) -> Result<String, String> {
    if name == "claude" {
        return Ok("curl -fsSL https://claude.ai/install.sh | bash".into());
    }
    if let Some(npm) = find("npm") {
        return Ok(format!("'{}' install -g @openai/codex", npm.display()));
    }
    if let Some(brew) = find("brew") {
        return Ok(format!("'{}' install codex", brew.display()));
    }
    Err("Installing the Codex CLI needs Node (npm) or Homebrew, and neither was found. Install Node from nodejs.org, or the Codex app from openai.com/codex, then come back.".into())
}

#[tauri::command]
pub fn cli_install_terminal(kind: String) -> Result<String, String> {
    let name = if kind == "codex" { "codex" } else { "claude" };
    let cmd = install_command(name)?;
    let label = if name == "claude" { "Claude Code" } else { "Codex" };
    let script = format!(
        "#!/bin/sh\nclear\necho 'Installing the {label} CLI for Alter:'\necho '  {}'\necho\n{cmd}\necho\necho 'Done. Go back to Alter, it checks again when you switch to it.'\n",
        cmd.replace('\'', "")
    );
    let path = std::env::temp_dir().join(format!("alter-{name}-install.sh"));
    std::fs::write(&path, script).map_err(|e| e.to_string())?;
    let osa = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"sh '{}'\"\nend tell",
        path.display().to_string().replace('"', "\\\"")
    );
    Command::new("osascript").arg("-e").arg(osa).output().map_err(|e| e.to_string())?;
    Ok(cmd)
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
    if m.contains("not supported when using codex with a chatgpt account") || m.contains("do not have access to it") {
        return Some("This ChatGPT account can't use Codex. Codex needs a ChatGPT Plus, Pro, Team or Enterprise plan, or sign in with a different account.".into());
    }
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
        if kind == "turn.failed" || (kind == "error" && !v.get("message").and_then(|x| x.as_str()).unwrap_or("").starts_with("Reconnecting")) {
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


