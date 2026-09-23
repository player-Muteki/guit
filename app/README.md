# guit M0 desktop probe

This is the first runnable milestone. It checks the installed Git CLI, configured diff/merge tools, Tauri window behavior, and a cancellable Git child process. Repository browsing and write operations begin in M1 and M2.

## Development prerequisites

- Node.js 22, npm 10, and a recent Rust toolchain.
- Git installed and available on `PATH`.
- Tauri 2 system dependencies for the target OS. On Ubuntu, install `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`, `libxdo-dev`, `libssl-dev`, `librsvg2-dev`, and `libayatana-appindicator3-dev`. Windows needs WebView2 and C++ build tools; macOS needs Xcode command-line tools.

## Commands

From `app/`:

```sh
npm ci
npm run tauri dev
npm run build
npm run test:fixture
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

The probe uses an isolated temporary Git repository for its status capability check. The process probe starts `git hash-object --stdin`, keeps stdin open briefly, and can terminate and reap that child. It does not modify any user repository. The window stores its size, position, and always-on-top preference in the application config directory.

## Current limits

The UI does not yet open repositories. The external-tool panel reports Git's configured tool names and the system opener type; it does not launch user tools yet. Child-process cancellation is a single-process probe, not proof that a future hook, SSH, or credential-helper process tree can be terminated on every OS. See `../plan/M0-validation.md` for recorded platform results.
