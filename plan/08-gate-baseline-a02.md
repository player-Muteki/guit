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

## 结论

完成(gates 全绿;idle 基线已固定,RSS 预算缺口已记录待修订;主窗口内容级桌面证据按路线图标记未测,须在 H 前补齐)。
