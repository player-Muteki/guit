#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod branches;
mod clone;
mod extools;
mod history;
mod inflight;
mod model;
mod probe;
mod refs;
mod repo;
mod reset;
mod runner;
mod sequencer;
mod session;
mod stash;
mod status;
mod submodules;
mod tags;
mod util;
mod watch;
mod worktrees;
mod write;

use probe::{GitProbe, ProbeError, ToolProbe};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, State};

struct ProbeState {
    cancelled: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}

#[tauri::command]
async fn open_repository(
    app: tauri::AppHandle,
    path: String,
) -> Result<session::SnapshotView, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<session::SessionState>();
        let snapshot = session::open(&state, std::path::Path::new(&path))?;
        // Recent/session bookkeeping must not undo a successful open.
        match app_config_dir(&app) {
            Ok(directory) => {
                if let Err(error) = session::record_recent(&directory, &path) {
                    eprintln!("guit [{}]: recent list not updated", error.code);
                }
                if let Err(error) = session::record_session(&directory, &path) {
                    eprintln!("guit [{}]: session not saved", error.code);
                }
            }
            Err(error) => eprintln!("guit [{}]: session not saved", error.code),
        }
        watch::restart(&app);
        Ok(snapshot)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn restore_repository(
    app: tauri::AppHandle,
) -> Result<Option<session::SnapshotView>, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<session::SessionState>();
        if state.current_identity().is_some() {
            let restored = session::restore(&state)?;
            if restored.is_some() {
                watch::restart(&app);
            }
            return Ok(restored);
        }
        let directory = app_config_dir(&app)?;
        let Some(path) = session::read_session(&directory)? else {
            return Ok(None);
        };
        match session::open(&state, std::path::Path::new(&path)) {
            Ok(snapshot) => {
                watch::restart(&app);
                Ok(Some(snapshot))
            }
            Err(error)
                if matches!(
                    error.code,
                    "repo_path_missing" | "not_a_repository" | "repo_worktree_missing"
                ) =>
            {
                session::clear_session(&directory)?;
                watch::stop(&app);
                Ok(None)
            }
            Err(error) => Err(error),
        }
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn refresh_repository(
    app: tauri::AppHandle,
) -> Result<Option<session::SnapshotView>, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<session::SessionState>();
        session::refresh(&state)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
fn close_repository(
    app: tauri::AppHandle,
    state: State<'_, session::SessionState>,
) -> Result<(), ProbeError> {
    session::close(&state);
    // Pending discard/clean tickets belong to the closed snapshot; drop them
    // so a reopen cannot reuse a nonce that referred to the previous session.
    app.state::<write::WriteState>().clear_previews();
    // Close first: any in-flight watcher refresh then sees no session and the
    // supervisor exits on its own without emitting a stale snapshot.
    watch::stop(&app);
    session::clear_session(&app_config_dir(&app)?)
}

