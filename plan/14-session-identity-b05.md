# B05 会话身份与请求代次

任务：B05 — 建立 sessionId/请求代次；定义数据域接口；更新 `types.ts`、session/main 命令和 IPC 测试。
验收口径（路线图）：“两个具有相同 HEAD 的仓库切换后旧请求不污染新会话”。
前置：B04 完成于 `6d26df5`（仅本地范围收敛，见 [B04 记录](13-local-scope-b04.md)）；按域订阅与内容键的口径来自 [B03 记录](12-two-tab-panel-b03.md)；身份设计来自 [详细设计 §3.1](02-design.md)。

## 1. 采用的结构决定（实施后续阶段不再自行解释）

- **身份由后端铸造，前端只携带与比较。** `SessionState` 新增 `next_session: AtomicU64`，`publish` 在**非 guard** 分支（open、重开、恢复）取一个新号并把两个代次归零；guard 分支（refresh/watch）保留会话自己的号，只推进真正动了的那个域。前端没有任何一处能从 Git 字段推出身份，`types.ts` 里 `ReadContext` 就是这一句话的形状：`{ sessionId, generation: number | null }`。
- **`version` 不承担身份。** 版本号仍是全局单调的写凭据，`snapshotBus` 的域键里已经没有它：同一份内容换一个版本号不是变化（B03 已定），同一份内容换一个会话**是**变化。这两件事此前被同一个键混着处理，现在由两个不同的数各自说一次。
- **代次按域而非按请求计数。** `history_generation` 的输入是 `(branch name, head_state, oid)` 三元组；`refs_generation` 的输入是这三元组**加上** `upstream / ahead / behind / operation kind`——头一动，names 必然跟着动，所以 refs 的推进条件包含 graph 的。B04 记录第 4 节要求“改键的来源，而不是删掉这些字段”，这两组输入就是那句话的落地：字段仍被读，只是读它们的地方从 `snapshotBus` 搬到了 `publish`。
- **一个没有任何会话报告过的名字既不推进 graph 也不推进 refs。** 例如只在别的提交上的 tag。选择层因此仍在**打开时**读一次；本阶段没有为它新增第三个计数器。
- **回声才是闭合的一半。** `SessionRead<T> { context, value }` 把请求所依据的那个上下文原样送回。只带请求不带的场景是真实存在的：一次为仓库 A 合法发起的读取，可以在用户已经打开 A 的**克隆** B 之后才返回——同 head、同分支名、同提交，前端无从分辨，只有答案里那个会话号能把它丢掉。
- **`ReadDomain::Session` 是给“没有归属域的列表”留的正当出口**，不是一个待填的槽位：`stash_list`、`list_worktrees`、`submodule_status` 绑会话本身（`generation: null`），刷新不让它们失效，换会话才失效。本阶段**没有**为搜索发明 `queryId`（属 E），也没有为活动监控发明 `activityGeneration`（属 C）。
- **校验落在 `bind_read(asked, domain)` 一个函数里。** 没有会话是 `read_no_session`，会话或代次不匹配是 `read_stale_context`；原先 `history_no_session`、`refs_no_session`、`stash_no_session`、`submodules_no_session` 四个各自表述同一件事的错误码一并收掉。
- **工具通道仍然独立，但先绑再占道。** `extools::execute_commit_diff` 在 `state.begin()` **之前** `bind_read`：为一个已经不存在的会话开差异窗口，不该先占住那条本来就不允许第二人进入的通道。测试直接断言被拒时 `begin()` 的计数仍是 1。
- **写面的绑定一点没动。** 写命令继续吃 `snapshot_version`（全局单调，所以旧会话的版本号在新会话里永远配不上），破坏性操作继续吃一次性票据。会话身份不进写路径，是划分而非遗漏。

## 2. 命令面按“绑定什么”四分

`ipc-surface.mjs` 新增一组断言，把每个注册命令归进恰好一组，并从**真实签名**上核对，而不是从一张名单上相信它：

