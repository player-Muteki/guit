# guit development guide

This directory holds the guit client: a Tauri 2 + Rust backend exposing
semantic Git operations, and a TypeScript + native HTML/CSS frontend that
never builds Git commands itself. The M0 probe these instructions grew out
of is long gone; the app now covers the full workflow described in the
root [README.md](../README.md).

## Prerequisites

- Node.js 22+ (the 0.1.0 cycle built with Node 26) and a recent Rust
  toolchain (1.96+).
- Git installed and on `PATH` (verified against Git 2.53).
- Tauri 2 system dependencies for the target OS. On Ubuntu, install
  `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`,
  `libxdo-dev`, `libssl-dev`, `librsvg2-dev`, and
  `libayatana-appindicator3-dev`. Windows needs WebView2 and C++ build
  tools; macOS needs Xcode command-line tools.

## Commands

From `app/`:

```sh
npm ci
npm run tauri dev                                # development iteration
npm run build                                    # frontend type-check + bundle
npm run test:fixture                             # frontend fixture tests
cargo test --manifest-path src-tauri/Cargo.toml  # Rust unit + temp-repo integration tests
npm run tauri build -- --bundles deb,rpm,appimage  # packaged artifacts
```

> Always package through `npm run tauri build` — a bare
> `cargo build --release` binary tries to load the dev server and is not a
> runnable app.

## Where the rules live

- Root `AGENTS.md` — repository boundaries and implementation rules.
- `../TECHNICAL_DESIGN.md` — product and technical constraints.
- `../plan/` — milestones, the task backlog with per-item verification
  evidence, and `plan/M6-validation.md` for the current release record.
- `../tools/bench/` — performance harness and AT-SPI drive scripts (not
  packaged). Run them from the repository root.

## Tests that touch your machine

Rust integration tests create isolated temporary repositories with their own
Git configuration; they never touch your global config or the repository
they live in. `tools/bench/clean-install-trial.sh` can install and purge the
deb under a polkit prompt — run it deliberately.
