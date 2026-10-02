# Ubuntu 置顶问题

日期：2026-10-02。用户确认 Ubuntu/GNOME，普通窗口获得焦点后就能遮住已开启置顶的 guit。

## 调查

- 当前终端环境报告 `XDG_SESSION_TYPE=wayland`、`XDG_CURRENT_DESKTOP=ubuntu:GNOME`，同时存在 X11 显示 socket。进一步检查确认 `GDK_BACKEND=wayland` 被显式设置，会覆盖应用的默认后端优先顺序。
- `window.ts::setAlwaysOnTop` 原实现把异步设置调用的成功返回直接写成按钮状态；启动恢复也直接把保存值写成当前状态。通过实际 `window.ts` 的行为测试，模拟原生请求成功、状态不变，旧实现错误地报告成功，测试确实先失败。
- 本地依赖 `tao 0.35.3` 将设置请求转发给 GTK `set_keep_above`；其 `is_always_on_top` 则由原生 `window-state-event` 的 `ABOVE` 状态更新。GTK 文档明确说设置是请求，不保证窗口管理器执行，应读取状态事件。
- 这与原生 Wayland 下不能依赖 keep-above 请求的限制相符，但本轮未能连接用户桌面，不能声称已捕获故障进程的实际 GDK 后端或窗口堆叠。

## 修复

1. Linux 在 `main` 的第一步、GTK/Tauri 和应用线程初始化之前，将进程内的 `GDK_BACKEND` 设置为 `x11,wayland`。覆盖启动环境继承的 Wayland 单后端选择，使直接运行二进制也优先尝试 X11/XWayland；X11 不可用时仍可回退至 Wayland。这不改变系统或桌面会话配置，但应用启动的子进程会继承该变量。移除已不需要的直接 `gdk` 依赖；GTK 仍由 Tauri 间接使用。
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

应直接启动新构建的 `app/src-tauri/target/release/guit`，不再需要终端环境前缀。X11 无法连接而回退 Wayland 时，仍不能保证置顶；程序保留原生状态检查，不通过反复抢焦点模拟置顶。

## 直接启动的后续修正

用户在提交 `9f28eff` 后直接启动程序，看到 `The desktop did not apply the requested always-on-top setting.`。这条提示来自前端等待约一秒后仍未读到预期状态的检查，本身不能证明桌面已经拒绝请求。

前次 `gdk::set_allowed_backends("x11,wayland")` 只改默认候选顺序；当前桌面导出的 `GDK_BACKEND=wayland` 仍会覆盖它。用户确认没有使用终端覆盖变量的启动命令，因此这条常用启动路径并未得到前次修复。现在在单线程启动入口设置进程的实际选择顺序，保留 Wayland 回退和失败提示。启动顺序的源码回归检查在修改生产代码前失败；该检查只验证初始化接线，不等同于原生置顶验收。

本轮普通权限的 GTK 探测仍返回 `gtk_init=False`，提升权限的只读探测仍因自动审批服务故障未执行；不宣称已观察用户窗口的后端或堆叠状态。

### GTK 初始化边界探针

`tools/bench/window-backend-probe.c` 在 GTK 初始化入口读取环境并退出，不建立窗口、不读取用户偏好。它可在没有桌面访问权限时检查实际 release 二进制是否在初始化之前设置了后端选择：

```sh
cc -shared -fPIC -Wall -Wextra -Werror tools/bench/window-backend-probe.c -o /tmp/guit-topmost-backend-probe.so
env GDK_BACKEND=wayland LD_PRELOAD=/tmp/guit-topmost-backend-probe.so app/src-tauri/target/release/guit
env -u GDK_BACKEND LD_PRELOAD=/tmp/guit-topmost-backend-probe.so app/src-tauri/target/release/guit
```

本轮两次均输出 `GDK_BACKEND at GTK initialization: x11,wayland`、退出码 0。另用旧启动调用 `gdk_set_allowed_backends("x11,wayland")` 的最小原生程序经过同一探针，继承 `GDK_BACKEND=wayland` 时仍输出 `wayland`、退出码 1，确认旧调用不能覆盖环境。该对比验证后端选择的传递，不验证连接到 X11、Wayland 回退或窗口覆盖关系。

构建和校验：`npm run bin:release`、12 条窗口接线测试、8 条置顶行为测试、文案门禁、367 条 Rust 测试、`cargo fmt --check`、`cargo clippy --locked --offline --all-targets` 和两道样式门禁通过。完整前端夹具为 31 个测试文件通过、5 个失败；失败均为涉及 Git 子进程的既有夹具，其中 `git-fixture.mjs` 单独重跑明确报告 `spawnSync git EPERM`。不宣称完整前端套件通过。
