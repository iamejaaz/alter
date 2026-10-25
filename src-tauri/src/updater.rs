use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

pub static BUSY: AtomicBool = AtomicBool::new(false);
static READY: Mutex<Option<(String, PathBuf)>> = Mutex::new(None);
static BUILDING: AtomicBool = AtomicBool::new(false);

const REPO: &str = "https://github.com/iamejaaz/alter.git";

fn installed_app() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(|p| p.to_path_buf())
}

fn git(root: &std::path::Path, args: &[&str]) -> Option<String> {
    let o = std::process::Command::new("git").arg("-C").arg(root).args(args).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn log_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("update.log"))
}

fn status(app: &AppHandle, text: &str) {
    let _ = app.emit("alter://update", serde_json::json!({ "text": text }));
}

pub fn busy(app: &AppHandle) -> bool {
    BUSY.load(Ordering::SeqCst)
        || app
            .try_state::<crate::bridge::BridgeState>()
            .map(|s| !s.running.lock().unwrap_or_else(|e| e.into_inner()).is_empty())
            .unwrap_or(false)
}

fn check(app: &AppHandle) {
    if BUILDING.load(Ordering::SeqCst) {
        return;
    }
    let root = crate::bridge::repo_root();
    if !root.join(".git").exists() {
        return;
    }
    if git(&root, &["fetch", "--quiet", REPO, "master"]).is_none() {
        return;
    }
    let Some(remote) = git(&root, &["rev-parse", "FETCH_HEAD"]) else { return };
    if remote == env!("ALTER_BUILD_COMMIT") {
        return;
    }
    if READY.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|(c, _)| *c == remote) {
        return;
    }
    let up = crate::bridge::self_update();
    if up["ok"].as_bool() != Some(true) {
        status(app, &format!("Update skipped: {}", up["error"].as_str().unwrap_or("the local copy can't be fast forwarded")));
        return;
    }
    let Some(head) = git(&root, &["rev-parse", "HEAD"]) else { return };
    BUILDING.store(true, Ordering::SeqCst);
    status(app, "Building the new version of Alter in the background…");
    let log = log_path(app).and_then(|p| std::fs::File::create(p).ok());
    let mut cmd = std::process::Command::new("/bin/zsh");
    cmd.arg("-lc")
        .arg("npm install --no-audit --no-fund --silent && npm run tauri build -- --bundles app")
        .current_dir(&root)
        .stdin(std::process::Stdio::null());
    if let Some(f) = log {
        if let Ok(f2) = f.try_clone() {
            cmd.stdout(f).stderr(f2);
        }
    }
    let ok = cmd.status().map(|s| s.success()).unwrap_or(false);
    BUILDING.store(false, Ordering::SeqCst);
    let built = root.join("src-tauri/target/release/bundle/macos/Alter.app");
    if ok && built.is_dir() {
        *READY.lock().unwrap_or_else(|e| e.into_inner()) = Some((head, built));
        status(app, "A new version of Alter is ready. It restarts when no chat is running.");
    } else {
        status(app, "Building the update failed. Details are in update.log in Alter's data folder.");
    }
}

fn swap(app: &AppHandle, new_app: &std::path::Path) {
    let Some(dest) = installed_app() else { return };
    let shown = app
        .get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .unwrap_or(false);
    let script = format!(
        "#!/bin/sh\nwhile kill -0 {pid} 2>/dev/null; do sleep 0.3; done\nrm -rf '{d}.old'\nmv '{d}' '{d}.old' && ditto '{n}' '{d}' && rm -rf '{d}.old' || mv '{d}.old' '{d}'\n{open}\n",
        open = if shown { format!("open '{}'", dest.display()) } else { format!("open -g '{}' --args --background", dest.display()) },
        pid = std::process::id(),
        d = dest.display(),
        n = new_app.display()
    );
    let path = std::env::temp_dir().join("alter-swap.sh");
    if std::fs::write(&path, script).is_err() {
        return;
    }
    if std::process::Command::new("/bin/sh").arg(&path).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().is_ok() {
        app.exit(0);
    }
}

pub fn start(app: AppHandle) {
    if installed_app().is_none() || env!("ALTER_BUILD_COMMIT").is_empty() {
        return;
    }
    let a = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        loop {
            check(&a);
            std::thread::sleep(Duration::from_secs(600));
        }
    });
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(20));
        let ready = READY.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some((_, path)) = ready {
            if !busy(&app) {
                swap(&app, &path);
            }
        }
    });
}

#[tauri::command]
pub fn update_now(app: AppHandle, _s: State<'_, crate::bridge::BridgeState>) -> String {
    if installed_app().is_none() {
        return "Auto update works in the installed app, not in npm run dev.".into();
    }
    let ready = READY.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some((_, path)) = ready {
        swap(&app, &path);
        return "Restarting into the new version.".into();
    }
    let a = app.clone();
    std::thread::spawn(move || check(&a));
    "Checking for a new version.".into()
}
