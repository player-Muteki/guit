// Temporary M6-03 diagnostic: print every notify event for the watch targets
// of a repository, one per line, for N seconds. Run alongside a real guit
// instance to see which filesystem traffic drives its refresh loop.
use notify::event::EventKind;
use notify::{RecursiveMode, Watcher};
use std::path::PathBuf;
use std::time::Duration;

fn main() {
    let dir = PathBuf::from(
        std::env::args()
            .nth(1)
            .expect("usage: watch_probe <repo> [seconds]"),
    );
    let seconds: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(8);
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher =
        notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            if let Ok(event) = event {
                let paths: Vec<String> = event
                    .paths
                    .iter()
                    .map(|p| {
                        p.file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default()
                    })
                    .collect();
                let _ = tx.send((kind_label(event.kind), paths));
            }
        })
        .expect("watcher");
    watcher
        .watch(&dir, RecursiveMode::Recursive)
        .expect("watch recursive");
    let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
    while std::time::Instant::now() < deadline {
        if let Ok((kind, paths)) = rx.recv_timeout(Duration::from_millis(200)) {
            println!("event kind={kind} paths={paths:?}");
        }
    }
}

fn kind_label(kind: EventKind) -> String {
    match kind {
        EventKind::Access(_) => "access".into(),
        EventKind::Modify(notify::event::ModifyKind::Data(_)) => "modify-data".into(),
        EventKind::Modify(notify::event::ModifyKind::Metadata(_)) => "modify-meta".into(),
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => "modify-name".into(),
        EventKind::Modify(_) => "modify-other".into(),
        EventKind::Create(_) => "create".into(),
        EventKind::Remove(_) => "remove".into(),
        EventKind::Any => "any".into(),
        EventKind::Other => "other".into(),
    }
}