#[tauri::command]
fn list_recent_repositories(app: tauri::AppHandle) -> Result<Vec<String>, ProbeError> {
    session::read_recent(&app_config_dir(&app)?)
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

fn app_config_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, ProbeError> {
    app.path()
        .app_config_dir()
        .map_err(|error| ProbeError::new("settings_path_failed", error.to_string()))
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, ProbeError> {
    Ok(app_config_dir(app)?.join("window.json"))
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

#[tauri::command]
async fn clone_repository(
    app: tauri::AppHandle,
    source: String,
    parent: String,
) -> Result<clone::CloneResult, ProbeError> {
    {
        let state = app.state::<clone::CloneState>();
        state
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| ProbeError::new("clone_busy", "A clone is already running."))?;
        state.cancelled.store(false, Ordering::SeqCst);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<clone::CloneState>();
        let outcome = clone::clone_repository(
            &state,
            &source,
            std::path::Path::new(&parent),
            &mut |line| {
                let _ = app.emit("clone-progress", line);
            },
        );
        state.running.store(false, Ordering::SeqCst);
        outcome
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
fn cancel_clone(state: State<'_, clone::CloneState>) {
    state.cancelled.store(true, Ordering::SeqCst);
}

#[tauri::command]
async fn stage_files(
    app: tauri::AppHandle,
    snapshot_version: u64,
    file_ids: Vec<u32>,
) -> Result<write::OperationResult, ProbeError> {
    run_write_command(app, snapshot_version, file_ids, write::OperationKind::Stage).await
}

#[tauri::command]
async fn unstage_files(
    app: tauri::AppHandle,
    snapshot_version: u64,
    file_ids: Vec<u32>,
) -> Result<write::OperationResult, ProbeError> {
    run_write_command(
        app,
        snapshot_version,
        file_ids,
        write::OperationKind::Unstage,
    )
    .await
}

#[tauri::command]
async fn commit_changes(
    app: tauri::AppHandle,
    snapshot_version: u64,
    message: String,
    amend: bool,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        write::execute_commit(&state, &sessions, snapshot_version, message, amend)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

async fn run_write_command(
    app: tauri::AppHandle,
    snapshot_version: u64,
    file_ids: Vec<u32>,
    kind: write::OperationKind,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        write::execute(&state, &sessions, snapshot_version, file_ids, kind)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
fn cancel_write(state: State<'_, write::WriteState>) {
    state.cancel();
}

#[tauri::command]
async fn preview_discard(
    app: tauri::AppHandle,
    snapshot_version: u64,
    file_ids: Vec<u32>,
) -> Result<write::PreviewResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        write::preview_discard(&state, &sessions, snapshot_version, &file_ids)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn discard_files(
    app: tauri::AppHandle,
    nonce: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        write::discard_files(&state, &sessions, nonce)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn preview_clean(
    app: tauri::AppHandle,
    snapshot_version: u64,
) -> Result<write::PreviewResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        write::preview_clean(&state, &sessions, snapshot_version)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn clean_files(
    app: tauri::AppHandle,
    nonce: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        write::clean_files(&state, &sessions, nonce)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn open_external_tool(
    app: tauri::AppHandle,
    snapshot_version: u64,
    file_id: u32,
    purpose: extools::ToolPurpose,
) -> Result<extools::ToolResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<extools::ToolState>();
        let sessions = app.state::<session::SessionState>();
        extools::execute(&state, &sessions, snapshot_version, file_id, purpose)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
fn cancel_exttool(state: State<'_, extools::ToolState>) {
    state.cancel();
}

#[tauri::command]
async fn history_page(
    app: tauri::AppHandle,
    start: u64,
    oid: Option<String>,
) -> Result<history::HistoryPage, ProbeError> {
    if let Some(target) = &oid {
        if !history::valid_oid(target) {
            return Err(ProbeError::new(
                "history_target_invalid",
                "History can only be requested for a full commit id from the current view.",
            ));
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = app.state::<session::SessionState>();
        let identity = sessions
            .current_identity()
            .ok_or_else(|| ProbeError::new("history_no_session", "No repository is open."))?;
        let directory = if identity.is_bare {
            identity.git_dir.as_path()
        } else {
            identity
                .work_dir()
                .map_err(|_| ProbeError::new("repo_worktree_missing", "The work tree is gone."))?
        };
        if oid.is_none()
            && sessions
                .current_view()
                .and_then(|view| view.branch)
                .is_some_and(|branch| branch.head_state == model::HeadState::Unborn)
        {
            // Unborn HEAD has no commits; Git would refuse the log outright.
            return Ok(history::HistoryPage {
                start,
                commits: Vec::new(),
                has_more: false,
            });
        }
        history::page(directory, start, oid.as_deref(), history::PAGE_SIZE)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn commit_files(
    app: tauri::AppHandle,
    oid: String,
) -> Result<Vec<history::CommitFileView>, ProbeError> {
    if !history::valid_oid(&oid) {
        return Err(ProbeError::new(
            "history_target_invalid",
            "Files can only be listed for a full commit id from the current view.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = app.state::<session::SessionState>();
        let identity = sessions
            .current_identity()
            .ok_or_else(|| ProbeError::new("history_no_session", "No repository is open."))?;
        // Read-only listing: a bare repository has objects even without a
        // working copy, so only the tool lane stays work-tree bound.
        let directory = if identity.is_bare {
            identity.git_dir.as_path()
        } else {
            identity
                .work_dir()
                .map_err(|_| ProbeError::new("repo_worktree_missing", "The work tree is gone."))?
        };
        history::commit_files(directory, &oid)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn open_commit_diff(
    app: tauri::AppHandle,
    oid: String,
) -> Result<extools::ToolResult, ProbeError> {
    if !history::valid_oid(&oid) {
        return Err(ProbeError::new(
            "history_target_invalid",
            "A diff can only be opened for a full commit id from the current view.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<extools::ToolState>();
        let sessions = app.state::<session::SessionState>();
        extools::execute_commit_diff(&state, &sessions, &oid)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn list_refs(app: tauri::AppHandle) -> Result<refs::RefListing, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = app.state::<session::SessionState>();
        let identity = sessions
            .current_identity()
            .ok_or_else(|| ProbeError::new("refs_no_session", "No repository is open."))?;
        let directory = if identity.is_bare {
            identity.git_dir.as_path()
        } else {
            identity
                .work_dir()
                .map_err(|_| ProbeError::new("repo_worktree_missing", "The work tree is gone."))?
        };
        refs::list(directory)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn create_branch(
    app: tauri::AppHandle,
    snapshot_version: u64,
    name: String,
    start_oid: Option<String>,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        branches::create_branch(
            &state,
            &sessions,
            snapshot_version,
            &name,
            start_oid.as_deref(),
        )
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn switch_branch(
    app: tauri::AppHandle,
    snapshot_version: u64,
    name: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        branches::switch_branch(&state, &sessions, snapshot_version, &name)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn rename_branch(
    app: tauri::AppHandle,
    snapshot_version: u64,
    old: String,
    new: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        branches::rename_branch(&state, &sessions, snapshot_version, &old, &new)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn preview_delete_branch(
    app: tauri::AppHandle,
    snapshot_version: u64,
    name: String,
    force: bool,
) -> Result<write::PreviewResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        branches::preview_delete_branch(&state, &sessions, snapshot_version, &name, force)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn delete_branch(
    app: tauri::AppHandle,
    nonce: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        branches::delete_branch(&state, &sessions, nonce)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn create_tag(
    app: tauri::AppHandle,
    snapshot_version: u64,
    name: String,
    target_oid: Option<String>,
    message: Option<String>,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        tags::create_tag(
            &state,
            &sessions,
            snapshot_version,
            &name,
            target_oid.as_deref(),
            message.as_deref(),
        )
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn show_tag(app: tauri::AppHandle, name: String) -> Result<tags::TagDetail, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = app.state::<session::SessionState>();
        let identity = sessions
            .current_identity()
            .ok_or_else(|| ProbeError::new("refs_no_session", "No repository is open."))?;
        // Read-only view: a bare repository resolves tags from its git dir.
        let directory = if identity.is_bare {
            identity.git_dir.as_path()
        } else {
            identity
                .work_dir()
                .map_err(|_| ProbeError::new("repo_worktree_missing", "The work tree is gone."))?
        };
        tags::tag_detail(directory, &name)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn preview_delete_tag(
    app: tauri::AppHandle,
    snapshot_version: u64,
    name: String,
) -> Result<write::PreviewResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        tags::preview_delete_tag(&state, &sessions, snapshot_version, &name)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn delete_tag(
    app: tauri::AppHandle,
    nonce: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        tags::delete_tag(&state, &sessions, nonce)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn stash_list(app: tauri::AppHandle) -> Result<Vec<stash::StashEntry>, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = app.state::<session::SessionState>();
        stash::list_view(&sessions)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn stash_save(
    app: tauri::AppHandle,
    snapshot_version: u64,
    message: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        stash::stash_save(&state, &sessions, snapshot_version, &message)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn stash_apply(
    app: tauri::AppHandle,
    snapshot_version: u64,
    index: u32,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        stash::stash_apply(&state, &sessions, snapshot_version, index)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn preview_stash_pop(
    app: tauri::AppHandle,
    snapshot_version: u64,
    index: u32,
) -> Result<write::PreviewResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        stash::preview_stash_pop(&state, &sessions, snapshot_version, index)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn stash_pop(
    app: tauri::AppHandle,
    nonce: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        stash::stash_pop(&state, &sessions, nonce)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn preview_stash_drop(
    app: tauri::AppHandle,
    snapshot_version: u64,
    index: u32,
) -> Result<write::PreviewResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        stash::preview_stash_drop(&state, &sessions, snapshot_version, index)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn stash_drop(
    app: tauri::AppHandle,
    nonce: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        stash::stash_drop(&state, &sessions, nonce)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn merge_start(
    app: tauri::AppHandle,
    snapshot_version: u64,
    target: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        sequencer::merge_start(&state, &sessions, snapshot_version, &target)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn rebase_start(
    app: tauri::AppHandle,
    snapshot_version: u64,
    target: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        sequencer::rebase_start(&state, &sessions, snapshot_version, &target)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn operation_continue(
    app: tauri::AppHandle,
    snapshot_version: u64,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        sequencer::operation_continue(&state, &sessions, snapshot_version)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn operation_abort(
    app: tauri::AppHandle,
    snapshot_version: u64,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        sequencer::operation_abort(&state, &sessions, snapshot_version)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn operation_skip(
    app: tauri::AppHandle,
    snapshot_version: u64,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        sequencer::operation_skip(&state, &sessions, snapshot_version)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn pick_commit(
    app: tauri::AppHandle,
    snapshot_version: u64,
    oid: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        sequencer::pick_commit(&state, &sessions, snapshot_version, &oid)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn revert_commit(
    app: tauri::AppHandle,
    snapshot_version: u64,
    oid: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        sequencer::revert_commit(&state, &sessions, snapshot_version, &oid)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn reset(
    app: tauri::AppHandle,
    snapshot_version: u64,
    mode: reset::ModeArg,
    target: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        reset::reset(&state, &sessions, snapshot_version, mode, &target)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn preview_reset_hard(
    app: tauri::AppHandle,
    snapshot_version: u64,
    target: String,
) -> Result<write::PreviewResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        reset::preview_reset_hard(&state, &sessions, snapshot_version, &target)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn reset_hard(
    app: tauri::AppHandle,
    nonce: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        reset::reset_hard(&state, &sessions, nonce)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn list_worktrees(app: tauri::AppHandle) -> Result<Vec<worktrees::WorktreeView>, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = app.state::<session::SessionState>();
        worktrees::list_view(&sessions)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn add_worktree(
    app: tauri::AppHandle,
    snapshot_version: u64,
    path: String,
    target: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        worktrees::worktree_add(&state, &sessions, snapshot_version, path, target)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn preview_remove_worktree(
    app: tauri::AppHandle,
    snapshot_version: u64,
    index: u32,
) -> Result<write::PreviewResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        worktrees::preview_remove_worktree(&state, &sessions, snapshot_version, index)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn remove_worktree(
    app: tauri::AppHandle,
    nonce: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        worktrees::remove_worktree(&state, &sessions, nonce)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn prune_worktrees(
    app: tauri::AppHandle,
    snapshot_version: u64,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        worktrees::prune_worktrees(&state, &sessions, snapshot_version)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn submodule_status(
    app: tauri::AppHandle,
) -> Result<Vec<submodules::SubmoduleView>, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = app.state::<session::SessionState>();
        submodules::list_view(&sessions)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn submodule_init_update(
    app: tauri::AppHandle,
    snapshot_version: u64,
    index: Option<u32>,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        submodules::init_update(&state, &sessions, snapshot_version, index, &mut |line| {
            let _ = app.emit("submodule-progress", line);
        })
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ProbeState {
            cancelled: Arc::new(AtomicBool::new(false)),
            running: Arc::new(AtomicBool::new(false)),
        })
        .manage(session::SessionState::default())
        .manage(watch::WatchState::default())
        .manage(clone::CloneState::default())
        .manage(write::WriteState::default())
        .manage(extools::ToolState::default())
        .invoke_handler(tauri::generate_handler![
            probe_git,
            probe_external_tools,
            run_process_probe,
            run_transfer_probe,
            cancel_process_probe,
            save_window_settings,
            load_window_settings,
            restore_window_settings,
            open_repository,
            restore_repository,
            refresh_repository,
            close_repository,
            list_recent_repositories,
            clone_repository,
            cancel_clone,
            stage_files,
            unstage_files,
            commit_changes,
            cancel_write,
            preview_discard,
            discard_files,
            preview_clean,
            clean_files,
            open_external_tool,
            cancel_exttool,
            history_page,
            commit_files,
            open_commit_diff,
            list_refs,
            create_branch,
            switch_branch,
            rename_branch,
            preview_delete_branch,
            delete_branch,
            create_tag,
            show_tag,
            preview_delete_tag,
            delete_tag,
            stash_list,
            stash_save,
            stash_apply,
            preview_stash_pop,
            stash_pop,
            preview_stash_drop,
            stash_drop,
            merge_start,
            rebase_start,
            operation_continue,
            operation_abort,
            operation_skip,
            pick_commit,
            revert_commit,
            reset,
            preview_reset_hard,
            reset_hard,
            list_worktrees,
            add_worktree,
            preview_remove_worktree,
            remove_worktree,
            prune_worktrees,
            submodule_status,
            submodule_init_update
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
