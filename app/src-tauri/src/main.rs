#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activity;
mod branches;
mod diagnostics;
mod extools;
mod fuzzy;
mod history;
mod inflight;
mod model;
mod perf;
mod probe;
mod refs;
mod repo;
mod reset;
mod runner;
mod search;
mod sequencer;
mod session;
mod status;
mod tags;
mod util;
mod watch;
mod write;

use probe::{Code, GitProbe, ProbeError, ToolProbe};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::{Manager, PhysicalPosition, PhysicalSize, State};

struct ProbeState {
    cancelled: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}

#[tauri::command]
async fn open_repository(
    app: tauri::AppHandle,
    path: String,
) -> Result<session::SnapshotView, ProbeError> {
    let started = Instant::now();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
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
    .await;
    perf::mark("open.total", started.elapsed());
    outcome.map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn restore_repository(
    app: tauri::AppHandle,
) -> Result<Option<session::SnapshotView>, ProbeError> {
    let started = Instant::now();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
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
                    Code::REPO_PATH_MISSING | Code::NOT_A_REPOSITORY | Code::REPO_WORKTREE_MISSING
                ) =>
            {
                session::clear_session(&directory)?;
                watch::stop(&app);
                Ok(None)
            }
            Err(error) => Err(error),
        }
    })
    .await;
    perf::mark("startup.restore_total", started.elapsed());
    perf::mark_since_start("startup.restore_at");
    outcome.map_err(|error| ProbeError::new("task_failed", error.to_string()))?
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
    // Same for the graph's remembered page boundary: it is a claim about the
    // history the closed session read, and no later session can match it, but
    // it holds object ids until the process ends.
    app.state::<history::GraphCache>().clear();
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
    // The refusing has to go both ways. `read_window_settings` will not interpret
    // a newer file, and without the same check here the next resize would write
    // this build's guess of the geometry over the newer choice it refused to read.
    if session::config_is_sealed(path, |existing: &WindowSettings| {
        existing.schema_version == settings_version()
    }) {
        return Err(ProbeError::new(
            "settings_sealed",
            "Window settings were written by another version and are left untouched.",
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
        .persist(path)
        .map(|_| ())
        .map_err(|error| ProbeError::new("settings_write_failed", error.to_string()))
}

/// Atomic config writes (window settings here, recent/session in the
/// session module) land through `tempfile` siblings named
/// `<name>.tmpXXXXXX`. A kill mid-write leaves such a sibling behind; it is
/// never read back, and after an hour no in-flight write can still own it.
/// The suffix shape (exactly six alphanumerics) keeps unrelated user files
/// that merely end in `.tmp` out of reach. Returns the number removed.
fn sweep_stale_config_temps(config_dir: &std::path::Path) -> usize {
    const OWNED: [&str; 3] = ["recent.json", "session.json", "window.json"];
    let Ok(entries) = std::fs::read_dir(config_dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some((base, suffix)) = name.split_once(".tmp") else {
            continue;
        };
        if !OWNED.contains(&base)
            || suffix.len() != 6
            || !suffix.chars().all(|c| c.is_ascii_alphanumeric())
        {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let older_than_an_hour = meta
            .modified()
            .ok()
            .and_then(|when| when.elapsed().ok())
            .is_some_and(|age| age > std::time::Duration::from_secs(3600));
        if older_than_an_hour && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Reads the stored geometry, if any. Not a command: the only caller is
/// `restore_window_settings`, which runs before the window exists, so
/// exposing this over IPC would publish an endpoint with no caller.
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
async fn stage_files(
    app: tauri::AppHandle,
    snapshot_version: u64,
    file_ids: Vec<u32>,
) -> Result<write::OperationResult, ProbeError> {
    run_write_command(app, snapshot_version, file_ids, write::PathWrite::Stage).await
}

#[tauri::command]
async fn unstage_files(
    app: tauri::AppHandle,
    snapshot_version: u64,
    file_ids: Vec<u32>,
) -> Result<write::OperationResult, ProbeError> {
    run_write_command(app, snapshot_version, file_ids, write::PathWrite::Unstage).await
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
    path_write: write::PathWrite,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        write::execute(&state, &sessions, snapshot_version, file_ids, path_write)
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
    file_ids: Vec<u32>,
) -> Result<write::PreviewResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        write::preview_clean(&state, &sessions, snapshot_version, &file_ids)
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
    context: session::ReadContext,
    start: u64,
    oid: Option<String>,
    first_parent: Option<bool>,
) -> Result<session::SessionRead<history::HistoryPage>, ProbeError> {
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
        let (identity, answered) = sessions.bind_read(context, session::ReadDomain::Graph)?;
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
            return Ok(session::SessionRead::new(
                answered,
                history::HistoryPage {
                    start,
                    commits: Vec::new(),
                    has_more: false,
                },
            ));
        }
        // A page is drawn from its own rows plus the lanes the page above left
        // open. When the caller named no commit, the commit is the one this
        // session was published with — the same value `historyGeneration` counts
        // moving — rather than a `HEAD` resolved afresh in each read.
        let target = oid.or_else(|| sessions.pinned_head());
        let cache = app.state::<history::GraphCache>();
        history::page(
            directory,
            answered,
            start,
            target.as_deref(),
            history::PAGE_SIZE,
            first_parent.unwrap_or(false),
            &cache,
        )
        .map(|page| session::SessionRead::new(answered, page))
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn commit_files(
    app: tauri::AppHandle,
    context: session::ReadContext,
    oid: String,
) -> Result<session::SessionRead<Vec<history::CommitFileView>>, ProbeError> {
    if !history::valid_oid(&oid) {
        return Err(ProbeError::new(
            "history_target_invalid",
            "Files can only be listed for a full commit id from the current view.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = app.state::<session::SessionState>();
        let (identity, answered) = sessions.bind_read(context, session::ReadDomain::Graph)?;
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
            .map(|files| session::SessionRead::new(answered, files))
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn open_commit_diff(
    app: tauri::AppHandle,
    context: session::ReadContext,
    oid: String,
) -> Result<session::SessionRead<extools::ToolResult>, ProbeError> {
    if !history::valid_oid(&oid) {
        return Err(ProbeError::new(
            "history_target_invalid",
            "A diff can only be opened for a full commit id from the current view.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<extools::ToolState>();
        let sessions = app.state::<session::SessionState>();
        extools::execute_commit_diff(&state, &sessions, context, &oid)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn search_repository(
    app: tauri::AppHandle,
    context: session::ReadContext,
    query_id: u64,
    query: String,
    cursor: u64,
) -> Result<session::SessionRead<search::SearchPage>, ProbeError> {
    // `query_id` numbers the reader's question rather than this request: every
    // window of one question carries the same id and shares one cancellation, and
    // a window belonging to an older question is refused before Git is asked.
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = app.state::<session::SessionState>();
        let lane = app.state::<search::SearchState>();
        search::page(&sessions, &lane, context, query_id, &query, cursor)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
fn cancel_search(state: State<'_, search::SearchState>, session_id: u64, query_id: u64) {
    // A cleared field is no longer asking its question, so the scan answering the
    // old one is stopped where it stands rather than walked to its window's end.
    // It carries no repository state of its own: it names a question by the two
    // numbers that identify it, and does nothing to either if the lane holds a
    // different one.
    state.cancel(session_id, query_id);
}

#[tauri::command]
async fn list_refs(
    app: tauri::AppHandle,
    context: session::ReadContext,
) -> Result<session::SessionRead<refs::RefListing>, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = app.state::<session::SessionState>();
        let (identity, answered) = sessions.bind_read(context, session::ReadDomain::Refs)?;
        let directory = if identity.is_bare {
            identity.git_dir.as_path()
        } else {
            identity
                .work_dir()
                .map_err(|_| ProbeError::new("repo_worktree_missing", "The work tree is gone."))?
        };
        refs::list(directory).map(|listing| session::SessionRead::new(answered, listing))
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
async fn show_tag(
    app: tauri::AppHandle,
    context: session::ReadContext,
    name: String,
) -> Result<session::SessionRead<tags::TagDetail>, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = app.state::<session::SessionState>();
        let (identity, answered) = sessions.bind_read(context, session::ReadDomain::Refs)?;
        // Read-only view: a bare repository resolves tags from its git dir.
        let directory = if identity.is_bare {
            identity.git_dir.as_path()
        } else {
            identity
                .work_dir()
                .map_err(|_| ProbeError::new("repo_worktree_missing", "The work tree is gone."))?
        };
        tags::tag_detail(directory, &name).map(|detail| session::SessionRead::new(answered, detail))
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
async fn preview_restore(
    app: tauri::AppHandle,
    snapshot_version: u64,
    target: String,
) -> Result<reset::RestorePreview, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        reset::preview_restore(&state, &sessions, snapshot_version, &target)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

#[tauri::command]
async fn restore_clean(
    app: tauri::AppHandle,
    nonce: String,
) -> Result<write::OperationResult, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<write::WriteState>();
        let sessions = app.state::<session::SessionState>();
        reset::restore_clean(&state, &sessions, nonce)
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

/// Writes the fixed diagnostics snapshot to the path the user chose
/// in the save dialog (the content manifest was confirmed in the UI before
/// this is ever invoked). The frontend sends only a path; every fact comes
/// from the backend's own redacted views.
#[tauri::command]
async fn export_diagnostics(app: tauri::AppHandle, path: String) -> Result<String, ProbeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let git = probe::git().ok();
        let mut config_files = Vec::new();
        if let Ok(directory) = app_config_dir(&app) {
            if let Ok(entries) = std::fs::read_dir(directory) {
                for entry in entries.flatten() {
                    let Ok(meta) = entry.metadata() else { continue };
                    if !meta.is_file() {
                        continue;
                    }
                    let schema_version = std::fs::read_to_string(entry.path())
                        .ok()
                        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                        .and_then(|value| {
                            value
                                .get("schema_version")
                                .or_else(|| value.get("schemaVersion"))
                                .and_then(serde_json::Value::as_u64)
                        });
                    config_files.push(diagnostics::ConfigFile {
                        name: entry.file_name().to_string_lossy().into_owned(),
                        size: meta.len(),
                        schema_version,
                    });
                }
            }
        }
        let facts = diagnostics::Facts {
            app_version: env!("CARGO_PKG_VERSION"),
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            git_available: git.as_ref().is_some_and(|probe| probe.available),
            git_version: git.as_ref().and_then(|probe| probe.version.as_deref()),
            git_executable: git.as_ref().and_then(|probe| probe.executable.as_deref()),
            watch_mode: watch::last_mode(),
            config_files,
            entries: diagnostics::snapshot(),
        };
        std::fs::write(&path, diagnostics::export_text(&facts)).map_err(|error| {
            ProbeError::new(
                "diagnostics_write_failed",
                format!("guit could not write the diagnostics file: {error}"),
            )
        })?;
        Ok(std::path::Path::new(&path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".to_owned()))
    })
    .await
    .map_err(|error| ProbeError::new("task_failed", error.to_string()))?
}

fn main() {
    #[cfg(target_os = "linux")]
    gdk::set_allowed_backends("x11,wayland");
    perf::init();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ProbeState {
            cancelled: Arc::new(AtomicBool::new(false)),
            running: Arc::new(AtomicBool::new(false)),
        })
        .manage(session::SessionState::default())
        .manage(watch::WatchState::default())
        .manage(write::WriteState::default())
        .manage(extools::ToolState::default())
        .manage(history::GraphCache::default())
        .manage(search::SearchState::default())
        .setup(|app| {
            // Reclaim what a kill -9 left behind — abandoned atomic-write
            // siblings of the config files. The count is reported but
            // startup never fails over it.
            let temps = match app_config_dir(app.handle()) {
                Ok(dir) => sweep_stale_config_temps(&dir),
                Err(_) => 0,
            };
            if temps > 0 {
                eprintln!("guit startup swept {temps} stale config temp file(s)");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_git,
            probe_external_tools,
            run_process_probe,
            cancel_process_probe,
            save_window_settings,
            restore_window_settings,
            open_repository,
            restore_repository,
            refresh_repository,
            close_repository,
            list_recent_repositories,
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
            search_repository,
            cancel_search,
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
            merge_start,
            rebase_start,
            operation_continue,
            operation_abort,
            operation_skip,
            pick_commit,
            revert_commit,
            reset,
            preview_restore,
            restore_clean,
            export_diagnostics
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
            read_window_settings(&path).unwrap_err().code.as_str(),
            "settings_decode_failed"
        );
        settings.schema_version = 99;
        assert_eq!(
            write_window_settings(&path, &settings)
                .unwrap_err()
                .code
                .as_str(),
            "settings_invalid"
        );
    }

    // A future window.json version is refused fail-closed: the bytes
    // survive untouched, and the restore path reports no settings, so
    // the frontend keeps the shipped 720x560 default instead of guessing.
    // The refusal holds against a write too, because the panel saves geometry on
    // every resize and that call must not undo the read's decision.
    #[test]
    fn future_window_version_is_refused_and_left_untouched() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("window.json");
        let bytes =
            br#"{"schemaVersion":2,"width":1234,"height":777,"x":10,"y":20,"alwaysOnTop":false}"#;
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(
            read_window_settings(&path).unwrap_err().code.as_str(),
            "settings_invalid"
        );
        let settings: WindowSettings =
            serde_json::from_str(r#"{"width":720,"height":560,"x":0,"y":0,"alwaysOnTop":false}"#)
                .unwrap();
        assert_eq!(
            write_window_settings(&path, &settings)
                .unwrap_err()
                .code
                .as_str(),
            "settings_sealed"
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }

    // Geometry a user set by hand is what a version-1 file holds, so a write
    // there is ordinary; only an unreadable shape stands in its way.
    #[test]
    fn a_current_window_version_is_still_written_over() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("window.json");
        std::fs::write(
            &path,
            br#"{"schemaVersion":1,"width":900,"height":700,"x":1,"y":2,"alwaysOnTop":true}"#,
        )
        .unwrap();
        let settings: WindowSettings =
            serde_json::from_str(r#"{"width":720,"height":560,"x":0,"y":0,"alwaysOnTop":false}"#)
                .unwrap();
        write_window_settings(&path, &settings).unwrap();
        let stored = read_window_settings(&path).unwrap().unwrap();
        assert_eq!((stored.width, stored.height), (720, 560));
        assert!(!stored.always_on_top);
    }

    #[test]
    fn the_config_sweep_removes_only_old_tempfile_siblings_of_owned_names() {
        let dir = tempfile::tempdir().expect("config dir");
        std::fs::write(dir.path().join("session.json.tmpAb1cD2"), b"x").expect("fresh owned");
        std::fs::write(dir.path().join("notes.tmp"), b"x").expect("foreign suffix");
        std::fs::write(dir.path().join("session.json.tmpZZ"), b"x").expect("short suffix");
        std::fs::write(dir.path().join("window.json.tmp123456"), b"x").expect("old owned");
        std::fs::write(dir.path().join("recent.json.tmpABC123"), b"x").expect("old owned");
        let old_output = std::process::Command::new("touch")
            .args(["-d", "3 hours ago"])
            .arg(dir.path().join("window.json.tmp123456"))
            .arg(dir.path().join("recent.json.tmpABC123"))
            .status()
            .expect("touch runs");
        assert!(old_output.success());
        assert_eq!(sweep_stale_config_temps(dir.path()), 2);
        assert!(dir.path().join("session.json.tmpAb1cD2").exists(), "fresh");
        assert!(dir.path().join("notes.tmp").exists(), "foreign name");
        assert!(
            dir.path().join("session.json.tmpZZ").exists(),
            "suffix shape"
        );
        assert!(
            !dir.path().join("window.json.tmp123456").exists(),
            "old owned"
        );
        assert!(
            !dir.path().join("recent.json.tmpABC123").exists(),
            "old owned"
        );
    }

    #[test]
    fn the_config_sweep_survives_a_missing_directory() {
        assert_eq!(
            sweep_stale_config_temps(std::path::Path::new("/nonexistent/guit-x")),
            0
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

    /// Unwrapping a lock whose previous holder panicked fails with "a lock was
    /// poisoned" — it names neither the state nor the failure the user already
    /// saw, and it keeps failing for every later request. Shared state is
    /// therefore borrowed through `util::guard`/`util::wait`, and this scans the
    /// shipped sources rather than trusting that each new lock remembers.
    #[test]
    fn shared_state_is_borrowed_without_unwrapping_a_poisoned_lock() {
        let source_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        for entry in std::fs::read_dir(&source_dir).unwrap() {
            let path = entry.unwrap().path();
            let Some(file_name) = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
            else {
                continue;
            };
            if path.extension().and_then(|name| name.to_str()) != Some("rs")
                || file_name == "util.rs"
            {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            let collapsed: String = text
                .split("#[cfg(test)]")
                .next()
                .unwrap_or_default()
                .split_whitespace()
                .collect();
            for forbidden in [".lock().unwrap()", "wait_timeout("] {
                if collapsed.contains(forbidden) {
                    offenders.push(format!("{file_name}: {forbidden}"));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "locks borrowed by panicking on poison: {offenders:?}"
        );
    }
}
