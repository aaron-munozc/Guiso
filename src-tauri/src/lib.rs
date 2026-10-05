//! Guiso – panic-button backend.
//!
//! The panic path is deliberately centralized: every trigger reaches
//! `guiso_process()`, which snapshots the current settings, protects against
//! re-entry, captures a disguise screenshot when requested, terminates the
//! configured targets, optionally launches a companion app, and finally opens
//! the disguise overlay.

use app_info::get_file_icon;
use base64::{engine::general_purpose, Engine as _};
use image::{ImageBuffer, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::PathBuf;
use std::process::Command;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::Color;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_store::{StoreBuilder, StoreExt};
use xcap::Monitor;

const RESCUE_SHORTCUT: &str = "CmdOrCtrl+Alt+Escape";

// ─── Gesture mathematics ──────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

fn distance(a: &Point, b: &Point) -> f64 {
    ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
}

fn path_length(points: &[Point]) -> f64 {
    points.windows(2).map(|w| distance(&w[0], &w[1])).sum()
}

/// Resample a stroke into exactly `n` equally spaced points.
///
/// The old implementation could loop forever for zero-length strokes because
/// its interval became zero. This version explicitly handles that case and
/// never mutates the source vector while iterating.
fn resample(points: &[Point], n: usize) -> Vec<Point> {
    if n == 0 || points.is_empty() {
        return Vec::new();
    }
    if n == 1 {
        return vec![points[0]];
    }
    if points.len() == 1 {
        return vec![points[0]; n];
    }

    let total = path_length(points);
    if !total.is_finite() || total <= f64::EPSILON {
        return vec![points[0]; n];
    }

    let interval = total / (n - 1) as f64;
    let mut out = Vec::with_capacity(n);
    out.push(points[0]);

    let mut accumulated = 0.0;
    let mut previous = points[0];
    let mut i = 1usize;

    while i < points.len() && out.len() < n {
        let current = points[i];
        let segment = distance(&previous, &current);

        if segment <= f64::EPSILON {
            previous = current;
            i += 1;
            continue;
        }

        if accumulated + segment >= interval {
            let t = ((interval - accumulated) / segment).clamp(0.0, 1.0);
            let q = Point {
                x: previous.x + t * (current.x - previous.x),
                y: previous.y + t * (current.y - previous.y),
            };
            out.push(q);
            previous = q;
            accumulated = 0.0;
        } else {
            accumulated += segment;
            previous = current;
            i += 1;
        }
    }

    while out.len() < n {
        out.push(*points.last().unwrap_or(&points[0]));
    }
    out.truncate(n);
    out
}

/// Scale uniformly, preserve the gesture's aspect ratio, and center it around
/// its centroid. Uniform scaling is much less distortion-prone than separately
/// stretching x and y into a 0..1 box.
fn normalize(points: &[Point]) -> Vec<Point> {
    if points.is_empty() {
        return Vec::new();
    }

    let mut pts = resample(points, 64);
    if pts.is_empty() {
        return pts;
    }

    let min_x = pts.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
    let max_x = pts.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
    let min_y = pts.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
    let max_y = pts.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
    let scale = (max_x - min_x).max(max_y - min_y).max(1.0);

    let cx = pts.iter().map(|p| p.x).sum::<f64>() / pts.len() as f64;
    let cy = pts.iter().map(|p| p.y).sum::<f64>() / pts.len() as f64;

    for point in &mut pts {
        point.x = (point.x - cx) / scale;
        point.y = (point.y - cy) / scale;
    }
    pts
}

fn match_gesture(drawn: &[Point], template: &[Point]) -> f64 {
    if drawn.len() != template.len() || template.is_empty() {
        return f64::MAX;
    }

    drawn
        .iter()
        .zip(template.iter())
        .map(|(a, b)| distance(a, b))
        .sum::<f64>()
        / drawn.len() as f64
}

fn gesture_button_from_str(value: &str) -> rdev::Button {
    match value {
        "left" => rdev::Button::Left,
        "right" => rdev::Button::Right,
        _ => rdev::Button::Middle,
    }
}

// ─── Settings ────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct UserSettings {
    // Trigger
    pub active_shortcut: String,
    pub gesture_enabled: bool,
    pub gesture_button: String,
    pub gesture_threshold: f64,
    pub panic_gesture: Vec<Point>,

    // Disguise/action
    pub panic_mode: String,
    /// Legacy shared target. Kept for backwards-compatible config migration.
    pub panic_target: String,
    /// Separate target for YouTube disguise URLs.
    pub youtube_url: String,
    /// Separate target for companion executables/scripts.
    pub launch_app_path: String,
    pub local_video_path: String,
    pub local_video_title: String,
    pub local_video_start_time: u32,
    pub panic_fade_ms: u64,
    pub panic_color: String,
    pub panic_blur_px: u32,
    pub panic_auto_close_ms: u64,
    pub panic_hotkey_close: bool,
    pub combo_modes: Vec<String>,

    // Process targets
    pub saved_kill_processes: Vec<String>,

    // UI
    pub theme: String,
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            active_shortcut: "CmdOrCtrl+Shift+K".into(),
            gesture_enabled: false,
            gesture_button: "middle".into(),
            gesture_threshold: 0.20,
            panic_gesture: Vec::new(),

            panic_mode: "fade".into(),
            panic_target: String::new(),
            youtube_url: String::new(),
            launch_app_path: String::new(),
            local_video_path: String::new(),
            local_video_title: "Video Player".into(),
            local_video_start_time: 0,
            panic_fade_ms: 600,
            panic_color: "rgba(8, 7, 6, 1.00)".into(),
            panic_blur_px: 20,
            panic_auto_close_ms: 0,
            panic_hotkey_close: true,
            combo_modes: Vec::new(),

            saved_kill_processes: Vec::new(),
            theme: "dark".into(),
        }
    }
}