| 组 | 签名必须包含 | 成员 |
| --- | --- | --- |
| 绑定读 | `context: session::ReadContext` + 返回 `SessionRead<…>`，且前端每个字面量 invoke 都传 `context` | `history_page`、`commit_files`、`open_commit_diff`（Graph）；`list_refs`、`show_tag`（Refs）；`stash_list`、`list_worktrees`、`submodule_status`（Session） |
| 快照绑定写 | `snapshot_version: u64` | 28 个写与 preview |
| 票据绑定确认 | `nonce: String` | 8 个破坏性确认 |
| 显式豁免 | 不得出现 `context` | 14 个：建立/结束/刷新会话本身、窗口与设置、探测、取消通道 |

豁免写成清单而不是启发式规则，理由与 B04 的反向断言同类：“它显然不需要绑定”正是**一个读仓库的端点悄悄带上了零个仓库线索**的那条路。清单带自检（绑定读 ≥5、豁免 ≥10、四组互斥且并集等于注册面），清空任何一组都会在这里报错，而不是把绿灯送给空集合。注册命令数仍为 58，本阶段既没有新增也没有删除端点——改的是它们的签名。

## 3. 前端三处重新推导被一次替换

B03 之后，`snapshotBus` 的 `refsKey`、graph 键和 `history.ts::graphIdentity()` 各自从快照字段里重新算了一遍“这是不是另一个仓库”，其中两处把 `repo.openPath` 当身份用。现在三处统一成 `readContextFor(snapshot, domain)` / `sessionContext(snapshot)` / `contextMatches(asked, answered)`：

- `history.ts`：`graphContext` 取代 `repoKey` 与 `graphIdentity()`；分页与详情各在发起前抓一次 `asked`，返回时同时校验“界面还停在这个上下文”和“答案回声一致”。顺带补掉一个真实缺口——`sync()` 的会话结束分支以前不清 `graphContext`，一个晚到的分页可以落在已经关闭的会话上。
- `branches.ts`：`syncedVersion` 换成 `syncedContext`；关闭会话时 `listing` 一起清空，否则一次 filter 键击会把上一个仓库的名字重画出来。
- `stash.ts` / `worktrees.ts`：这两个模块仍按版本触发重读（它们的列表没有归属域，代次也告诉不了它旧不旧），但**问**的时候带 `sessionContext`，答案只认会话号。触发口径不变、凭据换成身份，这是本阶段对遗留模块唯一的要求。

## 4. 验证

| 门禁 | 结果 |
| --- | --- |
| `npm run build`（tsc --noEmit + vite） | 0（JS 81.63 kB / CSS 29.52 kB，B04 为 81.78 / 29.52 kB） |
| `npm run test:fixture` | 144/144（B04 记录 139：`snapshot-bus` 重写为身份口径，`ipc-surface` 新增四组绑定断言） |
| `cargo fmt --check` / `cargo clippy --locked --all-targets` / `cargo test` | 0 / 无 warning / 256 通过（B04 基线 249 + 7：`session.rs` 4、`extools.rs`/`stash.rs`/`worktrees.rs` 3） |
| `color-contrast.py dist/assets` / `responsive-check.py` | fails=0 / fails=0 |
| `tools/bench/read-budget.mjs` | fails=0（21 项，B04 为 17 项） |

Rust 侧的**真实 Git** 证据不只是临时目录：`a_clone_shares_a_head_but_never_a_session` 用 `git clone` 造出第二个仓库，断言两者 head oid 相同、`session_id` 不同、旧上下文被拒。`only_the_domain_whose_input_moved_advances` 与 `an_unowned_listing_is_bound_to_the_session_alone` 钉住推进条件与 `generation: null`。

`read-budget.mjs` 是本阶段的运行证据所在，因为“旧请求不污染新会话”只有在真 bundle 的异步里才可观察。改动：

