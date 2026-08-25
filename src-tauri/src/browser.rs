use headless_chrome::protocol::cdp::Page;
use headless_chrome::{Browser, Tab};
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[derive(Default)]
pub struct BrowserState(pub Mutex<Option<Session>>);

pub struct Session {
    #[allow(dead_code)]
    browser: Browser,
    tab: Arc<Tab>,
}

fn tab(state: &BrowserState) -> Result<Arc<Tab>, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        let browser = Browser::default()
            .map_err(|e| format!("Could not start a browser (Chrome not found and download failed): {e}"))?;
        let tab = browser.new_tab().map_err(|e| e.to_string())?;
        *guard = Some(Session { browser, tab });
    }
    Ok(guard.as_ref().unwrap().tab.clone())
}

fn page_text(tab: &Tab) -> Result<String, String> {
    let html = tab.get_content().map_err(|e| e.to_string())?;
    let mut text = crate::html_to_text(&html);
    if text.len() > 12_000 {
        text.truncate(12_000);
        text.push_str("\n[truncated]");
    }
    Ok(text)
}

#[tauri::command]
pub fn browser_open(state: tauri::State<BrowserState>, url: String) -> Result<String, String> {
    let tab = tab(&state)?;
    tab.navigate_to(&url).map_err(|e| e.to_string())?;
    tab.wait_until_navigated().map_err(|e| e.to_string())?;
    let title = tab.get_title().unwrap_or_default();
    Ok(format!("{}\n{}\n\n{}", title, tab.get_url(), page_text(&tab)?))
}

#[tauri::command]
pub fn browser_read(state: tauri::State<BrowserState>) -> Result<String, String> {
    let tab = tab(&state)?;
    page_text(&tab)
}

#[tauri::command]
pub fn browser_click(state: tauri::State<BrowserState>, text: String) -> Result<String, String> {
    let tab = tab(&state)?;
    let xpath = format!(
        "//a[contains(normalize-space(.), '{t}')] | //button[contains(normalize-space(.), '{t}')]",
        t = text.replace('\'', "")
    );
    let el = tab
        .find_element_by_xpath(&xpath)
        .map_err(|_| format!("No clickable element containing \"{}\".", text))?;
    el.click().map_err(|e| e.to_string())?;
    tab.wait_until_navigated().ok();
    Ok(format!("Clicked \"{}\".\n\n{}", text, page_text(&tab)?))
}

#[tauri::command]
pub fn browser_type(
    state: tauri::State<BrowserState>,
    selector: String,
    text: String,
) -> Result<String, String> {
    let tab = tab(&state)?;
    let el = tab
        .find_element(&selector)
        .map_err(|_| format!("No element matches selector \"{}\".", selector))?;
    el.click().map_err(|e| e.to_string())?;
    tab.type_str(&text).map_err(|e| e.to_string())?;
    Ok(format!("Typed into \"{}\".", selector))
}

#[tauri::command]
pub fn browser_screenshot(
    app: tauri::AppHandle,
    state: tauri::State<BrowserState>,
) -> Result<String, String> {
    let tab = tab(&state)?;
    let data = tab
        .capture_screenshot(Page::CaptureScreenshotFormatOption::Png, None, None, true)
        .map_err(|e| e.to_string())?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("browser_shot.png");
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn browser_close(state: tauri::State<BrowserState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}
