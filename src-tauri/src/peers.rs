// Cross-session messaging with Claude Code, over the same local socket protocol
// its sessions use between themselves: a registry entry per session under
// ~/.claude/sessions, a Unix socket under /tmp/cc-socks, and a per-session auth
// token beside the registry entry. Alter registers itself once, as "Alter", so
// every Claude session lists it as a peer and can message it back.
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

const SOCK_DIR: &str = "/tmp/cc-socks";

static SELF: Mutex<Option<Registration>> = Mutex::new(None);

struct Registration {
    sock: PathBuf,
    key: PathBuf,
    json: PathBuf,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub pid: u32,
    pub name: String,
    pub cwd: String,
    pub status: String,
    pub session_id: String,
}

fn sessions_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| Path::new(&h).join(".claude/sessions"))
}

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

fn peer_token(sock: &str) -> Option<String> {
    let dir = sessions_dir()?;
    let suffix = format!(".{}.key", sha256_hex(sock));
    let key = std::fs::read_dir(&dir).ok()?.flatten().map(|e| e.path()).find(|p| {
        p.file_name().and_then(|n| n.to_str()).map(|n| n.ends_with(&suffix)).unwrap_or(false)
    })?;
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(key).ok()?).ok()?;
    v["peerToken"].as_str().map(|s| s.to_string())
}

fn proc_start(pid: u32) -> String {
    std::process::Command::new("ps")
        .env("TZ", "UTC")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn encode_addr(path: &str) -> String {
    let mut out = String::new();
    for b in path.bytes() {
        let c = b as char;
        if c.is_ascii_alphanumeric() || ":_/.\\-".contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn decode_addr(addr: &str) -> Option<String> {
    let path = addr.strip_prefix("uds:")?;
    urlencoding::decode(path).ok().map(|s| s.to_string())
}

fn read_registry() -> Vec<(u32, serde_json::Value)> {
    let Some(dir) = sessions_dir() else { return vec![] };
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    rd.flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_str()?.to_string();
            let pid: u32 = name.strip_suffix(".json")?.parse().ok()?;
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).ok()?).ok()?;
            Some((pid, v))
        })
        .collect()
}

