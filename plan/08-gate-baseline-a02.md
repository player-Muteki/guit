# A02 门禁运行与运行基线记录

任务:A02 — 在隔离配置目录和临时仓库运行当前 build/fixture/Rust gates;只读采集主窗口、提交/历史路径、idle CPU/RSS。
对应产品目标:G09(实时低占用)、G10(诚实验证声明)。
基线提交:门禁在 `8a7c0c2` 首跑,在夹具提交 `c5e3bc5`/`d220078` 后复跑(下表为复跑值,即本记录提交前的 HEAD)。

## 1. 命令与退出码(隔离条件)

| 命令(自 `app/`) | 退出码 | 结果 |
| --- | --- | --- |
| `npm run build`(tsc --noEmit + vite) | 0 | dist 产出 JS 103.28 kB / CSS 29.11 kB |
| `npm run test:fixture` | 0 | 123/123 通过(含 14 个 A03 语义夹具与 shipped-copy 门禁) |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 0 | 353 单元 + 5 集成(含 unix askpass e2e)全过 |
| `cargo fmt --check` | 0 | 干净 |
| `cargo clippy --locked --all-targets` | 0 | 无 warning(与基线一致,未放宽检查) |
| `python3 ../tools/bench/color-contrast.py dist/assets` | 0 | fails=0 |
| `python3 ../tools/bench/responsive-check.py src/style.css src/style/tokens.css` | 0 | fails=0 |
| `npm run bin:release` | 0 | 独立二进制 `target/release/guit`(8392904 字节,custom-protocol) |

已知失败:本轮未出现;历史失败清单无新增回归(基线即绿灯,任何后续红灯都是新增)。

## 2. idle CPU/RSS 运行基线

测量条件:release 二进制,`tools/bench/idle-baseline.py`(本次新增,纯 stdlib)以隔离 HOME(`.config/dev.guit.desktop/session.json` 指向夹具)启动;夹具 `make-repo.sh /tmp/... 1000 0 100`(1000 跟踪、100 脏、约 1.2 KB/文件)——"常规夹具"缺少 10k commits 维度,记录为偏差;300s 稳定窗口,1Hz 进程树采样(/proc,口径含 WebView 子进程,= RSS 求和,PSS 未采集)。

| 指标 | 实测 | 暂定预算(04-validation §4) | 判定 |
| --- | --- | --- | --- |
| 进程树平均 CPU | 0.19% 单核当量(32 核整机 0.006%) | < 1% 单核 | 达标 |
| idle 期间 `git` 子进程 | 采样窗口内未捕获(1Hz 有漏采可能;perf 日志 300s 仅约 2 轮 refresh 事件计数,与"无周期重查"一致) | 无周期 Git 重查 | 方向一致,口径偏弱(见限制) |
| 进程树 RSS 终值 | 437.4 MiB(guit 189.8 + WebKitWebProcess 196.3 + WebKitNetworkProcess 51.3) | ≤ 150 MiB | **超预算 2.9 倍**(WebView 子进程占 57%) |
| RSS 峰值/终值漂移 | 峰值 444.6 MiB,5 分钟无持续增长 | 长时无线性增长 | 达标(30 分钟口径未测) |

处置:RSS 预算缺口按 04-validation §4 的修订路径处理——记录基线、在 C/H 依据测量修订预算或给出削减方案(WebViewNetworkProcess 是否可抑制属平台配置研究);不得在未测量前改写 README 承诺。

## 3. 主窗口/提交历史路径证据与缺口

- 应用实际启动并进入稳态:perf 日志含 `startup.restore_*`、`git.status`、`history.graph/parse`、`refs.parse`、`git.stash/worktree/remote/config` 等阶段行;进程全程存活,收尾 terminate 正常。
- 本主机无 `python3-gi`,AT-SPI 地标探测(bench_run.py 路径)与 `tools/live` 截图未执行:**无窗口内容级证据,主窗口呈现按"未测"记录**,不引用历史点击证据冒充本轮结果。桌面完整旅程属 H05。
- "提交/历史路径"本轮为静态+阶段日志级采集;提交草稿保留、历史分页行为未做桌面交互验证(未测)。

## 4. 运行环境与命令版本

见 [A01 基线记录](05-baseline-a01.md):同一主机、同一 shell(Node v22.22.2 下全部 Node 门禁实测通过,预算文档记载的 Node 26 为历史证据口径)。

## 5. 不确定性与限制

- 1Hz /proc 采样会漏掉毫秒级 `git` 子进程;"未捕获"不等于"零次调用",结论依赖 perf 阶段日志交叉印证。
- 常规夹具未按 04-validation 完整规格(10k commits)构建;A03 的对象库管线可在后续低成本补齐深拓扑测量夹具。
- `idle-baseline.py` 的 CPU 口径为树内 utime+stime 差值,含僵尸进程贡献(实测本轮为 0)。

