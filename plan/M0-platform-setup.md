# M0 platform setup and runtime checklist

This record describes how to reproduce the M0 desktop probe. A CI compile is useful but does not replace the runtime checks below. Record the OS release, desktop environment, Git version, Node version, Rust version, and results for each run in `M0-validation.md`.

## Common setup

1. Install Git, Node.js 22, npm, and a current stable Rust toolchain.
2. Install the platform's Tauri 2 system prerequisites listed below.
3. From `app/`, run `npm ci` and `npm run test:fixture`.
4. Run `npm run build`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `npm run tauri build`.
5. Start `npm run tauri dev` and perform the runtime checklist.

Both the npm and Rust lock files (`package-lock.json`, `src-tauri/Cargo.lock`) are committed; CI uses `npm ci` and `--locked` so a clean checkout reproduces exact versions.

## Linux

On Ubuntu 24.04, install the build dependencies used by the CI workflow:

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev
```

Verify `pkg-config --modversion webkit2gtk-4.1` and `pkg-config --modversion gtk+-3.0` before compiling. Run the desktop app in a graphical session with a supported display server. Record whether the compositor honors always-on-top; some Wayland compositors may not expose identical behavior. Test `xdg-open` with a disposable text file and record the selected application, then test Git's configured diff and merge tool names without changing global Git configuration.

## Windows

Install Git for Windows, Node.js 22, Rust with the MSVC target, Microsoft C++ Build Tools, and the WebView2 runtime. Confirm `git --version`, `node --version`, `rustc --version`, and that WebView2 is installed. Use PowerShell from a normal user account. Test Git found through `PATH`, a PATH with Git intentionally omitted, a HiDPI display, window movement between two monitors, and a restart after a monitor is disconnected. Record whether saving window settings repeatedly succeeds; Windows file replacement semantics need verification.

## macOS

Install Xcode command-line tools, Rust, Node.js 22, and Git. Confirm the active Git executable and its version because `/usr/bin/git` may differ from a separately installed Git. Test on a signed or locally permitted build according to the machine's security settings. Verify a window restored after disconnecting an external display, always-on-top while switching applications, the system `open` command with a disposable text file, and configured Git diff/merge tools.

## Runtime checklist

| Check | Expected evidence |
| --- | --- |
| First launch | Window renders the environment panel; no blank view or startup crash. |
| Git present | Version and porcelain v2 capability appear; no user repository is modified. |
| Git missing | Clear install/PATH guidance; other controls remain usable. |
| Unsupported Git | Explicit unsupported status, not a false clean repository. |
| Resize | Main controls remain visible or reachable at the minimum size and at high DPI. |
| Always on top | Toggle changes actual window stacking and can be switched off. |
| Window restore | Size and position persist; off-screen coordinates fall back to a visible location. |
| Process probe | Window remains responsive; normal completion and cancellation are distinguishable. |
| External tools | Configured diff/merge tool names and opener type are reported accurately. |
| Errors | Failures are readable and do not expose credentials or silently disappear. |

For missing/unsupported Git and tool cases, vary the process environment or use a disposable test account. Do not edit a developer's global Git configuration. Attach screenshots or a concise run log, plus the exact commands and environment, to `M0-validation.md`.
