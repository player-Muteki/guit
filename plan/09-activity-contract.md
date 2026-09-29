# 阶段 C 契约依据：监听语义与文件元数据枚举

调研日期：2026-09-29。基线提交：`2ca0403`。本文只固定 C01–C05 依赖的事实与决策依据，
不是实现记录；`app/src-tauri/src/activity.rs`、`app/src/activityModel.ts` 在写作时仍不存在。

所有 Git 行为均在一次性临时仓库中实测（隔离 `GIT_CONFIG_GLOBAL`、`GIT_CONFIG_NOSYSTEM=1`），
不触碰开发仓库。主机条件同 [A01 基线](05-baseline-a01.md)：Linux x86_64、Git 2.53。
**本文没有 Windows/macOS 证据**；`~` 展开、路径分隔符与符号链接语义在非 Linux 平台仍未验证。

## 1. C01：连续事件会饿死刷新（已定位的具体路径）

`app/src-tauri/src/watch.rs` 的 `run_loop` 在 Watch 模式下收到事件后进入内层循环，
每再来一个事件就把 `deadline` 重设为 `now + debounce`（`watch.rs:82-93`）。
只要事件间隔小于 250 ms，`now >= deadline` 永不成立，`fire()` 永不执行：
外部 agent 连续写文件时，guit 停在旧状态，而这正是本产品的主场景。

现有测试覆盖不到它：`watch_events_debounce_into_a_single_fire` 用 20 ms 间隔发 5 个事件后停手，
quiet period 得以走完。缺失的那条断言是“事件永不停时刷新仍发生”。

目标契约（对应设计 §3.2）：

- 从**首个事件**起计最大等待（目标 1 s），到点即触发一次合并捕获，即使仍在收事件；
  250 ms quiet debounce 保留为“事件停止后”的路径，两者取先到者。
- 捕获进行中不启动第二个 Git 读：沿用 `session.rs` 的 leader/rerun 门（`refresh_with`），
  watcher 侧只置重跑标记。
- 事件携带的**种类与路径**必须保留到内部队列，作为“哪个数据域失效”的线索
  （工作树 → 状态 + 文件元数据；HEAD/refs/index → 相应域）。当前实现把事件压成 `()`
  （`watch.rs:158`），因此无法区分这两类，也无法增量更新 mtime。
- 队列有上界；溢出不是“没有变化”，而是合并成一个“需要重新核对”状态。
- 运行时 watcher 错误（创建成功但后续失败、队列溢出、休眠恢复）要产生可见的 stale 降级，
  并允许重建或降级到轮询。`choose_mode` 只覆盖“创建即失败”一条路径（`watch.rs:203`）。
  更硬的前提是：今天**根本看不见**运行时错误——回调里写的是 `if let Ok(event) = result`
  （`watch.rs:155-160`），`Err` 分支不存在，notify 递回来的错误直接被丢弃；同一处的
  `let _ = events_tx.send(())` 也忽略通道已关。C01 先把这两处变成可判定的输入
  （`Err` 进队列、发送失败视为自身失效），再谈降级文案。
- 端到端延迟包含 Git 读取耗时，文案不能把 1 s 说成任何仓库都能达到的上限。

一个必须保持的既有事实：`repo::status_output` 带 `--no-optional-locks`，因为它测到
普通 `git status` 会创建并删除 `.git/index.lock`，这些事件回流给 watcher 后一次真实改动
会引发无限刷新（`repo.rs:353-357`，并有测试 `status_output_never_acquires_the_index_lock`）。
新增的元数据读取同样不得取索引锁，也不得自己成为事件源。

### 1.1 保留路径与种类的真实用途（防止按域失效被做成一张矩阵）

快照的容量比“七域客户端”的表象小得多。`SnapshotView` 只有
`repo / branch / files / operation` 四项（`session.rs:175-186`），
`capture_inner` 的全部内容是**一次 `git status` 加一次 `inflight::detect` 文件读**
（`session.rs:200-223`）；分支列表、tag、stash、worktree、history 页都是独立的按需命令
（`main.rs:1659-1675`：`history_page`、`list_refs`、`stash_list`），不在快照里，
也不由 watcher 触发。

