use std::path::PathBuf;
use std::sync::Mutex;

static TRACKED: Mutex<Vec<(u32, String)>> = Mutex::new(Vec::new());

fn file() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join("Library/Application Support/com.ejaaz.alter/children.txt"))
}

fn start_times(pids: &[u32]) -> Vec<(u32, String)> {
    if pids.is_empty() {
        return Vec::new();
    }
    let list = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
    let Ok(out) = std::process::Command::new("ps").args(["-o", "pid=,lstart=", "-p", &list]).output() else { return Vec::new() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            let (pid, start) = l.split_once(char::is_whitespace)?;
            Some((pid.parse().ok()?, start.trim().to_string()))
        })
        .collect()
}

fn save(list: &[(u32, String)]) {
    if let Some(f) = file() {
        let body: String = list.iter().map(|(p, s)| format!("{p}\t{s}\n")).collect();
        let _ = std::fs::write(f, body);
    }
}

fn alive(list: &[(u32, String)]) -> Vec<(u32, String)> {
    let now = start_times(&list.iter().map(|(p, _)| *p).collect::<Vec<_>>());
    list.iter().filter(|e| now.contains(e)).cloned().collect()
}

pub fn track(pid: u32) {
    let mut list = TRACKED.lock().unwrap_or_else(|e| e.into_inner());
    let mut pids: Vec<u32> = list.iter().map(|(p, _)| *p).collect();
    pids.push(pid);
    let now = start_times(&pids);
    let mut next = alive(&list);
    if let Some(e) = now.into_iter().find(|(p, _)| *p == pid) {
        next.push(e);
    }
    *list = next;
    save(&list);
}

fn kill_group(pid: u32) {
    for target in [format!("-{pid}"), pid.to_string()] {
        let _ = std::process::Command::new("kill").args(["-TERM", "--", &target]).status();
    }
}

fn kill_list(list: &[(u32, String)]) {
    let live = alive(list);
    for (pid, _) in &live {
        kill_group(*pid);
    }
    if live.is_empty() {
        return;
    }
    std::thread::sleep(std::time::Duration::from_millis(800));
    for (pid, _) in alive(&live) {
        for target in [format!("-{pid}"), pid.to_string()] {
            let _ = std::process::Command::new("kill").args(["-KILL", "--", &target]).status();
        }
    }
}

pub fn kill_all() {
    let mut list = TRACKED.lock().unwrap_or_else(|e| e.into_inner());
    kill_list(&list);
    list.clear();
    save(&list);
}

pub fn sweep() {
    let Some(f) = file() else { return };
    let Ok(body) = std::fs::read_to_string(&f) else { return };
    let old: Vec<(u32, String)> = body
        .lines()
        .filter_map(|l| {
            let (p, s) = l.split_once('\t')?;
            Some((p.parse().ok()?, s.to_string()))
        })
        .collect();
    kill_list(&old);
    let _ = std::fs::remove_file(f);
}
