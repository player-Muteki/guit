# 阶段 C 契约依据：监听语义与文件元数据枚举

调研日期：2026-09-29。基线提交：`2ca0403`。本文只固定 C01–C05 依赖的事实与决策依据，
不是实现记录；`app/src-tauri/src/activity.rs`、`app/src/activityModel.ts` 在写作时仍不存在。
自该提交起 `app/src-tauri/` 未再变动（`git log 2ca0403..HEAD -- app/src-tauri/` 为空），
因此本文所有 Rust 行号在当前 HEAD 上仍然有效；前端行号随双 Tab 收敛已重新核对。

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
  今天**根本看不见**运行时错误——回调里写的是 `if let Ok(event) = result`
  （`watch.rs:155-160`），`Err` 分支不存在，notify 递回来的错误直接被丢弃；同一处的
  `let _ = events_tx.send(())` 也忽略通道已关。C01 要把这两处变成可判定的输入。
  但实测否定了“把 `Err` 接进队列就算覆盖了运行时降级”这个隐含假设：监听目录被删除时
  notify **不发 `Err`**，而是整条通道归于沉默（§1.2）。降级检测的真实来源因此是
  事件路径、刷新失败与一次有界的静默重建，而不是错误半支。
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

### 1.2 监听失效不可从错误得知（实测），因此 Watch 模式必须自带兜底

一次性原型 `/tmp/guit-c01-proto`（`dead_watch`、`rearm` 两个 bin，`notify =8.2.0`，
与 `app/src-tauri/Cargo.lock` 锁定的版本一致）测出五条形状各异的后果：

1. **被删掉的监听根会彻底沉默。** 监听 `root` 后 `rm -rf root`，回调收到
   `Remove(File)` 若干加一条 `Remove(Folder) ["root"]`；随后 `mkdir` 同名目录再写文件，
   回调**一条事件都没有**（实测 0 条），也没有任何 `Err`。沉默的原因是父目录不在监听
   集合里，根目录自己的重建不会产生事件。因此“把 `Err` 接进队列”不能覆盖这一类失效。
2. **可用的证据只有事件路径。** `Remove(Folder)` 的路径等于 `watch_targets` 的某一项
   （`watch.rs:121`）就是“这个监听根刚消失”的正面证据。这是 §1.1 三处用途之外的
   第四处，也是保留路径唯一无法用“刷新=全量重捕获”替代的理由：环路需要一个时机
   去重建监听，而不是只等下一次用户改动。
3. **重建是安全且幂等的，`unwatch` 不是。** 对同一路径连续调用 `watch(..., Recursive)`
   三次，一次写入仍只产生 4 条事件（`Close(Write)` 恰好 1 条），即 notify 按路径去重，
   不会造成事件翻倍；路径不存在时返回 `Err(PathNotFound)` 而不是 panic，因此可以按心跳
   无条件重发。相反 `unwatch` 对未监听路径返回 `Err(WatchNotFound)`，对内核条目已失效的
   路径返回 `Err(Io(Os { code: 22, kind: InvalidInput }))`，也就是“清理”这一步恰好在
   最需要它的状态下失败；既然重发本身已经足够，就先 unwatch 再 watch 这条写法不要出现。
4. **递归进新目录是异步建立的，中间窗口会丢事件。** 子目录被删除后立刻重建并写入，
   回调只有 `Create(Folder)` 与 `Access(Open)`，新目录里那次写完全丢失；同样场景留到
   500 ms 之后再写则正常。对快照语义无害——触发刷新的那一次 `git status` 会看到一切；
   对 C03 的增量索引有害，见 §3 新增的目录事件规则。
