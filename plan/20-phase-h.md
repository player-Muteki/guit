# 阶段 H：迁移收尾与发布验收

起点提交：`ac61b62`（A–G 验收与质量收口之后）。这一份记录 H 的实施与证据；每个任务完成就把它的结论、跑过的命令与**没有验证的部分**写在这里。

## 1. H01 清理旧视图、重复实现与孤儿命令

**任务**：清理旧视图/快捷键/死监听/临时开关；移除无依赖远程代码，核对 IPC 白名单；没有七视图、隐藏远端动作或重复实现残留；本地服务依赖完整。

### 1.1 两块没有页面到达的视图，连带它们唯一够得着的命令

`views/stash.ts`（168 行）与 `views/worktrees.ts`（262 行）没有任何 import——它们属于那个七视图套件，而面板早就只剩两个 Tab。它们同时是十四条命令在源码里**唯一**的字面量出处：`stash_list`／`stash_save`／`stash_apply`／`preview_stash_pop`／`stash_pop`／`preview_stash_drop`／`stash_drop`／`list_worktrees`／`add_worktree`／`preview_remove_worktree`／`remove_worktree`／`prune_worktrees`／`submodule_status`。

这不是本轮发现的，是迁移记录自己写下的（[13-local-scope-b04.md](13-local-scope-b04.md) 末段）："stash_list、list_worktrees、submodule_status 等本地命令仍在注册面上，**靠已经没有页面的模块里的字面量满足门禁**；实现与这些模块的彻底下线属于迁移收尾，本阶段不动"。H01 就是那个"迁移收尾"。

大纲 §7.3 把这两类事分开说：远程是"入口、自动执行路径和对前端开放的命令一并移除"，而 stash/worktree/submodule 是"本地高级能力不自动获得主界面位置……按迁移清单处理入口和兼容性"。本地这一类不进产品界面，但登记着一条没有界面可达的命令，正是 `ipc-surface.mjs` 那条"每条注册的命令都在前端被字面量命名"要拦的东西——把视图删掉之后门禁立刻红，报出七条孤儿，那正是它该报的。

因此这一刀连带三个后端模块一起走：`stash.rs`（804 行）、`worktrees.rs`（953 行）、`submodules.rs`（710 行）。它们只被 `main.rs` 里各自的命令函数用到，`branches.rs`／`reset.rs`／`write.rs`／`session.rs` 一处也没有引用。写通道上只为它们存在的形状一起删：`Bound::StashEntry`、`Bound::WorktreeRemove`、`StashAction`、`stage_stash_entry`、`stage_worktree_remove`，以及 `OperationKind` 的七个变体。

前端那层同样只由死视图写入的形状一起删：`PreviewKindKey` 的 `stashDrop`／`stashPop`／`worktreeRemove` 三个种类、`PendingPreview` 里对应的三个臂（三段确认文案、三条命令映射、四条臂、确认路由的三条 case）、`OperationResult.kind` 的七个值、`StashEntry`／`WorktreeView`／`SubmoduleView`／`SUBMODULE_STATE_LABELS` 四个类型、两个没有调用者的图标，以及 `stash?: undefined` 那一组判别式（已经没有臂带 stash）。

**一处测试换了对象而不是删掉**：`write.rs` 里"一张票只被操作它的那条读出来"原本用 stash 的 pop 票当例子（pop 与 drop 形状相同、只有 `action` 不同）。改成 discard 票与 clean 票互读——两者都带路径、都带工作根，最容易被派发器认错的一对——并双向断言。

**一处协议臂留下**：`ReadDomain::Session` 今天没有命令在问（`stash_list` 是最后一个）。它留下有两个理由：它是"下一次某个不由刷新域拥有的清单必须问的东西"，语义由 `session.rs` 里一条测试钉住（绑会话、刷新不失效、会话关闭即失效），而 `AGENTS.md` 明确把它写成答案而不是自己发明一个没人维护的计数。标记为 `#[allow(dead_code)]` 并把"为什么今天没人问"写在文档注释里。

### 1.2 门禁、快捷键与开发开关

