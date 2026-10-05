use headless_chrome::browser::tab::point::Point;
use headless_chrome::protocol::cdp::Page;
use headless_chrome::{Browser, Tab};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
pub struct PaneState(pub Mutex<Option<Browser>>);

fn front_target() -> Option<String> {
    let list: serde_json::Value = serde_json::from_str(&crate::agent_browser::cdp_get("/json/list")?).ok()?;
    list.as_array()?
        .iter()
        .find(|t| t["type"] == "page" && !t["url"].as_str().unwrap_or("").starts_with("devtools://"))
        .and_then(|t| t["id"].as_str())
        .map(|s| s.to_string())
}

fn tab(state: &PaneState) -> Result<Arc<Tab>, String> {
    let ws = crate::agent_browser::ws_url().ok_or("not_running")?;
    let target = front_target().ok_or("The agent browser has no open tab.")?;
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(Browser::connect_with_timeout(ws, Duration::from_secs(7 * 24 * 3600)).map_err(|e| e.to_string())?);
    }
    let browser = guard.as_ref().unwrap();
    for _ in 0..25 {
        let found = browser.get_tabs().lock().ok().and_then(|tabs| tabs.iter().find(|t| *t.get_target_id() == target).cloned());
        if let Some(t) = found {
            return Ok(t);
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    *guard = None;
    Err("Could not attach to the agent browser's tab.".into())
}

fn drop_on_error<T>(state: &PaneState, r: Result<T, String>) -> Result<T, String> {
    if r.is_err() {
        if let Ok(mut g) = state.0.lock() {
            *g = None;
        }
    }
    r
}

#[tauri::command]
pub async fn pane_snapshot(state: tauri::State<'_, PaneState>) -> Result<serde_json::Value, String> {
    let r = (|| {
        let t = tab(&state)?;
        let img = t
            .capture_screenshot(Page::CaptureScreenshotFormatOption::Jpeg, Some(70), None, true)
            .map_err(|e| e.to_string())?;
        let size = t
            .evaluate("JSON.stringify([innerWidth, innerHeight])", false)
            .ok()
            .and_then(|o| o.value)
            .and_then(|v| v.as_str().and_then(|s| serde_json::from_str::<Vec<f64>>(s).ok()))
            .unwrap_or_else(|| vec![0.0, 0.0]);
        Ok(serde_json::json!({
            "url": t.get_url(),
            "title": t.get_title().unwrap_or_default(),
            "image": crate::bridge::base64_encode(&img),
            "width": size.first().copied().unwrap_or(0.0),
            "height": size.get(1).copied().unwrap_or(0.0),
        }))
    })();
    drop_on_error(&state, r)
}

#[tauri::command]
pub async fn pane_click(state: tauri::State<'_, PaneState>, x: f64, y: f64) -> Result<(), String> {
    let r = tab(&state).and_then(|t| t.click_point(Point { x, y }).map(|_| ()).map_err(|e| e.to_string()));
    drop_on_error(&state, r)
}

#[tauri::command]
pub async fn pane_type(state: tauri::State<'_, PaneState>, text: String) -> Result<(), String> {
    let r = tab(&state).and_then(|t| t.type_str(&text).map(|_| ()).map_err(|e| e.to_string()));
    drop_on_error(&state, r)
}

#[tauri::command]
pub async fn pane_key(state: tauri::State<'_, PaneState>, key: String) -> Result<(), String> {
    let allowed = ["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "PageUp", "PageDown", "Home", "End"];
    if !allowed.contains(&key.as_str()) {
        return Err("unsupported key".into());
    }
    let r = tab(&state).and_then(|t| t.press_key(&key).map(|_| ()).map_err(|e| e.to_string()));
    drop_on_error(&state, r)
}

#[tauri::command]
pub async fn pane_scroll(state: tauri::State<'_, PaneState>, x: f64, y: f64, dy: f64) -> Result<(), String> {
    let r = tab(&state).and_then(|t| {
        t.evaluate(
            &format!("(document.elementFromPoint({x},{y})||document.scrollingElement).closest('*').scrollBy?.(0,{dy}); window.scrollBy(0,0)"),
            false,
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    });
    drop_on_error(&state, r)
}

#[tauri::command]
pub async fn pane_navigate(state: tauri::State<'_, PaneState>, action: String, url: Option<String>) -> Result<(), String> {
    let r = tab(&state).and_then(|t| {
        let res = match action.as_str() {
            "back" => t.evaluate("history.back()", false).map(|_| ()),
            "forward" => t.evaluate("history.forward()", false).map(|_| ()),
            "reload" => t.reload(false, None).map(|_| ()),
            _ => {
                let raw = url.unwrap_or_default();
                let raw = raw.trim();
                let target = if raw.contains("://") {
                    raw.to_string()
                } else if raw.contains('.') && !raw.contains(' ') {
                    format!("https://{raw}")
                } else {
                    format!("https://www.google.com/search?q={}", raw.replace(' ', "+"))
                };
                t.navigate_to(&target).map(|_| ())
            }
        };
        res.map_err(|e| e.to_string())
    });
    drop_on_error(&state, r)
}