fn is_youtube_like(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    value.starts_with("https://youtube.com/")
        || value.starts_with("https://www.youtube.com/")
        || value.starts_with("https://youtu.be/")
}

fn sanitize_settings(mut settings: UserSettings) -> UserSettings {
    if !matches!(settings.gesture_button.as_str(), "left" | "right" | "middle") {
        settings.gesture_button = "middle".into();
    }
    settings.gesture_threshold = settings.gesture_threshold.clamp(0.05, 0.50);
    if settings.active_shortcut.trim().is_empty() || settings.active_shortcut == RESCUE_SHORTCUT {
        settings.active_shortcut = "CmdOrCtrl+Shift+K".into();
    }
    settings.panic_fade_ms = settings.panic_fade_ms.clamp(0, 5_000);
    settings.panic_blur_px = settings.panic_blur_px.clamp(0, 80);
    settings.panic_auto_close_ms = settings.panic_auto_close_ms.min(300_000);
    settings.local_video_title = if settings.local_video_title.trim().is_empty() {
        "Video Player".into()
    } else {
        settings.local_video_title.trim().to_string()
    };

    // Migrate the old shared panic_target into the new dedicated field when
    // possible. This keeps existing installations working after the upgrade.
    if is_youtube_like(&settings.panic_target) && settings.youtube_url.trim().is_empty() {
        settings.youtube_url = settings.panic_target.trim().to_string();
    } else if !is_youtube_like(&settings.panic_target)
        && settings.launch_app_path.trim().is_empty()
        && !settings.panic_target.trim().is_empty()
    {
        settings.launch_app_path = settings.panic_target.trim().to_string();
    }

    settings.panic_mode = match settings.panic_mode.as_str() {
        "youtube" | "local" | "fade" | "glitch" | "launch_app" | "combo" => {
            settings.panic_mode
        }
        _ => "fade".into(),
    };

    let allowed: HashSet<&str> = ["fade", "youtube", "local", "glitch", "launch_app"]
        .into_iter()
        .collect();
    let mut combo = Vec::new();
    for mode in settings.combo_modes.drain(..) {
        if allowed.contains(mode.as_str()) && !combo.contains(&mode) {
            combo.push(mode);
        }
    }
    // Only one primary media disguise can own the visible playback surface.
    // Keeping both would result in one element hiding the other.
    let media = combo
        .iter()
        .position(|m| m == "youtube" || m == "local");
    if let Some(media_index) = media {
        let media_mode = combo[media_index].clone();
        combo.retain(|m| m != "youtube" && m != "local");
        combo.insert(0, media_mode);
    }
    settings.combo_modes = combo;

    settings.theme = match settings.theme.as_str() {
        "dark" | "dim" => settings.theme,
        _ => "dark".into(),
    };

    settings.saved_kill_processes = settings
        .saved_kill_processes
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .fold(Vec::<String>::new(), |mut out, name| {
            if !out.iter().any(|existing| existing.eq_ignore_ascii_case(&name)) {
                out.push(name);
            }
            out
        });

    settings
}

