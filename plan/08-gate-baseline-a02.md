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

## 结论

完成(gates 全绿;idle 基线已固定,RSS 预算缺口已记录待修订;主窗口内容级桌面证据按路线图标记未测,须在 H 前补齐)。
