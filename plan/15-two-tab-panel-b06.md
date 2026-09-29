# B06 布局与无障碍探针更新

任务：B06 — 更新布局和无障碍探针；迁移 Ctrl/Cmd+1/2、焦点返回目标。
验收口径（路线图）：“340×400/420×640 下主要操作可达；原先 focusRail 的调用有有效新目标”。
前置：B05 完成于 `a7227ae`（会话身份与请求代次，见 [B05 记录](14-session-identity-b05.md)）。B01–B05 每条记录都把桌面探针列为缺口：`layout-probe.mjs`、`view-smoke.py`、`narrow-smoke.py`、`layout-check.py`、`live-screens.py`、`bench_run.py` 仍指向七视图导轨与旧键，本阶段一次补齐。

## 1. 本阶段唯一的 shipped 代码改动

探针改版不是纯工具工作：它当场量出一个真实缺陷，并为此改了产品样式。

- **事实**：待处理计数徽标绝对定位在 tab 右上角（`top:-0.15rem; right:-0.15rem`）。计数从 1 到 99+ 变宽时，先在 3 位数处压住标签词的最后几个字母，再到 99+ 处整块糊在词上。静态门禁看不见：`responsive-check.py` 读 CSS 规则，AT-SPI 看不见 z 序，只有真渲染器做矩形相交才报得出来。
- **决定**：给 `.tab-item` 预留一条右侧 gutter（`padding-inline: 0.45rem 1.6rem`），宽度按“徽标能显示的最大值”定，而不是按当前值。词消失的窄窗口（`@media (max-width: 560px)` 隐藏 `.tab-label`）里 gutter 随词一起撤掉，`min-width` 归零——上标本来就该贴在字形角上。
- **被否掉的替代**（记录理由，避免以后重走）：
  - 把徽标改成流内 pill：340px 下要占走应用栏的横向空间，代价落在窗口最紧的那一端。
  - 用 `:has()` 只在有徽标时加 gutter：引入一个本仓库没用过的新选择器，且徽标出现的一瞬整条 tab 会变宽。
  - 在 `shell.ts` 里按页面加/去一个类：用 JS 表达一条 CSS 事实。

JS 产物字节数没有变化（81.63 kB，与 B05 记录一致），CSS 从 29.52 增至 29.55 kB——多出来的就是那条 media 覆盖规则。

## 2. 测量口径的三条修正（比新增断言更重要）

这三条决定探针今后还能不能相信，故写在结构之前。

1. **重叠/溢出用“裁剪后的可见矩形”，可读性用“自身 layout box”。** 虚拟列表的每个视口都有 clip，取 clip 后的相交矩形才是用户真看到的画面；但“一个 SHOWING、带文字、却小到画不出来的节点”必须用节点自己的框量——一个被祖先裁掉的行仍然有它自己的高度，把 clip 后的 0 高当成“压扁”会把真的压扁和单纯的不可见混成一件事。于是拆成两条断言：`no text overlaps another` / `nothing overflows the viewport` 走 painted rects，`no present-but-undrawable text` 走 raw box，下限取 `rawH < fontSize`、`rawW < fontSize * 0.45`（按根字号算，不写死像素）。
2. **覆盖层建模为覆盖，而不是推开。** 分支选择器是 `.overlay`（`background: var(--surface-app)`、`position:absolute; inset:0; z-index:30`）。选择器出现时不得改变 Main 的布局，因此探针断言 `the layer covers the panel opaquely rather than pushing it`：底色不透明、面板仍在原位。以前把它当成一个普通屏来量重叠，会把被它盖住的行报成冲突。
3. **桩必须按后端发布快照的方式应答。** 一开始桩把同一个对象交出去，前端存下的就是那个对象：改动它等于把已存快照的 `version` 一起抬高，`state.ts::applySnapshot` 按“不新于当前就丢弃”的规则把这次刷新正确地拒了——探针于是永远停在第一屏，且**绿着**。现在每次会话类应答都发一份新鲜副本（`Object.assign({}, __SNAPSHOT__, { version: ++issued })`），与 B05 的 `publish` 语义一致。这条修的是夹具保真度，不是新增覆盖。

另有一条属于可重复性：分栏键盘断言必须**从 Home 键起算**再按 ArrowDown。`localStorage["guit.mainSplit"]` 按 origin 存储，九个尺寸共用一个 profile，读“按之前的值”会把上一个尺寸留下的份额当成基线（症状：`17 -> 17`）。

## 3. 探针族的迁移

### `tools/bench/layout-probe.mjs`（主力）

启动真 bundle + 桩 IPC，对**每个尺寸 × 每屏**跑同一组断言。默认尺寸把验收口径的两个排在最前：`340x400,420x640,480x600,600x480,720x560,1100x700,1400x420,1600x900,2560x1440`。