fn persist_settings(app: &AppHandle, settings: &UserSettings) -> Result<(), String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    store.set("config", json!(settings));
    store.save().map_err(|e| e.to_string())
}

// ─── Process management ──────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_usage: f32,
    pub memory_mb: u64,
    pub icon: Option<String>,
    pub start_time: u64,
    pub killable: bool,
    pub protection_reason: Option<String>,
    pub exe_path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct QueuedProcess {
    pub pid: u32,
    pub name: String,
    pub start_time: u64,
}

#[derive(Default, Clone, Copy)]
struct KillStats {
    attempted: usize,
    succeeded: usize,
    failed: usize,
}

fn own_process_name() -> Option<String> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.file_name().map(|name| name.to_string_lossy().to_string()))
        .map(|name| name.to_ascii_lowercase())
}

fn protection_reason(name: &str, pid: u32) -> Option<String> {
    let lower = name.trim().to_ascii_lowercase();
    if own_process_name().as_deref() == Some(lower.as_str()) {
        return Some("Guiso is protected from terminating itself".into());
    }

    // Conservative cross-platform deny-list for processes that are commonly
    // essential to the OS/session. Users can still target ordinary apps.
    let protected = [
        "system", "registry", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe",
        "services.exe", "lsass.exe", "svchost.exe", "dwm.exe", "fontdrvhost.exe",
        "system idle process", "launchd", "init", "systemd", "kthreadd", "kernel_task",
    ];
    if protected.iter().any(|candidate| candidate.eq_ignore_ascii_case(&lower)) {
        return Some("Protected OS process".into());
    }

    #[cfg(unix)]
    if pid <= 1 {
        return Some("Protected system PID".into());
    }

    None
}

fn system_with_processes() -> System {
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
    );
    sys.refresh_processes(ProcessesToUpdate::All, true);
    sys
}

fn kill_queued_processes(targets: &[QueuedProcess]) -> KillStats {
    if targets.is_empty() {
        return KillStats::default();
    }

    let sys = system_with_processes();
    let mut stats = KillStats::default();

    for target in targets {
        stats.attempted += 1;
        let process = sys.process(Pid::from(target.pid as usize));
        let Some(process) = process else {
            stats.failed += 1;
            continue;
        };

        let current_name = process.name().to_string_lossy();
        if !current_name.eq_ignore_ascii_case(&target.name)
            || (target.start_time != 0 && process.start_time() != target.start_time)
        {
            // PID was reused or no longer points to the original process.
            stats.failed += 1;
            continue;
        }
        if protection_reason(&current_name, target.pid).is_some() {
            stats.failed += 1;
            continue;
        }

        if process.kill() {
            stats.succeeded += 1;
        } else {
            stats.failed += 1;
        }
    }

    stats
}

fn kill_named_processes(names: &[String]) -> KillStats {
    if names.is_empty() {
        return KillStats::default();
    }

    let targets: HashSet<String> = names
        .iter()
        .map(|name| name.trim().to_ascii_lowercase())
        .filter(|name| !name.is_empty())
        .collect();

    let sys = system_with_processes();
    let mut stats = KillStats::default();

    for (pid, process) in sys.processes() {
        let name = process.name().to_string_lossy().to_string();
        if !targets.contains(&name.to_ascii_lowercase()) {
            continue;
        }
        if protection_reason(&name, pid.as_u32()).is_some() {
            continue;
        }

        stats.attempted += 1;
        if process.kill() {
            stats.succeeded += 1;
        } else {
            stats.failed += 1;
        }
    }

    stats
}

fn spawn_panic_app(target: &str) -> Result<(), String> {
    let target = target.trim();
    if target.is_empty() {
        return Ok(());
    }

    let path = PathBuf::from(target);
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let mut command = if matches!(extension.as_str(), "bat" | "cmd") {
            let mut cmd = Command::new("cmd.exe");
            cmd.args(["/C", target]);
            cmd
        } else {
            Command::new(target)
        };

        command
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Could not launch '{target}': {e}"))
    }

    #[cfg(not(windows))]
    {
        Command::new(target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Could not launch '{target}': {e}"))
    }
}

// ─── App state ───────────────────────────────────────────────────────────────