pub fn list() -> Vec<Peer> {
    let me = std::process::id();
    let mut out: Vec<Peer> = read_registry()
        .into_iter()
        .filter(|(pid, _)| *pid != me)
        .filter_map(|(pid, v)| {
            let sock = v["messagingSocketPath"].as_str()?;
            if UnixStream::connect(sock).is_err() {
                return None;
            }
            Some(Peer {
                pid,
                name: v["name"].as_str().unwrap_or("").to_string(),
                cwd: v["cwd"].as_str().unwrap_or("").to_string(),
                status: v["status"].as_str().unwrap_or("").to_string(),
                session_id: v["sessionId"].as_str().unwrap_or("").to_string(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn self_addr() -> Option<String> {
    let reg = SELF.lock().unwrap_or_else(|e| e.into_inner());
    reg.as_ref().map(|r| format!("uds:{}", encode_addr(&r.sock.to_string_lossy())))
}

fn write_frames(sock: &str, frames: &[serde_json::Value]) -> Result<(), String> {
    let token = peer_token(sock).ok_or("no auth key published for that session")?;
    let mut s = UnixStream::connect(sock).map_err(|e| format!("session socket unreachable: {e}"))?;
    let mut body = serde_json::json!({ "type": "auth", "token": token }).to_string();
    body.push('\n');
    for f in frames {
        body.push_str(&f.to_string());
        body.push('\n');
    }
    s.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    let _ = s.shutdown(std::net::Shutdown::Write);
    Ok(())
}

pub fn send(pid: u32, text: &str, from_name: &str) -> Result<String, String> {
    let (_, v) = read_registry().into_iter().find(|(p, _)| *p == pid).ok_or("that session is gone")?;
    let sock = v["messagingSocketPath"].as_str().ok_or("that session has no inbox")?.to_string();
    let msg_id = super::bridge::gen_token();
    let frame = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text },
        "from": self_addr().unwrap_or_else(|| "bridge:alter".into()),
        "from_name": from_name,
        "msg_id": msg_id,
        "from_mode": "bypass",
    });
    write_frames(&sock, &[frame])?;
    Ok(msg_id)
}

fn receipt(to_addr: &str, orig_msg_id: &str) {
    let Some(sock) = decode_addr(to_addr) else { return };
    let Some(from) = self_addr() else { return };
    let frame = serde_json::json!({
        "type": "control",
        "action": "peer_message_status",
        "status": "delivered",
        "orig_msg_id": orig_msg_id,
        "from": from,
    });
    let _ = write_frames(&sock, &[frame]);
}

fn sender_pid(addr: &str) -> Option<u32> {
    let path = decode_addr(addr)?;
    let name = Path::new(&path).file_name()?.to_str()?;
    name.strip_suffix(".sock")?.split('-').next()?.parse().ok()
}

fn handle_conn(stream: UnixStream, token: &str, app: &AppHandle) {
    let mut reader = BufReader::new(stream);
    let mut authed = false;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
        match v["type"].as_str() {
            Some("auth") => {
                authed = v["token"].as_str() == Some(token);
                if !authed {
                    break;
                }
            }
            Some("user") if authed => {
                let Some(content) = v["message"]["content"].as_str() else { continue };
                let from = v["from"].as_str().unwrap_or("").to_string();
                let pid = sender_pid(&from);
                let registered = pid
                    .and_then(|p| read_registry().into_iter().find(|(x, _)| *x == p))
                    .and_then(|(_, r)| r["name"].as_str().map(|s| s.to_string()));
                let name = registered
                    .or_else(|| v["from_name"].as_str().map(|s| s.to_string()))
                    .unwrap_or_else(|| "Claude session".to_string());
                let msg_id = v["msg_id"].as_str().unwrap_or("").to_string();
                let _ = app.emit(
                    "alter://peer-message",
                    serde_json::json!({
                        "from": from,
                        "fromPid": pid,
                        "fromName": name,
                        "msgId": msg_id,
                        "content": content,
                    }),
                );
                if !msg_id.is_empty() && from.starts_with("uds:") {
                    receipt(&from, &msg_id);
                }
            }
            Some("control") if authed => {
                if v["action"].as_str() == Some("peer_message_status") {
                    let _ = app.emit(
                        "alter://peer-status",
                        serde_json::json!({
                            "origMsgId": v["orig_msg_id"],
                            "status": v["status"],
                            "from": v["from"],
                        }),
                    );
                }
            }
            _ => {}
        }
    }
}

pub fn start(app: AppHandle) {
    let Some(sessions) = sessions_dir() else { return };
    let _ = std::fs::create_dir_all(&sessions);
    let _ = std::fs::create_dir_all(SOCK_DIR);
    let _ = std::fs::set_permissions(SOCK_DIR, std::fs::Permissions::from_mode(0o700));
    let pid = std::process::id();
    let sock = Path::new(SOCK_DIR).join(format!("{pid}.sock"));
    let _ = std::fs::remove_file(&sock);
    let listener = match UnixListener::bind(&sock) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("peers: cannot bind {}: {e}", sock.display());
            return;
        }
    };
    let _ = std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600));
    let token = super::bridge::gen_token();
    let sock_str = sock.to_string_lossy().to_string();
    let key = sessions.join(format!("{pid}.{}.key", sha256_hex(&sock_str)));
    let started = proc_start(pid);
    let _ = std::fs::write(
        &key,
        serde_json::json!({ "peerToken": token, "procStart": started, "pidDomain": "darwin" }).to_string(),
    );
    let _ = std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600));
    let now = chrono::Utc::now().timestamp_millis();
    let json = sessions.join(format!("{pid}.json"));
    let _ = std::fs::write(
        &json,
        serde_json::json!({
            "pid": pid,
            "sessionId": format!("alter-{pid}"),
            "cwd": std::env::var("HOME").unwrap_or_default(),
            "startedAt": now,
            "procStart": started,
            "version": env!("CARGO_PKG_VERSION"),
            "peerProtocol": 1,
            "peerFeatures": [],
            "kind": "interactive",
            "entrypoint": "alter",
            "pidDomain": "darwin",
            "messagingSocketPath": sock_str,
            "name": "Alter",
            "nameSince": now,
            "updatedAt": now,
            "status": "idle",
            "statusUpdatedAt": now,
        })
        .to_string(),
    );
    *SELF.lock().unwrap_or_else(|e| e.into_inner()) = Some(Registration { sock, key, json });

    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let app = app.clone();
            let token = token.clone();
            std::thread::spawn(move || handle_conn(conn, &token, &app));
        }
    });
}

pub fn stop() {
    if let Some(r) = SELF.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = std::fs::remove_file(&r.sock);
        let _ = std::fs::remove_file(&r.key);
        let _ = std::fs::remove_file(&r.json);
    }
}

#[tauri::command]
pub async fn peers_list() -> Vec<Peer> {
    tauri::async_runtime::spawn_blocking(list).await.unwrap_or_default()
}

#[tauri::command]
pub async fn peer_send(pid: u32, text: String, #[allow(non_snake_case)] fromName: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || send(pid, &text, &fromName))
        .await
        .map_err(|e| e.to_string())?
}
