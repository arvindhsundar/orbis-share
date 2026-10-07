use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Files handed to Orbis by the OS (Finder double-click, `open -a Orbis file`)
/// before the web page was ready to receive them. fs-bridge.js drains this on start.
#[derive(Default)]
struct PendingFiles(Mutex<Vec<String>>);

#[tauri::command]
fn take_opened_files(state: tauri::State<PendingFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

fn queue_files(app: &tauri::AppHandle, files: Vec<String>) {
    if files.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<PendingFiles>() {
        state.0.lock().unwrap().extend(files.iter().cloned());
    }
    // If the page is already running it picks the files up from this event.
    let _ = app.emit("orbis://open-files", files);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
    }
}

// ─── Share: view-only copy on the site's hidden staging area ─────────────────
// Publishing goes through the site's own staging deploy script, so its
// confidentiality scans (private names, recording links) always run and can
// block the upload. Staging pages are noindex.
//
// Where to publish is NOT in the code. It comes from a local config file that
// is never committed:  <app config dir>/orbis.config.json
// (on a Mac: ~/Library/Application Support/com.puttheplayerfirst.orbis/).
// See orbis.config.example.json. Each value can be overridden by an env var
// (ORBIS_SITE_REPO, ORBIS_STAGING_SCRIPT, ORBIS_SITE_HOST, ORBIS_STAGING_ROOT,
// ORBIS_SHARE_BASE_URL, ORBIS_MAPS_DIR). No config = sharing is switched off.
const CONFIG_FILE: &str = "orbis.config.json";

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileConfig {
    site_repo: Option<String>,
    staging_script: Option<String>,
    site_host: Option<String>,
    staging_root: Option<String>,
    share_base_url: Option<String>,
    maps_dir: Option<String>,
}

#[derive(Clone)]
struct ShareConfig {
    site_repo: String,
    staging_script: String,
    site_host: String,
    staging_root: String,
}

fn config_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(CONFIG_FILE))
}