5. **Watch 模式今天没有任何兜底。** `run_loop` 的轮询分支写作
   `if mode == Mode::Poll && Instant::now() >= next_poll`（`watch.rs:104`），
   心跳在 Watch 模式下**永不**触发刷新。结合第 1 条，一个沉默的监听等于一个永不更新的面板，
   而状态栏仍显示 “watch”。因此 C01 的 Watch 分支必须保留一条低频核对
   （复用既有 `poll_interval` 或一个新的显式常量，二者都要在实现说明里点名），
   把“事件驱动”降级为“事件驱动 + 有界兜底”，而不是把 mode 当成二选一。

第 1、5 条合起来是设计 §3.2 那句“降级要可见”的真实内容：可见性不来自 notify 的错误，
而来自环路自己知道“我已经很久没有任何证据了”。测试要钉住的是
“监听根重建后写入重新被看见”与“Watch 模式在无事件时仍会按上界刷新”，
而不是“错误进入队列”——后者对本产品最可能的失效毫无帮助。

### 1.3 Git 自身写入的事件形状（过滤规则的边界，实测）

同一原型的 git 夹具（工作树 + `.git` 双目标监听，等同 `watch_targets`）显示，
一次 `git add` 与 `git commit` 产生 25+ 条事件，其中非 Access 的包括
`index.lock`、`HEAD.lock`、`refs/heads/main.lock`、`packed-refs.lock`、
`AUTO_MERGE.lock`、`maintenance.lock` 的 `Create(File)`/`Modify(Data)`/
`Modify(Name(From|To|Both))`/`Remove(File)`，以及对象子目录的 `Create(Folder)` 与
`tmp_obj_*` 的写。不带 `--no-optional-locks` 的 `git status` 同样产生
`Create(File) ["index.lock"]` 与 `Remove(File) ["index.lock"]`——这就是 §1 末尾
那条自喂回路的来源，已由既有测试钉住。

另一条必须写进契约的细节：内核的 `IN_CLOSE_WRITE` 在 notify 里是
`Access(Close(Write))`，因此今天 `refresh_worthy` 的 `Access(_)` 整类丢弃
（`watch.rs:146`）**顺带丢掉了“写入完成”这个最精确的信号**。这不是漏洞而是必要的取舍——
git 锁文件的 `Access(Close(Write))` 就在同一批事件里。C01 保留事件种类后不得
“顺手”把 `Close(Write)` 升格为刷新触发源：那会绕过 `--no-optional-locks`
之外的第二道防线，把每次 Git 内部锁写入都变成一次刷新。

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

### 2.3 100k 文件量级：全量扫描仍然够用，上限才是问题

同一主机、同一夹具形态放大到 100000 个已跟踪文件（`dXX/sY/fN.txt`，平均路径约 17 字节）：

| 负载 | 实测 |
| --- | --- |
| `ls-files --cached -z` | 8 ms |
| `ls-files --cached --stage -z` | 17 ms |
| 逐项 `lstat` + 求最大（Python 参考实现，100000 项） | 131 ms；按本轮 Rust 原型 10k 项 18 ms 的斜率外推约 180 ms |
| `--cached --stage -z` 输出字节 | 6,888,900 B（约 32 MB 预算的 1/5） |

两点结论，都影响 C02 的取舍：

1. **partial/stale 不是为了 10 万级仓库而设**。100k 文件的全量“枚举 + stat”在
   200 ms 量级，仍远小于一次轮询兜底周期，一次扫描跑得完。真正需要分批核对、
   保留 partial 的是更大规模、慢文件系统（网络挂载）或磁盘繁忙的情况；
   把 partial 实现成“10 万文件就分块”只会白增复杂度。分批的触发条件应当是
   **实测耗时预算**，不是条目数阈值。
2. **上限先于耗时坏**。stage 形式在 100k 已用掉预算的 1/5，按此斜率约 45–50 万条目
   触顶，届时读取报 `truncated`，活动统计必须进入 `unavailable` 并说明原因
   （§2.2）。这条比耗时更早成为实际约束，也因此 §2.2 的具名上限必须显式选定，
   不能沿用 64 KB。