- 快捷键：`window.ts` 里主面板的两条（`Ctrl/Cmd+1/2`、`/`）与 Settings 的一组（`Ctrl/Cmd+Shift+T`）都有调用者，没有指向已删功能的键。
- 死监听：`read-budget.mjs` 那十二次往返前后 `window`／`document`／`observers`／`timers`／`intervals`／`nodes` 六项相等，本轮复跑 fails=0。
- 临时开关：源码里唯一的开发开关是 `GUIT_PERF=1`，它是性能相位计量的记录手段，不是功能开关，保留。
- IPC 白名单：`capabilities/default.json` 与 `tauri.conf.json` 不含任何命令名（只有窗口动作与对话框权限），无需改动；`ipc-surface.mjs` 的四分表在删完之后仍完整覆盖注册表。

**度量**（`ac61b62` 与本条合并后同一棵树上）：build 退出 0（48 modules，`index-K3_kaYgY.css` 34.50 kB／`index-DkLN6U4t.js` 128.28 kB——比删之前的 130.23 kB 少 1.95 kB，那两页里有一部分本来就被 tree-shake 掉了）、fixture **416 pass／0 fail**、cargo test **365 passed／0 failed**（比 393 少 28 条，全部是被删模块的用例）、fmt 零 diff、clippy **0 告警**、九支引擎探针各 fails=0、`layout-probe.mjs` **568 ok／fails=0**、`read-budget.mjs` fails=0、两道样式 gate fails=0。

## 2. H02 全部适用门禁与架构约束复核

在 H01 之后的那棵树上按 AGENTS.md 的顺序跑了一遍，五条核心门禁全过（build／fixture 416／cargo test 365／fmt 零 diff／clippy 0 告警），渲染与布局那一族也全过（见 §1.2 末行）。这一轮**没有新增失败**：H01 之前最后一次全量是 412 fixture + 398 cargo + 九支探针 + 568 布局，全绿；本轮的数字变化全部来自有意删除的用例，没有一条是被改宽松的断言换来的绿灯。

四条由测试强制执行的架构约束逐条复核：

- **绝不解开中毒的锁**：`main.rs` 里那条读 `src/**/*.rs` 的测试在 365 条里，`util::guard`／`util::wait` 是唯一入口。
- **发布文字是契约**：`user-facing-copy.mjs` 通过；这一轮改到的注释里有"hard reset""stash""worktree"等词，没有里程碑编号、没有 `plan/` 路径、没有 `decision N`。
- **每条命令都回答它绑定的东西**：`ipc-surface.mjs` 九条，四分表无重叠无遗漏，且七条孤儿已经不在注册面上。
- **行高跟着样式表**：`fileModel.ts` 的两个常量与 `--row-height*` 一致（本轮未动这两个文件）。

## 3. H05 独立二进制与真实窗口旅程

`npm run bin:release`（带 `--features custom-protocol`，否则二进制指向 Vite 开发服务器）产出 `src-tauri/target/release/guit`，7.87 MB。

一次真实窗口旅程，同一台宿主、隔离 HOME（`/tmp/h05-home`）：

1. `make-repo.sh` 造夹具（200 跟踪 / 20 未跟踪 / 1 脏），`session.json` 指向它。
2. `setsid src-tauri/target/release/guit` 启动，**没有 Vite 在跑**——本轮从头到尾没有起过开发服务器。
3. AT-SPI 读到窗口 `guit`，文档节点屏幕范围 26,70,576,544。
4. 面板自己从 `session.json` 打开仓库并画出真实数据：mtime 那一行答 "Last modified 1 minute ago — untracked/u9.txt"；未跟踪文件逐条列出（u0…u15）并在每条上给出暂存与更多动作；提交框与**干净恢复那一行**都在（`Commit to restore to` + `Reset to clean state…`）；图头给出 `Switch branch`，图里有 "Checked out. First commit. bench fixture — guit-bench, 2026-10-01." 与 `Load older`；四个窗口动作（最小化／最大化／关闭）在。
5. 按 app bar 自己的关闭钮结束（不是杀进程），窗口写下 `window.json`：`{"schemaVersion":1,"width":920,"height":656,…,"alwaysOnTop":true,"maximized":false}`——`alwaysOnTop: true` 是大纲 §4 的"新用户默认置顶"。
6. 进程退出，**stderr 一个字节都没有**。

