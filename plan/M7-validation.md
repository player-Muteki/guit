# M7 界面重设计验证记录

## 范围与边界

M7 只重做前端呈现层。Rust 后端、Tauri 命令签名、事件名与数据结构一字未改（`git status app/src-tauri/` 全程为空）；不新增 npm 依赖；不引入 UI 框架。验证目标是：呈现层重写没有引入功能回归、破坏既有无障碍契约、或偏离 `plan/05-desktop-ux.md` 的约束。

## 环境

与 M6 同主机：Ubuntu 26.04.1 LTS、GNOME Wayland (XWayland, HiDPI scale 2)、Node 22+、Git 2.53、Tauri CLI 2.11.x、WebKitGTK 2.52.6 / GTK 3.24.52。所有运行时证据来自这一台 Linux 主机，**不构成 Windows/macOS 声明**（延续 0.1.0 口径）。

一项环境约束（本轮实测得出）：**AppImage 打包需要 `APPIMAGE_EXTRACT_AND_RUN=1`**。`appimagetool` 要用 FUSE 挂载 squashfs，本宿主没有；不带该变量时 `tauri build --bundles appimage` 在 `linuxdeploy` 之后失败（`failed to run linuxdeploy` 是 Tauri 的包装文案，真实卡点在 appimagetool 挂载）。带该变量后三件产物齐出。运行 AppImage 同样需要它。

## 设计决策

| 决策 | 取值 | 理由 |
| --- | --- | --- |
| 窗口装饰 | 保留系统原生标题栏 | 用户确认；跨平台窗口行为最稳，不引入 `decorations: false` 的吸附/最大化回归 |
| 主题 | 跟随系统 + 明暗双主题（可手动覆盖） | 用户确认；`prefers-color-scheme` 两套令牌，`data-theme` 覆盖 |
| 状态色 | GitHub Primer 语义色 | 与 GitHub 用户既有认知一致；色盲友好；颜色从不单独承载信息（行内始终有等宽两字母状态码 + 左侧 2px 状态轨） |
| 依赖 | 零新增 | `plan/02` 依赖原则；`dom.ts` 自带手写 16px SVG 图标集 |
| 反馈层 | 状态栏（进度/结果）+ Toast 栈（失败） | 修复 M6-05/06 记录的单告警位"后写覆盖前写"。外部工具**报告的**失败按 `plan/05`"结果文案走状态栏"仍走状态栏，只有**抛出的**失败进 Toast——与 0.1.0 逐字一致 |
| 危险动作 | 行内 `⋯` 菜单 + 原生 `<dialog>` 模态 | `plan/05` 要求危险动作收进显式菜单；模态统一 Escape/焦点返回 |
| 空态归属 | 无仓库时只显示欢迎态，Settings 除外 | 本轮实测修正：主题/缩放/快捷键/诊断都是应用级的，无仓库时也必须可达（见"实测修复"第 1 条） |
| 提交信息传递 | 确认仍只发 `{nonce, interactive:false}` | 安全关键路径逐字保留 |

## 代码结构

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `main.ts` | 341 | 启动器：事件、快捷键、窗口钩子、票据确认路由 |
| `state.ts` | 266 | 单一状态层：快照版本闸门、忙碌标志、活动视图、状态行、Toast、凭据重试、强推闸门 |
| `shell.ts` | 413 | 应用栏、活动栏、状态栏、视图挂载与空态归属 |
| `window.ts` | 148 | 置顶、边界持久化、获焦刷新、紧凑窗口测试 |
| `dom.ts` | 210 | `el()` 构造器、手写 16px 图标集、共享浮层菜单、激活元素记录 |
| `types.ts` | 326 | 全部线协议类型（镜像 Rust 命令载荷） |
| `font.ts` | 39 | 界面缩放 + 主题（localStorage） |
| `historyModel.ts` | 20 | 纯提交列表模型（`node --test` 直接导入） |
| `fileModel.ts` | 118 | 未改动 |
| `dialogs/confirm.ts` | 112 | 通用模态（票据确认、诊断导出清单共用） |
| `dialogs/askpass.ts` | 82 | 凭据模态 |
| `dialogs/toast.ts` | 49 | Toast 栈 |
| `dialogs/preview.ts` | 326 | 票据控制器：请求 → 重发 → 确认路由 + 11 种文案表 |
| `views/changes.ts` | 454 | 最大的视图 |
| `views/branches.ts` | 459 | 最大的视图 |
| `views/remotes.ts` / `history.ts` | 398 / 389 | |
| `views/worktrees.ts` / `settings.ts` / `stash.ts` / `welcome.ts` | 288 / 272 / 155 / 164 | |
| `style.css` + `style/tokens.css` | 449 + 198 | 组件样式与设计令牌 |