### 2.4 路径必须是字节；`-z` 不只是分隔符的选择（实测）

一次性夹具里放四个名字：`plain.txt`、`中文.txt`、`quo"te.txt`、
以及一个**非法 UTF-8** 名字 `bad\xff.txt`，实测输出：

| 形态 | 实测结果 | 对实现的约束 |
| --- | --- | --- |
| `ls-files --cached -z` | 原始字节逐字出现：`b a d 377 . t x t \0`，中文名为 `344 270 255 ...` | `-z` 是**唯一不转义**的形态 |
| `ls-files --cached`（无 `-z`） | `"bad\377.txt"`、`"quo\"te.txt"`、`"\344\270\255\346\226\207.txt"` —— C-引用 + 八进制转义 | 合法 UTF-8 的中文名同样被引用（`core.quotePath` 未设置即为真） |
| `status --porcelain=v1 -z` | `?? new\xff.txt\0`，同样原始字节 | 与既有 `repo::status_output` 的形态一致，不必新写解析 |
| 对 lossy 字符串 `stat` | `bad\xff.txt` 经 `String::from_utf8_lossy` 变成 `bad\xef\xbf\xbd.txt`，`stat` 报 `FileNotFoundError` | 见下 |

第三行与第四行合起来是本节的全部理由：**把枚举结果过一遍 `String` 会让该候选静默消失，
不带任何错误。** 如果消失的那一项恰好是最新修改的文件，面板只是显示一个偏旧的年龄——
这是“读失败伪装成正常状态”的同一类缺陷，只是方向相反（伪装成“索引完整”）。
因此契约写死三条：

1. 候选集合在 `activity.rs` 内部以**字节 / `OsStr`** 形态存活，`stat` 走字节路径。
   既有先例够用：`status.rs` 把路径存成 `Vec<u8>`（`raw_path()`），
   `PathTable` 按原始字节映射回 `FileId`（AGENTS.md 的“不能逆向的显示名”规则）。
2. lossy 只允许出现在**显示名**上，先例是 `model.rs:203` 与 `repo.rs:324 to_display`；
   `ActivityView` 的可选显示名因此同样不可逆，不得被前端拿去寻址。
3. §2.2 的输出上限必须以 `-z` 的原始字节计。引用形态把每个非 ASCII 字节从 1 字节
   变成 4 字节（`\344`）再加首尾引号：实测 `中文.txt` 从 10 字节变 18 字节。
   用那种形态估阈值会让上限提前触警。

Git 按字节序输出（`bad\xff` < `plain` < `quo"te` < `中文`），而最大 mtime 与输出顺序
无关，所以取最大必须逐项比较，不得依赖“列表最后一项是最新的”这类巧合。

### 2.5 Git 读不动目录时返回 rc=0 与空结果（实测），状态映射必须按 stderr 分

`status` 与 `ls-files` 在遇到**无法打开的目录**时不改退出码，只在 stderr 上留话。
夹具：`sub/` 里有一个已跟踪且已修改的文件加一个新文件，`ok/` 里有一个新文件，
然后 `chmod 000 sub`。用 guit 实际下发的那条形
（`status --porcelain=v2 -z --branch --untracked-files=all --ignored=no`，
`repo.rs:362-371`）实测：

| 读取 | 退出码 | stdout | stderr |
| --- | --- | --- | --- |
| shipped 的 `status` 形 | **0** | 只有 `# branch.oid`、`# branch.head` 与 `? ok/brand-new.txt`；`sub/deep.txt` 的修改与它旁边的新文件都不出现 | `sub/deep.txt: Permission denied`、`warning: could not open directory 'sub/': Permission denied` |
| `ls-files --others --exclude-standard -z` | **0** | 只有 `ok/brand-new.txt` | 同一条 `could not open directory` |
| `ls-files --cached -z` | 0 | 三项全在，含 `sub/deep.txt` | 空 |

三条结论：

