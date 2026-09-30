# 阶段 D 契约依据：历史读取的身份、双读一致与图的边界

调研日期：2026-09-29。基线提交：`ec1cf61`（阶段 C 收口之后）。本文只固定 D01–D05
依赖的事实与决策依据，不是实现记录：写作时 `history::page` 仍是两次各自解析 `HEAD`
的读取，`parse` 仍只核对行槽位是否存在。**§1–§3 描述的是实施前的树；D01 的落地见
§4（提交 `861a1ca`）。** 行号仅作导航，任何时候以符号名为准。

主机条件同 [A01 基线](05-baseline-a01.md)：Linux x86_64、Git 2.53、WebKitGTK。
**本文没有 Windows/macOS 证据**。所有 Git 形状都在一次性 `/tmp` 仓库里实测
（`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/nonexistent…`、`GIT_TERMINAL_PROMPT=0`、
`LC_ALL=C`），不触碰开发仓库。并行开发者的阶段 G 正在 `app/src/` 的外观侧推进
（`fontStack.ts`、`fontResolve.ts`、`tools/bench/`），与本文的 Rust 读取面无交集；
唯一会在后面相遇的是 `views/history.ts` 的行几何与字号，见 §2 末。

## 1. D01：两次读取今天只核对了一件事的一半

### 1.1 现状是一条长度检查，被注释写成了一致性检查

`history::page`（`app/src-tauri/src/history.rs`）先跑正文读
（`log --no-color -z --topo-order --format=<LOG_FORMAT> -n limit+1 --skip start <target> --`），
再跑拓扑读（`topology()`：同一条 `log`，`--format=%H %P`，`-n start+limit+1`，**没有 `--skip`**）。
两次都把 `target` 原样交给 Git；`target` 为 `None` 时是两条命令**各自**解析一次 `HEAD`。
前端 `views/history.ts` 今天永远发 `oid: null`，所以每一次分页都走这条竞态路径。

`parse` 拿拓扑读的结果给每一行找槽位，检查只有 `graph.get(offset)` 是否存在：
**既不比 oid，也不比 parents**。因此两次读取若描述了长度相同、内容不同的历史，
页面会被照原样画出来——正文行来自 A 历史，图线来自 B 历史。`parse` 里那段注释
（"The two reads described different histories"）声明的比代码做的多；今天它能拦住的
只有"第二次读到的历史更短"这一种，而且那是撞上的，不是设计出来的。

这条混排的后果不是难看：`GraphRow` 决定这一行画在哪一列、有没有汇入线，
按 §5.1 的话说就是"不能混合绘制"。本节是**代码事实**，不是实测事件——
在两次读之间移动 HEAD 需要竞争时序，本文没有构造出真实混排样本，也不声称量到过。

### 1.2 pin 的来源：会话已发布的那个 head，不是读取时刻的

决策：`target` 为 `None` 时，pin 取自 `SnapshotView.branch.oid`（`HeadState::Branch`
与 `Detached` 都带 oid）。三条理由，按分量排：

- `bind_read` 拒绝过期请求的判据是 `historyGeneration`，而这个数的定义就是
  "本会话的图 head 动过几次"——`graph_input` 正是 `(name, head_state, oid)` 三元组
  （`session.rs`）。用同一个已发布视图里的 oid 当 pin，答案描述的**正是**调用方回声
  的那个历史。反过来若在读取时刻重新解析 `HEAD`，答案可能比请求新：面板会画一个
  比它自己的分支标签更新的历史，而这条不一致恰好是 D01 要修的。
- 零额外进程。pin 已经在快照里。
- §5.1 要求"按固定历史上下文保存的增量轨道状态/检查点"（D03）。缓存键必须与一个
  既有代次计数器同寿，`(sessionId, historyGeneration)` 只有在 pin 来自会话时才成立；
  读取时刻的 `HEAD` 每次都可能是新值，键就退化成"缓存永不命中"。

边界：`view.branch` 为 `None` 的仓库（bare——快照不报 status）没有可 pin 的 oid。
这种情况留在 `history::page` 内部解决：`target` 为 `None` 时它自己解析一次
`rev-parse --verify HEAD`。这条 fallback 只服务 bare 仓库与直接调用 `page` 的测试，
代价是一次读多一个进程（实测 rc=0、stdout 一行 41 字节）。

实测的"解析不出 pin"形状（fresh bare 与 fresh 非 bare unborn **完全相同**）：

| 命令 | rc | stdout | stderr |
| --- | --- | --- | --- |
| `git log -1 --format=%H` | 128 | 空 | `fatal: your current branch 'X' does not have any commits yet` |
| `git log --no-color -z --topo-order --format=%H%x1f%P -n 1 --skip 0 --` | 128 | 空 | 同上 |
| `git rev-parse --verify --quiet HEAD` | 1 | 空 | 空 |
| `git rev-parse --verify HEAD` | 1 | 空 | `fatal: Needed a single revision` |

`--quiet` 的 rc=1 与"HEAD 指向一个不存在的分支"**无法区分**，所以本文不用它来判定
"这个仓库没有提交"。unborn 的正解仍来自快照（`main.rs` 已有的那道 gate：非 bare 的
unborn 直接回空页）。解析不出 pin 时新增一个失败码 `history_head_unresolved`，
**不返回空页**——按 AGENTS.md 那条"读失败永远不是干净仓库"，bare + unborn 的仓库
应当显示"历史读不出来"，而不是显示一条空历史。这条未在后端单测之外验证过真实 UI 呈现。

### 1.3 图侧读取不碰 optional lock，因此不给它们加 `--no-optional-locks`

held `index.lock` 的两种工作树（clean、以及把已跟踪文件 mtime 推后造成的 stat-dirty）
下，`page`/`topology` 用的那条 `log`、只有 `--topo-order --format=%H %P` 的那条 `log`、
`for-each-ref`、`diff-tree -r -z --name-status -M --root --diff-merges=first-parent`、
`rev-parse` 全部 **rc=0、stderr 0 字节，且 lock 文件原样还在**。
结论：这些读取不取 optional lock，D01 不给它们加 `--no-optional-locks`。

同一批探针里另外两件事：

- 把该选项写在子命令**之后**（`git log --no-optional-locks …`）⇒ **rc=128**
  `fatal: unrecognized argument: --no-optional-locks`，与 C01 记录的顶层位置约束同形。
- 诚实标注：本轮 `git status --porcelain=v1 -z --branch --untracked-files=normal`
  在带与不带该 flag 两次都 rc=0、0 字节 stderr，**这个夹具没有区分力**，
  因此本文**不**声称复现了 status 的锁冲突。flag 对 status 的必要性由既有测试
  `status_output_never_acquires_the_index_lock` 承担，本文不转述它的结论。

### 1.4 双读核对的契约，以及 pin 之后仍然活着的那条残差

落地把核对补全：`parse` 除 `rows` 外接收同一 window 的 `nodes`，对每个 offset 断言
正文 oid 等于 `node.oid` **且** parents 等于 `node.parents`；任一不等即拒绝整页。
这覆盖 §1.1 里"长度相同而内容不同"那个今天漏掉的形状。错误码沿用
`history_graph_mismatch`，但文案不再指认原因——pin 之后"历史在两次读之间变了"
已经不是唯一可能，代码看不出错在哪一次读，就不该在 shipped 文本里替它编。

pin 带来的残差要写清楚，因为它属于 D02 而不是 D01：`%D` 的装饰是**正文读那一刻**
按当前 refs 算出来的。HEAD 从 A 移到 B 之后，pin=A 的读取里 A 不再带 `main` 标签，
而快照的分支标签仍是 `main`。也就是说 pin 冻结了拓扑，**没有**冻结标签。
§5.2 的结构化 refs（按目标 oid 更新、绑定 `refsGeneration`）才是让两侧一致的机制，
所以本轮不试图用 `%D` 去凑标签。

另外记一条事实供 D02/D03 使用：`page` 里除了这两次 `log` 还跑第三次 Git 进程
（`remote_names` → `git remote`），今天**每页一次**，用途只是把 `%D` 里的
`origin/x` 与同名本地分支分开。它读的是一样的仓库配置，没有按会话缓存。

### 1.5 D01 不动的东西

- 深页重复读整个拓扑前缀的代价 ⇒ D03，且 §5.1 要求"先量化"。本文不引未测数字。
- `assign_lanes_with` 在 `peak > MAX_LANES(24)` 时把整窗折成 first-parent 并给每行
  标 `folded`（`folded_row`）。这**已经不是静默简化**；D03 要处理的是"确需突破 24 时
  扩大列标识类型并支持横向滚动"，不是补一个已经存在的提示。
- 带 `oid` 的历史读取今天没有前端调用者。pin 让这条路径变成可测的（§1.2 的 fallback
  与显式 target 都进单测），但**分支选择器是 D05**，本轮不给前端接。
- `first_parent` 仍由前端勾选并透传；两条读都带这个旗标（`page` 里那句注释说的是
  真的），D01 不改。

## 2. 待决：D02–D05 动手前各需要先拿到哪一条事实

- **D02**（已实测，见 §5.1；下面保留的是动手前的读代码结论）：
  `refs_input`（`session.rs`）= `(graph_input, upstream, ahead, behind,
  operation.kind)`，**不含 tag 集合、不含分支集合**。按 `publish` 的算法，
  在一个已有提交上新打 tag 既不动 `head_moved` 也不动 `names_moved`，
  于是 `refsGeneration` 与 `historyGeneration` 都不 bump——绑定 Refs 域的读取不会被
  拒绝，图上的 tag 标签也就不会自己更新。这是**从代码读出的结论**，D02 第一步要用
  一次真实刷新把它变成实测（`git tag` 之后 refresh，看两个代次计数）。
- **D03**（耗时表已实测，见 §6；下面保留的是动手前的读代码结论）：`topology()` 的
  `-n start+limit+1` 看着像"前缀随深度线性重读"，量下来不是——代价与深度无关，与**仓库大小**
  成正比，因为 `--topo-order` 要排完所有可达提交才吐第一行，而页读带着同一个旗标，所以一页付
  两次遍历。检查点因此省不掉那份遍历，能省掉的是其中一次。列标识是 `u8`
  （`GraphRow.node`/`lanes`/`branches`），§5.2 明说 `u8`、TS 限宽常量与 CSS 要一并审，
  不能只移一个阈值让列号溢出。
