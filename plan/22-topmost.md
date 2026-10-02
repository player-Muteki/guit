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

## 已置顶仍报错的后续调查

用户在后续构建仍看到同一错误，并明确确认：guit 已经保持置顶，只是报错。因此不能把状态查询未确认继续解释成窗口没有置顶；前面的启动环境探针也没有覆盖这个症状。尚需区分 Tauri 状态缓存与原生状态不一致、确认时序，以及重叠请求。

`bash tools/live/diagnose-topmost.sh` 用固定 release 路径启动真实程序，记录二进制校验值，并通过原生 GTK 调用观察器收集后端类型、置顶请求、映射/焦点/状态事件及请求后 1500ms 的状态。观察器转发原生调用，事件监听返回继续传播，不自行置顶、取消置顶或改变焦点；`x11_above` 读取窗口管理器的 `_NET_WM_STATE_ABOVE` 属性，与 `gdk_above` 分开报告。`-1` 表示该通道不可读或不适用，不能当作关闭。无窗口访问权限时该脚本需要用户在自己的桌面终端运行。

本轮观察器通过编译和无显示服务的初始化失败路径检查；真实置顶通道尚待用户提供报告。自动审批服务仍使提升权限的桌面探测无法执行。这里记录的是诊断工具，不是第三次已完成的置顶修复。

### 用户桌面证据及状态读取修复

用户随后在桌面运行诊断脚本，日志位于 `/tmp/guit-topmost.oQ3Ltv/trace.log`。二进制校验值为 `baa2431cdf240e18966363cf91342fda05e1500b1c3edbb53e8d0b2729919ea4`，对应前次 release。日志确认 `backend=GdkX11Display`；首次置顶请求约 300ms 后，X11 属性已报告 `x11_above=1`，但 `gdk_above=0`。三个请求的 1500ms 后检查以及焦点离开窗口后均保持这个差异。用户同时确认窗口实际保持置顶。因此本次错误源于 GTK/Tauri 状态读取与窗口管理器状态不一致，不能继续归因于仍在使用 Wayland 或确认等待不足。

修复将前端的确认和焦点同步接到 `window_is_always_on_top`。该命令只读取调用窗口的状态，不读取仓库；后端在 GTK 主线程上识别实际 X11 窗口并查询 `_NET_WM_STATE` 中的 `_NET_WM_STATE_ABOVE`。其他后端和平台沿用原生 Tauri getter。设置请求仍使用已有原生接口，不增加抢焦点或反复重置置顶的循环。超时文案改为“未确认”，不推断桌面已经拒绝。

原生边界使用现有传递依赖的 GTK、GDK X11 和 Xlib 绑定。`Window` 句柄可跨线程传递，GTK/GDK 对象只在主线程取得并使用；X11 连接借自持有引用的 `X11Display`，不由 guit 关闭。XGetWindowProperty 的缓冲区由 Xlib 分配并通过 RAII 的 XFree 释放；只有成功、未截断、ATOM/32 格式、长度不超过 64 项且非空缓冲区才转换为原生 Atom 切片。格式 32 的 Xlib 返回值使用原生 unsigned long 元素宽度，不能按固定四字节步长解释。X11 错误通过 GDK error trap 捕获；读失败保留此前确认状态并报错，不折算为关闭。

`node tests/window-topmost.mjs` 在生产修复前确实复现相同错误：窗口管理器已置顶、GTK 缓存始终为否时抛出原提示。修复后该场景、反向取消置顶及读失败保持已确认状态均通过。源端协议、能力接线和文案门禁同步更新；浏览器桩改为实现新的状态读取命令。

原生修复后的覆盖关系和错误消失仍需新构建的桌面复核，前述日志只证明旧构建的故障机制。

修复后的 `npm run bin:release` 已完成。构建期间发现 Xlib 符号只有绑定声明、没有显式链接项，已通过 Linux 专用直接依赖 `x11` 的 `xlib` feature 补齐；单纯 `cargo check` 及不执行该原生路径的单元测试不能替代独立产物链接验证。锁文件没有引入新的包或版本。前端 11 条置顶行为测试和 IPC/窗口接线/文案门禁通过；全套前端仍为 31 个文件通过、5 个 Git 夹具失败，不能标记全绿。

### 修复后构建的桌面复核

新构建（`15e310820df8b7c83924ef21c89c013d4c5b5563714a041df08f6dc659586105`）在这台主机的真实桌面会话里跑完了完整周期。前几轮被记为"需要桌面"而未执行的探测这次可执行：沙箱内 GTK 仍无法初始化显示服务，同一命令提升权限后返回 `backend=GdkX11Display`。

`tools/live/topmost-probe.c` 作为 `LD_PRELOAD` 挂在这个构建上，AT-SPI 连续按三次置顶按钮，探针同时记录 GTK 缓存与窗口管理器属性：

```text
event=request-on   x11_above=0   gdk_above=0
event=state-change x11_above=1   gdk_above=0
event=request-off  x11_above=1   after-1500ms x11_above=0
event=request-on   x11_above=0   after-1500ms x11_above=1
event=request-off  x11_above=1   after-1500ms x11_above=0
```

三轮请求后窗口管理器的 `_NET_WM_STATE_ABOVE` 都跟随请求切换，而 GTK 的 `gdk_window_get_state` 全程为否——正是上一节从用户日志里定位到的分歧，本次在修复后的构建上复现。面板日志零条"未确认"，置顶按钮状态随之更新。这就是本轮要修的那条路径。

三条不能由本次实测回答的边界：

- **覆盖关系仍未量到。** 这台主机的窗口管理器（`_NET_CLIENT_LIST_STACKING` 与 `_NET_CLIENT_LIST` 都只返回一项）不发布完整的堆叠列表，`xprop` 在长列表上还会把内容整段丢掉；AT-SPI 对 mutter frame 的 `grab_focus` 被拒绝，X11 `_NET_ACTIVE_WINDOW` 客户端消息也无法把焦点交给普通窗口。因此"普通窗口获得焦点后能否盖住已置顶的 guit"这一条只有用户目视可答，本记录不声称已实测。
- **原生 Wayland 回退未运行。** 本次始终是 X11/XWayland。
- **截图通道不可用。** ImageMagick 的 `import` 与仓库自带的 `tools/live/xgrab` 在这台主机上都取不到根窗口，无法留下目视证据。

因此 CHANGELOG 里"读窗口管理器状态、不再因陈旧 GTK 状态报错"一条有实测支撑，而置顶与拖动、缩放、原生菜单、几何持久化一起列在"尚未在真实窗口中演练"里，本轮只闭合了其中置顶的**状态读取**这一半，覆盖关系仍留给用户复核。

沙箱内 `npm run test:fixture` 的 5 条失败是沙箱拒绝 spawn `git`（`spawnSync git EPERM`）所致，提升权限后全套 437 条前端夹具为 436 通过、0 失败、1 跳过（跳过的一条是尚未落地的间距标度测试）。这一条修正了上一段"不能标记全绿"的说法：那不是代码失败。