struct AppState {
    icon_cache: Mutex<HashMap<String, String>>,
    runtime_kill_pids: Mutex<Vec<QueuedProcess>>,
    settings: Mutex<UserSettings>,
    last_screenshot: Mutex<Option<String>>,
    panic_active: Mutex<bool>,
    panic_generation: Mutex<u64>,
}

fn needs_overlay(settings: &UserSettings) -> bool {
    match settings.panic_mode.as_str() {
        "launch_app" => false,
        "combo" => settings.combo_modes.iter().any(|m| m != "launch_app"),
        _ => true,
    }
}

fn wants_mode(settings: &UserSettings, mode: &str) -> bool {
    if settings.panic_mode == mode {
        return true;
    }
    settings.panic_mode == "combo" && settings.combo_modes.iter().any(|m| m == mode)
}

fn overlay_is_present(app: &AppHandle) -> bool {
    app.get_webview_window("panic_overlay").is_some()
}

// ─── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
fn get_processes(state: tauri::State<'_, AppState>) -> Vec<ProcessInfo> {
    let sys = system_with_processes();
    let mut cache = state.icon_cache.lock().unwrap();
    let mut out = Vec::with_capacity(sys.processes().len());

    for (pid, process) in sys.processes() {
        let exe = process
            .exe()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();
        let icon = if exe.is_empty() {
            None
        } else if let Some(hit) = cache.get(&exe) {
            Some(hit.clone())
        } else {
            let value = get_file_icon(&exe, 32).ok().and_then(|raw| {
                let img = ImageBuffer::<image::Rgba<u8>, _>::from_raw(
                    raw.width,
                    raw.height,
                    raw.pixels,
                )?;
                let mut buf = Cursor::new(Vec::new());
                RgbaImage::from(img)
                    .write_to(&mut buf, ImageFormat::Png)
                    .ok()?;
                let encoded = general_purpose::STANDARD.encode(buf.into_inner());
                let url = format!("data:image/png;base64,{encoded}");
                cache.insert(exe.clone(), url.clone());
                Some(url)
            });
            value
        };

        let name = process.name().to_string_lossy().into_owned();
        let protection = protection_reason(&name, pid.as_u32());
        out.push(ProcessInfo {
            pid: pid.as_u32(),
            name,
            cpu_usage: process.cpu_usage(),
            memory_mb: process.memory() / 1_048_576,
            icon,
            start_time: process.start_time(),
            killable: protection.is_none(),
            protection_reason: protection,
            exe_path: if exe.is_empty() { None } else { Some(exe) },
        });
    }

    out.sort_by(|a, b| {
        a.name
         .to_ascii_lowercase()
         .cmp(&b.name.to_ascii_lowercase())
         .then(a.pid.cmp(&b.pid))
    });
    out
}

#[tauri::command]
fn add_pid(pid: u32, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let sys = system_with_processes();
    let process = sys
        .process(Pid::from(pid as usize))
        .ok_or_else(|| format!("PID {pid} is no longer running"))?;
    let name = process.name().to_string_lossy().into_owned();

    if let Some(reason) = protection_reason(&name, pid) {
        return Err(reason);
    }

    let target = QueuedProcess {
        pid,
        name,
        start_time: process.start_time(),
    };
    let mut queue = state.runtime_kill_pids.lock().unwrap();
    if !queue.iter().any(|item| item.pid == pid) {
        queue.push(target);
    }
    Ok("Process queued.".into())
}

#[tauri::command]
fn remove_pid(pid: u32, state: tauri::State<'_, AppState>) -> Result<String, String> {
    state
        .runtime_kill_pids
        .lock()
        .unwrap()
        .retain(|item| item.pid != pid);
    Ok("Process removed from the session queue.".into())
}

#[tauri::command]
fn get_queued_pids(state: tauri::State<'_, AppState>) -> Vec<QueuedProcess> {
    state.runtime_kill_pids.lock().unwrap().clone()
}

