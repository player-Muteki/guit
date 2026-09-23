# guit Repository Instructions

These instructions apply to the repository root and all subdirectories. Before starting a task, read `TECHNICAL_DESIGN.md`, then consult the relevant documents linked from `plan/README.md`. The root technical design defines the product and technical constraints; `plan/` expands them into implementation tasks and acceptance criteria. If they conflict, clarify the difference and update the documentation before implementing the change.

## Repository Boundaries

- `app/` is reserved for the guit client. The application project has not been scaffolded yet; do not assume build or test commands exist.
- `git/` is a separate clone of the Git source repository for reference. The root `.gitignore` excludes it. Do not modify, commit, package, or use it as a runtime dependency of guit.
- `plan/08-task-backlog.md` tracks implementation tasks. When completing a task, record verification evidence and update its entry. Update the relevant design documents when decisions change.

## Product Constraints

- Build a low-resource, cross-platform desktop Git client. The interface may draw on the VS Code Source Control sidebar; the window must resize responsively and offer an optional always-on-top mode.
- Do not add a built-in file-content viewer, diff viewer, or text editor. Open files, diffs, and conflict-resolution tools through the operating system or configured external applications.
- Use the user's installed Git CLI and respect their Git configuration, hooks, signing setup, SSH agent, and credential manager. Do not compile or bundle the source in `git/`.
- Do not store credentials or silently run force pushes, hard resets, cleanups, or other operations that may discard data.

## Implementation Rules

- The planned stack is Tauri 2, Rust, and TypeScript with native HTML/CSS. The Rust backend exposes controlled, semantic Git operations; the frontend neither constructs Git commands nor parses Git command output.
- Start processes with argument arrays and an explicit working directory, never through a shell. Parse stable machine-readable output. Prefer NUL-delimited paths and retain a lossless path representation in the backend.
- Serialize writes within each repository. After an operation succeeds, fails, or is cancelled, read the actual Git state again. Never let an outdated snapshot replace a newer one.
- Before a destructive operation, show the repository, target, and affected items, then recheck the state before execution. Preserve redacted Git error details; never present a parse failure as a clean repository.
- Keep dependencies lean. Explain the concrete benefit and resource impact of new dependencies or architectural changes. Fix root causes rather than bypassing these boundaries for convenience.

## Verification and Delivery

- Run the most relevant unit or temporary-repository integration tests first, followed by any necessary cross-platform checks. Use `plan/07-quality-release.md` and the relevant milestone exit criteria for acceptance.
- For platform-sensitive behavior such as paths, conflicts, authentication, cancellation, and external tools, record the test environment and identify platforms that remain unverified. Do not describe single-platform results as validated on all three platforms.
- Use isolated Git configuration and temporary repositories for tests; do not change the user's global Git configuration for convenience.
- Do not reset the repository or clean up user files unless the user explicitly requests it. Standing instruction (2026-09-23): after completing each subtask of a milestone (a checked item in `plan/08-task-backlog.md`), create one commit for that subtask; other commits still require an explicit user request.
