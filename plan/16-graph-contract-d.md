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
  `docs/known-limitations.md` 未新增条目，因为这个码在真实 WebView 里没有跑过。
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
的东西记在哪"的登记处，那个文件现在不存在了；D02 的未验证残差因此只写在 §5.4 与本节里。

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