#[tauri::command]
fn save_kill_list(
    app: AppHandle,
    names: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let cleaned = names
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .fold(Vec::<String>::new(), |mut out, name| {
            if !out.iter().any(|existing| existing.eq_ignore_ascii_case(&name)) {
                out.push(name);
            }
            out
        });

    let snapshot = {
        let mut settings = state.settings.lock().unwrap();
        settings.saved_kill_processes = cleaned;
        settings.clone()
    };
    persist_settings(&app, &snapshot)?;
    Ok("Kill list saved.".into())
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> UserSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn update_settings(
    app: AppHandle,
    new_settings: UserSettings,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let sanitized = sanitize_settings(new_settings);
    if sanitized.active_shortcut == RESCUE_SHORTCUT {
        return Err(format!("{RESCUE_SHORTCUT} is reserved for emergency overlay recovery"));
    }
    let old_shortcut = state.settings.lock().unwrap().active_shortcut.clone();

    if old_shortcut != sanitized.active_shortcut {
        let new_shortcut = Shortcut::from_str(&sanitized.active_shortcut)
            .map_err(|e| format!("Invalid shortcut '{}': {e}", sanitized.active_shortcut))?;

        app.global_shortcut()
           .on_shortcut(new_shortcut, |handle, _, event| {
               if event.state == ShortcutState::Pressed {
                   guiso_process(handle.clone());
               }
           })
           .map_err(|e| format!("Could not register new shortcut: {e}"))?;

        if let Ok(old) = Shortcut::from_str(&old_shortcut) {
            if let Err(error) = app.global_shortcut().unregister(old) {
                eprintln!("[guiso] warning: old shortcut unregister failed: {error}");
            }
        }
    }

    {
        *state.settings.lock().unwrap() = sanitized.clone();
    }
    persist_settings(&app, &sanitized)?;
    Ok("Settings saved.".into())
}

#[tauri::command]
fn save_gesture(
    app: AppHandle,
    raw_points: Vec<Point>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    if raw_points.len() < 6 || path_length(&raw_points) <= f64::EPSILON {
        return Err("Draw a longer gesture before saving it.".into());
    }

    let normalized = normalize(&raw_points);
    let snapshot = {
        let mut settings = state.settings.lock().unwrap();
        settings.panic_gesture = normalized;
        settings.clone()
    };
    persist_settings(&app, &snapshot)?;
    Ok("Gesture saved.".into())
}

#[tauri::command]
fn get_last_screenshot(state: tauri::State<'_, AppState>) -> Option<String> {
    state.last_screenshot.lock().unwrap().clone()
}

#[tauri::command]
fn trigger_panic(app: AppHandle) {
    guiso_process(app);
}

fn open_panic_preview(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let settings = sanitize_settings(state.settings.lock().unwrap().clone());
    if !needs_overlay(&settings) {
        return Err("This configuration has no visual overlay to preview.".into());
    }
    if overlay_is_present(app) || *state.panic_active.lock().unwrap() {
        return Err("A panic overlay is already active.".into());
    }

    if wants_mode(&settings, "glitch") {
        take_screenshot(app);
    }

    {
        let mut active = state.panic_active.lock().unwrap();
        if *active {
            return Err("A panic operation is already active.".into());
        }
        *active = true;
    }
    let generation = {
        let mut generation = state.panic_generation.lock().unwrap();
        *generation = generation.wrapping_add(1);
        *generation
    };

    spawn_overlay(app, &settings, generation, true);
    Ok(())
}

#[tauri::command]
fn preview_panic(app: AppHandle) -> Result<(), String> {
    open_panic_preview(&app)
}

fn do_close_panic(app: &AppHandle, state: &AppState) {
    if let Some(window) = app.get_webview_window("panic_overlay") {
        let _ = window.close();
    }
    *state.panic_active.lock().unwrap() = false;
    let mut generation = state.panic_generation.lock().unwrap();
    *generation = generation.wrapping_add(1);
}

#[tauri::command]
fn close_panic(app: AppHandle, state: tauri::State<'_, AppState>) {
    do_close_panic(&app, &state);
}

#[tauri::command]
fn is_panic_active(state: tauri::State<'_, AppState>) -> bool {
    *state.panic_active.lock().unwrap()
}

#[tauri::command]
fn test_gesture_score(raw_points: Vec<Point>, state: tauri::State<'_, AppState>) -> f64 {
    let settings = state.settings.lock().unwrap();
    if settings.panic_gesture.is_empty() || raw_points.len() < 6 {
        return f64::MAX;
    }
    match_gesture(&normalize(&raw_points), &settings.panic_gesture)
}

// ─── Screenshot / overlay ─────────────────────────────────────────────────────

fn take_screenshot(app: &AppHandle) {
    let Some(mon) = Monitor::all().ok().and_then(|monitors| monitors.into_iter().next()) else {
        *app.state::<AppState>().last_screenshot.lock().unwrap() = None;
        return;
    };

    let Ok(image) = mon.capture_image() else {
        *app.state::<AppState>().last_screenshot.lock().unwrap() = None;
        return;
    };

    let mut buf = Cursor::new(Vec::new());
    if image.write_to(&mut buf, ImageFormat::Png).is_ok() {
        let b64 = general_purpose::STANDARD.encode(buf.into_inner());
        *app.state::<AppState>().last_screenshot.lock().unwrap() =
            Some(format!("data:image/png;base64,{b64}"));
    } else {
        *app.state::<AppState>().last_screenshot.lock().unwrap() = None;
    }
}

fn spawn_overlay(app: &AppHandle, settings: &UserSettings, generation: u64, preview: bool) {
    // Tauri documents a Windows deadlock hazard when WebviewWindowBuilder::new
    // is called synchronously from commands/event handlers. The global shortcut
    // and tray callbacks are event handlers, so the actual window creation lives
    // on its own thread.
    let handle = app.clone();
    let settings = settings.clone();

    std::thread::spawn(move || {
        let state = handle.state::<AppState>();
        {
            let current_generation = *state.panic_generation.lock().unwrap();
            if current_generation != generation || !*state.panic_active.lock().unwrap() {
                return;
            }
        }

        let title = if wants_mode(&settings, "local") {
            if settings.local_video_title.trim().is_empty() {
                "System Process".to_string()
            } else {
                settings.local_video_title.clone()
            }
        } else {
            "System Process".to_string()
        };

        let result = WebviewWindowBuilder::new(
            &handle,
            "panic_overlay",
            WebviewUrl::App(if preview { "/panic?preview=1".into() } else { "/panic".into() }),
        )
        .title(title)
        .decorations(false)
        .maximized(true)
        .fullscreen(true)
        .always_on_top(true)
        .focused(true)
        .focusable(true)
        .closable(false)
        .visible(false)
        .shadow(false)
        .transparent(true)
        .background_color(Color(0, 0, 0, 0))
        .skip_taskbar(true)
        .resizable(false)
        .build();

        let window = match result {
            Ok(window) => window,
            Err(error) => {
                eprintln!("[guiso] failed to build panic overlay: {error}");
                let state = handle.state::<AppState>();
                let current_generation = *state.panic_generation.lock().unwrap();
                if current_generation == generation {
                    *state.panic_active.lock().unwrap() = false;
                }
                return;
            }
        };

        // Panic surfaces never need pointer interaction. Making the native window
        // click-through means mouse input goes straight to the app underneath,
        // while the focused webview still receives Escape for recovery.
        if let Err(error) = window.set_ignore_cursor_events(true) {
            eprintln!("[guiso] could not enable click-through panic overlay: {error}");
        }

        // A second lifecycle check closes an overlay if the user hit the trigger
        // again while the WebView was being created. This prevents stale windows.
        let stale = {
            let state = handle.state::<AppState>();
            let current_generation = *state.panic_generation.lock().unwrap();
            current_generation != generation || !*state.panic_active.lock().unwrap()
        };

        if stale {
            let _ = window.close();
            return;
        }

        if let Err(error) = window.show() {
            eprintln!("[guiso] failed to show panic overlay: {error}");
            let _ = window.close();
            let state = handle.state::<AppState>();
            let current_generation = *state.panic_generation.lock().unwrap();
            if current_generation == generation {
                *state.panic_active.lock().unwrap() = false;
            }
            return;
        }
        let _ = window.set_focus();

        // Only keep media modes persistent when they actually have usable input.
        // Media modes are persistent unless the user configured an explicit
        // timeout. Pure visual modes are transient: they finish their visual
        // transition and then the native transparent window is destroyed.
        let has_persistent_media =
            (wants_mode(&settings, "youtube") && !settings.youtube_url.trim().is_empty())
                || (wants_mode(&settings, "local") && !settings.local_video_path.trim().is_empty());
        let transient_ms = settings.panic_fade_ms.max(160).saturating_add(1_200);

        let hard_close_ms = if preview {
            10_000
        } else if has_persistent_media {
            if settings.panic_auto_close_ms > 0 {
                settings.panic_auto_close_ms.saturating_add(450)
            } else {
                0
            }
        } else {
            transient_ms.saturating_add(450)
        };

        if hard_close_ms > 0 {
            schedule_overlay_close(&handle, generation, hard_close_ms);
        }
    });
}

fn schedule_overlay_close(app: &AppHandle, generation: u64, delay_ms: u64) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(delay_ms));
        let state = handle.state::<AppState>();

        // Never hold both mutexes at once. Every panic lifecycle path follows
        // the same acquire/release discipline to avoid lock-order deadlocks.
        let current_generation = *state.panic_generation.lock().unwrap();
        if current_generation != generation {
            return;
        }
        if !*state.panic_active.lock().unwrap() {
            return;
        }

        if let Some(window) = handle.get_webview_window("panic_overlay") {
            let _ = window.close();
        }
        *state.panic_active.lock().unwrap() = false;
    });
}

