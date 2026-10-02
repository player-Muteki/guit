# Ubuntu 置顶问题

日期：2026-10-02。用户确认 Ubuntu/GNOME，普通窗口获得焦点后就能遮住已开启置顶的 guit。

## 调查

- 当前终端环境报告 `XDG_SESSION_TYPE=wayland`、`XDG_CURRENT_DESKTOP=ubuntu:GNOME`，同时存在 X11 显示 socket。进一步检查确认 `GDK_BACKEND=wayland` 被显式设置，会覆盖应用的默认后端优先顺序。
- `window.ts::setAlwaysOnTop` 原实现把异步设置调用的成功返回直接写成按钮状态；启动恢复也直接把保存值写成当前状态。通过实际 `window.ts` 的行为测试，模拟原生请求成功、状态不变，旧实现错误地报告成功，测试确实先失败。
- 本地依赖 `tao 0.35.3` 将设置请求转发给 GTK `set_keep_above`；其 `is_always_on_top` 则由原生 `window-state-event` 的 `ABOVE` 状态更新。GTK 文档明确说设置是请求，不保证窗口管理器执行，应读取状态事件。
- 这与原生 Wayland 下不能依赖 keep-above 请求的限制相符，但本轮未能连接用户桌面，不能声称已捕获故障进程的实际 GDK 后端或窗口堆叠。

## 修复

1. Linux 在 GTK/Tauri 初始化之前设置 GDK 后端顺序 `x11,wayland`。GNOME Wayland 会话可使用 XWayland；X11 不可用时仍能回退。GDK 自己遵守显式 `GDK_BACKEND` 设置，不改写用户环境变量。直接声明已有传递依赖 `gdk 0.18`，没有新增版本或下载新包。
2. 置顶请求后读取 `isAlwaysOnTop()`，允许至多约一秒等待窗口管理器异步确认；无法确认则展示错误，不把愿望当结果。
3. 焦点变化时重新同步实际状态。保存的用户偏好与当前实际状态分开，防止一次被忽略的启动请求将用户的置顶偏好永久覆盖为关闭。
4. 更新浏览器桩，使新 getter 返回原生接口承诺的布尔值，setter 改变桩自己的状态。这只是保持桩契约，不作为真实置顶证据。

## 验证范围

- `window-topmost.mjs` 直接执行转译后的生产 `window.ts`，仅替换 Tauri 边界。覆盖请求成功但状态不变、正常开启关闭、延迟确认、启动失败保留偏好、恢复明确关闭、窗口管理器外部变更、权限拒绝及关闭请求未生效。
- `window-controls.mjs` 保留现有关闭/权限/状态接线检查，并核对 Linux 后端选择发生在 Tauri 初始化之前。
- 构建、Rust 测试、格式及 Clippy 使用当前共享树；另有其他工作留下的 spacing/surface 测试改动，未由本任务改写。
- **原生窗口验收未完成**：沙箱内 GTK 无法连接显示服务，提升权限的只读 GTK 探测因自动审批服务故障未获执行。本轮不宣称已实测置顶覆盖关系、XWayland 窗口层级、多显示器或缩放。

## 用户复核

关闭旧 guit 后运行新构建的 `app/src-tauri/target/release/guit`，置顶开启时聚焦普通窗口，确认 guit 仍在其上；再关闭置顶，确认普通窗口可覆盖；最后重新开启并重启检查保存。

本轮启动环境已显式选择 Wayland，因此应使用 `GDK_BACKEND=x11 app/src-tauri/target/release/guit` 启动修复版进行复核。默认后端优先级不会覆盖用户显式设置，不能声称直接重启当前终端中的二进制就必然切换到 XWayland。新程序会在窗口管理器未确认请求时明确报错，不会通过反复抢焦点模拟置顶。
