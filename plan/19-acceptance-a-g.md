# 阶段 A–G 验收与质量优化记录

基线提交：`222fd5e`（工作区干净）。验收日期：本次会话。

这份文件是验收那一轮的结论：**A–G 各自交付了什么、在这一棵树上还能不能跑、留下的哪些问题属于质量而不是范围**。它不重复路线图里已经写着的实施记录，只写"重新跑一遍之后看见什么"，以及从看见的东西里挑出来的质量项。

## 1. 门禁复跑（`222fd5e`，工作区干净）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 构建与类型 | `npm run build` | 退出 0，48 modules，`index-BJ9BDPIF.css` 34.27 kB／`index-BR-rB_l0.js` 131.05 kB |
| 纯模型与源码夹具 | `npm run test:fixture` | **412 pass／0 fail** |
| Rust 单元 | `cargo test --manifest-path src-tauri/Cargo.toml` | **398 passed／0 failed** |
| Rust 格式 | `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 零 diff |
| Rust lint | `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets` | 0 告警 |
| 对比度 | `python3 ../tools/bench/color-contrast.py dist/assets` | fails=0 |
| 响应式 | `python3 ../tools/bench/responsive-check.py src/style.css src/style/tokens.css` | fails=0 |
| 引擎探针 ×9 | `/usr/bin/python3 ../tools/bench/webkit-engine-probe.py <probe> src/style.css src/style/tokens.css` | 各 fails=0（appearance／search-layer／commit-bubble／branch-selector／graph-pan／font／theme／theme-lifecycle／restore-preview） |
| 布局九尺寸 | `node ../tools/bench/layout-probe.mjs dist 9222`（headless Edge 154.0.4258.48） | **568 ok／fails=0** |
| 读预算 | `node ../tools/bench/read-budget.mjs` | fails=0 |

**两条关于"能不能跑"的更正**，它们各自关掉了计划里一句把可行记成不可用的话：

- `layout-probe.mjs` 不挑浏览器名字，它要的是一个能被 CDP 驱动的 Chromium 系浏览器。`/usr/bin/microsoft-edge` 154.0.4258.48 装着，`--headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/guit-edge` 起来探针就跑完了 568 条。九档 × 五页都过。
- AT-SPI 需要 `gi.require_version('Atspi', '2.0')` 之后 `from gi.repository import Atspi`。直接 `import Atspi` 在这台宿主上失败过，那不是"这台机器跑不了无障碍探针"。

计划 W05 行里"480 宽以内另有九条与本行无关的旧红"这一次没有出现：那九条的成因（门禁只在 More 菜单收起的那一眼里找 `Open repository` 与 `Refresh status`）已在阶段 E 那次改动里按样式表自己的说法修掉了。本行是引用这一事实的第一次复跑，不是新结论。

## 2. 逐阶段验收结论

| 阶段 | 交付物 | 验收结论 |
| --- | --- | --- |
| A | 基线、门禁运行、语义夹具、仅本地命令清单 | 通过。四份记录都在 `05`–`08`；命令清单与 `main.rs` 注册表仍一一对应（`ipc-surface.mjs` 覆盖检查即其门禁） |
| B | 双 Tab、同屏更改+历史、释放登记、仅本地、会话身份、探针迁移 | 通过。主面板两个区域在九个尺寸上都有盒子（`layout-probe.mjs` 的 `together` 一条） |
| C | 有界监听、mtime 索引、增量更新、计时显示与设置 | 通过。Rust 侧 `watch::tests` 与 `activity` 相关用例在内 |
| D | 历史身份双读、结构化 refs、跨页检查点、提交气泡、分支选择器 | 通过。四支相关引擎探针 fails=0 |
| E | 折叠口径、扫描通道、读取协议、顶栏搜索、撤掉页内 find、结果层证据 | 通过。`search-wiring.mjs` 与 `search-model.mjs` 在 412 条里 |
| F | 单文件清理、缩写解析、预览构造、票据与两步、事后判词、界面与渲染证据 | 通过，但**退出门槛的另一半仍开着**，见 §3 第 4 条 |
| G | 版本化记录、三类字体、自定义主题、四个窗口动作、小窗复核 | 通过（W05 记为"部分实施"，未闭合项是这台宿主没有的通道，不是缺口） |

## 3. 质量项（这一轮从"能跑"里看见的）

按"是不是真缺陷"排，不按发现顺序。

### 3.1 `.commit-row` 一个名字两处用（E04c-1 记下未拆）

`app/src/views/changes.ts:141` 给提交框那行 `class: "commit-row"`，而 `app/src/style.css:611` 起的那组无前缀 `.commit-row` 是图里的一行：固定 `height: var(--row-height-history)`、`cursor: pointer`、`overflow: hidden`、`font-size: var(--text-sm)`，外加 `.commit-row:hover` 的 `--surface-hover`。`.commit-footer .commit-row`（第 571 行）只覆盖了 `display`／`align-items`／`gap`／`margin-top` 四条，其余照旧落在提交框上。

后果是三件都能在渲染里看见的事：提交框那行被钉成图行高、按图行字号画、鼠标停在上面时整行泛出选中底色——而那一行不是图的一行，也不是可选的行。`.commit-row.flash` 与 `.commit-row.head .graph-gutter` 那些规则对提交框是空转（它没有 `.flash`／`.head`，也没有 `.graph-gutter`），但规则集本身已经把两个视图缝在了一起：下一次谁给提交框加一个类，就可能落进图行的样式里，而这种缝是改名看不出来的。

**改法**：提交框那行改用自己的名字（`commit-actions`），图侧的选择器收到 `.history-list` 之下。改名是一次性的选择器手术，行为差别由一支源码夹具钉住。

### 3.2 `.reset-input` 没有 `font: inherit`（F06 量到未修的那一格）

F06 记下：面板声明的最小宽度 340 配上最大缩放时，重置行的字段与按钮不再共一条顶边（`field:[160.5,193.859]`／`button:[149.109,185.359]`，差 8.5px）。原因是 `.reset-input` 只写了 `font-family` 与 `font-size`，没写 `font: inherit`——同一行的 `.btn` 写了，于是输入框与按钮的行高来自两处，`align-items: center` 把两个不同高的盒子各自居中，差就出现在顶边上。

**改法**：一个属性。与 `.commit-input` 同一写法（`font: inherit; font-size: var(--text-sm)`），家族另写在后面。

### 3.3 `cancel_search` 仍没有（E04 三处都记着）

清空字段只是不再发下一次提问；已经开始的那一趟仍走到自己那一窗结束。后端 `SearchState` 的 `Claim` 已经有 `cancelled: Arc<AtomicBool>`，`Ticket::finish` 也只在自己那一份 claim 还占着槽时才清——机制齐了，缺的是一条命令和它在前端的那一个调用者。`tests/ipc-surface.mjs` 的豁免说明里已经写着"Cancelling a lane … carry no repository state at all"，位置是现成的（与 `cancel_write`／`cancel_exttool` 同列）。

**改法**：`SearchState::cancel(session_id, query_id)` + `cancel_search` 命令 + 清空字段与提交新查询时的那一次取消，进 `NOT_SESSION_BOUND`。

### 3.4 旧的 hard reset 仍在图那一侧的详情面板里（F 退出门槛的另一半）

`views/history.ts:299` 的 `Reset hard…` 走 `preview_reset_hard`／`reset_hard`，票据只绑**已跟踪的脏文件集**（`reset.rs::1266` 的 `dirty`）与 target + HEAD。阶段 F §7 量出来的那一整类——目标树要写、而磁盘上是未跟踪文件或未跟踪目录的那些路径——不在这一张票里。新的干净恢复（F03–F06）覆盖它，旧的这一条没有。

这不是"文案没改"那么轻：`reset --hard` 对那一格 rc=0、无警告地写掉未跟踪文件，而旧预览看不见它们。计划 F 退出门槛写着"旧的 hard reset 与 preview_reset_hard／reset_hard 仍是它们自己那一条，没被改名成'干净恢复'"——留着的理由是"没被改名"并不成立，因为问题在绑什么，不在叫什么。

**改法**：旧的这一条要么按 `plan_restore` 的口径重做（复用 F03 已有的那一份计算），要么从界面上撤掉、把"回到目标"这件事留给干净恢复这一条。撤掉更诚实：面板里已经有第二条路，而两条都能从图侧到达时，第一条是一个已知有洞的入口。

### 3.5 不动的东西

- 计划里记着的 `Windows/macOS 仍只是构建配置`、多显示器钳位、键盘逐格注入（这台宿主是 Wayland 且无注入工具）都是**这台宿主没有的通道**，不是质量缺陷。它们继续留在留下它们的那一行。
- `layout-probe.mjs` 在 340×400 + 最大缩放下量出的提交框与重置行不同顶边，属于 §3.2 那一个属性。