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