fn read_file_config(app: &tauri::AppHandle) -> FileConfig {
    config_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Env var if set and non-empty, else the file value if non-empty.
fn pick(env: &str, file: Option<String>) -> Option<String> {
    let clean = |s: String| Some(s.trim().to_string()).filter(|s| !s.is_empty());
    std::env::var(env).ok().and_then(clean).or_else(|| file.and_then(clean))
}

fn load_share_config(app: &tauri::AppHandle) -> Result<ShareConfig, String> {
    let f = read_file_config(app);
    let where_ = config_path(app).map(|p| p.display().to_string()).unwrap_or_else(|| CONFIG_FILE.into());
    let need = |env: &str, v: Option<String>, key: &str| {
        pick(env, v).ok_or_else(|| format!("sharing not configured: set \"{key}\" in {where_} (or {env})"))
    };
    Ok(ShareConfig {
        site_repo: need("ORBIS_SITE_REPO", f.site_repo, "siteRepo")?,
        staging_script: need("ORBIS_STAGING_SCRIPT", f.staging_script, "stagingScript")?,
        site_host: need("ORBIS_SITE_HOST", f.site_host, "siteHost")?,
        staging_root: need("ORBIS_STAGING_ROOT", f.staging_root, "stagingRoot")?,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicSettings {
    share_configured: bool,
    share_base_url: Option<String>,
    maps_dir: Option<String>,
}

/// What the page needs to know: is sharing set up, the public link prefix, the maps folder.
#[tauri::command]
fn app_settings(app: tauri::AppHandle) -> PublicSettings {
    let f = read_file_config(&app);
    let base = pick("ORBIS_SHARE_BASE_URL", f.share_base_url.clone());
    let maps_dir = pick("ORBIS_MAPS_DIR", f.maps_dir.clone());
    PublicSettings {
        share_configured: base.is_some() && load_share_config(&app).is_ok(),
        share_base_url: base,
        maps_dir,
    }
}

fn valid_slug(slug: &str) -> bool {
    (3..=60).contains(&slug.len())
        && slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !slug.starts_with('-')
}

fn gui_path() -> String {
    // Apps opened from Finder get a bare PATH; the deploy script needs rsync, ssh, perl, curl.
    let base = std::env::var("PATH").unwrap_or_default();
    format!("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{base}")
}

fn tail(s: &str, lines: usize) -> String {
    let v: Vec<&str> = s.lines().collect();
    v[v.len().saturating_sub(lines)..].join("\n")
}

#[tauri::command]
async fn publish_share(app: tauri::AppHandle, slug: String, html: String) -> Result<String, String> {
    if !valid_slug(&slug) {
        return Err(format!("bad share name: {slug}"));
    }
    let cfg = load_share_config(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var("HOME").map_err(|e| e.to_string())?;
        // A relative siteRepo means "under the home folder".
        let repo = std::path::Path::new(&home).join(&cfg.site_repo);
        let script = repo.join(&cfg.staging_script);
        if !script.is_file() {
            return Err(format!("site deploy script not found at {}", script.display()));
        }
        let dir = std::env::temp_dir().join("orbis-share").join(&slug);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("index.html"), html).map_err(|e| e.to_string())?;
        let out = std::process::Command::new("/bin/bash")
            .arg(&script)
            .arg(format!("maps-{slug}"))
            .arg(&dir)
            .current_dir(&repo)
            .env("PATH", gui_path())
            .output()
            .map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(&dir);
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        if out.status.success() { Ok(tail(&text, 4)) } else { Err(tail(&text, 8)) }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn unpublish_share(app: tauri::AppHandle, slug: String) -> Result<(), String> {
    if !valid_slug(&slug) {
        return Err(format!("bad share name: {slug}"));
    }
    let cfg = load_share_config(&app)?;
    let root = cfg.staging_root.trim_end_matches('/').to_string();
    // Never run ssh with an empty host, and never rm -rf near the server's root.
    if cfg.site_host.is_empty() || cfg.site_host.starts_with('-') || root.is_empty() || !root.starts_with('/')
        || root.contains('\'')
    {
        return Err("sharing not configured: siteHost / stagingRoot look wrong".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let out = std::process::Command::new("/usr/bin/ssh")
            .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", &cfg.site_host])
            .arg(format!("rm -rf '{root}/maps-{slug}'"))
            .env("PATH", gui_path())
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() { Ok(()) } else { Err(tail(&String::from_utf8_lossy(&out.stderr), 4)) }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─── Menu bar ────────────────────────────────────────────────────────────────
// Custom items are forwarded to the page as "orbis://menu" events (id = action).
// Edit keeps the standard items so copy/paste work inside text fields.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
    let item = |id: &str, label: &str, accel: Option<&str>| {
        let b = MenuItemBuilder::with_id(id, label);
        match accel { Some(a) => b.accelerator(a).build(app), None => b.build(app) }
    };
    let app_menu = SubmenuBuilder::new(app, "Orbis")
        .item(&PredefinedMenuItem::about(app, Some("About Orbis"), None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&item("quit", "Quit Orbis", Some("CmdOrCtrl+Q"))?)
        .build()?;
    let export = SubmenuBuilder::new(app, "Export")
        .item(&item("export-png", "Picture (PNG)…", None)?)
        .item(&item("export-pdf", "PDF…", None)?)
        .item(&item("export-svg", "Vector (SVG)…", None)?)
        .item(&item("export-md", "Outline (Markdown)…", None)?)
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new", "New Map", Some("CmdOrCtrl+N"))?)
        .item(&item("open", "Open…", Some("CmdOrCtrl+O"))?)
        .item(&item("open-recent", "Open Recent…", Some("CmdOrCtrl+Shift+O"))?)
        .separator()
        .item(&item("save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item("save-as", "Save As…", Some("CmdOrCtrl+Shift+S"))?)
        .separator()
        .item(&item("share", "Share…", None)?)
        .item(&export)
        .item(&item("import-md", "Import Outline (Markdown)…", None)?)
        .separator()
        .item(&item("close", "Close Window", Some("CmdOrCtrl+W"))?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&item("find", "Find Node…", None)?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("arrange", "Arrange (tidy the map)", None)?)
        .item(&item("fit", "Fit Map in Window", None)?)
        .item(&item("drift", "Drift On/Off", None)?)
        .separator()
        .item(&item("zoom-in", "Zoom In", None)?)
        .item(&item("zoom-out", "Zoom Out", None)?)
        .item(&item("zoom-reset", "Actual Size", None)?)
        .separator()
        .item(&item("minimap", "Show/Hide Minimap", None)?)
        .item(&item("theme", "Day/Night Theme", None)?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&item("shortcuts", "Keyboard Shortcuts", None)?)
        .build()?;
    MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &window, &help]).build()
}

/// Called by the page once it has dealt with unsaved work.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    QUIT_OK.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}

static QUIT_OK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(PendingFiles::default())
        .invoke_handler(tauri::generate_handler![take_opened_files, app_settings, publish_share, unpublish_share, quit_app])
        .on_menu_event(|app, event| {
            let _ = app.emit("orbis://menu", event.id().0.clone());
        })
        .setup(|app| {
            let menu = build_menu(&app.handle().clone())?;
            app.set_menu(menu)?;
            // Command-line paths (dev runs, non-mac platforms).
            let args: Vec<String> = std::env::args()
                .skip(1)
                .filter(|a| !a.starts_with('-') && std::path::Path::new(a).is_file())
                .collect();
            queue_files(&app.handle().clone(), args);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Orbis");

    app.run(|_handle, _event| {
        // Any other way of quitting (Dock > Quit, logout) asks the page first,
        // so an unsaved map gets its save prompt.
        if let tauri::RunEvent::ExitRequested { api, .. } = &_event {
            // No window left (it was closed after its own save prompt): just quit.
            if !QUIT_OK.load(std::sync::atomic::Ordering::SeqCst) && !_handle.webview_windows().is_empty() {
                api.prevent_exit();
                let _ = _handle.emit("orbis://menu", "quit".to_string());
            }
        }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &_event {
            let files: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            queue_files(_handle, files);
        }
    });
}