因此“事件携带种类与路径”不是为了在后端若干 Git 读之间做选择——后端只有一个捕获单元，
任何非 Access 事件都等价于“重新捕获”。路径的真实用途只有三处，C01/C03 的改动范围
按这三处定，不多做：

1. 判定该事件是否与已捕获状态无关，从而**抑制**无谓刷新（目前唯一的抑制是丢 Access）。
2. 给 C03 的 mtime 索引做**免 Git 读**的增量更新：工作树内的路径直接按项改表，
   不需要 `ls-files`，也不需要 `git status`。
3. 判定**枚举规则来源**是否变化（`.gitignore`、`.git/info/exclude`、`git config` 里的
   `core.excludesFile`），这类事件才需要付一次全量重枚举。

第 2、3 两类是互斥的分流：把 `.gitignore` 的事件当作“改一个文件项”处理会让候选集合
停留在旧忽略规则下，反之把每次保存都升级为全量重枚举，就等于把 §2.2 的 18–22 ms
挂在每个按键上。实现必须显式区分这两类并有各自的测试。

## 2. C02：候选枚举实测契约

候选集合 = Git 认定的“已跟踪文件” + “未被忽略的未跟踪文件”，再按现存文件取最大 mtime。
实测确定的命令与行为：

| 事实 | 实测结果 | 对实现的约束 |
| --- | --- | --- |
| 已跟踪列表 | `git ls-files --cached -z`（含工作树上已被删除、但索引中仍在的文件） | 删除项必须 stat 后跳过，不得当作候选 |
| 未跟踪且非忽略 | `git ls-files --others --exclude-standard -z`；省略 `--exclude-standard` 时忽略规则完全不生效 | 必须带 `--exclude-standard` |
| 普通未跟踪目录 | 默认**递归列出其中的文件**（`newdir/inside.txt`）；加 `--directory` 才折叠成 `newdir/` | 不得使用 `--directory`，否则 stat 到目录本身 |
| 嵌套仓库（未注册，工作区里游离的 `.git` 目录） | `--others` 只输出**目录项** `nested/`，不进入其中（`-z` 输出同样保留斜杠） | 斜杠过滤足以排除这一类 |
| 已提交为 gitlink 的嵌套仓库（索引 mode `160000`） | **`--cached -z` 输出的是不带斜杠的 `nested`**（`ls-files -s` 显示 `160000 <oid> 0<TAB>nested`）。只按斜杠过滤会把它留下，`symlink_metadata` 成功，于是**目录的 mtime 进入候选**；在目录下新建一个文件就会推进这个 mtime，计时被非文件事件污染 | 必须双重排除：`--cached --stage -z` 按 mode 丢弃 `160000`，并在 stat 后丢弃 `is_dir()` 的项。只写其中一条都不算满足本契约 |
| submodule 目录内的游离文件 | `--others` 不进入：Git 自行停在边界 | 不需要额外的“排除 submodule 内容”扫描 |
| 未提交的 `.gitignore` | **照样生效**（`ignored-dir/hidden.txt`、`just-ignored.txt` 被排除）；`.gitignore` 自身作为未跟踪文件出现在候选中 | 候选集合与忽略判定同源，一次枚举即可；无需先提交 |
| `.git/info/exclude` | 生效（`from-info-exclude` 被排除） | 该文件在 `git_dir` 下，已被现有递归 watch 覆盖，不需要新增监听目标 |
| `core.excludesFile` | 生效；值中的 `~` 由 Git 展开，而 `git config --get core.excludesFile` 返回的是**未展开的原文** `~/myignores` | 解析观察目标时必须自行展开 `~`，否则会监听一个不存在的路径 |
| 未设置 `core.excludesFile` 时的默认忽略文件 | `XDG_CONFIG_HOME` 存在时读 `$XDG_CONFIG_HOME/git/ignore`；未设置 `XDG_CONFIG_HOME` 时读 `$HOME/.config/git/ignore`（实测两者互斥，XDG 优先） | 观察目标不止来自配置：默认路径也必须纳入，否则“只改全局忽略文件”这一验收场景失效 |
| 符号链接 | `ls-files --others` 把链接作为单条文件项列出；链接自身的 mtime 与被指向文件的 mtime 相互独立（`utime(follow_symlinks=false)` 只改链接） | 用 `symlink_metadata`（lstat 语义），不跟随到仓库外；据此，外部目标被改写不会反映在活动计时中，属于设计选择而非缺陷 |
| sparse-checkout（cone 模式）目录外的已跟踪文件 | `--cached -z` **照样列出**它们，但磁盘上不存在，`stat` 失败；`--sparse` 标志在 Git 2.53 下对输出无差异；`status --porcelain=v2 -uall` 完全不报它们为删除（10 个文件里 6 个不在盘上，status 只输出分支头） | “已跟踪列表”一行规定的 stat 失败即跳过，天然覆盖 sparse 仓库：不需要识别 skip-worktree 位，也不需要为 sparse 另设候选语义 |