1. **可分辨的状态只能靠 stderr。** 好消息是部分数据真的可用（`ok/` 照样报出），
   坏消息是 `repo::status_output` 现在只 gate 退出码与截断，然后
   `Ok(output.stdout)` 把 stderr 丢掉（`repo.rs:383-395`）。照这个 helper 原样复用，
   活动索引会进入 `ready`，而面板对 `sub/` 的判断来自一次根本没读到的读取。
   C02 因此需要 helper 交出 stderr（或一个“有警告”的标志）。这是 §1.1 之外第二处
   “阶段 C 必须改既有后端形状”的地方，而且改的是**共享**路径：同一个洞今天就让
   快照可以把读不动的仓库显示成“无变化”。修它属于 C02 的前提，不是可选清理。
2. **`stat` 的错误码要分流，不能一律当作“文件不存在”。** §2 的“stat 失败即跳过”
   是为已跟踪但被删掉的文件写的。实测 `sub/deep.txt` 的 `stat` 失败是
   `PermissionDenied`（而 `sub` 目录本身的 `stat` 成功）：文件在，只是 mtime 看不见。
   所以 `NotFound` → 不是候选；`PermissionDenied` 及其它 errno → 候选仍在但
   mtime 未知，本次枚举进入 `partial`。把后者并进前者，正好在最像“索引完整”的时刻
   少算最新的那个文件。
3. **`empty` 与“读失败”是两件事，且 `empty` 可以合法到达。** 新建仓库、从未
   `git add` 过时：`ls-files --cached` 返回 rc=0 且**空输出**，同时
   `ls-files --others` 正常列出文件、`status` 正常报 `?? a.txt`。
   “已跟踪集为空”因此不是错误信号，不得用它推断不可用。真正不可用的形状是 rc≠0：
   `.git/objects` 被 `chmod 000` 后 `status` 与两个 `ls-files` 全部返回 **128**，
   stderr 是 `fatal: not a git repository`——Git 认不出仓库，而不是读不出内容，
   这一支现有代码已经走 `git_status_failed`，是正确的一侧。

据此把状态映射钉成一张表，实现按它写，不按“stdout 是否为空”写：

- `ready`：rc=0 且 stderr 空。
- `partial`：rc=0 且 stderr 非空——可以给出已覆盖部分的 `latestModifiedAt`，
  但必须显示为不完整；这种状态下不得说“无变化”。
- `unavailable`：rc≠0，或输出触及 §2.2 上限被截断。
- `empty`：属于 `ready` 且候选集确实为空（全新仓库就是这条的真实来源）。
- `stale`：与单次枚举结果无关，由 §4.4 第 3 条的单调钟判定。

### 2.6 stderr 只能判空，不能读文本；shared helper 的影响面是两个生产调用点

补测四件事，其中两件事收窄了 §2.5 的结论。

| 形状 | 退出码 | stdout | stderr |
| --- | --- | --- | --- |
| 同一个 `chmod 000 sub` 夹具，`LC_ALL=C` | 0 | 与默认语言同（75 B） | 90 B：`sub/in.txt: Permission denied`、`warning: could not open directory 'sub/': Permission denied` |
| 同一条命令，默认语言（zh_CN） | 0 | 同 | 79 B：**同样两行，但文本是中文** |
| 单个已跟踪文件 `chmod 000`（目录可读） | 0 | `1 .M N... ...`（该文件报为已修改） | **空** |
| `.git/index` `chmod 000` | **128** | 空 | `fatal: ... 打开索引文件失败` |

由此得到三条实现规则：

1. **分类只看 stderr 是否为空，不看文本。** 同一个失败的 stderr 在 zh_CN 下 79 B、
   在 `LC_ALL=C` 下 90 B，文本随 `LC_*`/gettext 变化。任何“按 `warning:` 前缀过滤”
   “从 stderr 里抠出读不到的目录名”都会随语言环境失效——而且实测第一行本来就
   **没有** `warning:` 前缀（它是 git 在 diff-index 阶段写的裸行）。所以
   `partial` 的判据是 rc=0 ∧ stderr 非空，需要告诉用户“哪一部分没读到”时，
   由 C02 自己的枚举给出（§2.5 第 2 条的 `stat` 分流），不从 stderr 反解。
