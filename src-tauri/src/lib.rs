//! Guiso – Panic-button Tauri backend
//!
//! A single `guiso_process()` function is the entry-point for every trigger
//! (keyboard shortcut, mouse gesture, tray menu, frontend button).  It
//! kills the configured processes first, then opens the overlay — so the
//! desktop is already clean when the cover animation starts.
//!
//! ## Panic modes (`panic_mode` field)
//! | value        | description                                                |
//! |------------- |------------------------------------------------------------|
//! | `youtube`    | Fullscreen overlay that plays a YouTube URL                |
//! | `local`      | Windowed player for a file on the user's disk              |
//! | `fade`       | Solid-colour overlay that fades in (no video)             |
//! | `glitch`     | Screenshots the desktop first, then covers it with a fade  |
//! | `launch_app` | Silently spawns an exe/script – no overlay shown           |
//! | `combo`      | Mix of the above; the list lives in `combo_modes`         |
//!
//! ## Mouse-gesture trigger
//! Middle-click (default), right-click, or left-click — configurable via
//! `gesture_button`.  Draw the gesture while holding the button; release to
//! evaluate.  The threshold (`gesture_threshold`) is the maximum allowed
//! average per-point error; 0.0 = exact match, 1.0 = anything matches.

use app_info::get_file_icon;
use base64::{engine::general_purpose, Engine as _};
use image::{ImageBuffer, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::io::Cursor;
use std::process::Command;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_store::{StoreBuilder, StoreExt};
use xcap::Monitor;

// ─── Gesture Mathematics ($1 Unistroke Recogniser) ───────────────────────────

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

fn distance(a: &Point, b: &Point) -> f64 {
    ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
}

fn path_length(pts: &[Point]) -> f64 {
    pts.windows(2).map(|w| distance(&w[0], &w[1])).sum()
}

fn resample(points: &[Point], n: usize) -> Vec<Point> {
    if points.len() < 2 {
        return points.to_vec();
    }
    let mut resampled = vec![points[0]];
    let mut pts       = points.to_vec();
    let mut acc       = 0.0_f64;
    let interval      = path_length(&pts) / (n - 1) as f64;
    let mut i         = 1;

    while i < pts.len() {
        let d = distance(&pts[i - 1], &pts[i]);
        if acc + d >= interval {
            let t  = (interval - acc) / d;
            let q  = Point {
                x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x),
                y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y),
            };
            resampled.push(q);
            pts.insert(i, q);
            acc = 0.0;
        } else {
            acc += d;
            i   += 1;
        }
    }
    while resampled.len() < n {
        resampled.push(*points.last().unwrap());
    }
    resampled.truncate(n);
    resampled
}

fn normalize(points: &[Point]) -> Vec<Point> {
    if points.is_empty() {
        return vec![];
    }
    let mut pts = resample(points, 64);
    let (mut min_x, mut max_x) = (f64::MAX, f64::MIN);
    let (mut min_y, mut max_y) = (f64::MAX, f64::MIN);
    for p in &pts {
        min_x = min_x.min(p.x);
        max_x = max_x.max(p.x);
        min_y = min_y.min(p.y);
        max_y = max_y.max(p.y);
    }
    let w = f64::max(max_x - min_x, 1.0);
    let h = f64::max(max_y - min_y, 1.0);
    for p in &mut pts {
        p.x = (p.x - min_x) / w;
        p.y = (p.y - min_y) / h;
    }
    pts
}

/// Average per-point distance between two equal-length paths.
/// Lower = more similar.  Returns `f64::MAX` on empty / mismatched slices.
fn match_gesture(drawn: &[Point], template: &[Point]) -> f64 {
    if drawn.len() != template.len() || template.is_empty() {
        return f64::MAX;
    }
    drawn.iter()
         .zip(template.iter())
         .map(|(a, b)| distance(a, b))
         .sum::<f64>()
        / drawn.len() as f64
}

fn gesture_button_from_str(s: &str) -> rdev::Button {
    match s {
        "left"  => rdev::Button::Left,
        "right" => rdev::Button::Right,
        _       => rdev::Button::Middle, // safe default; middle is unambiguous
    }
}

