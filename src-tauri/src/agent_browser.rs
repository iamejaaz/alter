use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;
use tauri::Manager;

pub const CDP_PORT: u16 = 9333;
const PLAYWRIGHT_MCP: &str = "@playwright/mcp@0.0.83";

fn home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_default()
}

const CHROMIUM: [(&str, &str); 7] = [
    ("com.brave.browser", "Brave Browser.app"),
    ("com.google.chrome", "Google Chrome.app"),
    ("com.microsoft.edgemac", "Microsoft Edge.app"),
    ("org.chromium.chromium", "Chromium.app"),
    ("com.vivaldi.vivaldi", "Vivaldi.app"),
    ("com.operasoftware.opera", "Opera.app"),
    ("company.thebrowser.browser", "Arc.app"),
];

fn default_browser_id() -> Option<String> {
    let out = std::process::Command::new("defaults")
        .args(["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut role: Option<String> = None;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('{') || l.starts_with('}') {
            role = None;
        }
        if let Some(v) = l.strip_prefix("LSHandlerRoleAll = ") {
            role = Some(v.trim_end_matches(';').trim_matches('"').to_lowercase());
        }
        if l.starts_with("LSHandlerURLScheme = https") {
            return role;
        }
    }
    None
}

fn app_path(name: &str) -> Option<PathBuf> {
    [PathBuf::from("/Applications").join(name), home().join("Applications").join(name)].into_iter().find(|p| p.is_dir())
}

fn chrome_app() -> Option<PathBuf> {
    let preferred = default_browser_id().and_then(|id| CHROMIUM.iter().find(|(b, _)| *b == id).map(|(_, n)| *n));
    preferred.and_then(app_path).or_else(|| CHROMIUM.iter().find_map(|(_, n)| app_path(n)))
}

pub fn browser_name() -> Option<String> {
    chrome_app().and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_string()))
}

pub fn profile_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("browser-profile");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn media_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("media");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn cdp_get(path: &str) -> Option<String> {
    let mut s = std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], CDP_PORT).into(), Duration::from_millis(400)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{CDP_PORT}\r\nConnection: close\r\n\r\n").ok()?;
    let mut out = String::new();
    s.read_to_string(&mut out).ok()?;
    out.split_once("\r\n\r\n").map(|(_, b)| b.to_string())
}

pub fn ws_url() -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(&cdp_get("/json/version")?).ok()?;
    v["webSocketDebuggerUrl"].as_str().map(|s| s.to_string())
}

pub fn is_up() -> bool {
    ws_url().is_some()
}

pub fn ensure(app: &tauri::AppHandle, front: bool) -> Result<(), String> {
    if is_up() {
        if front {
            if let Some(list) = cdp_get("/json/list").and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok()) {
                if let Some(id) = list.as_array().and_then(|a| a.iter().find(|t| t["type"] == "page")).and_then(|t| t["id"].as_str()) {
                    let _ = cdp_get(&format!("/json/activate/{id}"));
                }
            }
            if let Some(a) = chrome_app() {
                let _ = std::process::Command::new("open").arg(&a).spawn();
            }
        }
        return Ok(());
    }
    let chrome = chrome_app().ok_or("No Chromium based browser found (Brave, Chrome, Edge, Chromium, Vivaldi, Opera or Arc). Safari and Firefox can't be driven. Install one of those to use the agent browser.")?;
    let profile = profile_dir(app)?;
    let mut cmd = std::process::Command::new("open");
    if !front {
        cmd.arg("-g");
    }
    cmd.arg("-n")
        .arg("-a")
        .arg(&chrome)
        .arg("--args")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(format!("--remote-debugging-port={CDP_PORT}"))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("about:blank");
    cmd.spawn().map_err(|e| format!("Couldn't start the agent browser ({e})"))?;
    for _ in 0..40 {
        if is_up() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "The agent browser started but did not open its control port {CDP_PORT}. Another program may be using that port."
    ))
}

fn node_bin() -> Option<PathBuf> {
    if let Some(p) = crate::local_cli::find("npx") {
        return p.parent().map(|d| d.to_path_buf());
    }
    let nvm = home().join(".nvm/versions/node");
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&nvm).ok()?.flatten().map(|e| e.path().join("bin")).filter(|d| d.join("npx").is_file()).collect();
    dirs.sort();
    dirs.pop()
}

pub fn mcp_entry(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let bin = node_bin().ok_or("Node is not installed, so the browser connector can't start. Install Node 18 or newer.")?;
    let path = format!("{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", bin.display());
    Ok(serde_json::json!({
        "command": bin.join("npx").display().to_string(),
        "args": ["-y", PLAYWRIGHT_MCP, "--cdp-endpoint", format!("http://127.0.0.1:{CDP_PORT}"), "--output-dir", media_dir(app)?.display().to_string()],
        "env": { "PATH": path },
    }))
}

#[tauri::command]
pub fn agent_browser_open(app: tauri::AppHandle) -> Result<(), String> {
    ensure(&app, true)
}

#[tauri::command]
pub fn agent_browser_status() -> serde_json::Value {
    serde_json::json!({ "running": is_up(), "browser": browser_name() })
}

#[tauri::command]
pub fn agent_browser_mcp(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let entry = mcp_entry(&app)?;
    let npx = entry["command"].as_str().unwrap_or("npx").to_string();
    let path = entry["env"]["PATH"].as_str().unwrap_or("").to_string();
    std::thread::spawn(move || {
        let _ = std::process::Command::new(npx)
            .args(["-y", PLAYWRIGHT_MCP, "--version"])
            .env("PATH", path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    });
    Ok(entry)
}

pub fn needs_browser(mcp: &Option<serde_json::Value>) -> bool {
    mcp.as_ref().map(|m| m.get("browser").is_some()).unwrap_or(false)
}

pub fn claude_config(mcp: &Option<serde_json::Value>) -> Option<PathBuf> {
    let servers = mcp.as_ref().filter(|m| m.as_object().map(|o| !o.is_empty()).unwrap_or(false))?;
    let body = serde_json::json!({ "mcpServers": servers }).to_string();
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    body.hash(&mut h);
    let path = std::env::temp_dir().join(format!("alter-mcp-{:x}.json", h.finish()));
    std::fs::write(&path, body).ok()?;
    Some(path)
}

fn toml_str(s: &str) -> String {
    serde_json::Value::String(s.to_string()).to_string()
}

pub fn codex_overrides(mcp: &Option<serde_json::Value>) -> Vec<String> {
    let mut out = Vec::new();
    let Some(map) = mcp.as_ref().and_then(|m| m.as_object()) else { return out };
    for (name, s) in map {
        let key: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
        if let Some(url) = s["url"].as_str() {
            out.push(format!("mcp_servers.{key}.url={}", toml_str(url)));
            continue;
        }
        let Some(command) = s["command"].as_str() else { continue };
        out.push(format!("mcp_servers.{key}.command={}", toml_str(command)));
        let args: Vec<String> = s["args"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).map(toml_str).collect()).unwrap_or_default();
        out.push(format!("mcp_servers.{key}.args=[{}]", args.join(",")));
        if let Some(env) = s["env"].as_object().filter(|e| !e.is_empty()) {
            let pairs: Vec<String> = env.iter().filter_map(|(k, v)| v.as_str().map(|v| format!("{}={}", toml_str(k), toml_str(v)))).collect();
            out.push(format!("mcp_servers.{key}.env={{{}}}", pairs.join(",")));
        }
    }
    out
}
