# B02 更改区与历史图同屏组件化

任务:B02 — 更改区与当前分支历史在同一页内共同占据高度,分隔、滚动与焦点由样式与一个纯模型决定。
对应产品目标:G01(两个顶级 Tab,Main 同屏显示更改与历史);G05(草稿与选择不因刷新丢失)。
前置:B01 完成于 `298e434`(两 Tab 导航与主面板组合,见 [B01 记录](10-two-tab-panel-b01.md))。

## 1. 采用的结构决定(实施后续阶段不再自行解释)

- 比例语义全部落在 `src/splitModel.ts`(纯函数,无 DOM):`SPLIT_DEFAULT=45`、`SPLIT_MIN=15`、`SPLIT_MAX=85`、`SPLIT_STEP=2`、`SPLIT_PAGE=10`。上下界保证两半各自留下 15% 的空间,因此不需要再为“另一半被压扁”写规则。`clampSplit` 把非有限值折回默认值,`readStoredSplit` 只接受能解析成数字的存储值。
- `views/mainPanel.ts` 只做三件事:把比例写成 `--main-split`(无单位数字,几何仍归样式管)、把分隔条做成可聚焦的 `role="separator"`(↑/↓ ±2,PageUp/PageDown ±10,Home/End 到边界,Enter/Space 回默认)、把测量到的 chrome 高度写成 `--region-chrome`。分隔条在 pointer 抓握时取得焦点,所以一次拖拽之后可以直接用方向键继续微调。
- 存储键 `guit.mainSplit` 在 `localStorage`,读写都包 try/catch(隐私模式下存储不可用,面板照样分隔)。
- 区域的下限 = 列表下限 + `--region-chrome`。样式令牌:`--main-list-floor`(3 个文件行)、`--main-graph-floor`(3 个历史行),两者由 `--row-height`/`--row-height-history` 推导,跟随界面缩放;`responsive-check.py` 的必需令牌清单已加入 `--main-split`/`--main-list-floor`/`--main-graph-floor`。
- `--region-chrome` 是**量出来的**,不是写死的:区域内除列表以外每个可见子元素的高度,加上它们之间的 `row-gap`(隐藏元素既不占高度也不产生 gap)。观测对象是这些子元素本身,而不是只有区域——横幅出现、提交框被拉高、界面缩放改变字号,区域盒子可以完全不变。写入前先比较,一次测量即收敛。
- 两个列表各自用 `ResizeObserver` 观察自己的盒子并重排行(替换原先挂在 `window` 上的 resize 监听),因此拖拽分隔条、缩放界面、改变窗口宽度都会让虚拟列表按新高度重算可视窗口。

## 2. 为什么不是 `min-height: min-content`

先按“区域下限由布局自己加出来”实现过一版 `min-height: min-content`(列表再加 `contain: size` 试图让内容不参与 intrinsic size)。同一份构建在两个引擎上给出两种不同的错法:

| 渲染器 | 观察 |
| --- | --- |
| Chromium(Headless Edge + CDP,900×800) | 区域下限把**整个列表内容**算进去:历史区高 1019px,面板自身滚动 634px,两半不再同屏 |
| WebKitGTK(发布二进制,`b-shot.sh` 900×800) | 区域停在 45% 份额,提交框被裁在 textarea 中间,Amend 与 Commit 不可见 |

即 intrinsic sizing 在跨引擎上不足以表达“除了列表以外我必须显示的东西”。改为量出来的 `--region-chrome` 后,两引擎给出同一结果,且不再依赖 `contain`。

## 3. 验证

| 门禁 | 结果 |
| --- | --- |
| `npm run build`(tsc --noEmit + vite) | 0(JS 105.11 kB / CSS 30.03 kB) |
| `npm run test:fixture` | 130/130(新增 `tests/main-split.mjs` 7 条:上下界互留下限、钳制、NaN 回默认、存储值先钳后用、pointer 位置→比例、未测得高度回默认、键盘步进停在边界) |
| `cargo fmt --check` / `cargo clippy --locked --all-targets` / `cargo test` | 0 / 无 warning / 全过(Rust 侧未改) |
| `color-contrast.py dist/assets` / `responsive-check.py` | fails=0 / fails=0 |
| 桌面运行证据 | 见 §4 |

## 4. 运行观察

几何用一次性 CDP 探针量真实盒子(Headless Edge,`microsoft-edge --headless=new --remote-debugging-port`,加载 `dist` 并桩化 `__TAURI_INTERNALS__.invoke`,快照/历史形状取自 `types.ts` 的 `SnapshotView`/`CommitView`)。窗口 900×800、900×700、900×600、420×640、340×400 × 分隔 15/45/85 共 15 组:

- `panelScroll=0`:15 组里面板自身都不滚动,即两半始终同屏(长历史不再把页面推成滚动)。
- `footerReachable && !footerOverflowsChanges`:提交框完整落在更改区内且未越出可见范围,15/15。
- `!detailOverflowsHistory`:历史详情面板未被推出历史区,15/15。
- 拖到 15% 时文件列表恰好停在 3 行下限(72px),拖到 85% 时历史区停在“图头 + 3 行 + 详情”下限,行仍按新窗口重绘(渲染行数 9–27 之间变化)。

“草稿与选择不随刷新丢失”用同一条探针驱动真实刷新:写入提交草稿、方向键选中 `conflict.txt`(`aria-activedescendant=file-row-1`),再触发 shell 注册的 `tauri://focus` 监听 → `refresh_repository` 返回 version+1 的新快照。结果 `refreshCalls=1`,刷新后草稿文本与选中行(含 `aria-activedescendant`)完全不变。

WebKitGTK 侧用 `tools/live/b-shot.sh` 抓 900×800、420×640、340×400 三张(`/tmp/guit-shots/b02-*.png`):合并横幅、3 行文件列表、完整提交框(含 Amend 与 Commit)、图头与提交图同屏可见。该主机 2× 缩放,因此 900 物理像素下 Tab 标签按 `max-width: 560px` 规则收成图标——与 B02 无关,是既有断点行为。

本轮同时修好 `b-shot.sh` 自身的窗口识别:它原先比较“上一次记下的 window id”,而 X 会复用同一个 id,于是第二次起每次都报 `no guit window`。改为在启动前记下已存在的 guit 窗口集合,只接受不在该集合里的新窗口——遗留窗口仍然不会被误拍。

## 5. 已知缺口

- 主机无 `python3-gi`,AT-SPI 与真实点击驱动仍不可用:拖拽分隔条、键盘调整比例只有 Chromium 桩化环境下的证据,WebKitGTK 上是静态截图(打开仓库后的初始状态),**没有**在真实引擎上完成一次拖拽旅程。
- `tools/bench/layout-probe.mjs` 仍引用 `.rail-item` 与 `--rail-*`,其结果不得作为本阶段证据引用;把上面这套几何与刷新断言搬进它是 B06 的活。
- 本轮新增的三个 `ResizeObserver`(两个列表 + 一个 chrome)与 `mainPanel` 的 pointer/keyboard 监听都没有 `disconnect`。面板与应用同生命周期,所以不会累积;真正的“一轮 snapshot 不再读取全部高级列表 / Tab 往返不增加 timer 与 listener”属 B03。
- `--region-chrome` 依赖盒子变化。若某个部件只改文字而不改尺寸(例如横幅文案变长但仍是一行),下限要等到下一次区域或部件 resize 才更新。

## 6. 回退

`git revert` 本阶段提交即回到 B01 的固定 45/55 无分隔布局;`splitModel.ts`、`main-split.mjs` 与三个新令牌随同一提交消失,`style.css` 回到 `flex: 1 1 0` 两区,不留悬空引用。

## 结论

完成(真实文件列表与真实提交图同屏;两半各自的下限可量、可拖、可键盘微调;窗口过矮时页面滚动而不是遮住提交按钮;草稿与选择在刷新后保留)。

## 7. 高度拖动修正（2026-10-02）

本次调整只涉及上下两块的高度，沿用 15–85 的比例范围、45 的默认值、区域内容下限和 `guit.mainSplit` 存储键。

- 原来的 pointer 比例取整个 Main 的 `scrollHeight`，其中包括不参与分配的搜索栏与分隔条。现在取两块区域的实际高度之和，以更改区的 viewport 顶边为原点；pointerdown 记录抓取点距分隔条顶边的偏移，pointermove 使用同一坐标系。滚动页面与从命中区边缘抓取均不改变计算口径。
- 键盘微调以当前布局给出的高度比例为起点，避免 CSS 已将某区域钳到内容下限、键盘却继续从下限外的旧比例开始。Home/End 与 Enter/Space 继续使用原来的边界与默认值。
- 双击分隔条恢复默认比例。拖动只接受主指针的主按钮，pointercancel、lostpointercapture 与释放生命周期都收尾；抓取焦点不要求页面滚动，拖动时保持调整光标并禁止选择页面文字。
- 新增模型回归覆盖搜索栏排除、抓取偏移、滚动坐标和从内容下限继续拖动。这些断言验证数值计算，不替代渲染器里的指针旅程。本轮浏览器启动的自动审批未能完成，因此尚无本轮真实拖动的渲染证据。

本轮检查：`npm run build` 通过；`npm run test:fixture` **422 passed / 0 failed**（其中分隔模型 11 条）；构建后的 `color-contrast.py` 与 `responsive-check.py` 均 `fails=0`；`git diff --check` 通过。Rust 未修改，本轮未重跑 Rust 检查。上述数字不包括浏览器或原生窗口拖动验证。