这一条同时关掉 H05 的两件事：二进制不依赖 Vite 即可启动，以及一次完整的真实窗口证据。仍未验证的写在那件：`tools/bench/recovery-checks.sh` 尾部的四个人工项（打字的三类字段、跨比例因子与第二块显示器的钳位）在这台单显示器宿主上仍要人跑；Windows/macOS 仍只是构建配置。
## 4. H03 与 A 基线的对比

同一台宿主、同一 release 构建方式（`--features custom-protocol`）、同一夹具生成器，A02 的口径在能对得上的维度上重跑一遍。**A02 自己记的两条偏差先摆出来**：它的 `python3-gi` 缺失（本轮 `/usr/bin/python3` 有 `gi` 与 `Atspi`，需要先 `gi.require_version('Atspi','2.0')`），以及"常规夹具未按完整规格构建"。所以下面每一行都写清本轮实际用的东西。

### 4.1 idle 常驻（`tools/bench/idle-baseline.py`，隔离 HOME，1000 跟踪／100 脏夹具）

| 指标 | A02 基线 | 本轮 | 判定 |
| --- | --- | --- | --- |
| 进程树平均 CPU（单核当量） | 0.19%（300 s 窗口） | **0.76%**（240 s 窗口）／1.06%（150 s 窗口） | 达标（预算 <1%）；与基线的差有原因，见下 |
| 进程树 RSS 终值 | 437.4 MiB | **459.3 MiB**（240 s） | 与基线同量级；**仍超 150 MiB 预算约 3 倍**，缺口主体是 WebKitWebProcess（208.7 MiB） |
| RSS 峰值 | 444.6 MiB | 712.0 MiB（启动与首屏加载期） | 峰值在启动后回落，5 分钟无持续增长 |
| idle 期间 `git` 子进程 | 300 s 采样窗口内未捕获 | 240 s 内未捕获（1 Hz 采样） | 方向一致（口径同样偏弱） |

**CPU 与基线那 0.60 个百分点的差有出处，不是泄漏**：perf 日志（`GUIT_PERF=1`）显示 240 s 内 49 次 `capture.total`、49 次 `refresh.leader`、49 次 `activity.stat`/`apply`——**约每 5 秒一次完整的 `git status` 捕获**。这是阶段 C 选定的 `watch.rs::POLL_INTERVAL = 5 s`（事件驱动之外的兜底上界），A02 那棵树还没有它。每���捕获 `capture.total` 约 11 ms，占空比约 0.2%；剩下的 CPU 在活动扫描与渲染上。**结论**：稳态达标（0.76%），但这个数字**只在 Watch 兜底轮询开着时成立**，把它当作"guit 的 idle 成本"写进任何文档都是不诚实的。A02 那句"idle tick 不触发 Git/全量扫描"现在需要改口：idle tick 不触发**额外**扫描，但 Watch 自己的 5 s 上界会。

**RSS 缺口按 A02 的处置路径继续挂着**：记录基线，不在未测量前改写承诺。这一轮没有削减方案可报，缺口主体是 WebView 子进程，属平台配置研究。

### 4.2 深页（6000 提交夹具，`make-history.py`）

每页就是 guit 跑的那条命令（`git log --skip N -n 50`，七个样本取中位）：

| skip | p50 | min | max |
| --- | --- | --- | --- |
| 0 | 1.8 ms | 1.7 | 1.9 |
| 500 | 3.1 ms | 3.0 | 3.4 |
| 2500 | 8.1 ms | 6.5 | 8.5 |
| 5000 | 12.2 ms | 10.6 | 15.3 |
| 5900（最深） | 14.4 ms | 12.2 | 17.0 |

一页的代价随深度线性增长，与阶段 D §6.1 量到的形状一致；最深页 14.4 ms 仍在 `runner.rs` 的 20 ms 下限之内，所以深页不会被自己的进程地板拖住。