### 2.1 成本量级（同一主机、临时夹具）

| 负载 | 命令 | 实测 |
| --- | --- | --- |
| 10k 未跟踪文件 + 1 条忽略规则 | `ls-files --others --exclude-standard -z`（10001 项） | 6.3 ms |
| 同上仓库（0 已跟踪） | `ls-files --cached -z` | 1.2 ms |
| 同上仓库 | `status --porcelain=v2 -z --untracked-files=all`（10003 项） | 6.4 ms |
| 10k 已跟踪文件仓库 | `ls-files --cached -z` | 2.8 ms |
| 10k 文件逐个 stat（Python `os.walk` 参考实现） | — | 11.8 ms～16.8 ms |
| 10001 项（10k 已提交 + 1 未跟踪）完整“`ls-files` 两次 + 逐项 `symlink_metadata`” | Rust 原型，同一主机 | 中位 18.1 ms，最差 22.0 ms（10 次重建） |
| 同一索引上对最大项取 max（10k 项线性扫描） | Rust 原型 | 约 100 µs/次（“删掉最大项再重建”200 轮共 42.8 ms，含每轮两次扫描） |
| 同一索引上“扫描后写入当前最大项”1000 次 | Rust 原型 | 224 µs/次——几乎全是线性扫描，不是插入 |

最后一行是本阶段最容易被实现掉的约束：**更新路径必须是 O(1)**。把 `max` 缓存在索引上，
一次 stat 得到新 mtime 后只比较“是否 ≥ 缓存的最大值”；只有当前最大项自己消失（被删、
被移出版格集合、mode 变成 gitlink）才付一次线性扫描。若实现写成“每次事件重扫全表”，
10k 文件仓库在持续写入下每事件多付约 100 µs 且随文件数线性增长，
这条代价应当由一个“持续写入下不做全表扫描”的测试固定，而不是靠代码审查。

结论：一次完整“枚举 + stat”在 10k 文件量级实测 18–22 ms（其中 Git 枚举部分 <10 ms），
足以在后台线程做初始扫描，但**绝不能挂在每个计时 tick 上**（设计 §4.2 的“静止时不反复扫描”）。
超过输出上限的枚举按现有 runner 规则失败关闭，不解析截断列表。

### 2.2 枚举输出必须选用的上限

同一夹具（10001 个已跟踪文件，路径平均 13 字节）测得 `ls-files` 的字节量级：

| 形式 | 10k 文件实测 | 与 `runner.rs` 现有常量的关系 |
| --- | --- | --- |
| `--cached -z` | 136,900 B | 超过 `DEFAULT_OUTPUT_LIMIT`（64 KB）约 2.1 倍 |
| `--cached --stage -z` | 636,950 B | 超过默认上限约 9.7 倍，是朴素形式的 4.6 倍 |
| `--others --exclude-standard --stage -z` | 与 stage 形式同量级 | 同上 |

按平均路径长度反推，朴素 `-z` 形式在约 **4800 个文件**处就会撞上 64 KB；带 `--stage`
（C02 用来排除 gitlink 必需）在约 **1000 个文件**处就会撞上。也就是说：沿用默认上限
会让 guit 在一个中等大小仓库上把活动计时判为 `truncated`。这不是可以“放宽再解析”的
问题——按现有规则截断的列表绝不解析，界面必须如实呈现不可用，而不是空集合或“没有修改”。