- 桩表按新协议应答（`{ context: A.context, value: … }`），并清掉 `list_remotes`、`pull_default`、`diagnostics_summary`、`set_always_on_top` 四个已退出或不存在的名字——留着它们，探针会以为前端还在调用一套并不存在的接口。
- 驱动改成**按后端发布的方式**移动快照：`__MOVE__(domain, patch)` 换对应域的代次，`__OPEN__(patch)` 换会话号而 Git 形状字段一字不改。只改 `branch.oid` 而不动代次，现在正确地什么都读不到——那正是新协议要证明的事，所以旧驱动必须一起改，不能留着当“仍然有效”的证据。
- 新增两项：同 head 的第二仓库两个域各读一次；一次被扣住的读在新仓库已经上屏之后才放行，图里既没有出现旧仓库那一页的文字，行数也停在**新**那一页的 21 行。
- 反向对照（临时副本，不入库）：把桩里的回声代次改成 `asked + 1`，`the new repository's page is what the graph shows` 立即变红（0 行）。这两项是一对——只断言“旧内容没出现”会因为什么都没画而假绿，所以前一项先要求确实画出了新页。

## 5. 与并行开发的对齐

未触碰 `plan/03-roadmap.md`、`plan/08-gate-baseline-a02.md`、`plan/09-activity-contract.md`。本阶段改的正是快照/版本协议，因此与 C、E 两条线的交界面在这里说清：

- **C（活动监控）**：`activityGeneration` 属于 C，不在本阶段预埋；接入方式已经留好——新增一个 `ReadDomain` 变体、在 `publish` 里给它一个推进条件、在 `ipc-surface` 的绑定读名单里加名字即可。C 若要把活动状态放进快照，需要同时决定它算不算 `refs_generation` 的输入；本阶段的 `refs_input` 只看 operation kind，不含活动事件。
- **E（统一搜索）**：搜索的 `queryId` 同理未预埋。`ReadContext` 的 `generation` 是 `Option<u64>`，`null` 已经有一个正当含义（无归属域），E 不要把它读成“待迁移的 0”。
- **A02 门禁基线**：`ipc-surface` 的注册数与断言数变了（同一条命令面的签名变化），A02 里按名字引用命令的段落若与本文冲突，以本文为准并需要一次同步。

## 6. 已知缺口

- 身份只在**进程内**有意义：`next_session` 不落盘，跨重启没有连续性。一次性票据的 nonce 同样如此，这是刻意的——落盘的身份会变成可预测的数，而它唯一的用途是丢弃自己进程里的晚到答案。
- 三个遗留列表（stash / worktrees / submodules）仍**按版本**触发重读，只有身份是新的。它们彻底下线后这套 `ReadDomain::Session` 出口可能只剩零个使用者；那属于迁移收尾，不要在本阶段预判。
- 桌面探针 `layout-probe.mjs`、`view-smoke.py`、`narrow-smoke.py` 仍指 B01 之前的结构与键；本阶段只更新了 `read-budget.mjs`。留给 B06。
- 运行证据仍来自同一台 Linux 主机（Edge headless 154 的 CDP），WebKitGTK 上的读取预算没有重新量过；Windows/macOS 仍只有构建配置。
- `commit_files` 在 `NEVER_READ` 里，但探针没有点击过任何行，所以“选中提交后刷新不得重读详情”这条只由 `contextMatches` 的单元测试和代码路径保证，缺一条桌面侧断言。

## 7. 回退

回退 = revert 本次提交，**必须整体回退**。签名与前端调用点是同一件事的两侧：只回退 Rust，`invoke` 会带着后端不再接收的 `context` 参数撞上 `task_failed` 之外的“参数缺失”；只回退前端，绑定读的断言与 read-budget 的桩同时变红。没有数据迁移、没有对用户仓库的额外写操作。快照 JSON 多出的三个字段（`sessionId`/`historyGeneration`/`refsGeneration`）随 revert 一起消失，不留兼容分支——本仓库不承诺跨版本前端复用。

## 结论

同一 HEAD 的两个仓库现在有两个身份，晚到的答案带着它被问起时的身份回来，界面只认那个身份。路线图给 B05 的那句验收——“两个具有相同 HEAD 的仓库切换后旧请求不污染新会话”——在 Rust 夹具（真 `git clone`）、前端单元测试（回声比较的四种不相交形状）与真 bundle 探针（被扣住的分页在换会话后放行）三层各自被断言一次，并附一条反向对照说明探针确实会红。