### 4.3 搜索（同一夹具）

| 范围 | p50 | min | max | n |
| --- | --- | --- | --- | --- |
| 一窗 1000 条（含整条说明 `%B`） | **6.0 ms** | 4.1 | 6.4 | 9 |
| 整个 6000 条历史 | 18.0 ms | 17.2 | 23.9 | 5 |

与阶段 E §10 记的 release 档首窗 warm p50 9.22 ms 同量级（夹具不同：那里 2000 条合成历史，这里 6000 条真实 `fast-import` 历史）。**端到端"输入到首批"仍然没有测到**——这些是 Git 层的墙钟，键盘到画上第一行之间还隔着一次 Tauri IPC 往返与渲染，那一段要另测。

### 4.4 连续写入风暴（`storm.py`，400 文件夹具）

120 次突发 × 20 文件、每 40 ms 一次（约 2400 次写、约 5 秒），面板开着：

- `watch.refresh` 触发 **7** 次，`refresh.leader` 7 次——**刷新在连续事件下没有被饿死**（阶段 C 的契约），而且合并闸门把 2400 次写收成 7 次捕获，不是 2400 次。
- 面板活着，mtime 那一行答 "Last modified just now — src/file88.txt"。

未验证：事件率上界本身（C01 的 `sync_channel` 容量与 `try_send`）本轮没有在风暴下直接观测，那条仍由 C 阶段的 Rust 用例与 `plan/09` 的记录承担。

### 4.5 主题恢复、重启持久化、窄窗、缩放回流（真实窗口，AT-SPI）

| harness | 结果 |
| --- | --- |
| `theme-check.py` | **fails=0**：深色令牌成对、两套在每个决定性令牌上都不同、系统默认被尊重、三档缩放可持久化、Light/Dark/Follow system 三次切换后缩放偏好都还在 |
| `restart-persistence-check.py` | **fails=0**：一份更新版本的几何文件被拒且窗口按出厂宽度起来、更新版本的会话是完整面板而不是半张壳、那份几何文件在会话结束后逐字节还在 |
| `layout-check.py 340x400` | **fails=0**：Main 与 Settings 与覆盖层菜单都干净铺开 |
| `narrow-smoke.py` | **fails=0**（本轮改了它，见下） |
| `view-smoke.py` | **fails=0**（夹具见下） |
| `zoom-reflow-check.py` | **fails=0**：最小窗 24px 下 Main 与 Settings 都把四个窗控钮留在窗内，Settings 不撑破最小窗 |

### 4.6 两个 harness 各修了一处"用错通道"

不是产品缺陷，是探针拿错了通道——两处都在**未改动的验收前基线 `222fd5e` 上同样失败**，所以这一条是必要的证据，不是把红灯解释掉。

- **`narrow-smoke.py` 的"提交历史与更改同屏"**：它用 showing-name 集合找图区，而 340×400 下图区在折叠线以下；WebKitGTK 的节点在焦点把它带进视野的那一刻才报 SHOWING。焦点实测：拿得到焦点、带 FOCUSED 与 SHOWING、尺寸 340×73——图区在、可滚、没被藏。改用 `reach()`，也就是探针自己文档里那条"SHOWING 是这个滚动位置，不是可达性"。
- **`view-smoke.py` 的三组标题**：`make-dirty-repo.sh 60 8 5` 那个夹具有 3 暂存 + 5 工作区 + 5 未跟踪 = 13 行，而默认窗里更改区只有约 73 px（约 2–3 行），未跟踪那一组在折叠线以下，虚拟列表里没有它的节点。探针自己的文档写着"夹具小到能放下全部三组"——是这个夹具没小到。换 `make-dirty-repo.sh 8 3 2`（保留 `src/file*` 命名，好让"模态列出候选文件"那条按它写的方式找）后 fails=0。

一处**没有**改的：AT-SPI 打出 `impl_get_CharacterCount: assertion 'ATK_IS_TEXT (user_data)' failed` 是探针自己的 `node_text()` 对非文本节点调 `get_character_count` 造成的，属于 harness 的噪音而不是面板的错误，因此没有为它改产品。