2. **文件级不可读不是读取失败，`partial` 只描述目录遍历。** 已跟踪文件
   `chmod 000` 后 status 仍 rc=0 且 stderr 为空，并把该文件报成 `.M`（模式变化）：
   `stat` 只需要父目录可执行，不需要文件可读。mtime 索引同理能拿到该文件的 mtime。
   因此不得把“内容读不出”算进 `partial`，否则每个正常仓库里被 `chmod 000` 过的
   文件都会让面板长期挂着不完整——那是把 §2.5 想避免的“误报干净”换成了“误报残缺”。
3. **索引损坏那一支已经在正确的一侧，无需为它加分支。** `.git/index` 不可读返回
   128 而非 0，走现有 `git_status_failed`；§2.5 第 3 条的 `unavailable` 覆盖它。

helper 改动的影响面实测清点：`repo::status_output`（`repo.rs:344`）的非测试调用点只有两个
——`session.rs:205`（快照 capture）与 `write.rs:992`（写前 recheck）。两处今天都在丢 stderr，
所以两处都会把“目录读不动”当成“读完了”：快照把不可读目录显示成无变化，recheck 把同一个
不完整集合当成绑定事实去确认。签名因此从 `Result<Vec<u8>, ProbeError>` 改为同时交出 stderr
是**两个调用点各自要决定如何使用它**的改动，而不是一个内部重构；C02 的实现提交要么同时给出
两侧的处置，要么把快照那侧的处置记为同批修复，不能只改活动索引一侧就宣称 false-clean 已闭合。
`runner::Output` 本来就带 `stderr: Vec<u8>`（`runner.rs:20`），所以这次改动不触碰 runner 缝隙。

## 3. C03：增量更新的触发来源

“哪些来源变化会改变候选集合”已由上表给出，落到监听上需要分别处理：

- 工作树内的创建/修改/删除/重命名：事件路径给出线索后按项更新；删除当前最大项后重算次大值，
  允许显示的“多久以前”变大。事件到达时间不得代替 mtime（A03 已用夹具钉住
  “保留旧 mtime 的写入不改 mtime 但使 Git 报脏”）。
- **目录级事件不是项级事件。** §1.2 第 4 条实测：新建子目录里的第一次写入可以完全不被
  看见，因为 notify 的递归覆盖是在处理 `Create(Folder)` 之后才建立的。因此
  `Create(Folder)` 只能解释为“该子树需要一次局部重枚举”（候选集合可能多了整批文件），
  `Remove(Folder)` 只能解释为“该子树的全部条目作废”（可能一次去掉当前最大项）。
  把二者按单条路径增删索引，会让索引长期多算或少算，且正好在批量写入的主场景里发生。
  子树重枚举的边界是 Git 的忽略规则：目录内被忽略的文件不得进入候选，
  所以这条路径仍需 §2 的 `ls-files` 语义，只是范围可以缩到该目录。
