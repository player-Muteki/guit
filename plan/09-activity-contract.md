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
- 端到端延迟包含 Git 读取耗时，文案不能把 1 s 说成任何仓库都能达到的上限。

一个必须保持的既有事实：`repo::status_output` 带 `--no-optional-locks`，因为它测到
普通 `git status` 会创建并删除 `.git/index.lock`，这些事件回流给 watcher 后一次真实改动
会引发无限刷新（`repo.rs:353-357`，并有测试 `status_output_never_acquires_the_index_lock`）。
新增的元数据读取同样不得取索引锁，也不得自己成为事件源。

## 2. C02：候选枚举实测契约

候选集合 = Git 认定的“已跟踪文件” + “未被忽略的未跟踪文件”，再按现存文件取最大 mtime。
实测确定的命令与行为：

| 事实 | 实测结果 | 对实现的约束 |
| --- | --- | --- |
| 已跟踪列表 | `git ls-files --cached -z`（含工作树上已被删除、但索引中仍在的文件） | 删除项必须 stat 后跳过，不得当作候选 |
| 未跟踪且非忽略 | `git ls-files --others --exclude-standard -z`；省略 `--exclude-standard` 时忽略规则完全不生效 | 必须带 `--exclude-standard` |
| 普通未跟踪目录 | 默认**递归列出其中的文件**（`newdir/inside.txt`）；加 `--directory` 才折叠成 `newdir/` | 不得使用 `--directory`，否则 stat 到目录本身 |
| 嵌套仓库（未注册的 `.git` 目录） | 只输出**目录项** `nested/`，不进入其中 | 目录项以结尾 `/` 标识（`-z` 输出同样保留斜杠），按边界排除 |
| 已注册 submodule（索引中 mode `160000`） | `--others` 输出为空：`mods/` 内的游离文件不被列出，Git 自行停在边界 | 不需要额外的“排除 submodule”扫描；但仍要识别 mode 160000 项不是普通文件 |
| 未提交的 `.gitignore` | **照样生效**（`ignored-dir/hidden.txt`、`just-ignored.txt` 被排除）；`.gitignore` 自身作为未跟踪文件出现在候选中 | 候选集合与忽略判定同源，一次枚举即可；无需先提交 |
| `.git/info/exclude` | 生效（`from-info-exclude` 被排除） | 该文件在 `git_dir` 下，已被现有递归 watch 覆盖，不需要新增监听目标 |
| `core.excludesFile` | 生效；值中的 `~` 由 Git 展开，而 `git config --get core.excludesFile` 返回的是**未展开的原文** `~/myignores` | 解析观察目标时必须自行展开 `~`，否则会监听一个不存在的路径 |
| 未设置 `core.excludesFile` 时的默认忽略文件 | `XDG_CONFIG_HOME` 存在时读 `$XDG_CONFIG_HOME/git/ignore`；未设置 `XDG_CONFIG_HOME` 时读 `$HOME/.config/git/ignore`（实测两者互斥，XDG 优先） | 观察目标不止来自配置：默认路径也必须纳入，否则“只改全局忽略文件”这一验收场景失效 |
| 符号链接 | `ls-files --others` 把链接作为单条文件项列出；链接自身的 mtime 与被指向文件的 mtime 相互独立（`utime(follow_symlinks=false)` 只改链接） | 用 `symlink_metadata`（lstat 语义），不跟随到仓库外；据此，外部目标被改写不会反映在活动计时中，属于设计选择而非缺陷 |

### 2.1 成本量级（同一主机、临时夹具）

| 负载 | 命令 | 实测 |
| --- | --- | --- |
| 10k 未跟踪文件 + 1 条忽略规则 | `ls-files --others --exclude-standard -z`（10001 项） | 6.3 ms |
| 同上仓库（0 已跟踪） | `ls-files --cached -z` | 1.2 ms |
| 同上仓库 | `status --porcelain=v2 -z --untracked-files=all`（10003 项） | 6.4 ms |
| 10k 已跟踪文件仓库 | `ls-files --cached -z` | 2.8 ms |
| 10k 文件逐个 stat（Python `os.walk` 参考实现） | — | 11.8 ms～16.8 ms |

结论：一次完整“枚举 + stat”在 10k 文件量级约 20–25 ms（Git 部分 <10 ms），
足以在后台线程做初始扫描，但**绝不能挂在每个计时 tick 上**（设计 §4.2 的“静止时不反复扫描”）。
超过输出上限的枚举按现有 runner 规则失败关闭，不解析截断列表。

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
- `state.ts` 的通知只有 `"status" | "render"` 两档（`state.ts:150-160`）。
  计时文本每 tick 全量 render 与设计 §3.2“普通计时 tick 只更新文本”冲突；
  需要按域通知（同 B03），C04 在 B03 的订阅模型上接线，而不是新增第三个全局档位。
- `WatchStatus` 目前只带 `mode` 与 `failed` 两个字段（`watch.rs:168-173`）。
  C01 的“需要重新核对/降级原因”要扩展这个事件体，前端 `watchStatus()` 同步跟进；
  文案属于 shipped text，不得出现阶段编号。
- 间隔 `x`：默认 5、整数 1–60，只控制文本重算；非法值拒绝并保留原值，
  且同一时刻只允许一个计时器（C05）。持久化接口先按临时通道接，字段归
  阶段 G 的版本化 preferences 所有，避免两处写同一偏好。

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

## 6. 未决事项

- `git ls-files` 在 sparse-checkout 仓库下的候选含义（是否应排除 cone 外文件）未测。
- 大量未跟踪项叠加深层目录时的枚举上界，需要与 `runner.rs` 现有 64 KB / 32 MB 上限对齐后再定
  （`git ls-files --stage` 因随文件数增长已改用 32 MB 界，见 `docs/known-limitations.md`）。
- Windows 的路径大小写/分隔符与符号链接语义、`~` 不展开时的默认忽略路径均无实测。
- 休眠恢复的时钟跳变只能靠 `observedAt` 与系统时钟单调性推断，具体检测方式待定。

## 7. 复现方式

本文表格中的每条 Git 行为都可用一次性夹具复现：临时目录内 `git init`，
设置 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=<夹具内文件>`、`GIT_TERMINAL_PROMPT=0`、`LC_ALL=C`，
分别构造：已跟踪后删除的文件、未提交的 `.gitignore`、`.git/info/exclude`、
普通未跟踪目录、含自身 `.git` 的嵌套目录、`update-index --cacheinfo 160000,<oid>,mods`
得到的 gitlink、`ln -s` 指向仓库外的链接，然后比对
`ls-files --others --exclude-standard[-z]`、`ls-files --cached`、`check-ignore -v`、
`config --show-origin --get core.excludesFile` 的输出。
阶段 C 实现时应把这些断言固化为 `app/tests/` 下的夹具测试。