原 `main.ts` 4014 行单文件 → 24 个源文件 + 1 个未改动的 `fileModel.ts`，最大 459 行。

## 实施中读出并修复的行为缺口

设计阶段的通读（在没有类型检查的条件下）已修 9 处（`stashPop` 票据被标成 `stashDrop`、`SyncAction` 残留已删除的 `"fetch"` 变体、`rows`/`spellcheck`/`tabindex` 属性类型不符、票据驱动的分支删除丢失 `not fully merged` 强删升级、建分支/标签的起点 OID 不清空、`preview.renew` 的伪取消、外部工具期间票据确认不占写通道、`resetHard` 票据重送解析后的 oid 而非用户请求的 commit id、模态取消丢失 `Cancelled; nothing was changed.` 文案）。

**本轮真正跑起门槛后又发现 11 处**（合计 20 处），其中前 6 处是只有运行时/AT-SPI 才能暴露的：

1. **Settings 在无仓库时不可达。** 壳层把七个视图一并隐藏、只留欢迎态，而主题、界面缩放、快捷键列表、诊断导出全是应用级的；`diagnostics-export-check.sh` 因此直接失败（step 1「export button not in tree」）。改为：Settings 是唯一无仓库也显示的视图，其余六个在无仓库时置灰（`disabled` + title「open a repository first」），Ctrl+1…7 也随之被同一条件挡住。**这是 M7 自身引入的可达性回归。**
2. **监听模式行对无障碍树不可见。** 状态栏的监听模式是裸 `<span>`，WebKitGTK 不为「脚本写文本的裸 span」生成可及对象——实测四种写法：裸 span ✗、`<span><strong>`+文本节点 ✗、`aria-label` ✓、`role="status"` ✓、`<div>` ✓。M6 把这行放在仓库摘要的 `<div><strong>` 里所以可见；搬进状态栏后既让读屏用户听不到，也让 `bench_run.py` 的 L2 地标（`Monitor: `）长期为 null（本轮 3 次里 2 次 null）。改用 `role="status"`，并在文本未变时不重写（活动区每次变更都会重播）。Settings 的缩放读数有同一缺陷，一并修。
3. **AT-SPI 地标串被改写丢失。** `Open a repository to list its working copy status.` 在重写中随 Changes 卡的空态一起消失（欢迎态换成了新文案），`recovery-checks.sh` 阶段 A/B 因此失败。已把它放回欢迎态（逐字），Changes 的空态相应收敛为只有 `Working copy is clean.` 一种（视图在无仓库时不显示，那个分支本不可达）。
4. **模态的用户关闭路径不还焦。** `hide()` 还焦，但确认/取消/Escape 三条路径直接 `close()`，键盘焦点被留在已离屏的对话框里；且经行内 `⋯` 菜单触发时 `document.activeElement` 已回落到滚动容器，`opener` 取到的是错的节点。四条路径统一走 `leave()`，并新增 `dom.ts` 的激活元素记录（`currentActivator()`）作为 opener 来源。
5. **浮层菜单泄漏 document 监听器。** `openMenu` 的 outside-click 监听只在它自己触发时注销；点菜单项时它先 return（因为 target 在菜单内），于是监听器随每次打开累积一条，在长驻进程里无上界。同时补上 `plan/05` 要求的 Escape 关闭与焦点返回。
6. **应用栏内联菜单无 Escape、无焦点管理。** 同样补齐，并把「打开时聚焦首项、退出时回到按钮」做成对称的一条路径。
7. `rebuild()` 展开整个判别联合后再 `as` 断言，类型检查直接报错；改为逐分支显式返回，让返回票据的判别式可证。
8. `applySnapshot` 在 `dialogs/preview.ts` 里漏 import（两处）。
9. `shell.ts` 从 `./font` 导入 `isAlwaysOnTop`/`setAlwaysOnTop`（它们在 `./window`）。
10. `views/history.ts` 用了不存在的 `commit.commitmitterName`（正确为 `committerName`，与 0.1.0 一致）。
11. `views/remotes.ts` 用 `[...select.options]` 展开 `HTMLOptionsCollection`；`tsconfig` 的 `lib` 只有 `DOM` 没有 `DOM.Iterable`，改 `Array.from`。