/// Whether panic should open a webview overlay (as opposed to only killing / launching).
fn needs_overlay(settings: &UserSettings) -> bool {
    match settings.panic_mode.as_str() {
        "launch_app" => false,
        "local" | "youtube" | "fade" | "glitch" => true,
        "combo" => settings
            .combo_modes
            .iter()
            .any(|m| m != "launch_app"),
        _ => true,
    }
}

fn persist_settings(app: &AppHandle, settings: &UserSettings) -> Result<(), String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    store.set("config", json!(settings));
    store.save().map_err(|e| e.to_string())
}

/// Spawn a companion executable without flashing a console window on Windows.
fn spawn_panic_app(target: &str) {
    if target.is_empty() {
        return;
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new(target)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }

    #[cfg(not(windows))]
    {
        let _ = Command::new(target).spawn();
    }
}

// ─── Data Structures ──────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ProcessInfo {
    pid:       u32,
    name:      String,
    cpu_usage: f32,
    memory_mb: u64,
    icon:      Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct UserSettings {
    // ── Trigger ────────────────────────────────────────────────────────────────
    pub active_shortcut:   String,
    pub gesture_enabled:   bool,
    /// "middle" | "right" | "left"  (left interferes with normal clicking)
    pub gesture_button:    String,
    /// 0.0–1.0; lower = stricter.  Recommended: 0.15–0.25
    pub gesture_threshold: f64,
    pub panic_gesture:     Vec<Point>,

    // ── Visual overlay ─────────────────────────────────────────────────────────
    pub panic_mode:           String,
    /// YouTube URL (youtube mode) or executable path (launch_app mode)
    pub panic_target:         String,
    /// Absolute path to the video file shown in "local" mode
    pub local_video_path:     String,
    pub local_video_title:    String,
    /// Seconds into the local video to start playback
    pub local_video_start_time: u32,
    /// Duration of the CSS fade-in animation (milliseconds); read by the frontend
    pub panic_fade_ms:        u64,
    /// CSS colour for the overlay backdrop  e.g. "rgba(10,10,10,0.97)"
    pub panic_color:          String,
    pub panic_blur_px:        u32,
    /// 0 = stay open until dismissed; >0 = auto-close after N ms
    pub panic_auto_close_ms:  u64,
    /// Pressing the panic shortcut a second time closes the overlay
    pub panic_hotkey_close:   bool,
    /// Sub-mode list when `panic_mode == "combo"` e.g. ["fade", "youtube"]
    pub combo_modes:          Vec<String>,

    // ── Kill list (persistent) ─────────────────────────────────────────────────
    /// Process names (case-insensitive substring) killed on every panic trigger.
    /// Stored by name so they survive restarts (PIDs change between sessions).
    pub saved_kill_processes: Vec<String>,

    // ── UI ─────────────────────────────────────────────────────────────────────
    pub theme: String,
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            active_shortcut:      "CmdOrCtrl+Shift+K".to_string(),
            gesture_enabled:      false,
            gesture_button:       "middle".to_string(),
            gesture_threshold:    0.20,
            panic_gesture:        vec![],

            panic_mode:           "youtube".to_string(),
            panic_target:         String::new(),
            local_video_path:     String::new(),
            local_video_title:    "Video Player".to_string(),
            local_video_start_time: 0,
            panic_fade_ms:        600,
            panic_color:          "rgba(15, 15, 15, 0.97)".to_string(),
            panic_blur_px:        20,
            panic_auto_close_ms:  0,
            panic_hotkey_close:   true,
            combo_modes:          vec![],

            saved_kill_processes: vec![],
            theme:                "dark".to_string(),
        }
    }
}

struct AppState {
    icon_cache: Mutex<HashMap<String, String>>,
    /// Session-only PID queue; merged with `saved_kill_processes` at panic time.
    /// Not persisted — PIDs are ephemeral.
    runtime_kill_pids: Mutex<Vec<u32>>,
    settings:         Mutex<UserSettings>,
    last_screenshot:  Mutex<Option<String>>,
    /// True while the panic overlay window is alive.
    panic_active:     Mutex<bool>,
}

// ─── Internal Kill Helpers ────────────────────────────────────────────────────

