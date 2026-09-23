#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod probe;
mod repo;
mod runner;
mod util;

use probe::{GitProbe, ProbeError, ToolProbe};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, State};

struct ProbeState {
    cancelled: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowSettings {
    #[serde(default = "settings_version")]
    schema_version: u32,
    width: u32,
    height: u32,
    #[serde(default)]
    frame_width: u32,
    #[serde(default)]
    frame_height: u32,
    x: i32,
    y: i32,
    always_on_top: bool,
    #[serde(default)]
    maximized: bool,
}

fn settings_version() -> u32 {
    1
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, ProbeError> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("window.json"))
        .map_err(|error| ProbeError::new("settings_path_failed", error.to_string()))
}

#[tauri::command]
fn save_window_settings(app: tauri::AppHandle, settings: WindowSettings) -> Result<(), ProbeError> {
    let path = settings_path(&app)?;
    write_window_settings(&path, &settings)
}

fn write_window_settings(
    path: &std::path::Path,
    settings: &WindowSettings,
) -> Result<(), ProbeError> {
    if settings.schema_version != settings_version() || settings.width == 0 || settings.height == 0
    {
        return Err(ProbeError::new(
            "settings_invalid",
            "Unsupported settings version or invalid window size.",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| ProbeError::new("settings_path_failed", "Invalid settings path"))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| ProbeError::new("settings_write_failed", error.to_string()))?;
    let data = serde_json::to_vec(&settings)
        .map_err(|error| ProbeError::new("settings_encode_failed", error.to_string()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| ProbeError::new("settings_write_failed", error.to_string()))?;
    temporary
        .write_all(&data)
        .map_err(|error| ProbeError::new("settings_write_failed", error.to_string()))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| ProbeError::new("settings_write_failed", error.to_string()))?;
    temporary
        .persist(&path)
        .map(|_| ())
        .map_err(|error| ProbeError::new("settings_write_failed", error.to_string()))
}

#[tauri::command]
fn load_window_settings(app: tauri::AppHandle) -> Result<Option<WindowSettings>, ProbeError> {
    let path = settings_path(&app)?;
    read_window_settings(&path)
}

fn read_window_settings(path: &std::path::Path) -> Result<Option<WindowSettings>, ProbeError> {
    match std::fs::read(path) {
        Ok(data) => {
            let settings: WindowSettings = serde_json::from_slice(&data)
                .map_err(|error| ProbeError::new("settings_decode_failed", error.to_string()))?;
            if settings.schema_version != settings_version()
                || settings.width == 0
                || settings.height == 0
            {
                return Err(ProbeError::new(
                    "settings_invalid",
                    "Unsupported settings version or invalid window size.",
                ));
            }
            Ok(Some(settings))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(ProbeError::new("settings_read_failed", error.to_string())),
    }
}

#[tauri::command]
fn restore_window_settings(app: tauri::AppHandle) -> Result<Option<WindowSettings>, ProbeError> {
    let Some(mut settings) = load_window_settings(app.clone())? else {
        return Ok(None);
    };
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| ProbeError::new("window_missing", "Main window is unavailable"))?;
    let monitors = window
        .available_monitors()
        .map_err(|error| ProbeError::new("monitor_query_failed", error.to_string()))?;
    let monitor = monitors
        .iter()
        .find(|monitor| {
            let origin = monitor.position();
            let size = monitor.size();
            i64::from(settings.x) >= i64::from(origin.x)
                && i64::from(settings.y) >= i64::from(origin.y)
                && i64::from(settings.x) < i64::from(origin.x) + i64::from(size.width)
                && i64::from(settings.y) < i64::from(origin.y) + i64::from(size.height)
        })
        .or(monitors.first());
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        fit_window(
            &mut settings,
            area.position,
            area.size,
            monitor.scale_factor(),
        );
        window
            .set_position(PhysicalPosition::new(settings.x, settings.y))
            .map_err(|error| ProbeError::new("window_restore_failed", error.to_string()))?;
    }
    window
        .set_size(PhysicalSize::new(settings.width, settings.height))
        .map_err(|error| ProbeError::new("window_restore_failed", error.to_string()))?;
    if settings.maximized {
        window
            .maximize()
            .map_err(|error| ProbeError::new("window_restore_failed", error.to_string()))?;
    }
    window
        .set_always_on_top(settings.always_on_top)
        .map_err(|error| ProbeError::new("window_restore_failed", error.to_string()))?;
    Ok(Some(settings))
}

