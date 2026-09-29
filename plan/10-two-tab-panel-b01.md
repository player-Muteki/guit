# B01 双 Tab 导航收敛

任务:B01 — 顶级导航收敛为 main/settings 两个 Tab,欢迎内容成为主面板空状态。
对应产品目标:G01(两个顶级 Tab);G09(静态提示不再每次重算)。
基线:阶段 A 完成于 `2ca0403`(门禁全绿,见 [A02 记录](08-gate-baseline-a02.md))。

## 1. 采用的结构决定(实施后续阶段不再自行解释)

- `state.ts::ViewId = "main" | "settings"`,`VIEW_ORDER` 同序;默认视图 `main`。快捷键 `Ctrl/Cmd+1/2`,旧 `+3…+7` 移除,Settings 的快捷键表同步改写( shipped copy 扫描范围内)。
- Tab 条在应用顶栏右端(`nav.tabs` + 两个 `button.tab-item`,`aria-current="page"`),不再有左侧活动栏。样式令牌随之改名:`--rail-width`/`--rail-item-size` → `--tab-min-width`/`--tab-item-size`,`tools/bench/responsive-check.py` 的必需令牌清单与禁用选择器同步改名(等强度,不减少条目)。
- 两个 Tab 都从冷启动可达:Main 无仓库时显示欢迎空状态(pseudo-view,无 Tab),Settings 始终可用。因此 `railHint(id, order)` 去掉 session 参数——"先打开仓库"的灰条说明已无对象。
- 主面板 = `views/mainPanel.ts` 组合 `changes.element` + `history.element`(`section.main-panel`,两个 `flex:1 1 0` 区域)。B01 只保证同屏可见;分隔条、独立滚动细节属 B02。
- 分支选择改为 Main 内的临时浮层:`shell.registerOverlay/openOverlay/closeOverlay`,顶栏分支按钮打开它,Escape 按"应用栏菜单→浮层"顺序退出,切走 Tab 时 `render()` 关闭它。它是浮层而非模态:Tab 条与状态栏仍可到达。
- `focusRail()` → `focusTabs()`(确认对话框的焦点返回目标);`focusCommit()` 改查 `views.get("main")` 下的 `#commit-message`。
- Stash / Worktrees&Submodules / Remotes 模块保留但**不再注册为视图**,其 `descriptor` 改为只暴露 `element`;`sync()` 仍按快照触发(B03 收敛),命令注册仍在(B04 处理)。因此 `app/tests/ipc-surface.mjs` 的"每个注册命令都要在前端出现字面量"这一条本轮仍然通过——退出顺序按 A04:先退 UI 入口,再撤注册,最后清实现。

## 2. 验证

| 门禁 | 结果 |
| --- | --- |
| `npm run build`(tsc --noEmit + vite) | 0(JS 102.95 kB / CSS 29.40 kB) |
| `npm run test:fixture` | 123/123(`rail-model.mjs` 与 `state-stress.mjs` 按新模型改写,未放宽) |
| `cargo fmt --check` / `cargo clippy --locked --all-targets` / `cargo test` | 0 / 无 warning / 353 + 5 全过(Rust 侧未改) |
| `color-contrast.py dist/assets` / `responsive-check.py` | fails=0 / fails=0 |
| 桌面运行证据 | 见 §3 |

## 3. 运行观察与已知缺口

本轮用 `tools/live/b-shot.sh`(新增:隔离 HOME + session.json 启动 release 二进制,`xwininfo`+`xgrab`+`ffmpeg` 抓窗口)取得两态静态截图:

- 有仓库(`/tmp/guit-ui-repo`):顶栏右端 `Main`(选中,徽标 6)| `Settings`,更改区在上、当前分支图在下,同屏可见;左侧活动栏已消失。
- 无仓库:主面板显示欢迎空状态(打开仓库入口 + 仍存留的克隆块,后者按 A04 清单在 B04 退出),两个 Tab 均在,Settings 可达。

截图同时暴露一个此前无窗口级证据因而未被发现的缺陷:`style.css` 的图标规则选择器是 `.icon .icon`,而 `icon()` 只产出一个 `svg.icon`,规则从未命中,`fill` 回落为黑色 → 所有手绘图标被画成实心黑块。本阶段一并改为 `svg.icon` 并在截图中确认恢复描边。

主机无 `python3-gi`,AT-SPI 地标与点击驱动路径仍不可用,因此 Tab 切换、浮层开关、确认对话框焦点返回**只有静态与单元层证据,点击旅程未测**。B06 需要迁移 `tools/bench/layout-probe.mjs`(仍引用 `.rail-item` 与 `--rail-*`)与 `view-smoke.py`/`narrow-smoke.py` 的定位器。**在 B06 之前这些探针是过期的,其结果不得引用为本阶段证据。**

## 4. 回退

`git revert` 本阶段提交即回到七视图活动栏;CSS 令牌改名随同一提交回退,不留悬空引用。

## 结论

完成(任意状态只有两个顶级 Tab;Settings 无仓库可用;欢迎为主面板空状态)。