这一失败已经有先例可循：submodule 视图读取的 `ls-files --stage` 起初共用 64 KB，
于是约一千个文件以上的仓库就报“列表过大”（包括根本没有 submodule 的仓库），后来改为
在模块内定义具名常量 `GITLINK_OUTPUT_LIMIT = runner::STATUS_OUTPUT_LIMIT`
（`submodules.rs`），`docs/known-limitations.md` 记录了这次修正。活动枚举沿用同一形状：
在自己的模块里定义一个具名上限、取 32 MB 档、注释说明它随**文件数**而非提交数增长。
不采用“按条目数截断”，因为 `runner` 的截断按字节判定；超长 UTF-8 深路径同样按字节计。
超过该上限时保持失败关闭，界面按 §4 的 `unavailable` 呈现。

## 3. C03：增量更新的触发来源

“哪些来源变化会改变候选集合”已由上表给出，落到监听上需要分别处理：

- 工作树内的创建/修改/删除/重命名：事件路径给出线索后按项更新；删除当前最大项后重算次大值，
  允许显示的“多久以前”变大。事件到达时间不得代替 mtime（A03 已用夹具钉住
  “保留旧 mtime 的写入不改 mtime 但使 Git 报脏”）。
- `.gitignore`（含各子目录）、`.git/info/exclude`：位于已监听目录内，事件可得，触发候选重枚举。
- 全局 `core.excludesFile` 与 XDG/`$HOME/.config/git/ignore` 默认路径：**在仓库之外**，
  现有 `watch_targets` 不覆盖。要么额外监听该文件（或其父目录），要么按有界低频核对 metadata；
  只有在观察目标本身变化时才重新解析 Git 配置。来源不可读时活动统计进入 stale/partial，
  不得继续声称索引完整。
- 索引/HEAD 移动、worktree 切换：改变候选集合，需重枚举；`.git` 内部元数据变化
  可触发 Git 状态刷新，但**不得计入 mtime 统计**。

## 4. C04/C05 的接口约束（依据现状代码）

- 后端已有单调 `version`（`session.rs::publish`）与只在本快照内有效的 `FileId`；
  `state.ts::applySnapshot` 镜像同一规则。mtime 统计的有效性键必须是
  `sessionId + activityGeneration`（设计 §3.1），因此 C04 依赖 B05 的会话标识先行落地。
- `state.ts` 的通知只有 `"status" | "render"` 两档（`state.ts:150-170`，双 Tab 收敛后仍如此）。
  计时文本每 tick 全量 render 与设计 §3.2“普通计时 tick 只更新文本”冲突；
  需要按域通知（同 B03），C04 在 B03 的订阅模型上接线，而不是新增第三个全局档位。
- `WatchStatus` 目前只带 `mode` 与 `failed` 两个字段（`watch.rs:168-173`）。
  C01 的“需要重新核对/降级原因”要扩展这个事件体，前端 `watchStatus()` 同步跟进；
  文案属于 shipped text，不得出现阶段编号。
- 间隔 `x`：默认 5、整数 1–60，只控制文本重算；非法值拒绝并保留原值，
  且同一时刻只允许一个计时器（C05）。持久化位置与它为什么不属于后端见 §4.1。

### 4.1 设置值只控制文本重算，因此它属于前端

设计把 `x` 定死了语义：**默认 5、范围 1–60 整数秒，只控制文字重算，不控制 Git
freshness；调整后只维护一个计时器**（设计 §4.2 末段）。这条决定了持久化位置，
也决定了 C05 的改动范围：

- 不新增后端命令、不进 `window.json`、不进任何 Rust 设置文件。它和接口缩放、主题
  是同一类偏好，`localStorage` 是**正确位置**而不是妥协：已有先例
  `src/font.ts:18,26` 与 `src/views/settings.ts:239-242`，同样是“非法值拒绝并保留原值”
  的形状（`font.ts` 里已有 clamp）。
- “只维护一个计时器”约束的是前端：不得为文件区、图表区、活动文本各起一个
  `setInterval`。持有这个 interval 的模块必须在实现说明里点名，并且它的
  `dispose`（同 B03）必须清掉它——否则切换 Tab 或关闭仓库后计时器仍在推进文本，
  这正是 B03 存在的原因，C04/C05 是它的第一个真实用户。