- **D04**：`%B` 全文已经在 payload 里（`CommitView.message`），气泡**不需要**新读一次
  Git；要测的是 250 ms 悬停延迟、键盘 focus 同一路径、以及虚拟行回收后气泡不跟到
  别提交的 oid（§5.3 那条"不指向重用 DOM 的其他提交"）。
- **D05**：分支切换要复用既有本地 switch 写命令并携带 `snapshot_version`；
  动手前先读 `write.rs` 里 switch 的拒绝形状（脏冲突、worktree 占用、unborn），
  detached/unborn 不能用空字符串冒充。
- **与 G 的接缝**：D03/D04 会碰 `views/history.ts` 的 `rowGeometry` 与
  `--graph-*` 令牌，G 正在动字体与主题 CSS。字号变化本就要求行高、虚拟列表与图线
  几何同步（§7.1），所以这两条线在 tokens 上是同一份事实；实施时按文件错峰，
  不共用一次提交。

## 3. 复现方式

§1.3 的锁探针与 §1.2 的 unborn 形状都是普通 shell + 临时仓库，
隔离配置同上；仓库建在 `/tmp` 下并随脚本删净，不含任何用户数据。
D01 落地后的可重跑证据是 `cargo test` 里新增的那几条（pin、双读混排拒绝、
held lock 下的图读取），以及既有分页/合并顺序测试不变。

## 4. D01 落地记录：`861a1ca`

提交：`861a1ca`（"Name the commit a history page is about, in both of its reads"），
基线 `84eb0db`。只改后端四个文件：`history.rs`、`session.rs`、`main.rs`、
`branches.rs`（后者只改一条断言，见 §4.3）。前端与 IPC 面**一个字节都没动**，
`HistoryPage`/`CommitView` 的线格式不变，所以 `ipc-surface.mjs` 的四类划分照旧。

### 4.1 代码事实

- `history::pinned_rev(directory, target)`：pin 的唯一出处。显式 `target` 先过
  `valid_oid`（不合即 `history_target_invalid`），否则跑
  `rev-parse --verify HEAD`；非成功是 `history_head_unresolved`，成功但答案不是
  一个完整 oid 是 `history_protocol_error`。**截断不需要单独分支**——被砍短的回答
  本来就不是完整 oid，`valid_oid` 那道检查会拒绝它，这正是 §1.2 想要的失败形状。
- `history::page` 第一句就取 pin，两次读都带这个 oid 且都跟 `--`；
  `topology()` 的 `target` 从 `Option<&str>` 变成必填 `&str`，"少一个参数就少一次
  歧义"落在类型上。
- `history::parse(bytes, nodes, graph, start, remotes)`：`nodes` 是新增的必填参数，
  位置在 `graph` 之前。每个 offset 断言 `node.oid == oid` **且**
  `node.parents == parents`；任一不等（含"槽位用完"）都由同一个闭包
  `mismatch()` 生成 `history_graph_mismatch`，文案不指认哪一次读出错——按 §1.4，
  pin 之后"历史在两次读之间变了"已不是唯一可能，代码看不出错在哪一侧就不该写进
  shipped 文本。原来的"reload to try again"那句随之删掉：它给的补救动作正是代码
  无法保证的那件事。
- `session::SessionState::pinned_head()`：`snapshot() → view.branch → branch.oid`。
  `main.rs` 里 `let target = oid.or_else(|| sessions.pinned_head())`；命令层原有的
  unborn gate（非 bare、`HeadState::Unborn` → 空页）留在原地，因为它读的是快照，
  比让 Git 报一句 fatal 更准确。
- bare 仓库走 `page` 内部 fallback（`view.branch` 为 `None` ⇒ pin 为 `None`），
  每页多一个 `rev-parse` 进程——与 §1.2 的预测一致。

### 4.2 与契约的两处偏离（都不是让步，是实现时才显形的）

1. **失败顺序变了。** pin 在正文读之前，所以 unborn 的失败码从
   `history_page_failed`（Git 的 stderr 首行）变成 `history_head_unresolved`。
   §1.2 写的是"新增一个失败码"，没写它会顶替旧的那条；受影响的是
   `branches.rs` 里那条 unborn 断言（含其注释），已改。
2. **`history_target_invalid` 现在有两道。** 命令层保留原有检查（前端边界），
   `pinned_rev` 再加一道（argv 边界）。§1.4 只说了"在构建 argv 的地方拒绝"，
   没说撤掉边界那道；两道并存的意义是：直接调用 `page` 的测试与将来任何后端调用者
   都在模块内被拦住，不依赖调用者自觉。

### 4.3 新增的测试与其能承讲到哪一步

`history::tests` 25 → 30 条。逐条说明它断言的到底是"实测"还是"内存构造"：

| 测试 | 形状 | 承讲范围 |
| --- | --- | --- |
| `two_reads_are_committed_to_the_same_commits_not_just_the_same_length` | 内存构造：手写记录 + 合成 `plain_nodes` | 槽位在而 oid 不同、oid 同而 parents 不同、两者皆同三种；这是 §1.1 说的"长度相同内容不同"那一半，**但不是真实竞态样本**，竞态仍没有被构造出来过 |
| `a_pinned_commit_is_the_history_a_page_is_about` | 真实仓库 | 显式 pin 的页面只关于那个提交，即使 HEAD 已前进；无 pin 时答 HEAD |
| `a_page_read_needs_no_lock_someone_else_is_holding` | 真实仓库 + held `index.lock` | §1.3 的结论进了可重跑的测试：锁被别人占着不是"历史读不出来"，且读不吃掉锁、锁在不在两次结果逐字段相同（`CommitView` 因此加 `PartialEq, Eq`） |
| `a_bare_repository_resolves_its_own_head_for_every_page` | 真实仓库 | bare 的 pin fallback 与"bare + unborn 是拒绝不是空页" |
| `a_target_that_is_not_a_full_commit_id_never_reaches_git` | 真实仓库 | `HEAD`/`--all`/`refs/heads/main`/短名/空串五种都在 `pinned_rev` 被拒，不进进程 |

bare 夹具的做法与 §3 预期不同，值得记一条 Git 事实：**Git 拒绝在 bare 仓库里
`commit`**（本机 Git 2.53，`git --git-dir=….git commit --allow-empty` ⇒ rc=128
"this operation must be run in a work tree"）。落地的做法是普通仓库提交完之后
`git config core.bare true`：同一份对象库、没有工作树，`rev-parse` 与 `log` 都照常答
（实测 `--is-bare-repository` 为 true、历史两行）。可选的替代是 `git clone --bare`
一个本地路径——测试夹具里跑本地 clone 并不是新事物（`session.rs` 的
`a_clone_shares_a_head_but_never_a_session` 就是这么建的），但它为了"这里能不能读
bare 历史"这一个问题多带一份对象库，形状也更容易被读成产品能力，所以没有采用。

门槛（本机 Linux x86_64、Git 2.53、Node 26）：`cargo test` **305/305**
（`84eb0db` 为 300，+5）；`cargo fmt --check` clean；
`cargo clippy --locked --all-targets` clean；`npm run build` 0 errors、
`npm run test:fixture` 305/305（本轮未改前端，这个数是全树的数）；
`color-contrast.py` 与 `responsive-check.py`（含 row-height 两条）fails=0。
`read-budget.mjs` 没有重跑：它统计的是前端 `invoke` 次数与 DOM 结果，
D01 在两者上都没有变化。

### 4.4 残差：现在仍然没有一致性保障的部分

- **标签侧仍活着。** `%D` 由正文读那一刻的 refs 算出，pin 冻结拓扑不冻结标签，
  与 §1.4 的预测逐字相同。这条现在有了测试可依赖（`a_pinned_commit…` 之后没有断言
  标签），但**没有**断言"标签与快照的分支名一致"——那是 D02 的
  `refsGeneration` 与结构化 ref，不是这里能凑的。
- **UI 呈现没有被驱动过。** `history_head_unresolved` 今天只在两种情况下能被真实
  用户看到：bare 且无提交的仓库。非 bare 的 unborn 走命令层的空页 gate。
  验证记录没有新增条目——这个登记处现已撤下，这条残差就记在本节——因为这个码在真实 WebView 里没有跑过。
- **深页代价照旧。** 拓扑读仍是 `-n start+limit+1`。这一条现在是数字：见 §6——
  它与深度无关，与仓库大小有关。（`remote_names` 那个每页第三个进程已经被消掉了。）

### 4.5 D03 继承的一条测量缺陷（先修它，再谈缓存）

`page` 里两个 perf 标签共用一个起点：

```rust
let parse_start = Instant::now();   // 现状即如此，早于 D01
let graph_start = parse_start;
…
perf::mark("history.graph", graph_start.elapsed());
perf::mark("history.parse", parse_start.elapsed());
```

两行 `elapsed()` 都在 `parse` 之后取，因此 `history.graph` 与 `history.parse` 报的是
同一段时间（拓扑读 + 布局 + 解析）。这不是 D01 引入的（`84eb0db` 的树即如此），
但 D03 要用 `GUIT_PERF=1` 的相位耗时来决定检查点尺寸与缓存边界，**在那之前先把这两个
起点分开**，否则量到的是"整个后处理"，无法回答"前缀重读值不值得换成检查点"。

> 这条已修：`page` 现在是 body / graph / layout / parse 四个起点四个标签，
> 分开之后量的结果是 §6。它给出的答案与这里预期的不同——被问的那个前缀重读不是代价的来源。

## 5. D02 落地记录：`315e988` + `61d9d4f` + `532be32`

三次提交是一条闸门的三段：先把 ref 观测放进会话（`315e988`），再把名字从页面里搬出来
（`61d9d4f`），最后把夹具里那条会被误读的命令换掉（`532be32`）。

### 5.1 §2 留给 D02 的那条预测，现在是实测

§2 写的结论来自读代码：`refs_input` 不含 tag 集合也不含分支集合，所以在已有提交上打
tag 既不动 `head_moved` 也不动 `names_moved`，两个代次都不 bump。D02 的落地否掉了它的
后半句——`publish` 现在把 ref 观测本身比一遍：