## 5. H06 需求追踪与交付检查

`plan/04-validation.md` §6 的交付门槛，逐条对现状。**"已完成"只写有实测证据的**；没有跑过或这台宿主做不到的，明写未验证。

### 5.1 G01–G10

| 目标 | 结论 | 证据 | 未验证/遗留 |
| --- | --- | --- | --- |
| G01 两个 Tab、上下同屏 | **达成** | `layout-probe.mjs` 九档 × 五页 568 ok；`layout-check.py` 340x400 fails=0；`layout-probe.mjs` 的"两区域同屏"在每一档都有盒子 | 整页 Tab 键序逐格记录（本宿主 Wayland 无按键注入，见 W05 行） |
| G02 四按钮/置顶 | **达成** | 真实窗口：四个窗控在两个 Tab 都在；`zoom-reflow-check.py` 最小窗 24px 四钮全在框内 fails=0；`restart-persistence-check.py` 读回几何且 `alwaysOnTop` 为真 | 多 DPI 与第二块显示器钳位（单显示器宿主，`recovery-checks.sh` manual 3） |
| G03 统一模糊搜索 | **达成（Git 层）** | `fuzzy.rs` 14 用例；`search.rs` 29 用例；搜索一窗 p50 6.0 ms（§4.3）；`read-budget.mjs` fails=0 | 端到端"输入到首批"p95 ≤500 ms 未测（§4.3 说清了为什么）；输入法在真实窗口的旅程未走 |
| G04 mtime 计时 | **达成** | 真实窗口 mtime 行答 "Last modified … — <file>"；C 阶段 Rust 用例 | 时钟异常、轮询降级的完整矩阵记在 C 阶段那一行 |
| G05 更改与提交 | **达成** | `view-smoke.py` fails=0（暂存/丢弃/模态/取消/草稿/开发探针）；Rust 写入用例 | 真实仓库上完整暂存→提交旅程未在本轮窗口里按（只有只读旅程） |
| G06 干净重置 | **达成** | `reset.rs` 37 用例（含票据、门槛、两步、事后、部分完成、保护边界）；`restore-preview-engine-probe.ts` 48 断言 × 八档窗口 fails=0；`clean-reset-probe.py` 复现测量 | 写前拒绝与部分完成在真实窗口里没演（探针答的是按字段构造的名单） |
| G07 Git Graph | **达成** | 六支图相关引擎探针 fails=0；深页 p50 1.8→14.4 ms（§4.2） | 约十万提交深度碰捕获上界那条仍是算术 |
| G08 字体与主题 | **达成** | `theme-check.py` fails=0（三档切换后缩放偏好都在）；`restart-persistence-check.py` 坏/新版几何文件可恢复；`font-engine-probe.ts` fails=0 | 打字的三类字段（无通道，manual 4） |
| G09 实时低占用 | **达成（预算内），但有一处必须说清** | idle 0.76% 单核当量（预算 <1%）；风暴下刷新未被饿死（§4.4）；`read-budget.mjs` 十二次往返六项平衡 | **RSS 459 MiB 超 150 MiB 预算约 3 倍**（WebView 子进程为主体，按 A02 路径继续挂着）；idle CPU 这个数**只在 Watch 5 s 兜底轮询开着时成立**，A02 那句"idle 不触发 Git"要改口成"不触发额外扫描，但 Watch 自己的上界会" |
| G10 本地与安全边界 | **达成** | `ipc-surface.mjs` 四分表覆盖注册表且无重叠；`EXITED_COMMANDS` 里远程一条不在注册面；无文件内容进 DOM（架构约束）；本轮又撤掉一个重复重置 | Windows/macOS 仍只是构建配置；RSS 缺口未闭合 |

### 5.2 发布阻断条件（`04-validation.md` §6 第一段）逐条