fn kill_process_by_pid(pid: u32) -> Result<(), String> {
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()),
    );
    sys.refresh_processes(ProcessesToUpdate::All, false);
    sys.process(Pid::from(pid as usize))
       .ok_or_else(|| format!("PID {pid} not found"))
       .and_then(|p| {
           if p.kill() { Ok(()) }
           else        { Err(format!("No permission to kill PID {pid}")) }
       })
}

/// Kills every process whose name exactly matches any of `names` (case-insensitive).
fn kill_processes_by_name(names: &[String]) {
    if names.is_empty() { return; }
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()),
    );
    sys.refresh_processes(ProcessesToUpdate::All, false);
    for (_, proc) in sys.processes() {
        let pname = proc.name().to_string_lossy().to_lowercase();
        if names.iter().any(|n| pname == n.to_lowercase()) {
            proc.kill();
        }
    }
}

// ─── Process Commands ─────────────────────────────────────────────────────────

/// Returns all running processes with icons, CPU, and memory.
/// Icons are cached by exe path to avoid repeated disk reads.
#[tauri::command]
fn get_processes(state: tauri::State<'_, AppState>) -> Vec<ProcessInfo> {
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
    );
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let mut cache = state.icon_cache.lock().unwrap();
    let mut out   = Vec::with_capacity(sys.processes().len());

    for (pid, proc) in sys.processes() {
        let exe = proc.exe()
                      .map(|p| p.to_string_lossy().into_owned())
                      .unwrap_or_default();

        let icon = if exe.is_empty() {
            None
        } else if let Some(hit) = cache.get(&exe) {
            Some(hit.clone())
        } else {
            // Fetch a 32 px icon — small enough to not bloat IPC payloads
            get_file_icon(&exe, 32).ok().and_then(|raw| {
                let img = ImageBuffer::<image::Rgba<u8>, _>::from_raw(
                    raw.width, raw.height, raw.pixels,
                )?;
                let mut buf = Cursor::new(Vec::new());
                RgbaImage::from(img).write_to(&mut buf, ImageFormat::Png).ok()?;
                let url = format!(
                    "data:image/png;base64,{}",
                    general_purpose::STANDARD.encode(buf.into_inner())
                );
                cache.insert(exe.clone(), url.clone());
                Some(url)
            })
        };

        out.push(ProcessInfo {
            pid:       pid.as_u32(),
            name:      proc.name().to_string_lossy().into_owned(),
            cpu_usage: proc.cpu_usage(),
            memory_mb: proc.memory() / 1_048_576,
            icon,
        });
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Add a PID to the session-only kill queue.
#[tauri::command]
fn add_pid(pid: u32, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let mut q = state.runtime_kill_pids.lock().unwrap();
    if !q.contains(&pid) { q.push(pid); }
    Ok("PID queued.".to_string())
}

/// Remove a PID from the session-only kill queue.
#[tauri::command]
fn remove_pid(pid: u32, state: tauri::State<'_, AppState>) -> Result<String, String> {
    state.runtime_kill_pids.lock().unwrap().retain(|&x| x != pid);
    Ok("PID removed.".to_string())
}

/// Return the current session-only PID queue so the frontend can display it.
#[tauri::command]
fn get_queued_pids(state: tauri::State<'_, AppState>) -> Vec<u32> {
    state.runtime_kill_pids.lock().unwrap().clone()
}

/// Persist a list of process names so they are killed on every future panic.
/// The frontend sends the names after the user selects them in the process picker.
#[tauri::command]
fn save_kill_list(
    app: tauri::AppHandle,
    names: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let mut s = state.settings.lock().unwrap();
    s.saved_kill_processes = names;
    persist_settings(&app, &s)?;
    Ok("Kill list saved.".to_string())
}

// ─── Settings Commands ────────────────────────────────────────────────────────

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> UserSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn update_settings(
    app: tauri::AppHandle,
    new_settings: UserSettings,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let mut lock = state.settings.lock().unwrap();

    // Hot-swap the global shortcut only when it actually changed
    if lock.active_shortcut != new_settings.active_shortcut {
        let old = Shortcut::from_str(&lock.active_shortcut)
            .map_err(|e| format!("Bad old shortcut: {e}"))?;
        let new_sc = Shortcut::from_str(&new_settings.active_shortcut)
            .map_err(|e| format!("Invalid shortcut '{}': {e}", new_settings.active_shortcut))?;

        app.global_shortcut()
           .unregister(old)
           .map_err(|e| e.to_string())?;
        app.global_shortcut()
           .on_shortcut(new_sc, |h, _, ev| {
               if ev.state == ShortcutState::Pressed { guiso_process(h.clone()); }
           })
           .map_err(|e| e.to_string())?;
    }

    *lock = new_settings.clone();
    persist_settings(&app, &new_settings)?;
    Ok("Settings saved.".to_string())
}

/// Normalise and persist a drawn gesture path.
#[tauri::command]
fn save_gesture(
    app: tauri::AppHandle,
    raw_points: Vec<Point>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let normalised = normalize(&raw_points);
    let mut lock   = state.settings.lock().unwrap();
    lock.panic_gesture = normalised;
    persist_settings(&app, &lock)?;
    Ok("Gesture saved.".to_string())
}

// ─── Panic Commands ───────────────────────────────────────────────────────────

/// Returns the base64 PNG of the last captured desktop screenshot (glitch mode).
#[tauri::command]
fn get_last_screenshot(state: tauri::State<'_, AppState>) -> Option<String> {
    state.last_screenshot.lock().unwrap().clone()
}

/// Trigger panic manually from the frontend (e.g. a test button or keyboard shortcut in the UI).
#[tauri::command]
fn trigger_panic(app: tauri::AppHandle) {
    guiso_process(app);
}

/// Close the panic overlay from the overlay UI itself (e.g. an ESC key binding).
#[tauri::command]
fn close_panic(app: tauri::AppHandle, state: tauri::State<'_, AppState>) {
    if let Some(w) = app.get_webview_window("panic_overlay") {
        let _ = w.close();
    }
    *state.panic_active.lock().unwrap() = false;
}

/// Whether the panic overlay is currently visible.  Lets the frontend style itself.
#[tauri::command]
fn is_panic_active(state: tauri::State<'_, AppState>) -> bool {
    *state.panic_active.lock().unwrap()
}

/// Evaluate a drawn path against the saved template and return the score.
/// Useful for a "test gesture" button in settings: lower = better match.
#[tauri::command]
fn test_gesture_score(raw_points: Vec<Point>, state: tauri::State<'_, AppState>) -> f64 {
    let settings = state.settings.lock().unwrap();
    if settings.panic_gesture.is_empty() || raw_points.len() < 5 {
        return f64::MAX;
    }
    match_gesture(&normalize(&raw_points), &settings.panic_gesture)
}

// ─── Core Panic Logic ─────────────────────────────────────────────────────────

fn take_screenshot(app: &AppHandle) {
    if let Ok(monitors) = Monitor::all() {
        if let Some(mon) = monitors.first() {
            if let Ok(img) = mon.capture_image() {
                let mut buf = Cursor::new(Vec::new());
                if img.write_to(&mut buf, ImageFormat::Png).is_ok() {
                    let b64 = general_purpose::STANDARD.encode(buf.into_inner());
                    *app.state::<AppState>().last_screenshot.lock().unwrap() =
                        Some(format!("data:image/png;base64,{b64}"));
                }
            }
        }
    }
}

/// Central panic handler.  Called from every trigger source.
fn guiso_process(app: AppHandle) {
    let state    = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();

    // ── Toggle: close overlay if it is already open ───────────────────────────
    if app.get_webview_window("panic_overlay").is_some() {
        if settings.panic_hotkey_close {
            if let Some(w) = app.get_webview_window("panic_overlay") {
                let _ = w.close();
            }
            *state.panic_active.lock().unwrap() = false;
        }
        return;
    }

    // ── Screenshot (glitch mode or combo containing glitch) ───────────────────
    let wants_glitch = settings.panic_mode == "glitch"
        || settings.combo_modes.contains(&"glitch".to_string());
    if wants_glitch {
        // Capture before killing so the screenshot is still "innocent"
        take_screenshot(&app);
    }

    // ── Kill session-only PID queue ───────────────────────────────────────────
    {
        let pids: Vec<u32> = state.runtime_kill_pids.lock().unwrap().clone();
        for pid in &pids { let _ = kill_process_by_pid(*pid); }
        state.runtime_kill_pids.lock().unwrap().clear();
    }

    // ── Kill persistent named processes ───────────────────────────────────────
    kill_processes_by_name(&settings.saved_kill_processes);

    // ── Silently launch a companion app if configured ─────────────────────────
    let wants_launch = (settings.panic_mode == "launch_app"
        || settings.combo_modes.contains(&"launch_app".to_string()))
        && !settings.panic_target.is_empty();
    if wants_launch {
        spawn_panic_app(&settings.panic_target);
    }

    if !needs_overlay(&settings) {
        return;
    }

    // ── Build the overlay window ──────────────────────────────────────────────
    // "local" mode: decorated, resizable window (the user controls it).
    // Everything else: transparent, fullscreen, always-on-top overlay.
    let is_local = settings.panic_mode == "local";
    let build_result = if is_local {
        let mut builder = WebviewWindowBuilder::new(&app, "panic_overlay", WebviewUrl::App("/panic".into()))
            .title(&settings.local_video_title)
            .decorations(true)
            .fullscreen(false)
            .inner_size(960.0, 540.0)
            .always_on_top(true)
            .transparent(false)
            .skip_taskbar(false);
        if let Ok(monitors) = app.available_monitors() {
            if let Some(monitor) = monitors.into_iter().next() {
                let size = monitor.size();
                let pos = monitor.position();
                builder = builder.position(
                    pos.x as f64 + (size.width as f64 - 960.0) / 2.0,
                    pos.y as f64 + (size.height as f64 - 540.0) / 2.0,
                );
            }
        }
        builder.build()
    } else {
        WebviewWindowBuilder::new(&app, "panic_overlay", WebviewUrl::App("/panic".into()))
            .title("System Process")
            .decorations(false)
            .fullscreen(true)
            .always_on_top(true)
            .transparent(true)
            .skip_taskbar(true)
            .build()
    };

    if build_result.is_ok() {
        *state.panic_active.lock().unwrap() = true;

        // ── Auto-close timer ──────────────────────────────────────────────────
        if settings.panic_auto_close_ms > 0 {
            let app_c = app.clone();
            let ms    = settings.panic_auto_close_ms;
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(ms));
                if let Some(w) = app_c.get_webview_window("panic_overlay") {
                    let _ = w.close();
                }
                *app_c.state::<AppState>().panic_active.lock().unwrap() = false;
            });
        }
    } else if let Err(e) = build_result {
        eprintln!("[guiso] Failed to build panic overlay: {e}");
    }
}