```rust
let names_moved = head_moved
    || refs_input(&active.view) != refs_input(&view)
    || active.refs != snapshot.refs;
```

`session.rs::a_name_that_no_head_move_explains_still_moves_the_refs_generation` 是本机
Git 2.53 上的实测：`tag v1`、`tag -a v2`、`update-ref refs/heads/dev HEAD`（一个没人站在
上面的分支）、`update-ref refs/remotes/origin/main HEAD`（远端跟踪引用按本地元数据读）、
`tag -d v1` 五步，每步 `refs_generation +1` 且 `history_generation` 不动；第六步什么都没
动，于是 version 仍然严格上升而两个代次都不动。§4.4 的第一条残差（"标签侧仍活着"）由
此闭合。

### 5.2 代码事实

| 位置 | 现在的形状 |
| --- | --- |
| `refs.rs` | `FIELD_COUNT = 9`，`REF_FORMAT` 增 `%(*objecttype)`；`TagRef { oid, targetType, commitOid }`；peel 只允许 tag object 携带，一条自称非 tag 却带着 peel 的记录整份拒绝；分支与远端跟踪引用非 `commit` 即拒绝 listing（Git 2.53 实测 `update-ref refs/heads/x <blob>` 本来就失败） |
| `refs.rs::list` | 一次 `for-each-ref`，`run_with_limit` + `REF_OUTPUT_LIMIT = 8 MiB`；truncated ⇒ `refs_truncated`；退出 0 但 stderr 非空 ⇒ `refs_unavailable`——被 Git 悄悄跳过的名字比没有名字更坏 |
| `tags.rs` | `TagDetail { targetType, commitOid, message }`，同一条 peel 规则；命名 tree/blob 的标签报告它命名了什么，不再假装是个提交 |
| `history.rs` | `LOG_FORMAT` 去掉 `%D`，`CommitView` 没有任何名字字段；`RefLabels`/`remote_names()`/`parse_labels()` 删除——**每页第三个 Git 进程（`git remote`）与 `origin/x` 消歧逻辑一起走** |
| `refsStore.ts` | 按 `(sessionId, generation)` 建槽、`KEEP = 2` 的有界缓存，in-flight 合并，**失败不入缓存**（所以重试与另一个视图的成功都还有效） |
| `views/history.ts` | 订阅 Refs 域；一次拒绝画成一次拒绝：计数行补一句"names could not be read"、`Names again` 重试、详情面板同一句话，且**不发 toast**（picker 开着时同一件事会被报两遍） |

名字不再进快照，是这一节里唯一偏离设计字面形状的决定。实测的重量：`for-each-ref` 的
记录在本机 4001 条本地 ref 上是 297,856 字节，**74.4 字节/条**（还不算 serde JSON 的字段
名，那一层更大）。快照每次 refresh 整份重发，把 listing 放进去等于每两秒把几千个名字
重新编码一遍；设计 §5.2 要的是"标签按目标 OID 更新，不必重算不变拓扑"，而不是"名字与
状态同生共死"。落地的形状是 Refs 域上的一次独立读 + 前端按代次有界缓存，于是同一次读
同时喂两个视图。

### 5.3 退出闸门的证据

闸门两条都在本机测到（Linux x86_64、Git 2.53、无头 Edge 154）：

1. **新 Tag/移动分支无需 HEAD 改变就更新。** 后端是 §5.1 那条测试；前端是
   `read-budget.mjs` 的 `a moved branch without a head move re-reads the names and no
   history`（`list_refs` 1、`history_page` 0）与 `the moved name repaints onto its new
   commit and the tag stays where it was`——移动的是 `topic`（row 0 → row 2），`master`
   留在 row 0、`v1` 留在 row 1。共享缓存的可测形式是同文件里的
   `opening the picker over a listing already read asks for nothing`（0 次）与
   `two views on one refs generation share one listing read`（1 次）。
2. **本地远端跟踪引用不需联网。** listing 只读 `refs/heads|tags|remotes` 三个本地命名
   空间；`532be32` 把 ahead/behind/gone 三条形状的夹具从 `git fetch` 换成手写
   `update-ref`（"远端"那个提交在本仓库里造出来，再挂到跟踪引用上，分支从它旁边另起），
   于是被引用的对象一直在本地对象库里。probe 的 `NEVER_READ` 列在这轮全为 0。

门槛（同一棵树）：`cargo test` **311 passed / 0 failed**（D01 记录为 305）；
`cargo fmt --check` 与 `cargo clippy --locked --all-targets` clean；`tsc --noEmit` 0 错；
`npm run build` 44 modules、`dist` 114.52 kB JS / 30.78 kB CSS；
`read-budget.mjs` **36 条 check、fails=0**；`color-contrast.py` 与 `responsive-check.py`
fails=0。`npm run test:fixture` 在这一轮开头是 **335 pass / 1 fail**，失败的不是 D02 的
文本而是 `tests/user-facing-copy.mjs` 自己：它对仓库根的 `docs/` 做 `readdirSync`，而那
个目录已被 `e2aab6f`（阶段 G 的文档清理）删净，于是门禁在 ENOENT 上倒下。这里把它改成
"目录在就扫、不在就没有文本可扫"——规则管的是文本，不是某一个路径永远活着——之后
**336 pass / 0 fail**。留下两条不属于 D02 的事实：`AGENTS.md` 与 `plan/README.md`、
`plan/01`、`plan/03`、`plan/05`、`plan/09` 仍把 `docs/known-limitations.md` 当作"没被验证
的东西记在哪"的登记处，那个文件现在不存在了（这批断链此后由把登记处改成本目录各阶段记录
的那次文档清理闭合，D02 本轮没有动它们）；D02 的未验证残差因此只写在 §5.4 与本节里。

### 5.4 残差

- **一次提交必然多一个 Git 进程。** `head_moved` 也 bump `refs_generation`，所以一次提交
  是两次读（`a head move that advances both counters costs one read each`）。这不是 bug，
  但它意味着 A02 那张 idle/提交耗时表在**形状**上过期了：一次刷新现在多跑一条
  `for-each-ref`。那组数字本轮没有重跑。
- **Refs 读的迟到没有被驱动过。** `read-budget.mjs` 的 `__HOLD__` 只 park `history_page`；
  一个跨过会话关闭才回来的 listing 靠 `bind_read` 与视图里两次 context 比对被丢掉，代码在
  跑，探针没测。
- **8 MiB 是一条会整体失败的上界。** 超过约十一万条 ref 的仓库，整份 listing 拒绝
  （`refs_truncated`），表现是所有行没有标签 + 那一句话 + 重试；没有在真实大 ref 库上量过。
- **标签比行晚一个往返。** 以前 `%D` 与正文同批到达，现在名字要等第二次读；这是新出现的
  可见时序，不是回归，但它在慢盘上会被看见。
- **`model.rs:386` 的夹具仍用 `git fetch`。** 与 `532be32` 消掉的形状相同；它不是 D02 的
  文件，本轮没动。

## 6. D03a：拆开相位之后，深页的代价换了名字

§2 留给 D03 的前提是"`topology()` 的 `-n start+limit+1` 意味着前缀随深度线性重读"，
也就是"深页比浅页贵，检查点省掉这份线性重读"。§4.5 要求先把共用的两个起点拆开再谈这件事。
拆开之后量到的形状与那个前提不同，这一节是它的记录。

### 6.1 表：6,300 提交的仓库，一页一次点击，深度 0 → 6,250

夹具是 `/tmp` 下 `git fast-import` 造的 6,300 提交仓库（主线每 40 个提交并一次三提交的侧分支）。
`npm run bin:release` 之后用 `tools/bench/bench_run.py --history-pages 126` 跑完整份历史，
`GUIT_PERF=1` 的日志按页对齐（`PAGE_SIZE = 50`，页 *n* 的深度是 50*n*）：

| 深度 | `history.body` | `history.graph` | `history.layout` | `history.parse` |
| --- | --- | --- | --- | --- |
| 0 | 20.5 | 16.3 | 0.0 | 0.1 |
| 500 | 19.1 | 17.5 | 0.1 | 0.0 |
| 1000 | 16.3 | 19.4 | 0.1 | 0.1 |
| 2000 | 18.6 | 21.7 | 0.2 | 0.0 |
| 3000 | 16.4 | 20.4 | 0.2 | 0.0 |
| 4000 | 17.9 | 24.7 | 0.4 | 0.0 |
| 5000 | 18.5 | 23.7 | 0.3 | 0.0 |
| 6250 | 18.2 | 23.4 | 0.4 | 0.0 |

中位数 body 17.9 / graph 20.3 / layout 0.2 / parse 0.0，最大 22.7 / 26.9 / 0.5 / 0.2（毫秒）。
126 次点击的端到端延迟平在 51–97 ms。

**前缀没有随深度长出代价来。** 两条读都是平的，graph 只有约 +4 ms 的弱增长（`-n` 那份输出，
不是排序）。`layout` 确实随节点数长，但整份历史跑完也只到 0.4 ms。
所以 §4.5 那个问题——"前缀重读值不值得换成检查点"——在这份表里的回答是：**不值得，因为它不是代价的来源**。

底噪也不是进程启动：按 §6.2 折算出的 2.3 µs/可达提交，6,300 个提交本身就是 14.5 ms。
两份夹具的数字互相印证，这一点才站得住。

### 6.2 代价是 `--topo-order` 的遍历，按仓库大小收费

同一形状的 210,000 提交夹具（每棵树一到两个条目，保证 fast-import 线性），
在 `<deeprepo>` 里对 app 实际发的那条命令按**可达提交数**计时（`<rev>` 取自主线的祖先，
所以遍历集合就是那一页要排的历史）：

| 可达提交 | `git log --topo-order --format='%H %P' -n 51 <rev>` |
| --- | --- |
| 1,000 | 0.00 s |
| 10,000 | 0.02 s |
| 50,000 | 0.11 s |
| 100,000 | 0.24 s |
| 210,000 | 0.49 s |

同一份仓库、同一批条件下，`-n 210001` 是 0.56 s：**Git 先排完所有可达提交才吐第一行，
`-n` 只裁输出、不裁工作**。去掉 `--topo-order` 之后 `-n 51` 是 0.00 s；
`--first-parent` 去掉 `--topo-order` 也是 0.00 s。约 **2.3 µs/可达提交/次**。