- `.gitignore`（含各子目录）、`.git/info/exclude`：位于已监听目录内，事件可得，触发候选重枚举。
- 全局 `core.excludesFile` 与 XDG/`$HOME/.config/git/ignore` 默认路径：**在仓库之外**，
  现有 `watch_targets` 不覆盖。这里定为**不引入任何仓库外的监听目标**，改为有界低频
  的 metadata 核对（对解析后的那一个路径比 `mtime`+`size`），理由有三条，前两条实测：
  1. 监听父目录的代价不可控。当 `core.excludesFile` 指向 `~/.gitignore_global` 时它的
     父目录就是 `$HOME`；本主机 `$HOME` 仅前两层就有 515 个目录，而 notify 的递归是按
     目录逐个申请 inotify watch（`fs.inotify.max_user_watches` 本机 65536，
     **每用户共享**，guit 自己的仓库监听也花这同一份预算）。为了少等一次全局忽略的变更，
     把面板的 watch 预算押在用户主目录的规模上，不成比例。
  2. 该路径常常不存在，而“不存在”正是 §1.2 测过的静默形状：`watch()` 对缺失路径返回
     `Err(PathNotFound)`，之后它被创建也不会自己回来；另外 inode 语义下编辑器替换文件
     （写新 inode 再 rename）会使针对旧 inode 的监听失效。低频核对同时绕过这两个坑。
  3. 忽略来源变化的后果只是“候选集合需要重枚举”，而重枚举本来就在快照里做。核对晚了
     只会让统计进入 `stale`（§2.5 最后一条），不会让面板说错一个具体的时间。
  核对的节拍**复用 §1.2 第 5 条为 Watch 模式新增的那个有界兜底 tick**，不新增第三个间隔：
  同一次兜底既确认监听还活着，又重看这一个外部路径。路径不可读（`PermissionDenied`）→
  本次枚举进入 `partial`；路径不存在 → 不是失败，就是“无全局忽略”，不得据此降级。
  只有在核对发现该路径本身变了时，才重新解析 Git 配置（`config --show-origin` 一次）。
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
  这一读法直接锚定在产品权威上：大纲的偏好表把 `x` 写成
  “用于计时显示，不替代 Git 状态监听”，正文写成“计时文字按间隔重算，
  文件变化触发数据更新，静止时不能为更新文字而反复执行 Git 或全目录扫描”。

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

### 4.4 活动文本是前端第一处时钟算术，因此要先定形再实现

对现状代码的盘点（`app/src/*.ts` 与 `app/src/views/*.ts` 全量 grep）：

- **没有任何 `setInterval`。** 前端定时器只有三处一次性 `setTimeout`：菜单打开后
  延迟一拍再挂外部点击监听（`dom.ts:202`）、窗口设置 400 ms 合并写入
  （`window.ts:59`）、提交行高亮 950 ms 回落（`history.ts:642`）。
- **没有任何 `Date` 使用**：`Date.now()`、`new Date()`、`Date.parse`、`toLocale*`
  一处也没有。日期一律是 Git 产出的字符串，前端只截断显示
  （`history.ts:535,623` 的 `authorDate.slice(0, 10)`；来源是 `history.rs:18`
  格式串里的 `%aI`/`%cI`）。

三条后果都属于“没有先例可抄”，所以写成契约而不是等着沿用惯例：

1. **C05 的计时器是整个应用第一个周期定时器。** §4.1 要求点名持有者并由它的
   `dispose` 清掉，这条不是形式：仓库里还没有“周期任务随视图生灭”的形状可参考，
   它是 B03 订阅模型的第一处真实用法。若 B03 落地的模型覆盖不了
   “持有一个 `setInterval` 的模块”，C05 就还缺前提，应当回头而不是另造一套。
2. **格式化函数不得自己读时钟。** `activityModel.ts` 与
   `fileModel.ts`/`historyModel.ts`/`railModel.ts` 一样要被 `node --test` 直接
   import（AGENTS.md 的纯模型规则，且不得引入 DOM）。因此年龄必须是对**注入的 now**
   的纯函数（`latestModifiedAt`、`observedAt`、`now` 三个入参），否则夹具测试只能真等秒数，
   也复现不出“多久以前”的边界文案。谁供给 `now` 与谁持有 tick，必须是同一个模块。