- 屏从七个视图变成四态：`Main`、`Picker`（覆盖层）、`Settings`、`Welcome`（Main 的空状态）。每屏 7 项：内容确有布局、三重绘制缺陷、横向文档滚动、`every action it offers is reachable`、`one page is the page on screen`。`exactly two pages hang off the strip` 单独钉住顶级导航数量。
- 只有渲染器能给的四项：`the changes area and the graph are on screen together`（两块各自有盒子）、`the divider is a grabbable bar`（`--splitter-size`）、`the divider takes focus` + `the arrow keys move the split from the keyboard`（现报 `15 -> 17`）、`reach`（每个主操作可聚焦且名字进无障碍树，含窄窗口里**丢了可见标签**的 tab）。
- 新增计数上限两项：`__PENDING__(120)` 把待处理数推到 120，先证明 UI 真把它显示成 `99+`，再证明最宽的那个值 `overWord:false, overOtherTab:false`。对端比较对象是 Settings 那一条里**可见子元素**矩形的并集——“徽标该挂的角本就是 padding，而 padding 什么都不遮挡”。随后 `__PENDING__(null)` 复原。
- 分栏地板：`neither region is dragged under its own floor`、`a panel too short for both floors scrolls rather than clips`。
- 应用栏紧凑化：`a roomy window keeps the full app bar` / `a short window compacts the app bar` / `a very short window compacts the app bar twice`。
- 焦点迁移的两条：`Ctrl/Cmd+1 and +2 answer from either page`、`Escape closes the layer and leaves focus on the strip`。后者是 `focusRail` 新目标的**运行时**证据。
- 令牌到达性：`the metrics reach the rendered document`（顶层 `:root` 规则数、`--appbar-height`）、`the colour scheme reaches the rendered document`。
- 无障碍可达性用 `Accessibility.getFullAXTree` 判定——“名字进了无障碍树”的**可运行替身**，且 CDP 报错一律算失败，不静默跳过。
- 路径解析修正：`dist` 参数缺省时按脚本自身位置找到 `app/dist`（旧默认指向不存在的 `tools/dist`，注释里的示例路径也在仓库外）。`read-budget.mjs` 同改。

### AT-SPI 族（`view-smoke.py`、`narrow-smoke.py`、`layout-check.py`、`bench_run.py`、`theme-check.py`）

分工写进各自 docstring：**AT-SPI 断言在场、可达、焦点，永不断言缺席**——它没有 z 序，覆盖层下面的行全都读得出名字，拿它测遮挡必然假绿。遮挡属于 `layout-probe.mjs`，肉眼可见的覆盖属于 `live-screens.py`。

- `view-smoke.py`：`PAGES = [Main, Settings]`，`MAIN_REGIONS`（`Commit message` / `Commit history`）改为在**一次** `A.dump()` 里同时断言，即同屏；新增选择器层的开合；焦点替身改为 `focused_name(...) == "Main"`。
- `narrow-smoke.py`：`TABS = {Main, Settings}`；`APPBAR` 去掉已退出的 Sync、补上 `Close session` 与 `More repository actions`；340×400 下新增 `the commit history shares the page at 340x400`。Commit 按钮仍按“工具要在，不必两份”的规则在页脚处检查。
- `layout-check.py`：页面清单与文案改为双 Tab 口径（“never reached the Changes view” → “never reached the panel”），并在 docstring 里写明选择器层**故意**不在这里量，指向 `layout-probe.mjs`。
- `bench_run.py`：L1 定义为“两个 tab 名都在树里”（窗口有导航、点击能落点）；L2 保持 `Monitor: ` + 更改区自身内容，注释说明**提交图不在任一 landmark 里**（它是另一次读，可能更晚落地），`--history-pages` 因此不再点击已不存在的 History tab，改为等 `\d+ commit\(s\)|No commits yet` 后直接翻 `Load older`。L2 数值与历史基线表不可比，这一点写进注释而不是留给读者猜。
- `theme-check.py`：运行时断言本来就对新 shell 正确（等 `Commit message`、点 `Settings`），只去掉描述里的阶段标签。

### `tools/live/live-screens.py`

镜头序列按新 shell 重排：`01-main` … `04-branch-picker`（从分支 chip 打开，经由 Settings 再回 Main 离开）… `09-dark-theme`。新增 `graph_rows()`——`ATSPI_ROLE_LIST_ITEM` 且名字含 `" — "`——用于确认图真的有行被画出来。这里是覆盖层“看得见”的那份证据。

### `focusRail` 的调用点

`app/src/main.ts:62` 把预览控制器的返回目标接成 `shell.focusTabs()`（`app/src/shell.ts:404`，焦点落在当前页的 tab 项上）。B06 做的是**证明这个新目标有效**：`layout-probe.mjs` 用 Escape/键位断言它，`view-smoke.py` 用 AT-SPI 焦点断言它。

## 4. 验证

