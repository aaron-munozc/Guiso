use app_info::get_file_icon;
use base64::{engine::general_purpose, Engine as _};
use image::{ImageBuffer, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::io::Cursor;
use std::str::FromStr;
use std::sync::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::{StoreBuilder, StoreExt};
use xcap::Monitor;

#[derive(Serialize)]
pub struct ProcessInfo {
    pid: u32,
    name: String,
    cpu_usage: f32,
    memory_mb: u64,
    icon: Option<String>,
}

pub enum Theme {
    Light,
    Dark,
}

// Struct to represent user preferences cleanly
#[derive(Serialize, Deserialize, Clone)]
pub struct UserSettings {
    pub active_shortcut: String,
    pub theme: String,
    pub panic_mode: String, // "youtube", "local", "color", "launch_app", "glitch"
    pub panic_target: String, // URL, file path, or app command
    pub panic_fade_ms: u64,
    pub panic_color: String,
    pub panic_blur_px: u32,
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            active_shortcut: "CmdOrCtrl+Shift+K".to_string(),
            theme: "dark".to_string(),
            panic_mode: "youtube".to_string(),
            panic_target: "".to_string(),
            panic_fade_ms: 2000,
            panic_color: "rgba(18, 18, 18, 0.95)".to_string(),
            panic_blur_px: 24,
        }
    }
}
struct AppState {
    icon_cache: Mutex<HashMap<String, String>>,
    pids_to_kill: Mutex<Vec<u32>>,
    settings: Mutex<UserSettings>,
    last_screenshot: Mutex<Option<String>>,
}

#[tauri::command]
fn get_processes(state: tauri::State<'_, AppState>) -> Vec<ProcessInfo> {
    // 1. Fixed: `new()` replaced by `nothing()` in recent versions of sysinfo
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
    );

    // 2. Fixed: `refresh_processes` now requires an argument
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let mut icon_cache = state.icon_cache.lock().unwrap();
    let mut processes = Vec::new();

    for (pid, process) in sys.processes() {
        // Extract the absolute path of the executable
        let exe_path = match process.exe() {
            Some(path) => path.to_string_lossy().to_string(),
            None => String::new(),
        };

        let mut icon_base64 = None;

        if !exe_path.is_empty() {
            // Check if we have already generated this icon during the session
            if let Some(cached_icon) = icon_cache.get(&exe_path) {
                icon_base64 = Some(cached_icon.clone());
            } else {
                // If not cached, extract a 64x64 icon from the OS binary
                if let Ok(icon) = get_file_icon(&exe_path, 64) {
                    // `icon.data` returns raw RGBA bytes. Convert to an ImageBuffer.
                    if let Some(img) = ImageBuffer::<image::Rgba<u8>, _>::from_raw(
                        icon.width,
                        icon.height,
                        icon.pixels,
                    ) {
                        // Write the buffer into memory as a standard PNG format
                        let mut buffer = Cursor::new(Vec::new());
                        if RgbaImage::from(img)
                            .write_to(&mut buffer, ImageFormat::Png)
                            .is_ok()
                        {
                            // Encode the PNG bytes into a Base64 string for the HTML frontend
                            let b64 = general_purpose::STANDARD.encode(buffer.into_inner());
                            let data_url = format!("data:image/png;base64,{}", b64);

                            // Save to cache for future lookups
                            icon_cache.insert(exe_path.clone(), data_url.clone());
                            icon_base64 = Some(data_url);
                        }
                    }
                }
            }
        }

        // 3. Fixed: `process.name()` returns an OsStr, needs `.to_string_lossy()`
        let process_name = process.name().to_string_lossy().into_owned();

        processes.push(ProcessInfo {
            pid: pid.as_u32(),
            name: process_name,
            cpu_usage: process.cpu_usage(),
            memory_mb: process.memory() / 1_048_576,
            icon: icon_base64,
        });
    }

    processes
}

fn kill_process(pid: u32) -> Result<String, String> {
    let mut sys = System::new_all();

    // 2. Fixed: Adding the argument here as well
    sys.refresh_processes(ProcessesToUpdate::All, true);

    if let Some(process) = sys.process(Pid::from(pid as usize)) {
        if process.kill() {
            Ok(format!("Process {} terminated successfully.", pid))
        } else {
            Err(format!(
                "Found process {}, but lacked OS permissions to kill it.",
                pid
            ))
        }
    } else {
        Err("Process not found. It may have already closed.".to_string())
    }
}

#[tauri::command]
fn add_pid(pid: u32, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let mut pids = state.pids_to_kill.lock().unwrap();

    if !pids.contains(&pid) {
        pids.push(pid);
        Ok(format!("PID {} queued for termination.", pid))
    } else {
        Ok(format!("PID {} is already queued.", pid))
    }
}