app 里同一份仓库的第一页因此是 `history.body 490.4 ms` + `history.graph 497.4 ms`
（`bench_run.py --history-pages 6` 的一次跑，两份夹具与日志都在 `/tmp`、本轮清掉，
复现形状见 §6.5）：`page` 的两条命令都带 `--topo-order`，所以**每一页付两次整仓库遍历**，
不管那一页在第几行、有多少条消息。一个 10 万提交的仓库就是每页约 0.5 s。

**一个例外改变了结论的形状。** 写过 `git commit-graph` 之后，同一份仓库的 `-n 51` 拓扑读是
0.00 s、整份 210k 是 0.18 s——Git 有了 generation number 就不必为了排序遍历。commit-graph 是
Git 自己 `gc` 的产物，读它 guit 不用写任何东西；为了翻页去用户的仓库里写维护文件不是选项。
上表是在 `git commit-graph write --reachable` 之后把那个文件移走量的（同一份仓库、同一个二进制，
留着它的第一页是 `body 3.4 / graph 2.3` ms，移走它是 `490.4 / 497.4` ms——两条读付的是同一次遍历），
所以两条都是本机 Git 2.53 的事实，但"真实仓库里通常有没有它"没有量过。

### 6.3 有界：现在先碰顶的是图读

- 拓扑读实测 **82.98 字节/节点**（210,000 节点整份 17,424,960 字节；单父 82、双父 123）。
  `LOG_OUTPUT_LIMIT = 8 MiB` 于是在约 **102,400 提交深度**把图读判成 `history_truncated`——
  一页画不出来，不是画得慢。`topology()` 的旧注释写着图读"永远不会是碰顶的那一个"，
  这条本轮按实测改掉了；它是 D03c 之外唯一的行为无关修正。
- 页读每行实测 **~220 字节**（50 行 10,997 字节，消息都是单行短标题），且固定 `limit+1` 行，
  不随深度长，所以页读离这条界很远。

### 6.4 D03c 因此要回答的是哪个问题

1. 检查点省不掉那 2.3 µs/提交——那是页读自己付的。能省的是**一页两次遍历里的一次**：
   页读的 `LOG_FORMAT` 第二个字段就是 `%P`，那一页 51 行的拓扑已经在页读里回来了。
   跨页缓存真正要换掉的是图读那一次遍历，前缀只是它的副产品。
2. "有界"的理由从深度换成了仓库大小：210k 节点的 `Vec<Node>` 约 33 MB（`Node` 是两个
   `String`；单父 152 字节、双父 216）。所以边界必须是**节点数**，且远小于一份大仓库的
   全历史——形状是"页边界的开口列状态 + 这一页的 51 个节点"，不是"从头到这里整份前缀"。
3. 闸门的第二条"深页无重复错位"在测量下变成另一件事：错位风险来自复用的边界状态与 Git
   排序在新提交进来时的差别。D03c 用 pin 的那条 OID 把这条做成测试，而不是靠缓存大小。

本轮不改任何行为。拆相位与改掉那条被量倒的注释，是让下一轮能在真实数字上做决定，
而不是在一个假设上。

### 6.5 复现方式与残差

两份夹具都在 `/tmp` 下用 `git fast-import` 造，形状相同：一条主线，每 40 个提交并入一条三提交的
侧分支。流的语法踩过两次：blob 必须在 `commit` 之前声明，提交块的顺序是
`commit / mark / committer / data <n> + 消息 / from / merge / M`（`message <n>` 不是命令），
`from` 只能指向提交 mark 而不是 blob mark。6,300 那份每提交新增一个路径（树随深度长，对本节没有
影响：`git log` 不带 `-p` 不读树对象）；210,000 那份每提交覆盖同一个 `main.c`，否则
fast-import 要为每个提交重写整棵树，量的就是打包而不是遍历。210k 那份 `git init` + fast-import 之后
HEAD 仍指向不存在的初始分支，要 `git symbolic-ref HEAD refs/heads/main`，在 app 里跑还要
`git checkout -f`。表里的命令形状就是 app 发的那两条：

```sh
git log --no-color --topo-order --format='%H %P' -n <count> <rev> --
git log --no-color -z --topo-order --format=<LOG_FORMAT> -n 51 --skip=<start> <rev> --
```

相位表来自 `GUIT_PERF=1`（`bench_run.py` 自己会设）：`--history-pages 126` 一次跑完 6,300 提交，
日志里每四条 mark 是一页。

- **本轮没加测试。** 拆的是诊断标签，`cargo test` 数不变是预期的；被量倒的那条注释改了，
  它描述的是代价而不是契约。
- **约 102,400 深度碰顶是算术，不是观测。** 82.98 字节/节点 × `LOG_OUTPUT_LIMIT` 推出的界，
  没有真的把 GUI 翻到十万行去量 `history_truncated`（`--history-pages` 到 126 页是 6,300 提交）。
  D03c 若要改这条界，得先把这条从算术变成观测。
- **真实仓库里有没有 commit-graph 没有量过。** 本节只量了同一份夹具的两种状态。
  这条差别值得在 D03c 之前先弄清楚：如果常见的被 `git gc` 过的仓库都带着它，
  那"每页两次整仓库遍历"在实践中就不是常态。

## 7. D03b 前半：轨道宽度的类型，与它和上限的关系

闸门那句"超过 24 轨道不静默简化"里，"不静默"部分早就有了（行上的 `folded` 与计数行那句
"Branches are not drawn…"）。这一节做的是另一半天：**列号不能靠算术巧合才不溢出**。

### 7.1 动手前的形状

`layout()` 在 `usize` 上数格子，往 `GraphRow` 里装的时候四行都是 `as u8`
（`node`/`lanes`/`branches`/`incoming`）。溢出确实发生过——一个 300 个父提交的扇形会数到列
299，`as u8` 把它折成 43——只是紧接着 `assign_lanes_with` 因为 `peak > MAX_LANES` 把整窗
丢掉换成 `folded_row`，那些行从未出门。**不溢出这件事当时的证明在两个常量之间**
（`MAX_LANES: u8 = 24` 与 `Lane::MAX`），代码里没有任何一处写着这层关系；上限被抬高就会失效。

### 7.2 现在的形状

| 位置 | 改动 |
| --- | --- |
| `history.rs` 顶部 | `pub type Lane = u8;`，`pub const MAX_LANES: Lane = 24;`——上限写成它自己约束的那个类型 |
| `GraphRow` | 四个列字段从 `u8` 改为 `Lane`/`Vec<Lane>`，线的两端是同一个名字 |
| `layout()` | 返回 `Vec<Slot>`：一行所有的事实、列仍是 `usize`。布局阶段不再接触要出门的类型 |
| `ship()` | 唯一一次窄化，`Lane::try_from(...).ok()?`；任何一格装不下就整窗返回 `None` |
| `assign_lanes_with()` | 两条出路合成一条宣布：超过上限折叠，装不下也折叠（`fold_window()`） |

`ship()` 的 `None` 分支在 `max_lanes: Lane` 的前提下是到不了的（一列 ≥ 256 意味着
`peak ≥ 257 > 255 ≥ max_lanes`，上限检查先走）。留着它不是防御性代码：它把"不会溢出"从
两个常量之间的算术，换成了**类型转换的那一处自己检查**。这正是 §2 要求一并审的东西。

### 7.3 新增的两条测试

`a_window_at_the_lane_cap_is_drawn_and_one_more_folds` 钉边界：24 格活的窗口照画，
最右一格 = `MAX_LANES - 1`（即"恰好放得下"），25 格折。这条以前没有——原来只测了
`MAX_LANES + 4` 这种明显越界的形状，上限两侧各差一格的形状没人问。
`a_fan_wider_than_the_lane_type_is_folded_never_renumbered` 用 300 个父提交跨过 `Lane::MAX`：
整窗 `folded`，且主线与那个 merge 仍然在（折叠不是把图清空）。

门槛：`cargo test` **313 passed / 0 failed**（+2）；`cargo fmt --check` clean；
`cargo clippy --locked --all-targets` clean；`npm run test:fixture` **336 pass / 0 fail**。

### 7.4 留给 D03b 后半的

"横向可达"还没做：`--graph-gutter-max: 6.5rem` 与 `--graph-lane: 0.8125rem` 让窗口里放得下
**8** 格，24 格的上限里有 16 格是画在界外、靠 `data-fade` 那道渐隐表示"还有"。
`rowGeometry` 已经把这种情况报成 `clipped`，但用户没有任何办法看到被裁掉的那些列。
后半要做的是给这条 gutter 一个共享的横向原点（一轮滚轮/一组方向键平移整列，
`at(column)` 减去原点），并让计数行说出现在看的是哪几格；`--graph-*` 令牌与
`GRAPH_LANE_REM` 那组常量由 G 的字体工作约束，改的只能是原点，不是尺子。

## 8. D03b 后半：把界外的那几格移进来看（`graphPan` + 一条 gutter 的原点）

§7.4 那条待办按它写的样子做完了：尺子一根没动，动的只有原点。

### 8.1 现在的形状

| 位置 | 改动 |
| --- | --- |
| `historyModel.ts` | `graphPan(columns, laneWidth, maxGutterWidth, origin) → {origin, shown, columns, over}`：`shown = floor(上限 / 道宽)`，原点钳在 `[0, columns - shown]` |
| `rowGeometry` | 第 7 个参数 `origin = 0`；`at(column) = (column - origin + 0.5) * laneWidth`。`width` 不看原点，`clipped` 看 |
| `views/history.ts` | 一份 `graphOrigin`；`graphWindow(fontPx?)` 由它和当前字号现算；`shiftGraph(by)` 一次改原点、重画行、改计数行 |
| 手势 | 横向滚轮、Shift + 纵向滚轮、`ArrowLeft`/`ArrowRight`；`over` 为假时一个都不接管（不 `preventDefault`） |
| `loadPage(reset)` | 重置回 0：换一份历史就从它自己的左边缘看起 |

三处都从同一个纯函数算，没有第二份状态：`shown` 由令牌来，所以 G 那边若把
`--graph-gutter-max` 或 `--graph-lane` 改了，能平移多远、计数行说看了第几格，都跟着一起变。

### 8.2 两条不是显然的取舍