// ─── App Entry Point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            icon_cache:        Mutex::new(HashMap::new()),
            runtime_kill_pids: Mutex::new(Vec::new()),
            settings:          Mutex::new(UserSettings::default()),
            last_screenshot:   Mutex::new(None),
            panic_active:      Mutex::new(false),
        })
        .setup(|app| {
            // ── Load persisted settings ───────────────────────────────────────
            let store = StoreBuilder::new(app, "settings.json")
                .default("config", json!(UserSettings::default()))
                .build()?;

            let saved: UserSettings = match store.get("config") {
                Some(v) => serde_json::from_value(v.clone()).unwrap_or_default(),
                None    => UserSettings::default(),
            };
            *app.state::<AppState>().settings.lock().unwrap() = saved.clone();

            // ── Register global shortcut ──────────────────────────────────────
            match Shortcut::from_str(&saved.active_shortcut) {
                Ok(sc) => {
                    app.global_shortcut()
                       .on_shortcut(sc, |h, _, ev| {
                           if ev.state == ShortcutState::Pressed { guiso_process(h.clone()); }
                       })
                       .unwrap_or_else(|e| {
                           eprintln!("[guiso] Could not register shortcut: {e}");
                       });
                }
                Err(e) => {
                    eprintln!("[guiso] Invalid saved shortcut '{}': {e}", saved.active_shortcut);
                }
            }

            // ── System tray ───────────────────────────────────────────────────
            let item_show  = MenuItem::with_id(app, "show",  "Open Settings",    true, None::<&str>)?;
            let item_panic = MenuItem::with_id(app, "panic", "⚡ Trigger Panic", true, None::<&str>)?;
            let item_quit  = MenuItem::with_id(app, "quit",  "Quit",             true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&item_show, &item_panic, &item_quit])?;

            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "quit"  => app.exit(0),
                    "panic" => guiso_process(app.clone()),
                    "show"  => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = ev
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // ── Mouse-gesture listener (dedicated OS-level thread) ────────────
            //
            // rdev::listen is a blocking call that must run on its own thread.
            // We read settings from the state only on button-press events
            // (not on every MouseMove) to minimise lock contention.
            let app_h = app.handle().clone();
            std::thread::spawn(move || {
                let recording:   Arc<Mutex<bool>>       = Arc::new(Mutex::new(false));
                let gesture_pts: Arc<Mutex<Vec<Point>>> = Arc::new(Mutex::new(Vec::new()));
                let rec2 = recording.clone();
                let pts2 = gesture_pts.clone();

                if let Err(e) = rdev::listen(move |ev| {
                    match ev.event_type {
                        // ─ Start recording when the configured trigger is pressed
                        rdev::EventType::ButtonPress(btn) => {
                            let settings = app_h.state::<AppState>()
                                                .settings.lock().unwrap().clone();
                            if !settings.gesture_enabled { return; }
                            if btn == gesture_button_from_str(&settings.gesture_button) {
                                *rec2.lock().unwrap() = true;
                                pts2.lock().unwrap().clear();
                            }
                        }
                        // ─ Accumulate path while recording
                        rdev::EventType::MouseMove { x, y } => {
                            if *rec2.lock().unwrap() {
                                pts2.lock().unwrap().push(Point { x, y });
                            }
                        }
                        // ─ Any button release ends the gesture attempt
                        rdev::EventType::ButtonRelease(btn) => {
                            // Atomically flip recording off and take the points
                            let was_recording = {
                                let mut r = rec2.lock().unwrap();
                                let v = *r;
                                *r = false;
                                v
                            };
                            if !was_recording { return; }

                            let settings = app_h.state::<AppState>()
                                                .settings.lock().unwrap().clone();
                            if btn != gesture_button_from_str(&settings.gesture_button) {
                                pts2.lock().unwrap().clear();
                                return;
                            }

                            let points: Vec<Point> = {
                                let mut lock = pts2.lock().unwrap();
                                let pts = lock.clone();
                                lock.clear();
                                pts
                            };

                            // Need at least 10 points to be a meaningful stroke
                            if points.len() <= 10 { return; }

                            if settings.panic_gesture.is_empty() { return; }

                            let score = match_gesture(
                                &normalize(&points),
                                &settings.panic_gesture,
                            );
                            if score < settings.gesture_threshold {
                                guiso_process(app_h.clone());
                            }
                        }
                        _ => {}
                    }
                }) {
                    eprintln!("[guiso] rdev listener error: {e:?}");
                }
            });

            Ok(())
        })
        // ── Window lifecycle events ───────────────────────────────────────────
        .on_window_event(|window, event| {
            match event {
                // Main window: hide to tray instead of quitting
                tauri::WindowEvent::CloseRequested { api, .. }
                if window.label() == "main" =>
                    {
                        let _ = window.hide();
                        api.prevent_close();
                    }
                // Panic overlay: reset the active flag whenever the window is gone
                // (handles close(), force-kill, and the auto-close timer equally)
                tauri::WindowEvent::Destroyed
                if window.label() == "panic_overlay" =>
                    {
                        *window.app_handle()
                               .state::<AppState>()
                               .panic_active
                               .lock()
                               .unwrap() = false;
                    }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            // ── Process management ────────────────────────────────────────────
            get_processes,
            add_pid,
            remove_pid,
            get_queued_pids,
            save_kill_list,
            // ── Settings ──────────────────────────────────────────────────────
            get_settings,
            update_settings,
            save_gesture,
            test_gesture_score,
            // ── Panic ─────────────────────────────────────────────────────────
            trigger_panic,
            close_panic,
            is_panic_active,
            get_last_screenshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}