另有两处**不是**缺陷、而是原计划与实测口径不符，如实记录：

- `recovery-checks.sh` 阶段 B 的 `Unsupported` 断言一度失败，是**遗留进程**抢占 AT-SPI 应用名所致（见下"基准脚本口径"第 5 条），不是应用行为。
- `make-repo.sh` 的 `dirty` 参数在提交**之前**追加内容，所以它造的夹具工作副本始终是干净的，M0–M6 的基线表里 1k/10k 两档其实从未渲染过文件行。本轮补 `make-dirty-repo.sh`（提交后再改脏，并让暂存/未暂存/删除/未跟踪同时存在）来真正走通行内路径。

## 验证清单（本轮实测结果）

| 项目 | 判据 | 结果 |
| --- | --- | --- |
| 类型检查与构建 | `tsc --noEmit && vite build` | ✅ 0 error；`index.css 20.83 kB` / `index.js 94.71 kB`（gzip 4.26 / 27.83 kB） |
| 前端单元 | `npm run test:fixture` | ✅ **18/18**（file-model 9、history-model 5、state 4） |
| Rust 回归 | `cargo test --locked` | ✅ 292 + 5；22 次全量中 2 次单发失败，20 次全绿（已定位用例，见"已知缺口"） |
| 格式 | `cargo fmt --check`、`git diff --check` | ✅ 均无输出 |
| clippy | 存量不增 | ✅ 恒 12 条（7 bin + 5 test-only），`app/src-tauri/` 零改动故必然等同 |
| 空态契约 | AT-SPI 命中 `Open a repository to list its working copy status.` | ✅ `recovery-checks.sh` 19 断言 fail=0（阶段 A、B） |
| 损坏索引 | 不得出现 `Working copy is clean.` | ✅ 阶段 C（`fatal:.*\.git/index` 命中 + 负向断言） |
| 陈旧 index.lock | 只读穿透、绝不写用户的锁 | ✅ 阶段 D（`tracked\.txt` 命中 + 负向断言 + 锁文件 sha256 不变） |
| 视图标题与可达性 | 活动栏七项各自打开并显示自己的内容 | ✅ `view-smoke.py` 19 断言 fail=0 |
| 空仓库时只显欢迎态 | 六个仓库级视图置灰，Settings 可达 | ✅ `view-smoke.py` + `diagnostics-export-check.sh`（后者从 Settings 驱动） |
| 提交计数 | 历史就绪行 `N commit(s)` 仍可见 | ✅ `bench_run.py --history-pages` 路径（见性能表） |
| 诊断导出 | 按钮名 `Export diagnostics…`、模态确认 `Export…`、原生 `Save`、落盘内容与脱敏 | ✅ `diagnostics-export-check.sh` 10 断言 fail=0 |
| 窄窗口 | 340×400 主要动作仍可达 | ✅ `narrow-smoke.py` 9 断言 fail=0（活动栏 7/7、应用栏主动作、分支芯片、提交框、缩放控件、行内 `⋯` 全部在树内且 SHOWING；窗口可复原） |
| 明暗双主题 | 两套令牌都在、决定可读性的令牌两套都不同；三个选项都能选中并落库 | ✅ `theme-check.py` 17 断言 fail=0 |
| 模态 | 丢弃预览 → 列出候选 → 取消关闭 → 票据未消费 | ✅ `view-smoke.py`（模态文案、候选清单、`Cancelled; nothing was changed.`、`git status --porcelain` 前后逐字相同） |
| Toast 不覆盖 | 连续两次失败同时可见 | ⚠️ 运行时无法稳定制造两次**抛出型**失败；改为在 `app/tests/state.mjs` 单测证明栈语义（追加不覆盖、按 id 独立关闭、封顶 4 条丢最旧），抛出型路径的运行时证据沿用 `recovery-checks.sh` 阶段 B/C |
| History 分页 | 10k 提交夹具点「Load older」无全表重建回退 | ✅ 12 次点击 0.021–0.045 s/页，中位 0.036 s |
| 打包 | `tauri build --bundles deb,rpm,appimage` 零告警 | ✅ 三件齐出，**无任何 warning 行**（AppImage 需 `APPIMAGE_EXTRACT_AND_RUN=1`） |
| rpm 载荷 | 载荷内有可执行的 `usr/bin/guit` | ✅ `bsdtar` 解出 4 图标 + desktop + `usr/bin/guit`（`rpm2cpio`/`rpm` 本机无，记录非失败） |
| AppImage 冒烟 | 隔离 HOME 启动到 Changes 视图 | ✅ `APPIMAGE_EXTRACT_AND_RUN=1` 下启动，AT-SPI 命中 `Commit message` 与 `Monitor: ` |