**步长是"一格"，不是滚轮的像素数。** 计数行说的是列，渐隐说的是列，一条道就是一个色相单位；
按像素平移会让那句"现在看的是第 5–12 格"和屏幕上真的那几格差半格。触控板因此可能凭惯性
一路推到端点——这条没测手感，只测了"一步恰好一格"（§8.4 第 3 条、§8.5 第 6–9 条）。

**接管与否看 `over`，不看这一行有没有被裁。** 窗口里只要还有列在界外，这一下手势就归图；
已经推到端点时仍然归图（不落到列表上去滚），因为同一个动作在这里有两个意思是错的。
`clipped` 仍然是**逐行**的：它决定那一行戴不戴渐隐，平移进来之后 `at(widest)` 落回盒内，
fade 自己就摘掉了——"还有"不再成立的时候，那句谎得同时收回。

### 8.3 计数行新增的那句话

`… The graph shows columns 5–12 of 12; scroll sideways or use the arrow keys to move it.`

`countLabel` 是 `role="status"`，所以每平移一格朗读会跟着报新的一格。折叠与这句话不会同时出现：
折叠的窗口里 `lanes` 是空的，`columns` 回到 1，`over` 自然是假。

### 8.4 模型侧新增的三条断言（`app/tests/history-model.mjs`）

1. **天花板确实窄于后端的上限。** `shown < MAX_LANES`，其中 `MAX_LANES` 是**读 `history.rs` 源文件**
   拿到的数字——同一条契约的两端之一写在另一端那里，抬高后端上限应当拓宽可平移的范围，
   而不是悄悄让 8 格窗口去裁一个 40 格的图。
2. `graphPan` 的钳制与 `over`：`origin` 停在 `columns - shown`，负数回到 0，放得下的历史 `over` 为假
   且被存储的越界原点不会把它留在那个位置上。
3. **平移把远列移进盒子。** 列 10 的道在 `origin = 10` 时落在 `0.5 * lane`，`width` 不变（还是上限），
   `clipped` 转假；圆点与那条道各自相对静止位置移动了恰好 `10 * lane`——两条一起断言是因为
   "整行一起挪"和"每行各走各的"在单看一条线时没有区别。

门槛：`npm run build`（`tsc --noEmit` + vite）clean；`npm run test:fixture` **338 pass / 0 fail**
（+2：`graphPan` 的钳制与关系一条、平移把远列移进盒子一条）；`read-budget.mjs` fails=0；
`color-contrast.py dist/assets` fails=0；`responsive-check.py` fails=0。Rust 本轮未改，§7.3 那组仍有效。

### 8.5 引擎里的实测：`tools/bench/graph-pan-engine-probe.ts`

模型能决定算式，决定不了"这两个手势真的动了那几列没有"。新探针把 `views/history.ts` 在
WebKitGTK 里建两个会话（一个 12 列的历史、一个 6 列的），派发真的 `WheelEvent` /
`KeyboardEvent`，读真的 SVG 属性和 `getBoundingClientRect`。15 条全过：

| 断言 | 实测 |
| --- | --- |
| 道宽 / 上限 / 放得下几格 | 13 px / 104 px / 8（字号 16 px） |
| 未平移时最右一条道 | x = 149.5 px，界外 45.5 px，行戴 `data-fade` |
| 计数行 | `… columns 1–8 of 12; scroll sideways or use the arrow keys to move it.` |
| 横向滚轮、Shift+纵向滚轮、`→` | 各动一格（136.5 → 123.5 → 110.5），事件都被接管，句子跟着改 |
| 普通纵向滚轮 | 不接管、一格也不动（123.5 → 123.5） |
| 推到端点之后再多按 3 次 `→` | 停在 `columns 5–12 of 12`，最右一条 97.5 px ≤ 104 px，`data-fade` 自己摘掉 |
| 整段平移过程中 `.commit-subject` 的左边界 | 277.578125 px，一次未变 |
| 全部返回 | 最右一条回到 149.5 px，句子回到 `1–8 of 12` |
| 6 列的历史 | 句子里没有 "columns"，`→` 不被接管，gutter 宽 78 px = 6 × 13 px |

复现：`/usr/bin/python3 ../tools/bench/webkit-engine-probe.py graph-pan-engine-probe.ts src/style.css src/style/tokens.css`
（需要显示器与 WebKitGTK 绑定；`-v` 会把上面这些数字全部打出来）。

### 8.6 残差

- **左边缘是硬切，右边缘有渐隐。** `style.css` 里 `.graph-gutter[data-fade]` 那道 mask 只写
  `to right`；原点大于 0 时，界外那几列在 x = 0 处被切平。补它要在样式表里加一条
  `data-fade-left`（或把两侧合成一个 `mask-composite: intersect`），而 `style.css` 是并行开发者的
  文件，这一条留给那边定，不是这边顺手改的。**注意**：内联两层 mask 并不能绕过它——默认的
  `add` 合成会把两处渐隐互相抵消掉。
- **手感没有量过。**"一步一格"是指令层的事实，触控板惯性事件密度会让它推得很快；端点有钳制，
  所以后果只是到得早，不是走到空处。
- **折叠的窗口没有东西可平移**（`lanes` 为空）。闸门里"超过 24 轨道不静默简化"由 §7 那条
  `folded` + 计数行那句话负责，横向可达负责的是 8 < 列数 ≤ 24 这一段。
- 真机上还需要一个用户知道手势存在。句子写了"scroll sideways or use the arrow keys"，但没有
  任何地方解释"sideways"在一台只有纵向滚轮的设备上就是 Shift——文案归 D04/D05 之后一起审。

## 9. D03c 动手前的补账：真实仓库到底有没有 commit-graph

§6.5 留了两条没量的东西，其中一条决定 D03c 值不值得做：**"真实仓库里通常有没有
commit-graph"没有量过**——如果有，§6.2 那句"每一页付两次整仓库遍历"就不是常态，省掉
一次遍历是在优化一个实践中不存在的热度。这一节把它变成观测。

量具是 `tools/bench/commit-graph-census.py`（普查只读目录与 `rev-list`；计时在临时拷贝
里跑，不在用户仓库里写任何东西）。复现：

```sh
python3 tools/bench/commit-graph-census.py --root ~/code --max-depth 3 --time <repo>
```

### 9.1 普查：本宿主 9 份仓库，0 份带图

`objects/info/commit-graph` 与 `objects/pack/*.graph` 两个位置都查过。

| 仓库 | 可达提交 | pack | `core.commitGraph` | 图 | shallow |
| --- | --- | --- | --- | --- | --- |
| pi | 6,524 | 13 | unset | 无 | **是** |
| cc-haha | 2,104 | 11 | unset | 无 | **是** |
| claudian | 999 | 7 | unset | 无 | 否 |
| vscode-git-graph | 447 | 1 | unset | 无 | 否 |
| co-ober | 406 | 1 | unset | 无 | 否 |
| guit | 203 | 0 | unset | 无 | 否 |
| hi-pi | 73 | 0 | unset | 无 | 否 |
| yousheng_s2_devhub | 54 | 1 | unset | 无 | 否 |
| hi-pi/repo | 1 | 0 | unset | 无 | 否 |

**两条理由叠在一起。** 两份 shallow 克隆永远不会有图：在它们的拷贝里
`git commit-graph write --reachable` **exit 0 而一个文件也不写**（同一次运行里，
新 `git init` 的三份提交控制组写得出来，所以这不是这台宿主的 Git 二进制的问题，
是 shallow 仓库按定义不能有图）。剩下 7 份是完整克隆，`core.commitGraph` 全部 unset、
也全都没有图——也就是说这台机器上 `gc` 没给任何仓库留下过图，哪怕 7 个 pack 那份。

### 9.2 代价按真实大小量，两次

在拷贝里量 app 实际发的那条命令（`--root ... --time <repo>` 的输出）。

| 仓库 | 一页有序 | 一页无序 | 整条历史有序 |
| --- | --- | --- | --- |
| pi（6,524，shallow，写不出图） | 28.4 ms | 2.0 ms | 33.1 ms |
| claudian（999，写图前） | 7.5 ms | 2.1 ms | 7.3 ms |
| claudian（写图后） | 1.8 ms | 1.7 ms | 2.4 ms |

三件事同时成立：`-n 51` 与 `-n <整条历史>` 在真实仓库里同样是一个价（§6.2 那条"`-n`
只裁输出"不是夹具特有的）；图确实便宜得多（有序那一档 7.5 → 1.8 ms，落到进程启动的底噪）；
**而本宿主的仓库没有一份在这个底噪上**。

### 9.3 因此 D03c 做什么

省掉一页两次遍历里的一次，在两种情形下都是净赢，但可见度不同：没有图的仓库（本宿主的
9/9）每页少付 2–30 ms，随仓库大小长；有图的仓库少付的是底噪，看不出来。所以这一轮的
价值主张写成"**一页不再为同一份历史起两个 Git 进程**"，不写成"翻页变快多少"——后者
在这台宿主上只有真实大小 2–30 ms 的证据，深的形状（0.5 s 一档）仍然只有 §6.2 的夹具。

§6.5 的另一条（约 102,400 深度碰捕获上界是算术）**这一轮不改那条界**，所以它按原样
留着：本轮把图读变成"只在没有可续边界时才读整段前缀"，那条算术上界描述的是这条少见
路径，不是每页都走的路径。要改它得先把它量成观测。

顺带记一条量的时候撞见的事实：这台宿主的 Git 以中文输出 stderr，而
`history_page_failed` / `commit_files_failed` 是把 Git 的第一行 stderr 原样报给用户的。
不是本轮的事，D04/D05 审文案时一起看。



## 10. D03c：一页不再为同一份历史起两个 Git 进程

§6.4 把问题换成了"一页能不能只起一个 Git 进程"，§9.3 把价值主张定成那句话而不是"翻页快
多少"。这一节是落地形状、实测和残差。代码在 `history.rs`（`Edge` / `GraphCache` /
`window` / `assign_edge`），命令层只是把 `GraphCache` 作为 app state 递给每一页，并在会话
关闭时清掉它。

### 10.1 跨页传下去的东西按列算，不按提交算