| 门禁 | 结果 |
| --- | --- |
| `npm run build`（tsc --noEmit + vite） | 0（JS 81.63 kB / CSS 29.55 kB，B05 为 81.63 / 29.52） |
| `npm run test:fixture` | 144/144（与 B05 持平：本阶段没有新增 node 单元测试，证据全在探针侧） |
| `cargo fmt --check` / `cargo clippy --locked --all-targets` / `cargo test` | 0 / 无 warning / 267 通过 |
| `color-contrast.py dist/assets` | fails=0 |
| `responsive-check.py src/style.css src/style/tokens.css` | fails=0（新增 media 覆盖未破坏两轴与令牌规则） |
| `tools/bench/layout-probe.mjs` | fails=0，435 项断言（9 尺寸 × 4 屏 × 7 项 = 252，其余为同屏/分栏/键位/计数/空状态/应用栏/令牌项） |
| `tools/bench/read-budget.mjs` | fails=0（21 项，与 B05 持平） |
| Python 探针 | `python3 -m py_compile` 六个文件全过；**本机无 `python3-gi`/AT-SPI，无法运行** |

Rust 的 267 比 B05 记录的 256 多 11 个：增量来自并行开发者已落地的 `1367f7e`（活动通道）。本阶段**未改动任何 Rust 文件**，那三项只是环境核对：记录运行的同时，对方正在编辑 `repo.rs`/`model.rs`/`session.rs`/`status.rs`/`write.rs` 并新增未跟踪的 `activity.rs`，所以这些结果不应读作对其工作树状态的结论。

## 5. 与并行开发的对齐

- 本阶段期间对方先落地 `1367f7e`（watcher/活动通道）与 `06e578f`（`plan/09-activity-contract.md` 的形态差异记录），随后正在编辑 `app/src-tauri/src/repo.rs`（`status_output` 返回 `StatusRead { stdout, warned }`，把 exit 0 + stderr 的降级读显式化），并新增 `activity.rs`。**那是 C 的工作**：我没有 stage 它，也没把它的改动算进本记录——本阶段没有 Rust 侧文件进入提交。
- 交界面只有一个，且是口径冲突的高危处：C 要把“降级监控状态”显示出来。`bench_run.py` 的 L2 现在**以 `Monitor: ` 为锚点**；若 C 改了这个前缀或让它在降级时消失，L2 的定义要同时改，否则基线数字会悄悄变成另一件事。`view-smoke.py`/`narrow-smoke.py` 的名字集合（`APPBAR`、`TABS`）同理是新增可见操作的登记处。
- D（历史身份与完整图表）会动 `--main-graph-floor` 与图侧地板断言；`layout-probe.mjs` 的地板项按令牌取值，不写死像素，D 只需改令牌即可。
- `plan/03-roadmap.md`、`plan/08-gate-baseline-a02.md`、`plan/09-activity-contract.md` 本阶段未触碰。

## 6. 已知缺口

- **AT-SPI 族在本机只是语法编译**，没有跑过。它们断言的是“在场/可达/焦点”，其结论要等一次有 `python3-gi` 的真桌面运行；本阶段的可运行替身是 CDP 无障碍树。
- 真实 WebKitGTK 上的布局与读取预算没有重量：两个 CDP 探针都跑在 Edge headless 154 上。CSS 的渲染差异（尤其 `<select>` 的主题绘制，见 `live-screens.py` 的注释）只有真引擎能证。
- `99+` 那条只在探针桩里成立：真仓库要 120 个待处理文件才会走到。没有做真仓库存压测量。
- `bench_run.py` 的 L2 与既有历史基线表**不可比**（测量对象变了），需要一次重新采集才能填进新的基线表；A02 的表格没有因此更新。
- `live-screens.py` 需要 X display 与旁边的 `xgrab` 二进制；本阶段没有产出新的截图。
- Windows/macOS 仍只有构建配置，不得宣称覆盖。

## 7. 回退

三段可独立回退，代价不同：

- **样式**（`.tab-item` 的 gutter + 窄窗口覆盖）单独 revert 会让已知的“计数压住标签词”复现，`layout-probe.mjs` 的两项计数断言随即变红——这条是产品可见改动，也是唯一需要 revert 才有用户影响的改动。
- **探针**（六个 `.mjs`/`.py` 文件）单独 revert 不影响产品，只是重新失去对当前 shell 的覆盖：旧 `layout-probe.mjs` 仍按七视图找 `Changes` 屏，会在每个尺寸上直接报“never reached the Changes view”。因此**不要**只回退探针而留着新的 shell。
- 没有数据迁移、没有对用户仓库的额外写操作，桩与 localStorage 都是探针自己的临时状态。

## 结论

路线图给 B06 的两句话各自被断言了：**340×400 与 420×640 下主要操作可达**，由 `layout-probe.mjs` 在九个尺寸上逐屏的 `every action it offers is reachable`（含丢掉可见标签的 tab 仍把名字交给无障碍树）、`narrow-smoke.py` 的 tab/应用栏/分支 chip/提交框/图同屏清单，以及 `view-smoke.py` 的两页开合共同覆盖；**原先 focusRail 的调用有有效新目标**，`shell.focusTabs()` 同时有 CDP 的 `Escape closes the layer and leaves focus on the strip` 与 AT-SPI 的焦点断言（后者本机未运行，见缺口）。过程中探针量出一个真实缺陷并当场修掉，也量出一个夹具自身的失真——桩必须像后端那样发布带递增版本的新鲜快照，否则它测的是自己缓存的第一屏。