| 阻断条件 | 现状 |
| --- | --- |
| 数据过期却显示成功 | 有快照版本与 `write_stale_snapshot`；部分执行报 `Partial` |
| 错误图连接 | 跨页检查点按列传边界；D03c 六个可重复夹具 |
| 无结果却未完成搜索 | `complete`／`stoppedBy` 分开；未完窗永不说"无结果" |
| mtime 伪用事件时间 | 取候选最大 mtime，不是最后事件；未来 mtime 报不可信 |
| 票据可重用 | `take_preview` 先移除；recheck 重跑同一计算 |
| 预览外文件损失 | `Bound::Restore` 绑整个计划；clean 只删它此刻提供的路径 |
| ignored/嵌套仓库被通用清理 | 嵌套仓库永不承诺、永不加第二个 force；忽略例外单独一类 |
| 远程命令仍能从产品调用 | 注册面已无远程命令；退出清单有门禁 |
| 坏主题无法恢复 | `Ctrl/Cmd+Shift+T` 页面按钮同一条出路；崩溃后标记恢复 |
| 窗口关闭绕过清理 | 先写几何再销毁；关闭收尾有 Rust 单测 |
| 文件内容进入 DOM | 无 content 类型、无路径 |

**没有一条是靠改文案绕开的**——唯一一条（忽略项被覆盖）本轮是把那个绑定更少的旧重置整条撤掉，而不是改它的措辞。

### 5.3 发布门槛（`04-validation.md` §6 末段）

| 要求 | 现状 |
| --- | --- |
| G01–G10 对应记录 | 本表即（§5.1） |
| 全套适用测试 | 五条核心门禁 + 九支引擎探针 + 布局/读预算/六个真实窗口 harness，本轮全过（§1.2、§2、§4.5） |
| 至少一个平台完整桌面旅程 | Linux 一个平台：独立二进制 + 真实窗口旅程（§3、§4.5） |
| 基线对比 | §4 对 A02（CPU/RSS、深页、搜索各有对照） |
| 独立二进制与迁移/重启测试 | `bin:release` 无 Vite 启动；`restart-persistence-check.py` 坏/新版配置可恢复（§3、§4.5） |
| 真实限制说明 | 本表"未验证/遗留"列 + §4 的偏差说明 |

### 5.4 结论

**不标记整体完成。** G09 的 RSS 预算缺口按 A02 的处置路径仍未闭合（超预算约 3 倍，缺口主体是 WebView 子进程，属平台配置研究），端到端"输入到首批"未测，Windows/macOS 未运行。这些都写在这里而不是被"Linux 一个平台通过"盖过去。

### 5.5 发布与回退方法

- **发布**：Linux 上 `npm run bin:release`（必须带 `custom-protocol`，否则二进制指向 Vite 开发服务器，只能在 `tauri dev` 旁边工作）。发行前把 `CHANGELOG.md` 的 `[Unreleased]` 切成版本号。
- **回退**：全部改动的回退方式是 `git revert` 到本轮之前的提交（`6b36115` 之前的 `e28d11d` 是 A–G 质量收口点，`ac61b62` 之前是 H01 之前的树）。本轮删掉的两块（stash/worktree 页面与其命令）是**代码删除**，回退即恢复那些文件——它们从未在真实窗口里到达过，恢复后不影响任何用户仓库。回退**不**恢复任何用户仓库的内容：本轮所有 Git 操作都跑在 `/tmp` 夹具上。

### 5.6 本轮提交清单

| 提交 | 内容 |
| --- | --- |
| `730504a` | 提交框与图行拆名；重置行按钮标签不再折行；探针量真正的承诺 |
| `6b7cead` | `cancel_search`：读者取走问题后，那趟扫描停下来 |
| `c6768ca` | 撤掉第二个重置与它绑定更少的票；目标解析七条改从 `preview_restore` 进去 |
| `8cd04f0` | 记录 A–G 验收与它翻出来的四个缺口，并纠正两句"可行被记成不可用"的话 |
| `399bc06` | H01：两页没有页面到达的视图，连带只够得着的 14 条命令与三个后端模块 |
| `ac61b62` | H01：只有那些视图才写的票据形状 |
| `e28d11d` | 记录收尾：撤下了什么，一次真实窗口 |
| `6b36115` | 图区问可达，而不是问它此刻的滚动位置 |
| `94ecee3` | H04：CHANGELOG 与两份 README 说清两个重置变成了什么 |