一个 `Edge` 是四件事：`next_start`（下一页的游标）、`lanes`（这一页画完时还开着的列，每格
是这一列在等的 OID）、`peak` 与 `folded`（这条历史到目前为止最宽到哪一格、是否已越过上限）。
`GraphCache` 只装一份 `Boundary`，键是 `(session_id, historyGeneration, pin 的 OID,
first_parent)`：面板只从刚画的那一页往下翻，所以能省一次重读的状态永远是最新窗口底部那份，
第二份只是对"用户接下来点哪里"的猜测。它的大小由列数上限钉住，与页深、与仓库大小都无关；
`past_the_lane_cap_keeps_the_inherited_state_small` 把这条钉成断言（越界时列直接丢掉，
传下去的只有那个折叠事实）。

`window()` 因此有两条路，差别是一条 Git 命令：

|  | 拓扑从哪来 | 布局铺多少行 | 图侧读取 |
| --- | --- | --- | --- |
| 命中 | 页读自己的 `%P`（`LOG_FORMAT` 第二个字段） | 这一页的 `limit+1` 行 | 不起进程 |
| 未命中 | 再起一条 `git log --topo-order -n start+limit+1` | 前缀那 `start+limit+1` 行 | 一次整仓库遍历 |

未命中是常态的第一页、动过的历史、乱序请求；两条路都把新的边界写回同一格，所以下一页不问
它是从哪条路来的。

### 10.2 边界停在"画出来的行"，不停在"读回来的行"

`assign_edge(edge, nodes, shown, max_lanes, follow_all)` 的 `shown` 是这一页要渲染的行数，
而 `nodes` 正常比它多一行。多那一行不是浪费：最后一行的线到底在这里断掉还是继续往下，是它
**下面**那一行才回答得了的事实，同一行又是 `has_more` 的答复者（`page` 照旧用
`commits.len() > limit` 判、再截断）。切在 `shown` 上买两件事：

- 边界停在下一页真正用来要货的游标上。停在 `nodes.len()` 上它就在每次请求的下一行，缓存
  永远不会命中，也没有任何地方会说为什么；
- 那一行照旧参与布局，所以页缝上虚不虚线仍是渲染层原有的规则（`historyModel.ts` 的
  `dashed: graph.dangling`）。

`has_more` 那一条是被这条切法救回来的：中间版本把窗口截到 `limit` 行（一个后来删掉的
`split_page`），游标对了，代价是每页最后一行的父提交落在窗口外、`dangling` 于是说真话——
每个页缝都画成虚线，而那一行本来只是探针。

### 10.3 边界凭什么可以被相信

三重，缺一重就是另一条路：键（§10.1）说它是哪次读取挣来的；`next_start` 说它停在哪个游标；
witness 说这一页的第一行确实是某条开着的列在等的提交。前两重是算术，第三重是唯一一条能
看见"同一份历史被重排"的检查——在拓扑序里除 head 之外每个提交都有一个孩子在它上面，那个孩子
就是把它塞进列里的东西，所以一页的第一行如果没有列在等它，就不是这一页的下一页。

折叠过的边界不要求 witness：它不带列，没有可以接错的线，带下来的只有 `peak`——一条关于这份
pin 住的历史最宽到哪的单调断言。这一条让缓存在前缀读最贵的那个形状（宽历史）上仍然有用。

### 10.4 实测：6,337 提交、127 页一轮跑完

夹具按 §6.5 的形状用 `git fast-import` 重造（主线每 40 提交并入一条三提交的侧分支，每提交
新增一个路径），实到 **6,337** 个可达提交、1 个 pack、无 commit-graph。跑法是
`npm run bin:release` 之后 `tools/bench/bench_run.py --history-pages 126`（`GUIT_PERF=1`
由它自己设），127 页一轮点完，没有一次提前停。基线那一列是 §6.1 在同一宿主、同一形状
（6,300 提交）上记下的 D03a 实测，不是本轮重量的。

| 相位 | 第一页 | 其余 126 页 中位 / 最大 | §6.1 基线 每页 中位 / 最大 |
| --- | --- | --- | --- |
| `history.body` | 19.8 | 18.0 / 23.2 | 17.9 / 22.7 |
| `history.graph` | 16.3 | 0.1 / 0.1 | 20.3 / 26.9 |
| `history.layout` | 0.0 | 0.0 / 0.0 | 0.2 / 0.5 |
| `history.parse` | 0.1 | 0.0 / 0.1 | 0.0 / 0.2 |

（毫秒。整轮里 `history.graph` 超过 1 ms 的页**恰好一页**：索引 0，没有边界可续的那一页。）

三条支撑：

- **一次点击一次进程**，这条不是从相位推的：runner 每次发射打一条 mark，整轮 139 条对应
  127 页 + 打开、3 次 capture、refs 列举等 12 条；两条路时每页会是两条。
- 省掉的那一条读在本夹具上是平的：直接量 app 发的那条拓扑命令，
  `-n 51 / 551 / 1551 / 6337` 的中位是 16.7 / 16.8 / 16.4 / 16.5 ms（各 9 次，
  `time.monotonic`），与 §6.1"前缀不随深度长、`-n` 只裁输出"一致，也和第一页量到的 16.3 ms
  对上。所以 126 页 × 约 16–27 ms 是这一轮省掉的量，深度越浅的仓库省得越少（§9.2）。
- 端到端一次点击 31.9–93.8 ms（§6.1 是 51–97 ms）。这条只当旁证：这一轮的 release 二进制
  是在共享工作树里打的，前端里还带着并行开发者的 `style.css`/`layout-probe.mjs`，而相位 mark
  量的是 Rust 侧的读取，不受它影响。

`layout` 从基线的 0.2–0.5 ms 落到 0.0，是同一件事的另一面：布局铺的行从"整段前缀"变成
"这一页加一行"。日志里另有 2 次 `watch.refresh` / 3 次 `capture`，head 没动、代次没变，
边界继续命中——如果哪次 refresh 真的动过历史，日志里就会多出一页 16 ms 的图读。

### 10.5 这一轮加的测试

`cargo test` 313 → **320**。七条新的都在 `history::tests`，夹具是 `merged_repo()`：11 个提交、
两次 `--no-ff` 并入，页缝落在线的中段而不是只落在 head 与 root；`PAGE = 3` 让一次走完是四页。

- `the_edge_continues_where_the_prefix_read_agrees`：每个游标上都把两条路各问一遍，比的是
  整个 `CommitView`（含图行）。走之前先断言 witness 成立，否则下面那页会安静地走前缀读、
  答对而什么也没证明。三个缝全命中。
- `an_edge_stops_at_the_cursor_the_next_page_asks_with` /
  `an_edge_only_continues_a_page_whose_top_row_it_is_waiting_for`：§10.2 与 §10.3 的两半。
  后一条还把"页与整史不该拿来比"钉住：窗口里没见过 `c` 的那一页诚实地说 `b` 的线悬着，
  整史那一页不说——所以断言是路对路，只有身份（OID）拿整史比。
- `a_page_asked_out_of_order_re_reads_the_prefix`：跳过一页仍是正确的页，而且它留下的边界
  和下下一页要的是同一个。
- `a_boundary_is_keyed_on_the_read_that_earned_it`：换会话、换代次、换 pin 的 OID 都是没有
  答案；`clear()` 就是关会话做的事。
- `past_the_lane_cap_keeps_the_inherited_state_small` /
  `a_folded_window_hands_the_fold_down_rather_than_re_deciding_it`：§6.4 第 2 条——有界的
  单位是列，折叠是传下去而不是每页重判。

另外 `read_page_with` / `read_page` 两个 helper 把"共享同一份缓存"这件事写成签名（前者接
缓存、后者每次新建），`branches.rs` 里那四处历史读取改成经 `read_page(dir, &sessions)` 问：
用会话真发布出来的 `(session_id, historyGeneration)`，而不是测试自己编一个。
`npm run test:fixture` 338 条不变，`ipc-surface` 仍把 `history_page` 归在"绑定会话与代次的
读取"里。

### 10.6 残差

- **"面板只顺序翻页"是读源码读出来的，不是量出来的。** `state.ts` 里
  `historyPageStart = loaded`，所以乱序那一条路在真实交互里走不到；它走到时答得对、走得少，
  但没有测量。
- **witness 是形状检查，不是证明。** 它拒的是"这一页第一行没有列在等它"。一次重排如果让每个
  页缝的第一行仍然被某条列等住，就过去了；在同一个 pin 住的 OID 下要让这点成立得先让 commit
  DAG 变，而那不叫重排。§9.1 那两份 shallow 克隆是真会加深的形状，本轮没有拿它们量过命中。
- **一份边界，写最后一次说了算。** 两个页同时在飞时后者覆盖前者，被覆盖的那条只是一次未命中
  （慢一次），不会画错。这是选了"永不猜用户下一步"的代价，没有测。
- **折叠传下去之后不再重判。** `peak` 单调，所以一条上面折了、下面某页其实放得下的历史会一路
  折着画——这是 D03b 定的契约（折叠是关于这份历史的断言，不是关于一页的），本轮照它在测试里
  钉死，"用户会不会在深历史中段看到本来放得下的图被折起来"仍然是契约问题不是测量问题。
- **约 102,400 提交深度碰捕获上界那条仍是算术**（§6.5、§9.3）。本轮不改那条界，但它描述的
  路径从"每页"变成了"未命中那页"。
- **内存没有单独量。** 边界的界是列数（最多 2 × 24 个 40 字符 OID ≈ 2 KB）加一页窗口的节点；
  `bench_run.py` 在这个形状上报的 idle RSS 是 508–528 MB，全是 WebView，看不见这 2 KB。
- **诊断标签早就分不清子命令了。** runner 的 label 取第一个非 flag 参数，而每条命令都以
  `-c submodule.recurse=false` 开头，所以整轮每条 Git 发射都叫
  `git.submodule.recursefalse`。本轮"每页一条命令"是靠数发射条数，不是靠 label 区分两条路；
  要把这条路做成可看的诊断，得先修那个取名规则。
- **Windows 与 macOS 仍只是构建配置。** 这一节的数来自 Linux 宿主、Git 2.53、WebKitGTK。

## 11. D04 动手前：气泡先要说清它不是什么