/// One canonical panic path for the keyboard shortcut, gesture, tray and UI.
fn guiso_process(app: AppHandle) {
    let state = app.state::<AppState>();
    let settings = sanitize_settings(state.settings.lock().unwrap().clone());

    if overlay_is_present(&app) || *state.panic_active.lock().unwrap() {
        if settings.panic_hotkey_close {
            do_close_panic(&app, &state);
        }
        return;
    }

    if !needs_overlay(&settings) && settings.panic_mode == "launch_app"
        && settings.launch_app_path.trim().is_empty()
    {
        eprintln!("[guiso] launch_app mode selected but no application path is configured");
    }

    // Claim the panic before doing any work so two triggers cannot overlap.
    {
        let mut active = state.panic_active.lock().unwrap();
        if *active {
            return;
        }
        *active = true;
    }
    let generation = {
        let mut generation = state.panic_generation.lock().unwrap();
        *generation = generation.wrapping_add(1);
        *generation
    };

    let wants_glitch = wants_mode(&settings, "glitch");
    if wants_glitch {
        // Capture first so the screenshot reflects the pre-panic desktop.
        take_screenshot(&app);
    }

    let queued_targets = {
        let mut queue = state.runtime_kill_pids.lock().unwrap();
        let snapshot = queue.clone();
        queue.clear();
        snapshot
    };
    let session_stats = kill_queued_processes(&queued_targets);
    let saved_stats = kill_named_processes(&settings.saved_kill_processes);

    if session_stats.failed > 0 || saved_stats.failed > 0 {
        eprintln!(
            "[guiso] process cleanup: session {}/{} succeeded, {} failed; named {}/{} succeeded, {} failed",
            session_stats.succeeded,
            session_stats.attempted,
            session_stats.failed,
            saved_stats.succeeded,
            saved_stats.attempted,
            saved_stats.failed
        );
    }

    if wants_mode(&settings, "launch_app") && !settings.launch_app_path.trim().is_empty() {
        if let Err(error) = spawn_panic_app(&settings.launch_app_path) {
            eprintln!("[guiso] {error}");
        }
    }

    if !needs_overlay(&settings) {
        *state.panic_active.lock().unwrap() = false;
        return;
    }

    // Build only after cleanup. Actual WebView creation is deliberately moved
    // off the shortcut/tray event thread (see spawn_overlay).
    spawn_overlay(&app, &settings, generation, false);
}