## 性能复测（对照 M6-01 基线）

协议同 M6：`bench_run.py` 逐夹具多次运行，RSS 取整棵进程树、100 ms 采样。**L2 地标定义随壳层变了**（历史移入独立视图，首屏树里不再有提交计数；详见"基准脚本口径"第 1 条），故 L2 数字与 M6 表**不是同一口径**；dirty→visible、RSS、CPU 三列可直接对照。

| cell | n | L1/L2 s | dirty→visible s | inotify | 空闲 RSS 中位 KB | 空闲 CPU 核 | 主进程 HWM KB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tiny | 2 | 0.983 / 0.983、1.006 / 1.006 | 0.333、0.362 | 20 | 459,020–459,136 | 0.0027–0.0034 | 208,784–208,988 |
| 100 | 2 | 1.034 / 1.034、1.018 / 1.018 | 0.334、0.370 | 20 | 459,076–459,312 | 0.0034 | 208,900–209,056 |
| 1k | 3 | 0.487、0.992、0.997 | 0.386、0.345、0.340 | 38 | 459,288–459,412 | 0.0025–0.0040 | 208,348–209,500 |
| 10k | 2 | 0.986、0.535 | 0.385、0.383 | 197 | 459,456–459,948 | 0.0054–0.0060 | 208,376–208,716 |
| hist10k | 3 | 1.044、0.982、0.969 | — | — | 462,976–463,904 | 0.025–0.035 | — |

对照 M6-01（1k warmed：L2 1.013 s、dirty→visible 0.370 s、空闲 RSS 470,282 KB、空闲 CPU 0.076 核、主进程 HWM 214,666 KB）：

- **dirty→visible 持平略好**（0.340–0.386 vs 0.360–0.394）。
- **空闲 RSS 低约 11 MB**（459 MB vs 470 MB）：历史列表不再常驻挂载。
- **空闲 CPU 低一个数量级**（0.003–0.006 核 vs 0.075–0.079 核）：同上，这是壳层重做最直接的收益。
- **主进程峰值低约 5 MB**（~209 MB vs ~215 MB）。
- inotify 句柄数逐档相同（20 / 20 / 38 / 197），确认监听面未被重做影响。

History 分页（hist10k，PAGE_SIZE=50，点「Load older」到行数落定）：12 次点击 0.021–0.045 s，中位 0.036 s。M6-02 记录的「500 行 129 ms / 3000 行 1664 ms」全表重建未回归（虚拟化沿用 `fileModel` 的窗口函数）。

## 基准脚本口径变更（五处，均在本 diff 中）

1. `bench_run.py` L2 地标：原条件含 `\d+ commit\(s\)`（M0–M6 单页布局下历史卡常驻树中）。M7 把历史移入独立视图后该计数不在首屏树中，故改为「状态栏 `Monitor: ` 行 + Changes 视图自身内容行」；历史计数的到达改由 `--history-pages` 路径在切到 History 视图后单独断言。**M6 与 M7 的 L2 数字因此不是同一口径。**
2. `bench_run.py --history-pages`：新增一步「点击活动栏 History」再翻页，否则 `Load older` 不在无障碍树中。
3. `diagnostics-export-check.sh`：新增一步切到 Settings 视图（应用默认落在 Changes），并把触发按钮改为精确名 `Export diagnostics…`（原为子串匹配，会与模态确认按钮 `Export…` 混淆）。M7-01 修好 Settings 可达性后这条才真正跑通。
4. `recovery-checks.sh`：仅注释更新（断言行未动）；空态串等四串在修复后于新设计中全部原样保留。
5. `atspi_landmark.py` 的 `app_root()`：**改为从后往前扫、取最后一个匹配**。原实现取第一个匹配，于是上一次运行残留的 guit 进程会一直占着 AT-SPI 应用名，整套脚本稳定地报「empty state not reached」——与被测构建无关。实测：在两个残留进程并存的情况下修复后仍 19/19 fail=0。

新增夹具与工具（均为本轮验证所需，零新依赖）：