- C01 的 `DEBOUNCE`、最大等待、`POLL_INTERVAL` 保持后端常量，**不接受这个设置值**。
  两个旋钮的不对称关系必须写进实现说明，避免后来者“顺手”把它们接成同一个：
  用户设 60 秒不得让面板的 Git 数据陈旧到 60 秒，设 1 秒也不得变成每秒一次 Git 读。

顺带记录一处本次不涉及、但下一个真正需要后端持久化的设置一定会踩的迁移陷阱：
`main.rs:230-238` 在读 `window.json` 时把 `schema_version != settings_version()`
判成 `settings_invalid`，也就是说**升版本号会让老用户已存的窗口几何整体作废**；
现有新增字段一律用 `#[serde(default)]` 而把 `settings_version()` 保持为 1
（`main.rs:148-166`）。写盘 helper 与 `WindowSettings` 类型耦合
（`write_window_settings`，`main.rs:184`），要复用就得先泛化成按类型写 JSON 的 helper；
另外该文件的校验把“窗口尺寸非法”和“版本不匹配”判成同一种错误，
一个只描述窗口的文件名也解释不了别的偏好，因此届时应当另建具名文件，
沿用 `session.rs:382-420` 里 `RECENT_SCHEMA_VERSION` 的“模块内常量 + 不匹配即拒绝”形状。

### 4.2 若某个值真要接到后端环路，生效路径只有两条

`run_loop` 在进入循环**之前**就算好了 `tick` 与 `next_poll`（`watch.rs:74-75`），
而 `supervisor` 把 `DEBOUNCE / POLL_INTERVAL / HEARTBEAT` 三个常量硬编码传进去
（`watch.rs:230-236`）。所以“传一个新 Duration 进去就即时生效”是不成立的：
只有经由已有的 `watch::restart`（`watch.rs:278`）重建 supervisor，或让环路每轮重读
共享值。选择重建还要说明正在进行的有界刷新如何与新旧两个环路交接
（`WatchState` 只保证旧线程在一个心跳内自退，不保证有序）。
按 §4.1，C05 不走这条路；这一段是为了让下一次有人想走时不必重新发现。

### 4.3 活动状态不得挂进快照

`SnapshotView` 是 `publish` 的唯一载荷，而 `publish` 需要一个完整的 `Capture`
（`PathTable` + 视图，`session.rs:237-261`）。把活动状态塞进快照会强制两件事之一：
每次索引变化都配一次 Git 捕获（与 §1.1 的“免 Git 读增量更新”直接矛盾），
或者造一次没有捕获的发布（破坏“快照即一次捕获”的既有不变量，并让 `version`
与文件寻址之间的关系变得可疑）。因此活动状态走**独立事件通道**，载荷直接取设计里
已经定形的 `ActivityView`（设计 §4.1：`sessionId`、`generation`、
`latestModifiedAt`、`observedAt`、`state`、可选显示名与错误原因，
`state` 至少区分 scanning/ready/empty/partial/stale/unavailable），
前端按 `sessionId + generation` 丢弃迟到的旧代次；计时组件不得仅凭
`latestModifiedAt` 为 null 猜原因。

接线点现状：全局 `listen` 只有两条——`repo-refreshed` 与 `watch-status`
（`main.ts:295-296`），后者已经带自己的状态形状。C04 是第三条，
必须落在 B03 的按域订阅上；如果实现时图省事写成又一个全局 `render`，
“静止时计时 tick 不重绘文件列表与图表”这条就自动失效，且现有测试不会报错。

反过来，纯“多久以前”的文本推进不需要后端参与：`observedAt` 一到，
前端按设置值重算文本即可。区分这两类是 C04 的核心：
**索引变了才发事件，时钟推进只改文本。**

## 5. C01 环路原型实测（一次性 /tmp crate，非交付代码）

在改动 `watch.rs` 之前，先用 notify 8.2.0 + 真实 inotify 事件验证“quiet 或最大等待取先到者”
的环路是否成立。夹具：临时目录递归监听，后台线程按固定间隔写文件，统计捕获次数与
**首个待处理事件到捕获之间**的最差延迟。同一主机同一构建（debug）实测：