3. **两套时钟各有归属，不得混用。** “多久以前”是墙钟差值：文件确实随真实时间变旧，
   休眠或校时让这个数跳大是**正确行为**，不需要“检测休眠”。需要防的是反向混淆——
   C02 的 `stale` 判定是“我多久没拿到证据了”，必须用单调钟；用墙钟相减时，一次向前的
   校时会让刚建好的索引被宣布陈旧。后端对应形状的先例是 `runner.rs:179` 的
   `started.elapsed()`（`Instant`）判超时，而不是任何 `SystemTime` 相减。
   负年龄同样要显式定形：已有先例把“时间戳在未来”判为“还不旧”
   （`askpass.rs:446-450`，`elapsed()` 返回 `Err` 时走保守一侧），
   活动文本要同样明确地夹到“刚刚”，而不是产出负数或 `NaN`。

§4.3 定形了 `latestModifiedAt`/`observedAt` 这两个字段，此处补上它们的类型选择：
跨通道传输用 **epoch 数字**，不用格式化字符串。`types.ts` 里现有日期是字符串
（`authorDate`、`StashEntry.date`），只因为前端从不对其做算术；活动值每 tick 都要算，
用字符串等于把解析塞进那条唯一的纯模型里。格式化后的文字属于 shipped text，
受文案门禁约束。

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

- §1.2 的监听失效形状全部在 Linux/inotify 上测得。notify 在 Windows 与 macOS 走的是
  另外的后端，`watch()` 是否同样按路径去重、`unwatch()` 的错误形状如何、递归覆盖是否
  也在事件之后才建立，均未验证；跨平台实现前不得把本节结论当作三平台共同的契约。
- Watch 模式兜底刷新用哪个间隔（复用 `POLL_INTERVAL`、按心跳计数、还是新增具名常量）
  是实现要选的，本文只固定“必须存在且不得依赖 `Err`”。选定后要在实现说明里写明该间隔，
  并回答它带来的代价：兜底刷新在无变化的仓库上仍会付一次 `git status`
  （沿用 `--no-optional-locks`，`watch.rs` 环路原有的 Poll 分支已经是同一形状），
  这是把“面板永不更新”换成“每个兜底间隔一次可忽略的读”，需要显式记录而不是当作免费。
  §3 已经让同一个 tick 兼做“仓库外忽略来源”的 metadata 核对，因此选定间隔时要按
  **两处用途共同的代价**记录，并且不得为此再新增第二个间隔。
- 活动枚举的上限形状已按 submodule 视图的先例定为“模块内具名常量 + 32 MB 档”（§2.2）；
  具体常量名与注释随实现落地后，需要在 `docs/known-limitations.md` 的 output bounds 一节
  补一条同等强度的记录，不得只留在代码注释里。
- Windows 的路径大小写/分隔符与符号链接语义、`~` 不展开时的默认忽略路径均无实测；
  §2.4 的字节契约也只在 Linux/UTF-8 文件系统上测得，Windows 下名字如何到达
  `OsString`（WTF-8 形态）与 Git 的输出编码都还是未知。
- `status_output` 把 stderr 一并交出已不是“要不要改”的问题：影响面清点是两个生产调用点
  （`session.rs:205` 快照、`write.rs:992` 写前 recheck，§2.6 末）。剩下未决的是
  **recheck 一侧如何处置非空 stderr**——把它当作“绑定事实不可信”直接拒绝写入，
  是当前 fail-closed 形状的自然延伸，但会让一个只读不动无关目录的仓库失去写入口。
  活动索引那侧按 §2.5 的表分状态已经定形，快照那侧的处置与它是同一次改动。
  这是本轮新发现的“现有代码已经在说谎”的形状——仓库里有读不动的目录时，
  快照会把“没读到”显示成“无变化”。本轮按约束没有改代码，
  也没有把它写进 `docs/known-limitations.md`（那属于 shipped text，应与修复同批落地，
  而不是先立一条无人实现的记录）。