| 文件 | 用途 |
| --- | --- |
| `tools/bench/make-dirty-repo.sh` | 提交后再改脏的夹具，暂存/未暂存/删除/未跟踪同时存在；NUL 分隔 pathspec 保证非 ASCII 与含空格路径完整 |
| `tools/bench/view-smoke.py` | 19 断言：七视图各自内容、三组变更标题、行内菜单、丢弃票据的取消路径、状态行确认、工作副本零变化 |
| `tools/bench/narrow-smoke.py` | 9 断言：340×400 下活动栏/应用栏/提交框/缩放控件/行内动作仍在可及树内，窗口可复原 |
| `tools/bench/theme-check.py` | 17 断言：两套令牌都在且决定性令牌全不同、三个主题选项可选且落库正确（复制 localStorage 后只读副本，绝不打开原库） |
| `app/tests/state.mjs` | 4 单测：快照只前进、Toast 追加不覆盖且按 id 独立关闭且封顶 4 条、忙碌/监听/状态/强推闸门可读 |

## 已知缺口（如实记录）

- **Windows/macOS 未实测**（延续 0.1.0 口径）：无运行时验证，仅配置到位。
- **焦点无法用 AT-SPI 验证。** 实测该宿主的 AT-SPI 桥把 `FOCUSED` 状态**粘住**（点开应用栏 `⋯` 聚焦首项，再点活动栏 History，旧节点仍报 FOCUSED），且 `do_action` 不移动 DOM 焦点。因此焦点返回/取焦的断言全部从 `view-smoke.py` 移除，改为代码层保证（四条关闭路径统一 `leave()`、`openMenu`/应用栏菜单对称还焦、opener 取自激活元素记录）。**焦点行为本轮未经运行时验证**，与 M6 记录的 Wayland 键盘注入缺口同源。
- **Toast 栈的"不覆盖"只有单测证据**：见验证清单中该行的说明。
- **`cargo test` 单发 flake（已定位到用例）**：本轮 22 次全量里 2 次 291/292，失败用例是 `probe::tests::unsupported_git_reports_update_guidance`，报错 `git_start_failed: Text file busy (os error 26)`。该用例 `std::fs::write` 写一个 `#!/bin/sh` 假 git 后立刻 `execve` 它，偶发 ETXTBSY（内核在该 inode 上仍见写句柄）。**单独跑该用例 40 次全绿**，只在与全量 292 个用例并发时出现，故属并发/内核时序而非用例逻辑。与 M6-03/M6-06 记录的同类单发画像一致。**未修**：修它要动 `src-tauri/src/probe.rs` 的测试代码，越出 M7「后端零改动」边界；可能的修法（写后 `sync_all` 再 exec、或对 ETXTBSY 做有限重试）留给后续独立议题。
- **外部 diff/merge 工具的失败文案走状态栏而非 Toast**：与 0.1.0 逐字一致，也符合 `plan/05`"结果文案走状态栏"；代价是它会被下一次状态更新覆盖。本轮按现状保留，如实记录。
- **1k/10k 夹具在 `submodules_list_too_large` 上失败**：`git ls-files --stage` 走 `DEFAULT_OUTPUT_LIMIT`（64 KB），约千级文件即触顶，于是该档 Changes 列表为空并弹出该错误。**这是 M7 之前就有的后端读上限**（`app/src-tauri/` 零改动，`known-limitations.md`「Output bounds」已记载），M7 未引入也未修复；因 M7 明确不改后端，本轮不擅动，留作独立议题。1k/10k 两档的 L2 因此命中的是空态占位而非填充列表，与 M6 同。
- **AppImage 需 `APPIMAGE_EXTRACT_AND_RUN=1`**（见"环境"）。
- `docs/known-limitations.md` 的「单一错误告警位」条目已改为 M7-03 修复记录。

## 运行时结果

**全部门槛已在本机实跑。** 逐项命令与数字见上表与性能表；`recovery-checks.sh` 19/19、`diagnostics-export-check.sh` 10/10、`view-smoke.py` 19/19、`narrow-smoke.py` 9/9、`theme-check.py` 17/17 均 fail=0，五套连跑后无残留进程。类型检查、构建、18 个前端单测、292+5 Rust 单测、`fmt --check`、`clippy` 存量、三件打包均通过。

结论：**M7 达成 Linux 已验证出口**；本记录与用户文档处处只作单机结论，不含三平台声明。