#[tauri::command]
fn remove_pid(pid: u32, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let mut pids = state.pids_to_kill.lock().unwrap();
    pids.retain(|&x| x != pid);
    Ok(format!("PID {} removed from queue.", pid))
}

// Helper function to execute the kill sequence
fn execute_kill_sequence(app: tauri::AppHandle) {
    let state = app.state::<AppState>();
    let mut pids = state.pids_to_kill.lock().unwrap();
    for pid in pids.iter() {
        let _ = kill_process(*pid);
    }
    pids.clear();
}
#[tauri::command]
fn update_settings(
    app: tauri::AppHandle,
    new_settings: UserSettings,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let mut settings_lock = state.settings.lock().unwrap();

    if settings_lock.active_shortcut != new_settings.active_shortcut {
        let old = Shortcut::from_str(&settings_lock.active_shortcut).unwrap();
        let new = Shortcut::from_str(&new_settings.active_shortcut).unwrap();

        let _ = app.global_shortcut().unregister(old);
        let _ = app
            .global_shortcut()
            .on_shortcut(new, move |app_handle, _, event| {
                if event.state == ShortcutState::Pressed {
                    guiso_process(app_handle.clone());
                }
            });
    }

    *settings_lock = new_settings.clone();
    let store = app.store("settings.json").unwrap();
    store.set("config", json!(new_settings));

    Ok("Settings updated successfully.".to_string())
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> UserSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn get_last_screenshot(state: tauri::State<'_, AppState>) -> Option<String> {
    state.last_screenshot.lock().unwrap().clone()
}

// Runs on the global shortcut
fn guiso_process(app: AppHandle) {
    let settings = app.state::<AppState>().settings.lock().unwrap().clone();

    // 1. If mode is glitch, capture the screen BEFORE killing anything
    if settings.panic_mode == "glitch" {
        if let Ok(monitors) = Monitor::all() {
            if let Some(monitor) = monitors.first() {
                if let Ok(image) = monitor.capture_image() {
                    let mut buffer = Cursor::new(Vec::new());
                    if image.write_to(&mut buffer, ImageFormat::Png).is_ok() {
                        let b64 = general_purpose::STANDARD.encode(buffer.into_inner());
                        let state = app.state::<AppState>();
                        *state.last_screenshot.lock().unwrap() =
                            Some(format!("data:image/png;base64,{}", b64));
                    }
                }
            }
        }
    }

    // 2. Execute order 66 (Kill the apps)
    execute_kill_sequence(app.clone());

    // 3. If mode is "launch_app", spawn it and abort window creation
    if settings.panic_mode == "launch_app" && !settings.panic_target.is_empty() {
        let _ = app.shell().command(&settings.panic_target).spawn();
        return;
    }

    // 4. Build the immersive overlay window
    if app.get_webview_window("panic_overlay").is_some() {
        return;
    }

    let _ = WebviewWindowBuilder::new(&app, "panic_overlay", WebviewUrl::App("/panic".into()))
        .title("System Process")
        .decorations(false)
        .fullscreen(true)
        .always_on_top(true)
        .transparent(true)
        .skip_taskbar(true)
        .build();
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init()) // Init shell
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            icon_cache: Mutex::new(HashMap::new()),
            pids_to_kill: Mutex::new(Vec::new()),
            settings: Mutex::new(UserSettings::default()),
            last_screenshot: Mutex::new(None),
        })
        .setup(|app| {
            let default_config = UserSettings::default();
            let store = StoreBuilder::new(app, "settings.json")
                .default("config", json!(default_config))
                .build()?;

            let loaded_settings: UserSettings = match store.get("config") {
                Some(value) => serde_json::from_value(value.clone())
                    .unwrap_or_else(|_| UserSettings::default()),
                None => UserSettings::default(),
            };

            let state = app.state::<AppState>();
            *state.settings.lock().unwrap() = loaded_settings.clone();

            // 1. Build Native Context Menu for the System Tray
            let open_settings_item =
                MenuItem::with_id(app, "open_settings", "Open Dashboard", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Application", true, None::<&str>)?;

            let tray_menu = MenuBuilder::new(app)
                .item(&open_settings_item)
                .separator()
                .item(&quit_item)
                .build()?;

            // 2. Instantiate the System Tray Icon
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .on_menu_event(|app_handle, event| match event.id.as_ref() {
                    "open_settings" => {
                        // Locate and bring the main control window to foreground
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app_handle.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // 3. Bind Global Keyboard Listener to Layout Engine Sequence
            let active_shortcut = Shortcut::from_str(&loaded_settings.active_shortcut).unwrap();
            app.global_shortcut()
                .on_shortcut(active_shortcut, move |app_handle, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        guiso_process(app_handle.clone());
                    }
                })
                .unwrap();

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_processes,
            add_pid,
            remove_pid,
            get_settings,
            update_settings,
            get_last_screenshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
