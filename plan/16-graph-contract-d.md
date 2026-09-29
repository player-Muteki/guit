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

- **D02**：`refs_input`（`session.rs`）= `(graph_input, upstream, ahead, behind,
  operation.kind)`，**不含 tag 集合、不含分支集合**。按 `publish` 的算法，
  在一个已有提交上新打 tag 既不动 `head_moved` 也不动 `names_moved`，
  于是 `refsGeneration` 与 `historyGeneration` 都不 bump——绑定 Refs 域的读取不会被
  拒绝，图上的 tag 标签也就不会自己更新。这是**从代码读出的结论**，D02 第一步要用
  一次真实刷新把它变成实测（`git tag` 之后 refresh，看两个代次计数）。
- **D03**：`topology()` 的 `-n start+limit+1` 意味着前缀随深度线性重读；先量
  `start=0/1000/2000/3000/4000` 的耗时表，再决定检查点形状。列标识是 `u8`
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
"this operation must be run in a work tree"）。可选的替代是 `git clone --bare`
一个本地路径，但那会把 clone 这个动作写进产品源码树，与 AGENTS.md 的仅本地范围
相冲（测试夹具不是产品入口，但也不必为此引入一个更容易被误读的形状）。落地的做法
是普通仓库提交完之后 `git config core.bare true`：同一份对象库、没有工作树，
`rev-parse` 与 `log` 都照常答（实测 `--is-bare-repository` 为 true、历史两行）。

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
- **深页代价照旧。** 拓扑读仍是 `-n start+limit+1`，`remote_names` 仍是每页第三个
  进程。D03 前不引数字。

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
