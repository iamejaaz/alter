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

fn html_to_text(html: &str) -> String {
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

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36")
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn fetch_url(url: String) -> Result<String, String> {
    let client = http_client()?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let mut text = html_to_text(&body);
    if text.len() > 12_000 {
        text.truncate(12_000);
        text.push_str("\n[truncated]");
    }
    Ok(format!("HTTP {} — {}\n\n{}", status.as_u16(), url, text))
}

#[tauri::command]
async fn web_search(query: String) -> Result<String, String> {
    let client = http_client()?;
    let resp = client
        .get("https://lite.duckduckgo.com/lite/")
        .query(&[("q", &query)])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let html = resp.text().await.map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    for part in html.split("href=\"").skip(1) {
        if let Some(end) = part.find('"') {
            let href = &part[..end];
            if href.starts_with("http") && !href.contains("duckduckgo.com") {
                let title_start = part.find('>').map(|p| p + 1).unwrap_or(0);
                let title_end = part[title_start..].find("</a>").map(|p| title_start + p);
                if let Some(te) = title_end {
                    let title = html_to_text(&part[title_start..te]);
                    if !title.is_empty() {
                        results.push(format!("{}\n{}", title, href));
                    }
                }
            }
        }
        if results.len() >= 8 {
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
            fetch_url,
            web_search,
            save_routine_state,
            take_routine_results
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
}