## 6. 回退方式

删除本记录与 `tools/bench/idle-baseline.py`;基线测量不可回退为"未占用资源",但不改任何应用状态。

## 7. 基线适用性（记录一次，后续阶段不再自行解释）

双 Tab 收敛提交后逐项判定，避免拿本记录去比一个已经改过的口径：

| 本记录的口径 | 是否仍适用 | 依据 |
| --- | --- | --- |
| `cargo test` 353 单元 + 5 集成、`cargo fmt --check`、`cargo clippy --locked --all-targets` | **适用** | 该提交未触碰 `app/src-tauri/` 任何文件，后端语义与测试数量不变；C01/C02/C03 的 Rust 侧改动直接与此基线比较 |
| `npm run build` 的 dist 体积（JS 103.28 kB / CSS 29.11 kB） | **不适用** | 视图合并与样式令牌改名改变了产物；以后一阶段自己的记录为准，体积差异不得解释为性能回归或改进 |
| `npm run test:fixture` 123/123 | **口径已变** | 其中 `rail-model.mjs`、`state-stress.mjs` 按新的双视图模型改写（未放宽断言），计数以后续记录为准 |
| `responsive-check.py` 的必需令牌清单 | **已随之改名** | `--rail-width`/`--rail-item-size` → `--tab-min-width`/`--tab-item-size`，门禁强度未减 |
| `tools/bench/layout-probe.mjs`、`view-smoke.py`、`narrow-smoke.py` 的定位器 | **过期** | `layout-probe.mjs` 仍字面引用 `.rail-item` 与 `--rail-*`（本轮 grep 全仓唯一命中该选择器的文件）；`view-smoke.py` 断言“每个 activity-rail 视图各自显示内容”、`narrow-smoke.py` 断言“窄屏下 activity rail 仍可见”，这两条几何断言的对象在双 Tab 收敛后已不存在。探针迁移完成前，它们的结果不得引用为本基线的证据 |

第 2 节的 idle CPU/RSS 测量取自 release 二进制的进程树口径，后端未变、WebView 宿主未变，
因此作为“同一主机同一构建”的量级仍可引用；但其中前端 DOM 规模已随双 Tab 合并变化，
若要把它当作 C 阶段新增常驻开销的对照，需要重跑一次同口径测量而不是复用旧数。

### 7.1 分隔条那一提交之后复判（逐项按本轮清点，不转抄阶段记录）

依据是对该提交的一次文件清单核对：它**没有触碰 `app/src-tauri/` 下任何文件**
（按名字过滤 `src-tauri` 命中数为 0），改的是 `splitModel.ts`、`mainPanel.ts`、
`changes.ts`、`history.ts`、`settings.ts`、`style.css`、`tokens.css`、
新增 `tests/main-split.mjs`，另外动了 `tools/bench/responsive-check.py` 与
`tools/live/b-shot.sh`。

| 本记录的口径 | 复判 | 依据 |
| --- | --- | --- |
| `cargo test` 353 单元 + 5 集成、`cargo fmt --check`、`cargo clippy --locked --all-targets` | **仍然适用** | 该提交零个 `src-tauri` 文件改动；C01/C02/C03 的 Rust 侧继续与这一条基线直接比较，不需要“先重跑一次旧口径” |
| dist 体积 JS 103.28 kB / CSS 29.11 kB | **再次不适用** | 同一文件清单里 `style.css`/`tokens.css` 都变了；阶段记录自报的产物已是 JS 105.11 kB / CSS 30.03 kB。任何“体积变化 = 性能变化”的解释都不成立，两边都不要引用 |
| `npm run test:fixture` 123/123 | **口径已变** | 新增 7 条分隔比夹具把计数推到 130；C 阶段夹具的计数只能与“落地当时的最新数”比，不能与本记录比 |
| `responsive-check.py` fails=0 | **不构成对新清单的证据** | 该提交给必需令牌清单加了 `--main-split`/`--main-list-floor`/`--main-graph-floor`（门禁强度上升）。本记录那次 fails=0 是对**旧清单**跑的，换清单必须重跑 |
| idle CPU 0.19% / RSS 437.4 MiB | **不能直接当 C04 的对照基数** | 同一提交新增两个列表的 `ResizeObserver` 与一个 chrome 观察器，其阶段记录自己写明这三者当时没有 disconnect。C 要测的是“活动索引 + 计时那一行”的增量，减去的基数已经变大 |
| “idle 期间未捕获 git 子进程”（1Hz `/proc` 采样） | **仍然是弱口径，且没有被新探针接走** | 并行改动里的 `tools/bench/read-budget.mjs` 数的是**前端 `invoke`**；`watch.rs` 的刷新与兜底 tick 在 Rust 里自己 spawn git，前端一次请求都不发，所以它给不出“无周期 Git 重查”的计数。本记录第 5 节那条弱口径继续成立：后端侧要么新增 spawn 计数，要么继续引用 `GUIT_PERF=1` 阶段日志（交叉印证口径，见 [活动契约](09-activity-contract.md) 第 4.9 节） |