fn fit_window(
    settings: &mut WindowSettings,
    origin: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    scale: f64,
) {
    let available_width = size.width.saturating_sub(settings.frame_width).max(1);
    let available_height = size.height.saturating_sub(settings.frame_height).max(1);
    settings.width = settings.width.clamp(
        ((340.0 * scale) as u32).min(available_width),
        available_width,
    );
    settings.height = settings.height.clamp(
        ((400.0 * scale) as u32).min(available_height),
        available_height,
    );
    settings.x = i64::from(settings.x).clamp(
        i64::from(origin.x),
        i64::from(origin.x) + i64::from(available_width - settings.width),
    ) as i32;
    settings.y = i64::from(settings.y).clamp(
        i64::from(origin.y),
        i64::from(origin.y) + i64::from(available_height - settings.height),
    ) as i32;
}

#[tauri::command]
async fn probe_git() -> Result<GitProbe, ProbeError> {
    tauri::async_runtime::spawn_blocking(probe::git)
        .await
        .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn probe_external_tools() -> Result<ToolProbe, ProbeError> {
    tauri::async_runtime::spawn_blocking(probe::external_tools)
        .await
        .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn run_transfer_probe(app: tauri::AppHandle) -> Result<String, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        probe::transfer(|bytes| {
            let _ = app.emit("probe-progress", bytes);
        })
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn run_process_probe(state: State<'_, ProbeState>) -> Result<String, ProbeError> {
    state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| ProbeError::new("probe_busy", "A process probe is already running."))?;
    state.cancelled.store(false, Ordering::SeqCst);
    let cancelled = state.cancelled.clone();
    let running = state.running.clone();
    let result = tauri::async_runtime::spawn_blocking(move || probe::process(&cancelled))
        .await
        .map_err(|error| ProbeError::new("task_failed", error.to_string()));
    running.store(false, Ordering::SeqCst);
    result?
}

#[tauri::command]
fn cancel_process_probe(state: State<'_, ProbeState>) {
    state.cancelled.store(true, Ordering::SeqCst);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ProbeState {
            cancelled: Arc::new(AtomicBool::new(false)),
            running: Arc::new(AtomicBool::new(false)),
        })
        .invoke_handler(tauri::generate_handler![
            probe_git,
            probe_external_tools,
            run_process_probe,
            run_transfer_probe,
            cancel_process_probe,
            save_window_settings,
            load_window_settings,
            restore_window_settings
        ])
        .run(tauri::generate_context!())
        .expect("failed to start guit");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_settings_use_frontend_field_names() {
        let settings = WindowSettings {
            schema_version: 1,
            width: 720,
            height: 560,
            frame_width: 0,
            frame_height: 0,
            x: 10,
            y: 20,
            always_on_top: true,
            maximized: false,
        };
        let value = serde_json::to_value(settings).unwrap();
        assert_eq!(value["alwaysOnTop"], true);
        assert!(value.get("always_on_top").is_none());
    }

    #[test]
    fn settings_replace_existing_file_and_reject_corruption() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("window.json");
        let mut settings: WindowSettings =
            serde_json::from_str(r#"{"width":720,"height":560,"x":0,"y":0,"alwaysOnTop":false}"#)
                .unwrap();
        write_window_settings(&path, &settings).unwrap();
        settings.always_on_top = true;
        write_window_settings(&path, &settings).unwrap();
        assert!(read_window_settings(&path).unwrap().unwrap().always_on_top);
        std::fs::write(&path, b"invalid").unwrap();
        assert_eq!(
            read_window_settings(&path).unwrap_err().code,
            "settings_decode_failed"
        );
        settings.schema_version = 99;
        assert_eq!(
            write_window_settings(&path, &settings).unwrap_err().code,
            "settings_invalid"
        );
    }

    #[test]
    fn window_fits_new_monitor_including_frame_and_negative_origin() {
        let mut settings: WindowSettings = serde_json::from_str(r#"{"width":9000,"height":9000,"frameWidth":180,"frameHeight":278,"x":9000,"y":9000,"alwaysOnTop":false}"#).unwrap();
        fit_window(
            &mut settings,
            PhysicalPosition::new(-1920, 0),
            PhysicalSize::new(1920, 1080),
            1.0,
        );
        assert_eq!((settings.width, settings.height), (1740, 802));
        assert_eq!((settings.x, settings.y), (-1920, 0));
    }
}