- 时钟跳变按 §4.4 第 3 条处理：不检测，靠“墙钟给显示、单调钟给陈旧判定”的归属分开。
  仍未实测的是 WebKitGTK 里 `performance.now()` 是否计入休眠，以及真实休眠后
  notify 事件队列的形状（队列溢出是否发 `Err`）。这两条都需要挂起主机或改时钟权限，
  本轮没有做，也不能当作已验证。
- 10 万级的一次性“枚举 + stat”已测（§2.3，约 200 ms 量级）；仍未测的是
  **慢文件系统/网络挂载**下的同一扫描，以及分块核对对 mtime 单调性的影响。
  分批的触发条件按耗时预算定，实现若改用条目数阈值需要给出理由。

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
§2.4 的名字夹具：同一目录里放 `plain.txt`、`中文.txt`、`quo"te.txt` 与
zsh 的 `$'bad\xff.txt'` 产生的非法 UTF-8 名，比对 `ls-files --cached` 与
`ls-files --cached -z | od -An -c`，再用一次性程序分别对原始字节与
lossy 之后的字节 `stat`（本轮用 Python 做的这一步：前者成功、后者
`FileNotFoundError`）。非法字节名只在 Linux/UTF-8 文件系统上有意义，
同一夹具在 Windows 上根本构造不出来。
§2.5 的权限夹具：一个仓库里放 `sub/`（已跟踪文件改一次、再放一个新文件）与
`ok/`（一个新文件），提交后 `chmod 000 sub`，分别跑 shipped 的 `status` 形、
`ls-files --cached -z`、`ls-files --others --exclude-standard -z` 并**分开看
stdout 与 stderr**（只看 stdout 会得出“干净”的错误结论）；
再单独 `chmod 000 .git/objects` 看 128 那一支。清理时先 `chmod 755` 再删目录。
§2.6 的三条补测用同一夹具接着做：`chmod 000 sub` 后同一条命令分别以默认语言和
`LC_ALL=C` 各跑一次并**比字节数**（zh_CN 79 B、C 90 B，两行、第一行无 `warning:` 前缀），
这是“只能判空、不能读文本”的根据；再 `chmod 000 <单个已跟踪文件>`（目录保持可读）
看 rc=0 且 stderr 为空、该项以 `.M` 出现，与 `chmod 000 .git/index` 看 rc=128。
mtime 索引的三项成本用一次性 Rust 原型测得（临时目录下 `cargo run`，随进程删除夹具，
不是交付代码）：10 次“两次 `ls-files` + 逐项 `symlink_metadata`”重建、200 轮“取最大后删除”、
1000 次“取最大后写回同一项”。§3 那三条“不监听仓库外路径”的数字来自三条只读命令：
`cat /proc/sys/fs/inotify/max_user_watches`、`cat /proc/sys/fs/inotify/max_user_instances`、
`find "$HOME" -maxdepth 2 -xdev -type d | wc -l`（本机 65536 / 128 / 515），
以及 `git config --global --get core.excludesFile` 与对 `$HOME/.config/git/ignore` 的
`ls -ld`（本机：前者未设置、后者存在）。这两项都不写任何文件，也不需要夹具。
阶段 C 实现时应把这些断言固化为 `app/tests/` 下的夹具测试。

§1.2 与 §1.3 的监听形状由同一原型目录里另外两个 bin 测得（依赖 `notify =8.2.0`，
夹具建在 `/tmp` 下、进程退出前自删）：`dead_watch` 依次跑“监听根删除并重建”
“子目录删除并重建”“`watch()` 错误形状”“git 形态目录里 git 自己的写入”；
`rearm` 依次跑“对同一路径重复 `watch()`”“`unwatch()` 后重听”“根目录消失后靠定时重建恢复”
“子目录重建后的三种补救形状”。复现要点是**每一步之间留 drain 窗口**：
`dead_watch` 场景 2 与 `rearm` 场景 D 的差别只在重建后是否立刻写入，
这正是“递归覆盖在事件之后才建立”这条结论的来源，写成固定 sleep 的测试会把它抹平。