因此本记录给 C 阶段留一个**带时机的动作**，而不是一句“后续重测”：复跑必须在
**那一组生命周期/订阅改动提交之后、C04 第一次给出数字之前**，用同一个
`tools/bench/idle-baseline.py`、同一个 release 构建、同一夹具规格
（`make-repo.sh /tmp/... 1000 0 100`）与同一个 300 s/1 Hz 窗口。
早于它重测会把 B 的改动算进 C 的账，晚于它给数则 C04 的增量不可归因。
若届时确实无法重跑（无桌面条件），本记录第 2 节一律标注为“旧基数”，
C 阶段只能报相对同一旧基数的“不可分解的合计变化”，不得把差值解释成活动索引自身的开销。

### 7.2 B03 落地之后复判（`d60f177`）

清点方式仍是该提交的文件清单：15 个文件，其中 `src-tauri/` 命中数 **0**。

| 本记录的口径 | 复判 | 依据 |
| --- | --- | --- |
| `cargo test` 353 单元 + 5 集成、`cargo fmt --check`、`cargo clippy --locked --all-targets` | **仍然适用** | 零个后端文件改动；C01/C02/C03 的 Rust 侧继续直接与这一条基线比 |
| dist 体积 | **第三次不适用** | 其阶段记录自报 JS 98.44 kB / CSS 30.03 kB；与本文任何数都不可互比 |
| `npm run test:fixture` 123/123 | **口径再变** | 该记录自报 143/143（新增 `snapshot-bus.mjs` 8 条、`lifecycle.mjs` 5 条）。**这两个数取自带作者本人的阶段记录，本记录没有独立复现它们**（原因见下面那次不被引用的测量） |
| “idle 期间未捕获 git 子进程” | 见第 7.1 节那一行的更正 | 探针只数前端 `invoke`，接不走这条 |
| 第 1 节那张“全套 gates”表 | **不再等价** | B03 引入 `tools/bench/read-budget.mjs`：需要浏览器与已构建 dist，且明确不属于 `npm run test:fixture`。“门禁全绿”从此多出一个 CDP 步骤，本文第 1 节的表里没有它 |

第 7.1 节那条带时机的动作，其前置条件**现已满足**（生命周期/订阅改动已提交）：
C04 第一次给数字之前用同一 `tools/bench/idle-baseline.py`、同一 release 构建、
同一夹具规格与同一 300 s/1 Hz 窗口重跑一次即可，不必再等任何东西。

**一次不允许被引用的测量**（写下来是为了防止它日后被当作 HEAD 的数）：
本轮在 `d60f177` 之后跑了一次 `npm run test:fixture`，得 142/143，
失败的是 `ipc-surface.mjs` 的“每个注册命令都要有调用方”，报出
`clone_repository`、`cancel_clone`。这**不是 HEAD 的失败**：
当时工作树不干净——盘上 `app/src/views/welcome.ts` 按 `wc -l` 已从 164 行缩到 74 行，
而 `git grep` 对 HEAD 的同一文件仍能看到那两处 `invoke` 字面量，
`main.rs` 的注册两侧都还在。据此可判定那是**移除克隆入口的改动进行到一半**的形状
（谁在做、属于哪一个阶段不在本文推断范围内）。

它留下两条可复用的结论：

- 共享工作树下，任何门禁数字都必须先确认工作树干净，才能归属于某个提交。
  本记录第 1 节的数字可引用，正是因为它们当时在干净树上跑。
- 这个瞬时红灯是退出顺序约束的**活样本**：`ipc-surface.mjs` 剥掉注释后按带引号
  字面量匹配，所以把“UI 入口”和“命令注册”分两步删，中间那一步必然红。
  退出清单里每一对入口 + 命令必须**同一次改动里两侧一起走**——这不是风格，
  是那道门禁的实际行为。同一时刻读预算探针**没有**变红，
  正好印证 [活动契约](09-activity-contract.md) 第 4.9 节那句：它只断言“没人读”，
  不断言“命令不存在”。

## 结论

完成(gates 全绿;idle 基线已固定,RSS 预算缺口已记录待修订;主窗口内容级桌面证据按路线图标记未测,须在 H 前补齐)。