路线图给 D04 的闸门是三句话："完整消息/时间/OID；键盘和鼠标可用；不显示 diff"。
§2 留给 D04 的那条事实已核实（`%B` 就在 payload 里，`CommitView.message`，
`history.rs:24` 的 `LOG_FORMAT` 第九个字段，去掉尾部换行后原样交给前端），
所以"气泡要不要再读一次 Git"这一问在今天就有了答案。但闸门那三句话没有定义气泡**是**什么，
而它的形状只能从它不是什么推出来。下面五条是写代码之前定的边界，
每条都留了一个事后会被人当成 bug 的反例。行号仅作导航。

### 11.1 现状：今天没有浮层，只有三处 `title`

代码事实（读出来的，不是记得的）：

- 节点上的原生 tooltip：`views/history.ts:607-609` 给每个 `.graph-node` 挂一个 `<title>`，
  文本出自 `graphTooltip()`（`:498-513`），内容是"作者 — 主题"加一句
  `Included in: <载入的历史里包含这个提交的 ref tip>`。
- 行上另有两处 `title`：`commit-subject`（`:848`）与 `commit-author`（`:849`），
  理由是那两格会被省略号截断。
- 完整消息、时间、OID、文件列表都在**点击之后**停靠的 `.history-detail` 里
  （元素 `:147`，填充 `:286-342`）。
- 复制只有一条路：`copyOidNow()`（`:357-367`）写 `navigator.clipboard`，
  失败就把整串 id 打进状态行。
- 行本身不可聚焦：`listPane` 是唯一的 `tabIndex=0`（`:137-142`），当前行靠
  `aria-activedescendant` 指认（`:878-882`），方向键在 pane 的 `keydown` 里
  （`:948-983`）。

所以 D04 不是给已有的气泡补功能，是把一个只有操作系统延迟、只有操作系统排版的
`<title>` 换成面板自己的浮层。换的前提是新浮层必须**接管旧 tooltip 那句话**——
`Included in` 是节点唯一说得出"我在哪些分支上"的地方，撤掉 `title` 而不接住它，
就是把 CHANGELOG 已经承诺的一件事悄悄收回去了。

### 11.2 边界一：一次悬停不起 Git 进程

`commit_files`（`history.rs:1077`）是一条 `git diff-tree`，**每提交一次进程**。
它今天已经被方向键白白付掉了：`setSelected`（`:255-260`）在选中变化时开详情面板，
于是按 ↓ 走 30 行就是 30 个 Git 进程（§11.5）。气泡按定义不能有文件列表——
不是"文件列表算 diff"（路径列表不是内容，`diff` 那条界在别处守着），
而是悬停不付费：一条规则说得出"鼠标扫过一列提交"和"起了一串子进程"之间的关系，
这条规则就把气泡的内容定死了。

于是气泡的内容就是闸门要的三样，加一句节点原来说的话：

| 行 | 来源 | 为什么是它 |
| --- | --- | --- |
| 完整消息 | `commit.message`（`%B`） | 行上只有主题；这一行是气泡存在的理由 |
| 作者 + 时间 | `commit.authorName`、`commit.authorDate`（`%aI`，完整 ISO） | 行上日期被 `slice(0, 10)` 截成日；时间那一半只有气泡给到分秒 |
| 完整 OID | `commit.oid` | 行上是 `slice(0, 7)`；详情面板要点击才有 |
| Included in | `refsIncluding()`（`:498-513` 那段现成的） | 接管 `<title>` 的唯一出口，见 §11.1 |

committer 名与 commit 日期不进气泡：详情面板有，且"谁写的、什么时候"这一问只需要一个时间。

### 11.3 边界二：浮层归视图，不归行

`renderRows()`（`:822-883`）每次滚动、翻页、过滤、选中都 `rowsHost.replaceChildren`
（`:863`）。气泡如果挂在行里，就跟着行一起被换掉——这不是能修的 bug，是虚拟列表的定义。
所以气泡是 `.history-view` 的直接子元素（与 `listPane`/`detail` 同层，`:149` 那条 append 链上），
`position: absolute`，`.history-view` 加 `position: relative`。

不走 `.menu.float` 那条 body + `position: fixed` 的路（`dom.ts:170-214`）：
body 上的浮层不属于视图，切到 Settings 时 shell 只是把 `view.element.hidden` 置起来
（`shell.ts:428-431`），留在 body 上的气泡会替一个不在屏幕上的页面继续挂着。
挂在视图里，隐藏与销毁都跟着视图走。代价是 `.history-list` 有 `container-type: inline-size`
（`style.css:519`），而它意味着 layout containment——所以气泡**不能**放进那个滚动框里，
否则既被它的 containing block 定位，又被它的 `overflow` 裁掉。

### 11.4 边界三：身份是 oid，不是行号

行 id 是 `commit-row-${index}`（`:837`），`visible` 会被过滤、翻页、刷新换掉内容。
浮层记下的是 `(index, oid)`，每次行重建按 `anchorRow(visible, index, oid)` 重新确认：
那一行还在、且仍写着同一个 oid，才重画；否则**收起，不追**。
"追"是这里唯一会让面板说谎的失败模式——气泡跟着屏幕位置走到下一条提交上，
说出的就是上一条提交的消息配下一条的 id。这条就是 §2 留的那一句
（虚拟行回收后气泡不跟到别提交的 oid）。

### 11.5 边界四：键盘那条路要改的既有行为是方向键

闸门说"键盘和鼠标可用"。今天键盘能拿到同样的三样事实（方向键 → `setSelected` →
详情面板），代价见 §11.2：每次按键一个 `commit_files` 进程。让气泡在键盘路径上
"也出现"，就会出现两个面板同时说同一件事；真正该改的是方向键顺手开详情面板这件事本身：

- **方向键 / Home / End**：移动选中，气泡跟着当前行走（无延迟——按键是有意动作，
  §2 那条 250 ms 是给鼠标的，不是给键盘的）。不再开详情面板，不再起进程。
- **Enter / 点击**：打开详情面板（含文件列表），保持今天的样子。

这是一次行为变更，不是纯加法，所以写在这里：它把"看一眼"和"打开来干活"分成两条路，
前者不付费、后者付费；`revealScroll` 那段（`:981`）与 `aria-activedescendant` 都不动，
所以 AT 与滚动可见性走的是同一条老路。反例也要记下：只看方向键的人从此不会自动看到文件列表，
得按 Enter——这正是分界要的效果。

### 11.6 边界五：气泡里没有控件，复制不归它

气泡是 hover 面，指针一离开就收；在里面放"复制"按钮，等于放一个用户点不到的按钮。
两种解法都试想过：延迟收起（多一个要解释的计时器常量）与零间距相接（气泡盒贴着行盒，
指针从行移到气泡不经过第三块区域）。选了零间距，但**只**为了让 `oid` 那行可以被选中复制，
不放任何按钮：剪贴板那条路仍归详情面板的 Copy OID（唯一写 `navigator.clipboard` 的地方，
`ipc` 面与状态行文案都不变）。理由：`oid` 是一串 40 个字符，选中它比记住一个快捷键便宜，
而"复制"这个词在面板里只能有一个出处，否则两处按钮的失败文案会长歪。

`title` 的撤除随之定死：节点的 `title` 被气泡整句接管（`:607-609` 删），
`commit-subject`/`commit-author` 的 `title` 也删（`:848-849`），因为完整消息与作者名
现在都在气泡里——留着会出现原生 tooltip 压在自定义浮层上面，那是同一条信息被两种排版说两遍。
ref chip 上的 `title`（`:634`）**留**：它说的是"这个标记是什么种类的名字"，
与气泡那句"哪些 tip 包含这个提交"是两件事。

### 11.7 视口避让的规则，写成纯函数

面板最小 340 CSS px 宽（AGENTS.md 的出厂宽度是 720），气泡带 40 字符 id，
必须既能贴在行下，又不会盖住指针或跑出框。这条几何放进 `historyModel.ts`，
不碰 DOM，好让 `node --test` 钉住（同 §8.4 那三条 `graphPan` 断言的待遇）：

| 步 | 规则 | 为什么 |
| --- | --- | --- |
| 1 | 宽高都先按 pane 的内框封顶 | 高一旦被封顶，"上下都放不下"就只剩 pane 高度不足一种可能 |
| 2 | 默认贴行下、左边对齐行的左边 | 指针在读行，浮层出现在它下面而不是遮住它 |
| 3 | 下面放不下就翻到行上面 | 一行贴列表底部时的常态 |
| 4 | 两边都不够（气泡高于剩余空间）：选空间大的一侧，并把顶边夹进 pane，同时报告压住了锚行 | 不假装放得下；`overlaps` 是可见事实，不是内部状态 |
| 5 | 左右同样夹进 pane 内框 | 横向平移过的图（§8）与窄窗口都从这一条走 |

### 11.8 收起气泡的路径，穷举

滚动（`:924-926` 那个 passive 监听已经在重建行——气泡跟着行追会让指针底下的东西动起来，
而滚了就是不再读这一行）、行重建后确认不上（§11.4）、指针离开行且不在气泡里、
焦点离开 pane（§11.5 的键盘路）、Escape、`sync()`（换历史）。
每条路都必须把定时器与 DOM 一起收，不留一个"下次 hover 先闪一下"的尾巴。
shell 的 `escapeStack`（`shell.ts:250-254`）只管 app-bar 菜单与 overlay，
气泡的 Escape 归视图自己，理由同 §11.3：它是这个页面的东西。

### 11.9 留给探针的

纯几何测试钉住 §11.7，真实 Git fixture 钉住 §11.4（回收后不追），
第三条证据得在真 WebView 里量（同 §8.5 那条 `graph-pan-engine-probe.ts` 的口径）：
250 ms 之前不出现、方向键路径无延迟、`commit_files` 的发射次数在走 20 行之后不涨、
窄窗（340）下气泡仍在 pane 里。§11.5 那句"每次按键一个进程"目前是读代码读出来的，
探针跑过才算实测。

## 12. D04 落地：气泡是什么，以及它在引擎里量出来的数

三条提交各留一段：切片一是纯几何与身份（§11.7 那五行 + §11.4 那一条），切片二是视图接线与样式
（§11.2/§11.3/§11.5/§11.6/§11.8），切片三是探针（§11.9）。行号仅作导航，取落地时的树。

### 12.1 先分开的是状态，不是界面

