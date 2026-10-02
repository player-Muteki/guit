# 表面与深度：把"质感"变成可测量的，再改它

这一篇记两件事。头一件是一次原本记不下来的实测（原生窗口旅程），它推翻了本目录里两处"这台机器跑不了"的旧记录；后一件是界面的第一刀：先把浮层的深度量出来，再给它。

## 0. 这台机器现在有桌面会话

`plan/21-titlebar.md` 与 `plan/README.md` 的交付表里都写着"这台无头 Wayland 主机跑不了原生窗口验收"。实测不成立：

- `DISPLAY=:0`，`WAYLAND_DISPLAY=wayland-0`，`Gtk.init_check()` → `True`；
- `import gi; gi.require_version("Atspi", "2.0")` 成功，a11y 总线可达。

当时的失败与当时另一批被挡的审批服务故障同源——沙箱够不到 display socket，而不是这台机器没有显示器。`webkit-engine-probe.py:244` 先查 `DISPLAY`/`WAYLAND_DISPLAY`，所以三支引擎探针一直都能跑；把它们记成"需要桌面会话而这台机器没有"是错的。

## 1. 原生窗口旅程：能驱动什么，不能驱动什么

用 release 二进制（`npm run bin:release` 的产物，不是 `cargo build --release`）、隔离的 `HOME`、一次性夹具仓库，全程 stderr 为空。

### 1.1 用 AT-SPI Action 接口能驱动的，五项全部通过

| 动作 | 观测到的 |
| --- | --- |
| 仓库自动恢复 | 面板从 `session.json` 自己打开仓库，画出搜索框、更改区、提交框、干净重置行、图与分支选择器 |
| 置顶 | toggle `PRESSED: true → false`，按钮翻转 |
| 最大化 / 还原 | `(664,338,720,624) → (0,21,2048,1259) → (664,338,720,624)`，按钮名 `Maximise window ↔ Restore window` 同步翻转 |
| 关闭 | 走 app bar 自己的关闭钮，退出码 0，stderr 空 |
| 重启恢复 | `alwaysOnTop` 恢复正确（存 `false` → 按钮 `false`）；`maximized` 恢复正确（存 `maximized` → 开窗即最大化） |

### 1.2 合成输入这条通道是坏的，而且它会撒谎

`Atspi.generate_mouse_event` 与 `generate_keyboard_event` 在这台机器上**都存在、都返回 `True`、都不起作用**：

- Wayland 后端：点置顶按钮 → 状态没变；拖动 → 窗口没动；
- 强制 `GDK_BACKEND=x11` 重试：同样不动（XTEST 只到 X11 客户端，这个应用是 Wayland 的；换 X11 重试也不通）；
- 在搜索框里打 5 个键：搜索结果层没有出现。

这比 `plan/20-phase-h.md` 与 `plan/README.md` W05 行记的"AT-SPI 只能夺焦点而不能按键"更锋利。那两处写的是做不到；实测是**返回成功而实际无效**。任何相信返回值的人都会以为自己驱动了窗口。

因此四项无法验证，因为这条通道根本到不了：窗口拖动、八向缩放、双击最大化、Alt+Space / 右键原生菜单。

`plan/20` 另一条仍然成立并被复现：WebKitGTK 的 `<input>` 不暴露 `EditableText`（实测为 `None`，`Text.get_character_count()` 也是 0）。

### 1.3 一个未定性的观察

几何往返：`x` 与 `width` 精确恢复，但 `y` 与 `height` 各差 32 逻辑像素（= 64 物理像素），无论把 `frameHeight` 写成 64 还是 0 都一样。

这不能被记成缺陷：AT-SPI 的 extents 报的是外框，而 `window.json` 存的是 `window.innerHeight × scale`。若两边分别是外框与内框的读数差异，那就什么都不是。要分辨需要一个第三方事实——应用自己报告的 scale factor，而 Settings 里那行几何文字是普通文本节点，AT-SPI 树的命名节点里没有它。记作"观察到的不对称，未定性"。而且这是在树移动之前构建的二进制上测的，现在的 `main.rs` 已不是被测的那一份。

## 2. 第 0 刀：把"质感"变成可测量的

三件交付物都跑过并留下数字（`tools/bench/surface-probe.ts`、新夹具 `app/tests/spacing-scale.mjs`、`responsive-check.py` 新增第 8 条）。

### 2.1 地表阶梯——两个方案各自相邻地面的通道差

| 相邻对 | light | dark |
| --- | --- | --- |
| sunken → app | 13 | 8 |
| app → panel | 12 | 9 |
| panel → raised | **4** | 12 |
| raised → input | 4 | 12 |

**这组数推翻了我上一轮读 CSS 得出的判断。** 我当时说"浮层与面板只差 4/255 且无投影，这就是阶梯存在但看不见的证据"。实测五个浮层画在 `.view-body` 之上，而 `.view-body` 画的是 `--surface-app`——所以浮层与**它下面真正那个东西**的差是 light 16、dark 20（toast 因为是 `--danger-soft` 洗色，是 11 与 35）。那个 4/255 是 panel→raised，而没有任何浮层画在 panel 上。结论（要投影）成立，理由（4/255）不成立。

### 2.2 反馈——九个交互元素里七个没有过渡

只有 `.btn` 与 `.icon-btn` 有（0.12s，`background`/`border-color` 与 `background`/`color`）。文件行、提交行、分组标题、菜单项、搜索行、quiet 按钮、输入框全是 `0s`。

### 2.3 会变的数字

