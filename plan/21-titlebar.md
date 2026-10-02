# 顶栏重构与验证状态

日期：2026-10-02。基于 `b5aec4c` 之后的共享工作树实施；保留此前未提交的上下区域高度拖动修复。同一轮内审批服务恢复后重跑了此前受阻断的实测（见下方两节），并修掉其中抓到的一处真实缺陷。本轮没有提交、暂存或改动用户仓库数据。

## 已实现

- 顶栏按仓库入口、Main/Settings、四个窗口按钮组织。删除重复仓库按钮、顶栏提交按钮和分支 chip。
- 仓库短名来自 Rust `RepoView::from_identity` 的工作树根目录名；裸仓库使用 Git 目录名。进入子目录不改变仓库名，linked worktree 使用自己的根目录。完整位置保留在 tooltip 和菜单中；前端不从显示路径解析名称。
- 仓库菜单包含当前位置/分支、打开、最近仓库、刷新、分支与 Tag 管理、关闭会话；支持方向键、Home/End、Tab、Escape 和点击外部退出。会话关闭时禁用其专属动作。
- Main/Settings 保留文字；根据实际字体和控件宽度选择一行或两行，窗口按钮固定在首行右侧。计数口径仍是未暂存或未跟踪文件数，零至 99+ 占用相同宽度。
- 搜索与最近修改时间共用主面板工具栏。仍由 changes view 持有原有唯一计时器及 activity 订阅；拖动比例只分配 changes/history 高度。
- 关闭原生装饰，空白顶栏调用原生 startDragging，双击最大化/还原，八个边缘区域调用 startResizeDragging。右键顶栏或 Alt+Space 打开 Tauri 原生菜单。关闭仍经 close 请求、否决检查、资源释放、几何保存和 destroy。
- 仓库入口按钮在最小窗口与最小界面尺寸下与四个窗控钮同高（`align-self: stretch`），修掉 23.2px 的命中区。
- 更新旧入口的布局、读取预算和 AT-SPI 探针；布局探针增加 12/16/20/24px、长仓库名、计数宽度、菜单键盘导航、真实浏览器鼠标事件拖动与双击复位的检查。

## 本轮验证

审批服务恢复后，本轮记录里"受阻断"的三项在当前主机重新跑过；下表是那次的读数。

| 项目 | 结果与边界 |
| --- | --- |
| `npm run build` | 通过；TypeScript 类型检查和 Vite 打包 |
| `npm run test:fixture` | **422 项全部通过**，含需要 Git 子进程的五个夹具文件。上一轮记的"沙箱中 Git 子进程不能执行"在当前主机不再成立，那条阻断理由作废 |
| `cargo test --locked --offline` | **367 项通过**；含子目录打开与 linked worktree 名称测试，以及裸仓库名称断言 |
| `cargo fmt --check` / `cargo clippy --locked --offline --all-targets` | fmt 零 diff；clippy **0 告警** |
| 已构建 CSS 对比度 / 响应式门禁 | 两道检查 fails=0 |
| `npm run bin:release` | 成功构建带 custom-protocol 的独立 Linux 二进制；构建成功不代表原生窗口行为通过 |
| `tools/bench/layout-probe.mjs`（Edge 154.0.4258.48 无头 CDP，九档窗口 + 12/16/20/24px） | **637 条断言，fails=0**。详见下面 §1 与 §2 |
| `tools/bench/read-budget.mjs` | **fails=0**；按键→"Searching…" p50 120.4 / p95 120.9ms，按键→首行画上 p50 120.8 / p95 121.2ms，对照导出的 120ms 等待。二十次按键恰好二十条 `search_repository` 与二十条 `cancel_search`，顶栏重构没有多发任何读 |
| Linux GTK/WebKit/AT-SPI 原生窗口 | **仍未验证**。这台主机是无头 Wayland 会话，`Gtk.init_check()` 仍不可用，访问桌面的提升权限未获执行 |
| Windows、macOS、CI | 本轮均未运行，不新增覆盖声明 |

临时日志在 `/tmp/guit-topbar-*.log`，不会作为仓库交付物。

## §1 探针自己先过期了：55 条红不是产品的账

阻断解除后第一次跑 `layout-probe.mjs`，九档窗口的**全部 Search 图层断言**都红，报"no layer in the built bundle"与 `--search-cap 0px`。这一轮把搜索字段移进了主面板工具栏，`.search-view` 从 `.main-panel` 的直接子元素变成 `.main-toolbar` 的子元素，而探针有两条选择器仍按旧结构找：

- `layout-probe.mjs` 取图层的 `.main-panel > .search-view .search-results`
- 同一段里算 `overBar` 的 `.main-panel > .search-view .search-bar`

两条都改成走 `.main-toolbar`。改完 **55 红 → 1 红**，图层实测 40 行、盒子 1068×280、`--search-cap` 为 700px 的 0.400——与 [阶段 E 记录](17-search-contract-e.md) §15 记的值一致。教训与 §2 相同：**门禁搬了家，读数没搬**；这次是 CSS 结构搬了家、探针没搬。

## §2 剩下那一条红是真的：最小窗口最小字号下的 23.2px 命中区

`[340x400/12px] top bar controls fit without overlap` 不是重叠——同一个断言还要求每个控件高度 ≥24px，而 `.appbar-repo` 在 340×400、12px 界面尺寸下实测 **23.21875px**，差 0.78px。16/20/24px 三档都过。

成因：`.appbar` 是 grid 且设了 `align-items: center`，覆盖了 grid item 默认的 `stretch`，于是这个按钮按内容收缩到 23.2px；同一行的四个窗控钮各有固定高度，把行撑到 28px，中心对齐的那个反而是唯一没到 24px 的。

修法是一个属性：`.appbar-repo { align-self: stretch; }`，取同行窗控钮已经定下的行高。改后该盒子实测 **28px**（top 3、bottom 31，与四个窗控钮同一行高），不是把门槛调低。没有写成 rem 下限，因为任何能让 12px 下够 24px 的 rem 取值都会在 24px 档把行撑到近两倍高。

## 尚待完成的实测

**原生窗口验收仍未闭合，且不能用别的证据代替。** 需要在有桌面会话的 Linux 主机上，用独立临时配置目录和测试仓库启动 `app/src-tauri/target/release/guit`，测量窗口移动、八向缩放、双击及按钮最大化/还原、置顶、最小化恢复、原生菜单、关闭保存和重启恢复。更新后的 `layout-check.py`、`narrow-smoke.py`、`view-smoke.py` 和截图脚本可复用。

浏览器里跑通的那 637 条只证明 Web 交互与渲染：它量的是布局盒、绘制矩形、可达名称与按键派发，**没有**碰过 Tauri 的 `startDragging`、`startResizeDragging`、原生窗口菜单或几何持久化。不得沿用旧原生装饰窗口的实测记录，宣称本次集成顶栏通过。

**当前结论：渲染层验收已闭合并修掉一处真实缺陷（§1、§2）；原生窗口验收仍未闭合。**