§11.5 要把"看一眼"和"打开来干活"分家，而今天这两个动作共用一个 `selected`。所以视图里先立两根
指针：`selected`/`selectedIndex` 是**光标**（键盘与悬停读的那一行），`opened` 是**打开的详情面板**
（`views/history.ts:300-319`）。`openDetail()` 是唯一的开面板入口，它先 `closeBubble()` 再移动光标，
于是点击不会留下一个"面板与气泡各说一行"的中间态。凡是原来读 `selected` 的面板读者——九个动作按钮、
`renderActions()`、`copyOidNow()`、`paintDetailNames()`、`showDetail()` 的过期答复守卫、splitter 拖拽
——一律改读 `opened`；`runCommitDiff()` 改成显式收一个 `CommitView`，双击因此不可能作用在一条早已
移走的光标上。这一条不是洁癖：分家之后 `selected` 每按一次键都在动，任何还读它的面板动作都会在
下一次键之后拿错提交干活。

### 12.2 纯函数与它们的测试（切片一）

`historyModel.ts` 的气泡一节（`:411-539`）：`BUBBLE_HOVER_MS`（`:411`，250 只在这一处出现）、
`Rect`（`:417`）、`BUBBLE_INSET_REM`/`bubbleInsetPx`（`:428-432`）、`BubbleSize`/`BubblePlacement`
（`:434-445`）、`placeBubble`（`:466-519`）、`anchorRow`（`:521-529`）、`includedInLine`（`:535-539`）。
`app/tests/history-model.mjs` 加 7 条（`:784-880`），`npm run test:fixture` 338 → **345**：

- 落点：贴行下、左边对齐；向上翻也是贴的（`flipped.top + flipped.height === row.top`）——两箱之间
  没有缝，指针走在两箱之一上，§11.8 的 `:hover` 复查才有意义。
- 封顶：宽与高都按 pane 内框收，收的结果是气泡被推离行的左边也要留在框内。
- 两侧都不够：选大的一侧并夹进 pane，且**承认**它盖住了行（断言写成几何：`top < 124 && top + height > 100`）。
- 行的位置怎么变，箱都在框内；行没画出来（虚拟窗口外）时 `placeBubble` 收到的是缺锚点，不是猜一个。
- 身份：同一 index 换了 oid 就是 `null`；`includedInLine` 把"names 读失败"与"这条提交没人命名"分成两句。

### 12.3 与 §11.7 的一处偏离：`overlaps` 没有成为返回字段

§11.7 第 4 步要求"把顶边夹进 pane，同时报告压住了锚行"，并把 `overlaps` 列为可见事实。落地时返回类型里
没有这个布尔（`BubblePlacement` 只有 `left/top/width/height/above`）。理由不是省一次赋值：

- 第 1 步把高度封顶之后，"两侧都不够"只剩 pane 比气泡矮一种原因，而那一支写出的位置就是"贴着 pane
  内框的底"。压住锚行是这个位置的**结果**，任何拿到四个数的读者都能自己算
  `bubble.top < row.bottom && bubble.bottom > row.top`——探针正是这样断言的（§12.5）。
- 视图里没有一条分支依它而变：样式上"压住"不是一种态（气泡本来就带自己的边框与 `z-index`），文案上也
  没有。留一个恒为真的布尔在返回类型里，是给下一个读者一条他会以为需要处理的信号。

于是那句"报告"从返回字段改成了探针里的一句不变式：**要么与行齐平，要么盖住行，永不相离**。
§11.7 的字面因此按本节为准。

### 12.4 视图接线的五条路（切片二）

- **鼠标付等待，键盘不付。** `scheduleBubble()`（`:641-652`）在行的 `pointerenter` 上排一个
  `BUBBLE_HOVER_MS`；方向键/Home/End 那条（`:1174-1179`）直接 `openBubble()`。同一个函数
  `paintBubble()` 填那四行，两条路唯一的区别是等待。
- **换行不是刷新。** `scheduleBubble()` 先看清气泡是否属于另一行：属于别的行就立刻收起（旧答案不该在
  新 250 ms 里挂着），同一行就什么都不做。
- **视图自己造成的滚动不算读者离开。** `revealRow()`（`:543-556`）只在目标与当前不同时置
  `internalScroll`，并在赋值后读回 `scrollTop`：钳到端点的赋值不发事件，旗标留着会让读者下一次滚轮
  被当成"视图要的"，气泡就活得比它回答的那一行久。滚动监听（`:1100-1107`）吃旗标，否则收起。
- **指针走在两箱之间。** `retireBubble()`（`:658-667`）排一个 0 ms 的复查，读 `bubble.matches(":hover")`
  决定收不收；气泡自己的 `pointerenter`/`pointerleave`（`:1112-1116`）接在同一条路上。`listPane` 的
  `blur`（`:1184-1186`）同样先看 `:hover`——选中那 40 个字符会把焦点拿走，那不是"不再读这一行"。
- **行重建后重新确认身份。** `renderRows()` 末尾（`:1054-1058`）对 `anchorRow(visible, index, oid)`：
  认上就重画，认不上就收起，不追屏幕位置。`sync()` 与 `placeholder()` 一并 `closeBubble()`。

样式那一节（`style.css:641-…`）把 §11.3 与 §11.6 写死：`.history-view{position:relative}`（`:492`）是
唯一的 containing block；`.commit-bubble` 是 `position:absolute` + `z-index:20`、无控件、`overflow:hidden`；
`[data-side]` 把 accent 那条 2 px 边放在贴行的一侧，所以"哪一行被回答"不需要读文字就能看出来；
`.bubble-oid{user-select:all}` 让一次点击选中整串 id，而复制仍只有详情面板那一个出处。
撤掉的 `title` 是节点的与 `commit-subject`/`commit-author` 的三处；chip 上那句留，理由同 §11.6。

### 12.5 引擎里的实测：`tools/bench/commit-bubble-engine-probe.ts`

§11.2 那句"每次按键一个 `commit_files` 进程"到本轮为止只是读代码读出来的。新探针把视图在 WebKitGTK
里建两个舞台（720×640 与 340×400），派发真的 `pointerenter`/`WheelEvent`/`KeyboardEvent`/`click`，
并把 `window.setTimeout` 换成一个可拨的队列——于是"250 ms 之前不出现"是一次断言而不是一次等待，
而延时本身比的是模型导出的常量，两处手打 250 蒙对的可能被排除。25 条全过：

| 断言 | 实测 |
| --- | --- |
| 悬停后排着的定时器 | `[250]`，与 `BUBBLE_HOVER_MS` 同一个数；跑它之前 `hidden === true` |
| 跑掉之后 | `data-side=below`，在 pane 内，与行齐平 |
| 四行内容 | `the body no row draws for commit 3.`；`dev — 2026-09-01T10:11:12+08:00`；`3000…0`（40 字符）；`Included in: release-1.0, main` |
| 悬停的成本 | `commit_files` 发射 0 次；气泡内无 `button`；消息里没有文件路径 |
| 原生 tooltip | `commit-subject` 的 `title` 为 null，SVG 里没有 `<title>`；chip 仍是 `Branch release-1.0` |
| 离开与滚动 | 离开后收起（队列空）；读者一次滚动后收起 |
| 340×400 走 20 行 | `commit_files` 仍 0 次，详情面板 `hidden`，按键当下就出答案且队列空 |
| 同一段的几何 | inset 6 px，气泡被封顶到 300 px 宽；20 行全在 pane 内、全与行齐平（`covering = 0`，§12.3 那条退路在这个形状上没走到） |
| 翻转 | `below` 与 `above` 都出现过 |
| 身份 | 每一步气泡写的整串 id 都以那一行的 7 字符短 id 开头（夹具的 id 把序号放在最前，否则七字符全同，这条断言就是空的） |
| 键造成的 reveal | 保留气泡；紧接着第二次滚动收起 |
| 过滤 | `subject of commit 3` 命中 11 行，index 0 换了提交 → 收起，不追 |
| 付费的两条路 | 一次点击 `commit_files` 0→1，之后两次方向键仍 1，`Enter` 1→2；详情 meta 里是 `2000…`（点击那一行）而不是 `4000…`（光标所在） |

复现：`/usr/bin/python3 ../tools/bench/webkit-engine-probe.py -v commit-bubble-engine-probe.ts src/style.css src/style/tokens.css`
（需要显示器、WebKitGTK 绑定与 `/usr/bin/python3`）。本轮全树门禁：`npm run build` 0 errors，
`npm run test:fixture` 345/345，`color-contrast.py` 与 `responsive-check.py` fails=0，
`graph-pan-engine-probe.ts` fails=0（D04 改的正是同一个视图，那条探针是它的回归网）。后端一行未动，
因此 `cargo test` 与本轮无关，也没有新命令进 `ipc-surface` 的四张表。

### 12.6 残差

- **`coversRow` 那一条退路没被走到。** 340×400 下 20 行全都能翻上翻下，"pane 比气泡矮"只在更高的
  消息、更大的界面缩放或更矮的窗口上才成立；本轮探针允许它并数出 0 次，也就是说它是从模型测试
  （§12.2 第三条）知道的，不是从引擎看见的。
- **`blur` 那条路没派发过。** `listPane` 失焦收起、`:hover` 例外（`:1184-1186`）是读代码的结论；
  真机上"选 id 时焦点被拿走"需要一次真实点击与选择，探针给不了选择状态。
- **`.bubble-message` 的内滚动没量过。** `max-height: 7rem` + `overflow-y: auto` 是为一条几千字的
  消息准备的，本轮夹具的消息是三行。封顶后的气泡高度是否仍在 pane 内是算术，画面上是否读得动不是。
- **250 ms 是"等一个定时器"，不是"这个延时合适"。** 前者可测且测了；后者是手感，没有任何通道能测。
- **`layout-probe.mjs` 本轮没跑**（它要 WebKit 远程检查端点，本会话拿不到：`ECONNREFUSED 127.0.0.1:9222`）。
  因此"气泡压在列表上而不被裁"这一条只有本探针的矩形证据，AT-SPI 那边没有新断言——AGENTS.md 记着
  AT-SPI 没有 z-order，本来也看不见这一层。
- **Windows 与 macOS 仍只是构建配置。** 上面的每个数来自 Linux 宿主、Git 2.53、WebKitGTK。