| 元素 | "9" | "10" | "100" | 跨度 | font-variant-numeric |
| --- | --- | --- | --- | --- | --- |
| `.tab-badge` | 18.31 | 18.31 | 18.31 | **0** | "" |
| `.history-count` | 7.22 | 14.44 | 21.66 | 14.44 | "" |
| `.activity-line` | 6.11 | 12.22 | 18.33 | 12.22 | "" |
| `.detail-meta` | 105.59 | 105.59 | 105.59 | 0 | "" |

`tab-badge` 是唯一做对的，而且是结构性做对（固定 `3ch`），不靠 `tabular-nums`。`.detail-meta` 我上一轮列为"需要补"是错的——它是块级，宽度不由内容驱动，从来不跳。

### 2.4 一个诚实的能力声明（探针自己的 `fails=1`）

`the measurement can tell two faces apart at all`：serif 对照与两个字体面只差 0.03px。这台宿主的 WebKitGTK 对三种字体给出了几乎相同的 "0" 宽度，所以 ch 的比值（1.0）不是关于面板的测量结果。这是这支探针设计上的正确行为——它说的是"我测不了这个"，而不是"它们相等"。

### 2.5 探针自己的两个 bug（读代码时抓到的）

- `ground` 在设置 `data-theme` 之前读了一次，深色方案的所有 wash 都被压到浅色地面上——报出 209 的间距，真实值是 20。
- 通过 CSSOM 赋值的行内 `var(--font-mono)` 在这个引擎上不替换，两个 ch 探针都继承了 body 字体；对照检查用 0.01px 阈值，在 0.03px 的实际差异上通过了——把"这个宿主机对字体不敏感"当成"面板的两个字体面一样宽"报了出来。阈值提到 0.5px 后它正确地失败了。

### 2.6 夹具自己抓到的第三个

`\w` 不含连字符，所以 `margin-inline-start` 以及所有连字符长写属性全部从门禁的视野里溜过去。第三个测试（专门守这个正则的）在第一次运行就抓到了它。

## 3. 第 1 刀：深度与材质

### 3.1 深度阶梯（三档）

- `--shadow-1`：菜单、搜索结果层、提交气泡
- `--shadow-2`：toast
- `--shadow-3`：对话框

每一档两层：紧的接触影 + 宽的投影。浅色方案的影色是深茄紫（与深色地表同一支）而不是黑——黑影落在暖奶油上读作脏。深色方案的理由相反：近黑的地面没什么可再暗的，于是拿暖换力度与铺展。

### 3.2 档位的判据

不是"看起来多重要"，是**打断了多少页面、在页面上停留多久**：菜单与结果层答完一次点击就走，取接触影；toast 比举起它的动作活得久，取铺展；对话框把窗口扣住到被回答，且它背后已经有 backdrop 说这件事了，它的投影任务是给那张卡片一面可投的墙。列表行、面板、页面本体不投影——它们在平面里，给已经在地面上的表面加影等于画了第二个地面。

### 3.3 探针先变红，再改样式

`shadowOf` 原来读"computed `boxShadow` 字符串非空"，而 `"none"` 是个非空字符串——所以它对着一个完全没有投影的产品报绿。改成数"带非零 alpha 的实画阴影层数"后，两个方案五个浮层全红（10 条）。这条是这一刀唯一一个"先改探针、再改样式"的实例，照做。

另加一条"每层要投到它那一档承诺的深度"（每档一个 blur 地板 6/18/48 px），避免"声明了 `0 1px 1px`"也算深度。并用抬高其中一档地板验证这条断言不是空转（抬到 999 时对话框如期转红）。

### 3.4 一处被自己的门禁抓到的错

改 tokens 时顺手把 `--radius-sm` 换成了 `--radius-lg`。`responsive-check.py` 第 8 条（`var()` 引用的自定义属性必须被声明）立刻报红 `undeclared --radius-sm`。这正是那条门禁存在的理由。

## 4. 第 1 刀的验证

| 检查 | 结果 |
| --- | --- |
| `npm run build` | ✓ 56 modules，CSS 37.25 kB / JS 141.31 kB |
| `npm run test:fixture` | 437 项，436 通过，0 失败，1 跳过（跳过的就是新夹具） |
| `responsive-check.py` | fails=0（第 8 条通过） |
| `color-contrast.py dist/assets` | fails=0 |
| `surface-probe.ts`（真实 WebKitGTK） | 20 条 casts/depth 全 ok，fails=1（就是 §2.4 那条能力声明） |
| `appearance-engine-probe.ts` | fails=0 |
| `search-layer-engine-probe.ts` | fails=0 |
| `layout-probe.mjs`（headless Edge 154.0.4258.48） | 637 条 ok / fails=0——与基线一字不差（投影不动任何盒子） |
| `cargo test / fmt / clippy` | 本刀一行 Rust 未动，没跑 |

投影不动任何盒子这一条由 layout-probe 的 637 条守住——那正是把投影加进浮层而不动列表行、面板、页面本体的原因。

## 5. 未闭合

- 原生窗口的拖动、八向缩放、双击最大化、Alt+Space / 右键原生菜单仍无证据，因为合成输入这条通道在本机返回成功而实际无效（§1.2）。
- §1.3 的几何不对称未定性，缺一个应用自报的 scale factor 作第三方事实。
- ch 的字体面之差在本机测不出来（§2.4）；这一支探针在此宿主上永远带着那一条 `fails=1`。
- 第 2 刀（节奏）、第 3 刀（反馈与排版）、第 4 刀（空状态）尚未开始。第 3 刀要动 §2.2 的七处零过渡，第 4 刀要动三个空状态，文案一字不改（那是契约）。