// ─── Application startup ──────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            icon_cache: Mutex::new(HashMap::new()),
            runtime_kill_pids: Mutex::new(Vec::new()),
            settings: Mutex::new(UserSettings::default()),
            last_screenshot: Mutex::new(None),
            panic_active: Mutex::new(false),
            panic_generation: Mutex::new(0),
        })
        .setup(|app| {
            let store = StoreBuilder::new(app, "settings.json")
                .default("config", json!(UserSettings::default()))
                .build()?;

            let loaded: UserSettings = match store.get("config") {
                Some(value) => serde_json::from_value(value.clone()).unwrap_or_default(),
                None => UserSettings::default(),
            };
            let saved = sanitize_settings(loaded);
            *app.state::<AppState>().settings.lock().unwrap() = saved.clone();

            // Persist migrated/sanitized settings immediately so old configs do
            // not re-enter the application in an invalid state.
            if let Err(error) = persist_settings(app.handle(), &saved) {
                eprintln!("[guiso] warning: could not persist normalized settings: {error}");
            }

            if let Ok(shortcut) = Shortcut::from_str(&saved.active_shortcut) {
                if let Err(error) = app.global_shortcut().on_shortcut(shortcut, |handle, _, event| {
                    if event.state == ShortcutState::Pressed {
                        guiso_process(handle.clone());
                    }
                }) {
                    eprintln!("[guiso] could not register shortcut: {error}");
                }
            } else {
                eprintln!("[guiso] invalid saved shortcut '{}'; use Settings to fix it", saved.active_shortcut);
            }

            if saved.active_shortcut != RESCUE_SHORTCUT {
                if let Ok(rescue) = Shortcut::from_str(RESCUE_SHORTCUT) {
                    if let Err(error) = app.global_shortcut().on_shortcut(rescue, |handle, _, event| {
                        if event.state == ShortcutState::Pressed {
                            let state = handle.state::<AppState>();
                            if *state.panic_active.lock().unwrap() || overlay_is_present(&handle) {
                                do_close_panic(&handle, &state);
                            }
                        }
                    }) {
                        eprintln!("[guiso] could not register rescue shortcut: {error}");
                    }
                }
            }

            let show = MenuItem::with_id(app, "show", "Open Settings", true, None::<&str>)?;
            let preview = MenuItem::with_id(app, "preview", "Preview Panic", true, None::<&str>)?;
            let panic = MenuItem::with_id(app, "panic", "Trigger Panic", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &preview, &panic, &quit])?;

            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "panic" => guiso_process(app.clone()),
                    "preview" => {
                        if let Err(error) = open_panic_preview(app) {
                            eprintln!("[guiso] preview failed: {error}");
                        }
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // OS-level mouse gesture listener. We only record after the chosen
            // trigger button is pressed and only end a gesture when that exact
            // button is released. This prevents unrelated clicks from aborting
            // the recognition state.
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                struct GestureState {
                    button: Option<rdev::Button>,
                    points: Vec<Point>,
                }

                let state = Arc::new(Mutex::new(GestureState {
                    button: None,
                    points: Vec::new(),
                }));
                let state_cb = state.clone();

                if let Err(error) = rdev::listen(move |event| match event.event_type {
                    rdev::EventType::ButtonPress(button) => {
                        let settings = app_handle
                            .state::<AppState>()
                            .settings
                            .lock()
                            .unwrap()
                            .clone();
                        if !settings.gesture_enabled
                            || button != gesture_button_from_str(&settings.gesture_button)
                        {
                            return;
                        }
                        let mut recording = state_cb.lock().unwrap();
                        recording.button = Some(button);
                        recording.points.clear();
                    }
                    rdev::EventType::MouseMove { x, y } => {
                        let mut recording = state_cb.lock().unwrap();
                        if recording.button.is_some() {
                            let point = Point { x, y };
                            if recording
                                .points
                                .last()
                                .map(|last| distance(last, &point) >= 1.0)
                                .unwrap_or(true)
                            {
                                recording.points.push(point);
                            }
                        }
                    }
                    rdev::EventType::ButtonRelease(button) => {
                        let points = {
                            let mut recording = state_cb.lock().unwrap();
                            if recording.button != Some(button) {
                                return;
                            }
                            recording.button = None;
                            std::mem::take(&mut recording.points)
                        };

                        if points.len() < 8 || path_length(&points) < 20.0 {
                            return;
                        }

                        let settings = app_handle
                            .state::<AppState>()
                            .settings
                            .lock()
                            .unwrap()
                            .clone();
                        if !settings.gesture_enabled || settings.panic_gesture.is_empty() {
                            return;
                        }

                        let score = match_gesture(&normalize(&points), &settings.panic_gesture);
                        if score <= settings.gesture_threshold {
                            guiso_process(app_handle.clone());
                        }
                    }
                    _ => {}
                }) {
                    eprintln!("[guiso] rdev listener error: {error:?}");
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                let _ = window.hide();
                api.prevent_close();
            }
            tauri::WindowEvent::Destroyed if window.label() == "panic_overlay" => {
                let state = window.app_handle().state::<AppState>();
                *state.panic_active.lock().unwrap() = false;
                let mut generation = state.panic_generation.lock().unwrap();
                *generation = generation.wrapping_add(1);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_processes,
            add_pid,
            remove_pid,
            get_queued_pids,
            save_kill_list,
            get_settings,
            update_settings,
            save_gesture,
            test_gesture_score,
            trigger_panic,
            preview_panic,
            close_panic,
            is_panic_active,
            get_last_screenshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