| 场景 | 写入节奏 | 捕获次数 | 最差“首事件→捕获” | 说明 |
| --- | --- | --- | --- | --- |
| 连续风暴 | 每 20 ms 一个文件，约 5.6 s | 6 | **1.0002 s** | 等于 `MAX_WAIT`；现行实现此场景 0 次捕获 |
| 风暴 + 队列上限 4 | 同上 | 4 | 1.0006 s | 114 次溢出合并，域信息未丢，捕获仍按上界发生 |
| 单次写入后静默 | 1 个文件 | 1 | **250.1 ms** | quiet 路径未被最大等待改动破坏 |

由此确定 C01 的三条实现约束：

1. 待处理为空时只等心跳/轮询；有待处理时唤醒时间取
   `min(quiet 剩余, max_wait 剩余, 心跳)`，两者都不满足不得捕获。
2. 触发后清空队列并重置两个时间戳，使风暴期间的捕获节奏稳定在每 `MAX_WAIT` 一次；
   捕获自身耗时由 `session.rs` 的 leader/rerun 门吸收，环路不再叠一层节流。
3. 溢出时把丢掉的条目按数据域合并回队首并标记“需要重新核对”，不得当作无事发生。

原型只为拿到这三条结论与延迟量级，不进入仓库；正式实现连同“连续事件不饿死刷新”的
测试一起落在 `watch.rs`（阶段 C）。

落地时还有两处形状约束，避免测试被迫等真实秒级时间：

4. `max_wait` 必须像 `debounce`、`poll_interval`、`heartbeat` 一样是 `run_loop` 的**入参**
   而非模块常量（`watch.rs:65-73`）。否则新测试只能真等 1 s，与现有环路测试
   用 10–80 ms 计时的强度（`watch.rs:333-424`）不一致，也容易在慢机器上抖。
5. 把通道元素从 `()` 换成事件值，直接受影响的驱动点是
   `watch_events_debounce_into_a_single_fire` 里的 `tx.send(())`（`watch.rs:353-355`）；
   其余三条环路测试只建通道不发送，随签名改类型即可。这是预期的连带修改，不是回归。
   但 `watcher_delivers_real_filesystem_events`（`watch.rs:452-459`）目前只断言
   “收到一个东西”，改类型后应顺带断言它携带的路径与种类，否则这条测试对新契约
   毫无约束力。

## 6. 未决事项

- 活动枚举的上限形状已按 submodule 视图的先例定为“模块内具名常量 + 32 MB 档”（§2.2）；
  具体常量名与注释随实现落地后，需要在 `docs/known-limitations.md` 的 output bounds 一节
  补一条同等强度的记录，不得只留在代码注释里。
- Windows 的路径大小写/分隔符与符号链接语义、`~` 不展开时的默认忽略路径均无实测。
- 休眠恢复的时钟跳变只能靠 `observedAt` 与系统时钟单调性推断，具体检测方式待定。
- 单次 stat 覆盖 10 万级文件的真实上限未测（本轮只到 10k 量级）；若实现选择按条目数分块，
  需要另测分块边界对 mtime 单调性的影响。

## 7. 复现方式

本文表格中的每条 Git 行为都可用一次性夹具复现：临时目录内 `git init`，
设置 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=<夹具内文件>`、`GIT_TERMINAL_PROMPT=0`、`LC_ALL=C`，
分别构造：已跟踪后删除的文件、未提交的 `.gitignore`、`.git/info/exclude`、
普通未跟踪目录、含自身 `.git` 的嵌套目录、`update-index --cacheinfo 160000,<oid>,mods`
得到的 gitlink（本轮补测：直接 `git add -A` 提交一个嵌套仓库同样得到 mode `160000` 项，
且 `--cached -z` 输出不带斜杠）、`ln -s` 指向仓库外的链接，然后比对
`ls-files --others --exclude-standard[-z]`、`ls-files --cached`、`ls-files --cached --stage -s`、
`check-ignore -v`、
`config --show-origin --get core.excludesFile` 的输出。
mtime 索引的三项成本用一次性 Rust 原型测得（临时目录下 `cargo run`，随进程删除夹具，
不是交付代码）：10 次“两次 `ls-files` + 逐项 `symlink_metadata`”重建、200 轮“取最大后删除”、
1000 次“取最大后写回同一项”。阶段 C 实现时应把这些断言固化为 `app/tests/` 下的夹具测试。
