# 阶段 F 契约依据与记录：提交、单文件清理与干净重置

实施日期：2026-09-30。基线提交：`e9c5a1a`（阶段 D 的 D05 收口之后）。本文既固定
F01–F06 必须遵守的口径，也是它们各自的实施记录。§1–§3 是动手前先拿到的事实，
§4 是 F01 的落地（`9e3cac4` 后端、`29be513` 前端、`a20a0e4` 收口），§5 是 F02 的落地
（`67cdd7a` 测量、`12a718b` 实现、本次收口），§6–§7 是 F03 动手前先拿到的测量与由它们
倒推出的构造规则（`tools/bench/clean-reset-probe.py` 复现 §6）；F03 之后的落地各起一节，
写到时才存在，不要按编号去找还没有的小节。

主机条件同 [A01 基线](05-baseline-a01.md)：Linux x86_64、Git 2.53、WebKitGTK、
Node 26、rustc 1.96.1。**本文没有 Windows/macOS 证据**，那两个平台仍只是构建配置。

并行开发状态：阶段 E 在同一棵共享工作树上推进。收口 F02 时 E03 已落（`0295068`），在飞的是
`app/src-tauri/src/{fuzzy,main,search}.rs`、`app/src/searchModel.ts`、`app/src/views/history.ts`
与 `app/tests/ipc-surface.mjs`；§6 这一轮量完之后他们落了 E04a（`988bc5e`：新增
`app/src/views/search.ts` 与 `app/tests/search-wiring.mjs`，改了 `main.rs` 的注册表、
`main.ts`、`style.css`、`style/tokens.css`、`views/{history,mainPanel}.ts`、
`tests/{ipc-surface,search-model}.mjs` 与 `tools/bench/responsive-check.py`），下一刀 E04b
要动的就是 `views/history.ts` 上 `/` 挂着的那一处。本文的所有度量只针对**已经提交**的状态，
阶段 F 的每次落地只 `git add` 自己改过的那些路径。
本节的量完之时那张交付表也是共享的：属于阶段 F 的索引行先被他们那次提交（`988bc5e`）连着
他们自己的两行一起带进了历史，表里剩下的两处阶段 F 改动由本次提交写下——共享文件上的顺序
不是谁的失误，但它意味着 `git add` 之前先看一眼 `git status`。

一次记录在这里，因为它改变的是整棵树的门禁读数：收口 F01 时 `npm run test:fixture` 是红的，
红的不是阶段 F 的用例——`tests/search-model.mjs` 从 `searchModel.ts` 导入了一个当时还没有的
名字，整个文件在装载期就失败，于是 `node --test` 的汇总少了它全部的用例，看起来只是"总数
变了"。那次运行用排除该文件的办法证明阶段 F 自己全绿（369 通过、0 失败），排除项与被排除的
文件都写在这里；共享树上跑门禁时，先看清红的是谁。

收口 F02 时红的有两处，也都不属于阶段 F：`npm run build` 停在
`src/views/history.ts`（一个当时还不存在的 `anchorOid`，和 `HistoryView` 上那个还没被实现的
`reveal`），`tests/ipc-surface.mjs` 报 `search_repository is registered but no literal invoke
names it`——那正是 E03 收口行写明的"命令注册必须与它的前端调用者同一次提交"这条门槛在在飞
状态下应有的红。这一次不再靠排除法自证，而是把度量整个搬到 detached worktree 的 `12a718b`
上跑：build 45 modules、fixture 389 通过 0 失败、cargo test 373 通过 0 失败、两道样式 gate
fails=0。**共享树上的红不等于 HEAD 上的红，而 HEAD 上的读数才是本文引用的读数。**

## 1. 四条现有出口，今天各自兑现到哪一步

`OUTLINE.md` §5.1/§5.2 与 [设计文档 §7](02-design.md) 已经把 G05/G06 写清楚。落到
代码前先把"现在到底做到哪"量出来，否则 F 阶段的六条会被读成六件新事，而其中三件
其实已经成立、两件半成立、只有一件是全新的。逐条给证据。

| 契约句子 | 今天在哪 | 兑现到什么程度 |
| --- | --- | --- |
| 提交只包含已暂存的更改，不隐式暂存 | `write.rs:702-707` 的 argv 是 `commit -F <0600 临时文件>`，可选 `--amend` | **成立**。没有 `-a`、没有 `--only`、没有任何 `add`；后端从不解析文件 id，只调 `sessions.commit_context(version)` 取工作树根 |
| hooks/签名失败保留草稿 | `changes.ts:264-270`：`outcome === "success"` 才写 `commitMessage.value = ""` | **成立**，但只在同一份文本里成立（见下） |
| 刷新不清空提交草稿、不夺焦点 | `changes.ts:451-460` 的 `render()` 只切 `disabled`/`hidden`，从不写 `.value` | **成立**。但同一件事在**换仓库**时也成立，这一条不是"成立"，是没设边界 |
| 丢弃/清理先展示准确影响范围再确认 | `preview_discard`（`write.rs:748-800`）/ `preview_clean`（`write.rs:955-991`）→ 一次性 nonce → `confirm()` 重查 | **成立**。二者都从一次全新的 Git 读重算候选，绝不采用前端交回的名单 |
| 更改区提供提交号输入栏与重置按钮 | 没有。重置今天只有图侧详情面板的三个按钮，`target` 永远是后端刚读出来的完整 oid（`history.ts:299-307`） | **全新**，F06 的活 |
| 支持可唯一解析的缩写 | `sequencer::validate_target`（`sequencer.rs:33-50`）只放行完整 oid 或**恰好等于某个 `refs/heads/` 名字**，缩写在此之前就被拒 | **不成立**，F02 的活 |

两件尚未被任何探针看过的事：

- **草稿跨会话**。文本框是建视图时造一次的（`main.ts:132`），`render()` 不改它，
  开另一个仓库也不改它——于是在 A 仓库写了一半的说明，换到 B 仓库之后仍然在框里，
  而 `Ctrl/Cmd+Enter` 是全局绑在文本框上的（`changes.ts:467-472`）。写进 B 的那一条
  不会触发任何拒绝：`snapshot_version` 只保证"这份快照还新"，换仓库恰好会拿到一个
  更新的快照。契约说刷新不清草稿，没说换仓库清不清；**不写清就把一个能静默把话写进
  另一个仓库的输入框留下**。
- **一个未跟踪文件没法单独删**。行的 `⋯` 菜单对未跟踪项只给 `Open`（`changes.ts:345-364`），
  `discardEligible` 明确排除未跟踪（`changes.ts:136-137`），未跟踪那一组的标题上有
  `Clean…`（`changes.ts:309-316`），而 `preview_clean` 根本没有"是哪几个文件"这个参数
  （`main.rs:490-497`）。想扔掉一个编译产物，只能把整个仓库的未跟踪项一起端走。

还有一条是**注入面**，虽然今天没有已知的可达路径：软/混合重置把用户文本直接放进
argv 第三位（`reset.rs:145`：`["reset", mode.flag(), target]`），这一路没有 `--`
分隔（`git reset` 的 `--` 之后是路径，不是 rev，加不了）。今天挡得住只因为
`validate_target` 先按形状把非 oid 非分支名的输入都拒了。F02 把"按形状挡"换成
"按 Git 解析出来的完整 oid 行事"之后，argv 里才真正不再有用户敲的那串字符。

## 2. 一个手打的提交号，Git 自己怎么答

`tools/bench/reset-target-probe.py` 在临时目录里造仓库（41 提交 + 一个附注标签），
把每种形状问一遍 Git，只打印它自己的 rc/stdout/stderr，**不断言**——这些答案随
Git 版本、对象数量和对象格式变，跑它是为了看见，不是为了通过。本节是这次运行
（Git 2.53，sha1 与 sha256 两个仓库各一遍）读出来的东西。

先说最容易答错的那一条。**"唯一"不是"全仓库只有一个对象顶着这个前缀"。**

| 我问的形状 | Git 答 `X^{commit}` | Git 答光秃秃的 `X` | `--disambiguate=X` 看到几个候选 |
| --- | --- | --- | --- |
| 完整 id | 0 | 0 | 1 |
| 只有一个提交顶着的 4 hex | **0** | 0 | 1 |
| 一个提交 + 一个 blob 共用同一 4 hex | **0（就是那个提交）** | 1 | 2 |
| 两个提交共用同一 4 hex（外加两个 blob） | **1** | 1 | 4 |
| 同一对提交被拉到 6 hex 才分开 | 0 | 0 | 1 |

第三行和第四行放一起才是结论：Git 按**它需要的那个类型**判唯一。一个前缀同时顶着
一个提交和一个 blob，`X^{commit}` 照样给出那个提交；两个提交共用前缀它才拒。所以
歧义判定只能问 Git（`rev-parse --verify --quiet <输入>^{commit}` 的 rc），**不能拿
`--disambiguate` 的候选数当裁判**——它数的是所有类型，上面第三行它会报 2。

其余几条：

1. **输入的地板是 4 个十六进制，而且不是 `core.abbrev` 给的。** `-c core.abbrev=40`
   之下一个 4 hex 前缀**照样解析成功**（`core.abbrev` 管的是 `--short` 输出的宽度，
   不是输入的下限）；`core.abbrev=3` 本身被 Git 拒（`error: abbrev length out of
   range: 3`，rc=128）。把对象数从 124 灌到 40,083，输入地板没动（4 hex 仍解析），
   `--short` 也仍是 7。**不要按 `core.abbrev` 判长短，也不要假设大仓库里 4 hex 会失效。**
2. 3 hex 与更短：`X^{commit}` rc=1，且 `--disambiguate` **一个候选都不报**（不是
   "0 个对象顶着它"，是"短到 Git 不看"）。所以"太短"与"查无此物"在候选数上同形，
   想分开必须自己按 4 这条线判。
3. 名字类一律能通过：`main`、`v1`、`HEAD`、`HEAD~1`、`HEAD^`、`@{0}` 在
   `X^{commit}` 下全部 rc=0。**Git 乐意接受 revspec，所以"只接受十六进制"这件事必须
   由 guit 在问 Git 之前做**，不能指望 Git 挡。
4. 非提交的对象：tree 与 blob 的完整 id 在 `X^{commit}` 下 rc=1，stderr 是
   `expected commit type, but the object dereferences to ...`；但光秃秃的 `X` 对它们是
   **rc=0**。也就是说**每次都必须带 `^{commit}` 去 peel**，只问 `X` 会把一个 blob 的 id
   当成合法目标。附注标签的 tag 对象 id 则会 peel 成它指向的提交（rc=0）。
5. 形状类噪声一律被拒：空串、纯空白、前后带空格、`--help`、`-` 开头的 hex、
   另一个对象格式的宽度（sha1 仓库里递 64 hex）、非十六进制。大小写例外：
   **全大写完整 id Git 接受**（`0F44...` → 解析成功）。

第 5 条与现有代码有一处出入：`history::valid_oid` 只认小写。这不是漏洞（更严），但
一个人从别的工具里复制出大写形式的 id 会被我们挡在 Git 之前。

## 3. 这些事实决定了 F02 怎么解析

1. **先用形状门，再问 Git**：去两端空白后，整串必须是十六进制、长度 4–64。这一道
   存在的唯一理由是把 revspec 与名字挡在问 Git 之前（§2 第 3 条）。大小写都放过去
   （§2 第 5 条），但**放过去的从来不是用户那串字符**：进 argv 与进票据的只能是
   Git 自己答出来的那个小写完整 oid。
2. **唯一性交给 peel**：`rev-parse --verify --quiet <hex>^{commit}` 的 rc 就是答案
   （§2 表）。不在 Rust 里自己数候选，因为数的口径必然和 Git 差（§2 第 1、3 行）。
3. **失败要分诊，且不靠猜**：rc!=0 之后跑一次 `--disambiguate=<hex>` 拿候选，再用
   **一个** `cat-file --batch-check` 批量问类型，数其中有几个提交——0 个报"这不是本
   仓库里的提交"，>=2 个报"这个缩写顶着 N 个提交"。诊断只在失败路径上花一条进程。
   分诊必须做，因为"太短"与"歧义"与"不是提交"在 Git 那里都是同一个 rc=1，把三者压成
   一句"找不到"就是 AGENTS.md 说的把一次读失败报成干净仓库的同一类错。
4. **两条重置路都用解析结果**：软/混合与硬重置都改成把解析出来的完整 oid 放进 argv
   （硬重置今天已经是 `reset.rs:319` 这样，软/混合不是 §1 末）。这一条把 §1 那个注入面
   从"按形状挡住"变成"结构上不可能"。
5. **不改 `sequencer::validate_target`**：merge/rebase 的目标确实可以是分支名
   （`sequencer.rs:30-32` 的注释就是这条），reset 的目标不行。共用的那一只按各自契约
   收紧自己那一份，别拿 reset 的规则去改别人的门。
6. **票据绑定的是解析后的 oid**，`Bound::ResetHard` 今天已经是这样（`target_oid`）；
   F04 新增的那个变体照同一口径，用户敲过什么字符串不属于绑定事实。

§2 是测量，本节是把测量变成规则。F02 动手前先读这六条；它自己的落地在实现时另起一节。

## 4. F01 落地：一次删除只碰它确认过的那一个

三个提交，边界各自闭合。`9e3cac4` 是后端那半边（pathspec 还原为字面量 +
`preview_clean` 接受文件集合并绑定它），`29be513` 是前端那半边（单行的删除入口、
票据续约、草稿的会话边界），本节末尾那条 busy 审计随收口提交进来。

### 4.1 先量到的那个缺陷：Git 把路径当模式读

票据绑定的路径是 Git 自己列出来的，所以它是**名字**，永远不是模式——但 Git 读一条
不带引号的 pathspec 时按模式读。在同一台主机、Git 2.53 上现量：仓库里
`s1.txt`、`s2.txt`、`s*.txt` 三个文件各自 dirty，

```
git restore --worktree -- 's*.txt'   →  三个全部回到 HEAD
git restore --worktree -- ':(literal)s*.txt'  →  只有 `s*.txt` 自己
```

也就是说：**确认了一个文件，丢弃了三个**，而且预览看不见——预览列的是路径。这条不
是假设出来的注入面，`write.rs` 里 `run_git_paths`（`write.rs:1159`）当时把
`FileId` 还原出的裸字节直接交给 `restore`/`add`/`clean`，凡文件名里带 `* ? [ ]`
或反斜杠的都是活的。

修法只有一处：`quote_pathspec`（`write.rs:1148`）把每条路径包成 `:(literal)`，
`run_git_paths` 与 `clean_candidates` 都从它过。`:(literal)` 早于 guit 支持的最低
Git 版本（`write.rs:1145` 的注释记着这条出处）。钉住的用例是
`discarding_one_file_never_reverts_a_file_whose_name_its_pattern_matches` 与
`a_file_name_that_is_also_a_pattern_cleans_only_itself`。

### 4.2 `preview_clean` 有了"是哪几个文件"这个参数

签名变成 `preview_clean(state, sessions, snapshot_version, file_ids)`
（`write.rs:985`），`file_ids` 为空就是原来那句"整个仓库的未跟踪项"，非空则先
`resolve_files` 再问 `git clean -nd -- <字面量路径>`。三件事跟着这个形状：

- **候选由 Git 判**。问 scoped 的那一条不只收窄列表，它同时改变了答案的形状：一个
  未跟踪目录里的单个文件，整体问会折成 `dir/`，按路径问就答 `dir/a.txt`（§4.1 那次
  测量里一并量到）。前端因此永远不必自己展开目录。
- **票据记下确认的是哪一句**（`Bound::Clean { paths, all_untracked }`，
  `write.rs:20-28`）。这两句的重查规则不同：整仓库那一句被"别处新冒出一个未跟踪文件"
  作废，scoped 那一句与之无关。这个差别从 `paths` 里读不出来，所以它是一个字段。
  用例是 `a_scoped_clean_is_not_undone_by_an_unrelated_file_that_arrives_afterwards`。
- **Git 不肯删的东西当场变成"未移除"，而不是换一条更狠的argv**。ignored 文件与嵌套
  仓库在 scoped 问法下根本不会出现在列表里；请求了它们就落进 `dropped`
  （`write.rs:1013-1017`），一个都没有时报 `clean_nothing` 并说清原因。
  `a_nested_repository_is_never_cleaned_and_never_promised` 钉住的是那句承诺：git
  要 `-ff` 才肯碰另一个仓库，guit 不加第二个 force。

`clean_nothing` 的文案跟着形状分成两句：整仓库那句是"没有未跟踪文件"，scoped 那句
说"选中的这些里没有能删的"——后者不能读成前者，否则就是把一次具体的拒绝报成一个
通用的干净。

### 4.3 前端：单行的删除、续约的两条路、草稿的边界

`state.ts` 把 `discard | clean` 那一支拆成两支，clean 多带一个 `allUntracked`
（`state.ts:47`），与后端的绑定字段同口径。理由是续约：一张按文件问出来的票据在
新快照里只能靠**名字**重新拿到 id（id 随旧快照死掉），而整仓库那一句的名字里可能
有目录折叠项，压根没有行指着它——所以"当初问的是哪一句"必须随票据走，不能从名字
列表里猜。仓库里恰好只有一个未跟踪文件时，两种问法的名字一模一样。

`idsForNames`（`fileModel.ts:177`）是那条不猜的规则：一个名字在新快照里对不上
恰好一条合格行，整张票据就撤回，而不是把活下来的那几个继续送去。它对不上有两个
方向——行没了，以及**两条行顶着同一个显示名**（`display_name` 是有损的，从原始字节
来，不保证回得去），所以重复是被检查出来的，不是被假设不存在的。这个函数与
`discardEligible` / `cleanEligible` 一起放进 `fileModel.ts`，因为**菜单给不给这个
动词**和**续约接不接受这一行**必须是同一个判断：两份拷贝就是删除动词悄悄换目标的
方式。`file-model.mjs` 里新增的六条用例钉住顺序、消失、重名、换了种类这四件事。

`changes.ts` 那一边：未跟踪行的 `⋯` 里多了 `Delete`（`cleanEligible` 判给不给，
`changes.ts:365-367`），分组标题上的 `Clean…` 继续问整仓库（`requestClean([])`）。
两条路都把 `currentFiles` 交给票据，否则续约没有可比对的名字表。

草稿那条是 §1 记下的第二个缺口。契约说"刷新不清草稿"，没说换仓库清不清；不写清
就留下一个能把话静默写进另一个仓库的输入框，而 `Ctrl/Cmd+Enter` 正绑在它上。
现在按 `sessionId` 划线（`changes.ts:471-476`）：刷新永不动它，换会话（含关掉仓库）
连文本带 Amend 一起清。这条之所以安全，全靠 `types.ts:69` 那个字段的定义——每次
open 都换、refresh 永不变——`changes-wiring.mjs` 因此同时钉住规则与它所依赖的那句
话。

### 4.4 busy 审计：一条能走到的静默拒绝，其余不可达

更改区每一个入口都有自己的忙判定。逐条走"用户真能走到吗"：可见的 Stage/Unstage、
分组批量按钮、横幅三键、提交按钮与文本框，都在 `render()` 里按 `isWriteRunning()`
关掉；`⋯` 按钮只按 `isToolRunning()` 关（`changes.ts:373`），因为工具通道与写通道
是两条道。**唯一还能走到忙判定的，是已经打开的 `⋯` 菜单里的 Discard/Delete**——
菜单项是打开那一刻建的，之后别处起来的一次写不会替它改灰。原先点下去什么也不说；
现在 `preview.request` 在写期间明确回报"A write is still running; this clean was
not asked."（`preview.ts:153-156`），并把剩下的两条守卫留在沉默里：确认框是
`showModal()`，页面在它背后是惰性的，没有会话时更改区也不在屏幕上——给走不到的状态
编一句话，是另一种说谎。

### 4.5 这一格什么没验

- **没有引擎探针**。`Delete` 打开的预览列的正是那一个文件、草稿随会话清除，这两条
  现在是源码门槛（`changes-wiring.mjs`）加纯模型用例（`file-model.mjs`）；渲染出来的
  菜单与对话框没有量过。更改区还没有探针，为这两条建一个的成本与它能看见的东西不成
  比例——被删掉的可能是整个未跟踪集，而那件事的证据在 Rust 侧的真实 Git 仓库里。
- Rust 侧是真实 Git：五条 scoped clean 用例在临时仓库里跑完 `clean -fd` 再查磁盘，写 `write::tests` 那一个过滤词就能只跑它们。
- 仍是本宿主（Linux x86_64、Git 2.53）。**Windows/macOS 没有证据**，`:(literal)`
  在别的 Git 构建上的行为也没量过。

## 5. F02 落地：一次重置走去 Git 自己说出的那一个提交

两个提交，一条量、一条写：`67cdd7a` 把"三种 no 拿什么分开"打进探针，`12a718b` 把 §3
那六条落成代码。六条逐条对照在下面；第 3 条有**一处偏离**，理由是两次测量，写在 §5.2。

### 5.1 形状门，和吃它的两条路

`shape_of`（`reset.rs:105`）在起进程之前把输入分成四类——空、非十六进制、短于四、长于
六十四——余下的小写化之后才交给 Git。四句 `reset_target_shape` 各自成文，"太短"那一句
直接说出 4 这个数：§2 第 1、2 条量到它既不是 `core.abbrev` 给的（`-c core.abbrev=40`
之下 4 hex 照样解析），也不能靠候选数和"查无此物"分开（3 hex 时 `--disambiguate` 报零
行）。所以这条线是 guit 自己划的，钉在 `MIN_TARGET_LEN`（`reset.rs:75`）上，注释指着那
次测量。

大小写放过去（§2 第 5 条），但**进 argv 的从来不是用户那串字符**：只有
`resolve_target`（`reset.rs:259`）返回的那个完整小写 oid 才是目标。软/混合在
`reset.rs:388` 取它，硬重置在 `reset.rs:434` 取它；票据绑的、`rev-list` 用来数丢哪些提交
的、确认列表上显示的（`short()`，十个字符）全是这一个值。§1 末那条注入面到这里不再是
"被形状挡住"，而是结构上不可能——调用点在类型上已不持有用户文本。

`sequencer::validate_target` 一个字没动（§3 第 5 条）：merge/rebase 的目标确实可以是分支
名，`sequencer.rs:30-32` 的注释记的就是这件事。收紧的是 reset 自己那两只入口。

### 5.2 唯一性问 Git；分诊为什么不是"一条 batch-check"

§3 第 3 条写的是"rc!=0 之后跑一次 `--disambiguate`，再用**一个** `cat-file
--batch-check` 批量问类型"。没照做，因为那条进程在 guit 里问不出来：`--batch-check`
只从 stdin 读 id（把 id 直接摆进 argv 是 rc=129），而 `runner.rs` 给每条进程强制
`Stdio::piped()` 并在 `close_stdin_after = Duration::ZERO` 处关掉——任何人还能往 stdin 写
之前，那个通道已经没了。探针把两种问法都打了出来：候选存在时 `one batch-check` 那行是
rc=0 且形状正确（`commit,commit,blob,blob`），**它对，只是我们喂不进去**。为一句拒绝的
话给三个缝里最窄的那一个加一条输入通道，代价不成比例。

也没走"`--type` 一次问出提交数"这条路：`rev-parse` 没有这个选项。
`--disambiguate=0f44 --type=commit` 把 `--type` 当普通参数回显进 stdout，同时以
`error: short object ID 0f44 is ambiguous` 的 rc=128 退出；四种参数摆法、两个对象格式都
试过（`type_filter`）。"一次进程直接给出提交数"这句话在 Git 里不存在。

于是分诊改成**每个候选一次 peel**（`why_absent`，`reset.rs:221`），上限
`TRIAGE_CANDIDATE_LIMIT = 16`（`reset.rs:83`）。它只住在失败路径上：成功的一次解析仍是
**一条**进程。本宿主量得一次失败的 peel 约 1.2 ms，含列表与三个候选的一次完整分诊
6.5 ms / 5 条进程。候选多于 16 个就不再数（`Absent::Crowded`，`reset.rs:214`），那句拒
绝说"这不是恰好一个提交"，不带一个我们没问出来的数字。

分诊自己还发现一条：候选里恰好数出**一个**提交，是两次读互相矛盾（peel 说"不是恰好一
个"，逐个 peel 说"有一个"）。那是关于这次读的事实，不是关于那个 id 的事实，所以报
`reset_target_unreadable`（`reset.rs:247`）。

### 5.3 三种 no 各有句子，读失败永远不是查无此物

| 代码 | 说的是什么 | 怎么知道的 |
| --- | --- | --- |
| `reset_target_shape` | 空 / 非十六进制 / 太短 / 太长 | 没问 Git |
| `reset_target_absent` | 没有任何对象顶着这个 id | `--disambiguate` 零行 |
| `reset_target_not_commit` | 有东西顶着它，而它不是提交 | 候选逐个 peel，零个提交 |
| `reset_target_ambiguous` | 两个及以上提交顶它（带真实数目）/ 候选多过 16（不带数目） | 同上 / 没数 |
| `reset_target_unreadable` | 进程起不来、输出被截断、列表不是完整小写 id、两次读互相矛盾 | 这四条都是"问不成" |

软/混合把拒绝写成 `Outcome::Rejected` 的一句话并且**不起进程**
（`reset.rs:390`，用例断言 `exit_code == None`）；硬重置直接返回错误，预览压根不开。
`AGENTS.md` 那句"一次读失败不能报成干净仓库"在这一格的形状是：把"问不成"说成"查无此
物"，就是把一次读失败讲成一个关于仓库的事实。

### 5.4 用例（真 Git，临时仓库，`cargo test … reset` 二十条通过）

- `reset_targets_are_validated_before_git`：`HEAD~1`、`@{u}`、`nosuchbranch`、
  `main extra`、`HEAD`、`main`、`v1`、空串、纯空白逐条被拒且 `exit_code` 为 `None`；
  一个形状完好却不存在的完整 id 在硬预览上是 `reset_target_absent`，而 `main` 是
  `reset_target_shape`——**票据不能绑一个今天指向某提交、明天指向另一个的名字**。
- `a_shape_gate_needs_no_git_to_answer`：不起仓库，只问分类。`de adbeef`、`deadbeeg`、
  `-deadbeef`、`--help` 都归 Noise，`abc` 短、`abcd` 过、64 个 `a` 过、65 个不过，
  `" 0F44 "` 与 `"0f44"` 同一类。门与进程隔开，才是"一次 Git 都没起"那句断言的依据。
- `an_abbreviation_names_the_commit_it_uniquely_names`：一个 4 hex 前缀打到那个提交，
  并且软重置回话里出现的是 Git 答出的完整 id 的前十个字符，不是敲进去的那四个。这条
  顺带钉住续约口径——预览会重读并抬版本，所以确认用的是预览返回的那个版本。
- `an_id_copied_in_upper_case_is_the_same_commit`；
  `the_id_of_a_thing_that_is_not_a_commit_is_named_as_one`：blob 的完整 id 要求
  `reset_target_not_commit`，且那句里不许出现 "does not exist"。
- `an_abbreviation_that_names_two_commits_says_so_with_their_count`：从拒绝的话里读出数
  目，要求 ≥ 2。

歧义夹具是 `colliding_commit_prefix`（`reset.rs:897`）：提交对象就是文本，于是手写
payload 交给 `hash-object -t commit -w`，两批各 1500 个、共两条进程（本宿主约 0.13 秒），
在返回的 id 里找第一个被两个提交共用的 4 hex 前缀；找到之后还要用 `--disambiguate` 复查
候选数 ≤ 上限才采用——否则夹具自己造出一条 `Crowded`，测的就不是数目。暴力等真哈希不在
测试里做。

### 5.5 这一格什么没验

- **还没有人能看到这些句子**。更改区的提交号输入栏与重置按钮是 F06；今天重置只从图侧详情
  面板那三个按钮到达，而它的 `target` 是后端刚读出来的完整 oid（§1 那张表就是这么记的），
  所以 `reset_target_shape`、`reset_target_ambiguous` 这几句在现有界面上不可达。句子先于
  入口存在是 F02/F06 的顺序决定的，不是漏了接线——F06 必须把它们接到人面前，并量渲染出来
  的那一句。
- **没有新的引擎探针**：这一格改的全是"Git 怎么答"，证据在 Rust 侧的真实仓库里；渲染出来
  的拒绝归 F06 一起量。
- 4 这个地板、16 这个上限、分诊的毫秒数，全是本宿主（Linux x86_64、Git 2.53，sha1 与
  sha256 各一遍）的量。**Windows/macOS 没有证据**，别的 Git 构建上"短于四是否仍报零候选"
  也没量过。
- §3 第 6 条（票据绑定解析后的 oid）今天只对**已存在**的 `Bound::ResetHard` 成立；F04 那
  个新变体落地时必须照同一口径，这一条在这里只是被引用，没有被验证。

## 6. 干净重置要动的每一类路径，Git 自己怎么答

F03 之后那几格要造的预览，比已有的硬重置多出的部分全是磁盘上的事：目标树和当前工作树
哪里不同、哪些未跟踪的东西挡在那里、哪些东西受保护不能碰、两步走完凭什么说"干净了"。
这些口径不能自己定，因为**同一个仓库上五条命令给的是相反的答案**：`git reset --hard`
会覆盖一个未跟踪文件，`git checkout` 为同一个文件拒绝。所以先把"每条命令 × 每类路径"
的量下来。

`tools/bench/clean-reset-probe.py`（本节随此新增）干这件事：它在 `/tmp` 下造临时仓库，
只打印 Git 自己的 rc / stdout / stderr，外加事后每个被盯路径的**字节指纹**
（`absent`、`dir:成员`、或那串字节的 sha1 前十位），**不断言任何东西**，跑完把创建的目录
全部删掉。没有 Git 就带着理由退出。本节是 Git 2.53、Linux x86_64、区分大小写的 ext4 上
的一次运行。

    python3 ../tools/bench/clean-reset-probe.py   # 从 app/ 起，或按仓库根路径起

被量的五条（同一个目标、同一份初始状态，每次都新建仓库）：

| 记号 | argv | 动 HEAD 吗 | 动索引吗 |
| --- | --- | --- | --- |
| `reset --hard <t>` | `reset --hard <t>` | 动，**当前分支的指针跟着移到目标** | 重置到目标 |
| `checkout <t>` | `checkout <t>` | 动，**分离** | 重置到目标 |
| `switch --detach <t>` | `switch --detach <t>` | 动，**分离** | 重置到目标 |
| `checkout <t> -- .` | pathspec 形式 | **不动** | **写进去** |
| `restore --source <t> --staged --worktree -- .` | | **不动** | **写进去** |

### 6.1 一个未跟踪文件，目标树里也跟踪它

仓库：`target` 同时跟踪 `gone.txt` 与 `keep.txt`；后来 `gone.txt` 从树里被删掉（HEAD 到
此不含它），磁盘上又出现一个未跟踪的 `gone.txt`。目标是回到那个 `target`。

| 磁盘上那个文件是什么 | `reset --hard` | `checkout <t>` | `switch --detach <t>` | `checkout <t> -- .` | `restore --source …` |
| --- | --- | --- | --- | --- | --- |
| 字节与目标不同（手写的一份） | **rc=0，覆盖**（指纹从 `242c990fca` 变成目标的 `6d914deaa8`），status 空 | **rc=1 拒绝**，什么都没动 | 同左，rc=1 | rc=0，覆盖**并且索引里多一条 `A  gone.txt`**，HEAD 不动 | 同左 |
| 字节**与目标完全一致** | rc=0，覆盖（无从可见） | **仍然 rc=1 拒绝** | 仍然 rc=1 | rc=0，同上 `A` | 同上 |
| 名字只差大小写（`GONE.txt`） | rc=0，写出 `gone.txt`，`GONE.txt` 原样留着成 `?? GONE.txt` | **rc=0 成功**，`GONE.txt` 同样留着 | rc=0 | rc=0，`A  gone.txt / ?? GONE.txt` | 同上 |

三条结论，按危险程度排：

1. **`reset --hard` 不会替 guit 拒绝。** 目标树跟踪的名字撞上一个未跟踪文件，它直接覆盖，
   rc=0，无警告。那个手写的字节就是"确认什么就动什么"里必须点名的一类，Git 不点名。
2. **拒绝只看名字，不看内容。** 字节和目标一模一样的时候 `checkout` 照样 rc=1（stderr
   是 `error: The following untracked working tree files would be overwritten by
   checkout`）。反过来这也定下了 guit 的口径：**"会不会被覆盖"是关于范围的判断，不是关于
   内容是否变化的判断**（§6.3 第二次量到同一件事）。
3. **只差大小写在这块盘上不是同一名字**，因此不构成障碍。这条只在区分大小写的文件系统上
   成立；不区分的那类宿主（§6.9）没量，别把这条当通用规则写进代码。

后两条 pathspec 形式各留一个额外的坑：它们覆盖并且**把那个文件当作新增写进索引**，而
HEAD 原地不动。预览里如果只说"工作树回到目标"，那一条 `A` 是它没说的话。

### 6.2 同一个路径，一边是文件、一边是目录

| 情形 | `reset --hard` | `checkout <t>` / `switch --detach <t>` | 两条 pathspec 形式 |
| --- | --- | --- | --- |
| `x` 是**已跟踪且干净**的文件，目标里 `x` 是目录（`x/a`） | rc=0，`x` 成 `dir:a` | rc=0，同样成功 | rc=0，`D  x / A  x/a`，HEAD 不动 |
| `y/` 里有一个未跟踪目录（`y/nested`），目标里 `y` 是文件 | **rc=0，`y/nested` 变成 `absent`——整个未跟踪目录被销毁** | **rc=1**，stderr `error: Updating the following directories would lose untracked files in some of them`，`y/nested` 原样还在 | rc=0，同样销毁 `y/nested`，并把 `y` 记成 `A` |

第二行是这一节最该记住的一条：**销毁发生在目录这一层，而任何按路径列的名单只会给你
`?? y/nested`**。谁要按"未跟踪文件逐个和目标的文件比对"算名单，就会算出"没有障碍"，而
真正没的是那整个目录。所以名单的构造必须带一条目录前缀规则（§6.3、§7 第 3 条）。

### 6.3 覆盖名单能不能在写之前算出来

探针里那段 `predict()` 就是候选规则的全部：**目标路径 ∩ 未跟踪路径**（按完整名字），
加上**"目标的某个路径是某条未跟踪路径的目录前缀"**。三次实测：

| 情形 | 未跟踪（`ls-files --others`） | 规则预测会被覆盖 | 事后字节真的变了 |
| --- | --- | --- | --- |
| 未跟踪文件，目标也跟踪，字节不同 | `gone.txt` | `gone.txt` | `gone.txt` |
| 未跟踪文件，目标也跟踪，**字节一致** | `gone.txt` | `gone.txt` | **`-`** |
| 未跟踪目录 `y/nested`，目标把 `y` 当文件 | `y/nested` | `y/nested` | `y/nested`（absent） |

第二行不是失败，是这一条规则的语义：**预测说的是范围，不是内容变化**。字节一致那次，
Git 仍然把目标字节写了一遍（无人能看见），名单里必须留着它——否则承诺就漏了一个 Git
认为"被我写过"的路径。反过来，事后"字节没变"绝不能被讲成"什么都没被覆盖"。

同一节里另外一次对照，问的是"本地改动落在哪条路径上，哪份名单说得出会被丢弃"。
第一次夹具：`HEAD` 已经删掉 `doomed.txt`，目标还留着它，而 `doomed.txt` 与 `keep.txt`
各有一处没人暂存的本地改动。

    status --porcelain             : M doomed.txt |  M keep.txt
    diff --name-only HEAD <target> : doomed.txt, keep.txt

两条读取各说一件事：status 说"工作树现在哪里不干净"，diff 说"目标与 HEAD 哪里不同"。
**这一次它们重合，而那次重合当时被写成了规则——它不是规则，是巧合**，第二格把它推翻了。

第二次夹具：`a.txt` 在目标之后又前进了一次提交（所以它在 `diff HEAD <target>` 里），
`b.txt` 自目标以来一字未动、只在手里被改脏（所以它不在那一条 diff 里）。

    status --porcelain             : b.txt
    diff --name-only HEAD <target> : a.txt
    两条的交集                      : -（空）
    reset --hard <target> 之后      : b.txt 的字节从"hand"回到"as committed"

`reset --hard` 把 `b.txt` 的本地改动丢了，rc=0，没有任何一句关于它的预告。**交集会承诺
"什么都不丢弃"，然后丢掉一个文件。** 所以这一问的答案是 `status` 给出的那一份脏的已跟踪
路径全集，与 `diff HEAD <target>` 无关；第三条夹具（`git add c.txt` 之后直接恢复）还显示
只在索引里脏、工作树没动过的那个新增文件也一起没了——`clean` 不列它（它已跟踪），只有
`status` 列它。diff 那一条读的仍是它本来读的那件事：目标的版本动了哪些路径。

### 6.4 受保护的东西，每一份名单各报什么

一份仓库里各放一样：一个脏的已跟踪文件、一个普通未跟踪文件、一个目标树跟踪的未跟踪文件、
一个被忽略的目录（`ign/`，里面两层深还有一个文件）、一个被忽略的名字（`secret.txt`）、
一个**嵌套仓库**（`nested/`，自己的 `.git`）、一个**子模块**（`mod`，里面还写了东西）。
16 次读取的答案：

| 一次读取 | rc | 条目 | 内容 |
| --- | --- | --- | --- |
| `status --porcelain` | 0 | 5 | `M mod`、` M tracked.txt`、`?? gone.txt`、`?? nested/`、`?? plain.txt` |
| `status --porcelain -uall` | 0 | 5 | 同上——`nested/` **在这一条里也不展开**，里面有一个 `.git`，Git 不往别人的仓库里列文件（对照 §6.6：一个普通未跟踪目录 `-uall` 会展开成 100 条） |
| `status --porcelain -uall --ignored` | 0 | 7 | 上述 5 条 + **逐文件**的 `!! ign/nested/deep.txt`、`!! secret.txt`（`ign/` 不是仓库，所以 `-uall` 展开了它） |
| `status --porcelain -z -uall` | 0 | 5 | 同上，NUL 分隔 |
| `clean -nd` | 0 | 2 | `gone.txt`、`plain.txt` |
| `clean -ndx` | 0 | 4 | 上述 2 条 + **折叠成目录的** `ign/` + `secret.txt` |
| `clean -ndff` | 0 | 3 | 上述 2 条 + `nested/` |
| `clean -ndffx` | 0 | 5 | `-ndx` 那 4 条 + `nested/` |
| `clean -nd -- plain.txt`（scoped） | 0 | 1 | `plain.txt` |
| `clean -nd -- nested`（scoped，那是个仓库） | 0 | **0** | — |
| `clean -nd -- mod`（scoped，那是个子模块） | 0 | **0** | — |
| `diff --name-only HEAD <target>` | 0 | 3 | `.gitmodules`、`gone.txt`、`mod` |
| `ls-files --others` | 0 | 5 | 两条未跟踪文件 + **折叠的** `nested/` + 两条被忽略 |
| `ls-files --others --exclude-standard` | 0 | 3 | `gone.txt`、`plain.txt`、`nested/` |
| `ls-files --others --ignored --exclude-standard` | 0 | 2 | **只有被忽略那一类**，且逐文件：`ign/nested/deep.txt`、`secret.txt`（`ign/` 在这里也不折叠：这一条没传 `--directory`，而它折叠的只有仓库那一种目录） |
| `submodule status` | 0 | 1 | `mod (heads/main)` |

这张表里四条"每一类名单各说各话"是 F03 的全部难点：

- **`clean` 才是删除承诺的唯一来源。** 它不加 `-ff` 就不列嵌套仓库，**加了 `-ff` 也永远
  不列子模块**（`clean -nd -- mod` 甚至报 0 条）。`status` 会报 `?? nested/`，`ls-files`
  也会。谁拿 status 的名单去删，就会承诺一件 Git 不肯做的事；谁为了兑现那句承诺去加第二个
  force，就越过了 F01 立下的"永不加第二个 force"。
- **折叠的目录不能自己展开。** `clean -ndx` 给 `ign/`，`status --ignored` 给
  `ign/nested/deep.txt`。要算"目标跟踪了某个被忽略的路径"这个交集，必须从**逐文件**那一条
  读起；从折叠那条读会算不出来（`ign/` 不是目标树里的路径）。逐文件那一条有两个来源，这一
  节把它们都跑了一遍：`status --porcelain -uall --ignored` 把 7 条混在一起（5 条非忽略的
  还要先认出 `!!` 那两个字节），`ls-files --others --ignored --exclude-standard` 只给被忽略
  的那 2 条，粒度相同。
- **`--exclude-standard` 不是可选的。** 少它一次，`secret.txt` 和 `ign/…` 就以"未跟踪"的
  身份进名单（5 vs 3）。
- **gitlink 会在恢复之后变成未跟踪的残留。** `diff --name-only HEAD <target>` 里有
  `.gitmodules` 与 `mod`：目标比那次"加子模块"的提交更早，回到它就把 gitlink 和
  `.gitmodules` 一起拿掉。

于是紧接着问了那一句：硬重置会不会伸进子模块或嵌套仓库里去？

    git reset --hard <target>   rc=0   err=warning: unable to rmdir 'mod': Directory not empty
    before: mod/dirty.txt = 40c7aceaee, nested/README.md = 6a447dedf2
    after:  mod/dirty.txt = 40c7aceaee, nested/README.md = 6a447dedf2
    after:  status = ?? mod/ / ?? nested/ / ?? plain.txt
    after:  clean -nd 仍然只说 Would remove plain.txt

两处字节纹丝不动——**Git 不进子模块，也不进别人的仓库**，它只是把索引里的 gitlink 撤了，
留下一句 warning，然后那两个目录以 `??` 的身份挡在"干净"的路上，而 `clean` 从此不再列出
其中任何一个（`plain.txt` 之外它什么都不说）。

最后一类，是"忽略"和"目标要跟踪"同时成立：`.gitignore` 里写着 `built.txt`，目标树跟踪
`built.txt`。这一例**造它的人差点没造出来**：`git add -A` 会跳过那条规则盖住的路径，于是
第一次跑这份夹具时 `built.txt` 从来没进过树，`git rm --cached` 直接 rc=128 而探针不看返回码，
后面那几句量的其实是"一个未跟踪的忽略文件"——不是这一问。现在的夹具用 `add -f`，并先把目标
自己的树打印出来作证据。

    the target holds:                        .gitignore / built.txt
    git rm --cached now                      rc=0
    check-ignore -v                          rc=0  .gitignore:1:built.txt   built.txt
    status --porcelain -uall --ignored       rc=0  !! built.txt
    ls-files --others --ignored --exclude-standard  rc=0  built.txt
    clean -ndx                               rc=0  Would remove built.txt
    git reset --hard <target>                rc=0  built.txt 变成目标的字节；status 变空
    之后再看同一条规则                        rc=1  什么都不报
    再加 --no-index                           rc=0  .gitignore:1:built.txt

也就是说：**被忽略的路径如果目标要跟踪它，恢复会写它**——写之前它在 `status --ignored` 与
`ls-files --others --ignored` 里都是逐文件的一条，写之后它变成已跟踪、`status` 不再报它。
`check-ignore` 这一条**纠正本节早先记的一句**：它不是"写完仍然报那条规则"，而是反过来——
默认它先看索引，路径一旦跟踪就 rc=1 沉默，加上 `--no-index` 才只答模式。所以它两个方向都不能
当判据：拿它判"这条路径不受保护"（未跟踪时报的是模式）与拿它判"这条路径已被跟踪"（跟踪之后它
不答）都会答错。构造里一次都没问它。

### 6.5 两步走完，凭什么说"干净了"

同一份受保护夹具：先 `reset --hard <target>`，再 `clean -fd` 并把预览里承诺过的那几个名字
逐个交给它。

    git reset --hard <target>                        rc=0（同 §6.4 那句 warning）
    git clean -fd -- plain.txt gone.txt ign secret.txt
                                                     rc=0  out=Removing plain.txt
    plain.txt absent / gone.txt 还在（目标的字节）/ ign/ 还在 / secret.txt 还在
    残留：?? mod/ / ?? nested/
    工作树与目标树一致吗？ diff --quiet <target>     rc=0
    跟踪与未跟踪都清干净了吗？ status -uall 为空       False
    git clean -fd -- nested                          rc=0，无输出，nested/ 原样还在

四条事实：

1. **一次 scoped `clean` 会沉默地什么都不做。** `gone.txt` 在预览里是未跟踪、被列进删除
   名单；`reset` 之后它已被目标树跟踪，于是 `clean` 不再认为它是候选，rc=0、无输出。
   `ign/` 与 `secret.txt` 同理（`-fd` 不带 `-x` 不碰忽略）。**逐路径的"移除/未移除"只能照
   Git 事后的答案说**——这正是 F01 定下的口径在两步组合下仍然要守的那一条。
2. **两个"干净"条件可以相反。** 上面这份夹具最后：与目标树一致（`diff --quiet` rc=0），
   但 `status -uall` 不空（`mod/`、`nested/`）。所以"恢复到干净"不能是一个 bool，必须说
   按哪一条成立、哪些路径留在外面、以及为什么留在外面（一句 Git 的拒绝，或一条受保护的
   边界，或用户自己选的"忽略的东西不动"）。
3. **对未跟踪的把关条件是**`status --porcelain -z -uall` 为空 **且** `diff --quiet <target>`
   rc=0，两条都要读；缺前一条会把 `?? mod/` 说成干净，缺后一条会把"根本没回到目标"说成
   干净。
4. **`clean -fd` 删不掉嵌套仓库**，即便明确点名（第 4 行）。这一句是"永不加第二个 force"
   要付的代价，代价的样子现在量出来了：预览里必须把 `nested/` 写成"留下"，而不是删了它。

### 6.6 造这份预览要起几条进程、花多少毫秒

2,000 个已跟踪文件、其中 200 个与目标不同、100 个未跟踪（都在一个 `extra/` 目录里）、
外加一个被忽略的 `node_modules/`。同一份量连跑三遍，表里给中位数与那三次覆盖的区间：

| 一次读取 | rc | 条目 | 本宿主（中位／区间） |
| --- | --- | --- | --- |
| `rev-parse HEAD` | 0 | 1 | 1.4 ms（1.2–1.6） |
| `diff --name-only HEAD <target>` | 0 | 200 | 3.4 ms（2.6–3.8） |
| `diff --name-status HEAD <target>` | 0 | 200 | 2.9 ms（2.9–3.2） |
| `diff --name-status -z --no-renames HEAD <target>` | 0 | 400 token = 200 项 | 3.1 ms（3.1–3.1） |
| `ls-tree -r -z --name-only <target>` | 0 | 2001 | 2.4 ms（1.9–2.4） |
| `status --porcelain -z -uall` | 0 | 100 | 10.6 ms（9.5–10.6） |
| `status --porcelain -z -uall --ignored` | 0 | 101 | 8.9 ms（7.2–10.0） |
| `ls-files --others --exclude-standard -z` | 0 | 100 | 2.0 ms（1.9–2.0） |
| `ls-files --others --ignored --exclude-standard -z` | 0 | 1 | 1.9 ms（1.9–1.9） |
| `clean -nd` | 0 | 1（折叠成 `extra/`） | 2.2 ms（2.1–2.5） |
| `clean -ndx` | 0 | 2 | 2.0 ms（1.9–2.2） |

这一版连上一条新读的行一起重测，所以十一行是同一次三遍的一份读数；`status` 那两行比上一版
（7.0／5.9）贵出一截，宿主当时正在并行编译，这不影响下面的结论，因为要比的两个数在同一列里。
`-z --no-renames` 那一条是构造真正发出的 argv：400 个 token 就是 200 项，代价与不带 `-z`
的那条同量。`ls-tree` 那一条是覆盖判定要用的"目标自己持有哪些路径"（§6.3 的 `predict()`
一直用它，只是上一版没量），2,001 条路径 2.4 ms，比 `status` 便宜四倍——这一条读放大不亏。

能省的地方都在这张表上，而且**"忽略 ∩ 目标"那一问有两个可用的来源**：§7 第 7 条点名的
`status --porcelain -z -uall --ignored`（8.9 ms，101 条里只有 1 条是 `!!`，剩下 100 条是这一问
不需要的、还要先解析那三个字节表头的工作树状态）与同一条引擎反着用的
`ls-files --others --ignored --exclude-standard -z`（1.9 ms，只给被忽略那一类，逐文件，粒度
与前者相同）。§7 第 7 条点名的因此是这一条，`plan_restore` 接上它是紧接着的那一次提交。按 §7 的构造（§8 的 `plan_restore`）一次预览自己起**七条进程**：
目标的一次 `rev-parse`、一次 `rev-parse HEAD`、`diff`、`ls-tree`、`ls-files`（未跟踪）、
`ls-files --ignored`、`clean -nd`——把这七行对应的中位数相加约 **15 ms**。表里那两条 `status`
**不在这七条里**：脏路径来自会话已经发布的那份索引（`write::status_index`），预览不再起一次
`status` 进程，所以 refresh 付的 10.6 ms 不算进这次预览。**没有新增的读放大**，Rust 侧的解析
开销没量。`clean -nd` 会把 100 个未跟踪折叠成一条 `extra/`，这份名单不能拿去和目标的逐路径
名单做交集（§6.4 第二条）。

### 6.7 一个折叠的未跟踪目录，一半是恢复要写的那个文件

前两节把"覆盖"与"删除"当成两份名单读，但它们的**粒度不一样**：`ls-files --others` 逐文件
报，`clean -nd` 会把整个未跟踪目录折成一条。于是有了这一例——目标跟踪
`extra/wanted.txt`，HEAD 连 `extra/` 都不知道，磁盘上 `extra/` 里躺着
`wanted.txt`（手写的一份）与 `other.txt`（目标不要的）。

    before:  clean -nd                                → Would remove extra/            （1 条）
    before:  ls-files --others --exclude-standard -z   → extra/other.txt, extra/wanted.txt（2 条）
    git reset --hard <target>   rc=0   extra/wanted.txt = 6d914deaa8（目标的字节）
                                       extra/other.txt   = 177c247561（没动）
                                       status = ?? extra/other.txt
    between: clean -nd            rc=0  Would remove extra/other.txt                   （1 条）

三种叫法各跑一遍（`-- extra`、`-- extra/wanted.txt extra/other.txt`、
`-- extra/other.txt`），三遍的最后状态完全相同：

    out = Removing extra/other.txt     extra/ = dir:wanted.txt
    status = 空     diff --quiet <target> = rc 0

四条结论：

1. **`clean` 不会删掉一个已被跟踪的文件，哪怕你点名要删它所在的那个目录。** 三种叫法都只
   报 `Removing extra/other.txt`，`extra/wanted.txt` 原样留着。所以"折叠目录把刚恢复出来的
   文件一起带走"这个担心，Git 自己已经挡住了——代价是它挡的方式是**沉默地少删**。
2. **重置之后重问一次 `clean -nd`，那条折叠项自己缩小成了逐文件的那一条。** 目录不再"整个
   未跟踪"，Git 就不再用目录名代表它。因此"执行前重问 Git 同意删什么"（F01 已有的口径）在
   两步组合里不只是防漂移，它还会**改写名单的粒度**。
3. **承诺的名单必须按逐文件那条读**，不能按折叠那条：`Would remove extra/` 这一句在用户读到
   的那一刻就已经不准了，因为它盖住的文件里有一个是被写入而不是被删除的。预览里那一条应该
   拆成两句——"这一个会被目标写入"、"那一个会被删掉"——而不是"这个目录会被删掉"。
4. **事后如实报告只报 Git 真做的事**（`Removing extra/other.txt`），并把它没做的那一条按
   "未移除"报出去，而不是按失败报。

### 6.8 一个仓库正站在目标要写的那个路径上

最坏的一类，单独量：HEAD 在 `y` 上什么都没有，目标把 `y` 当**文件**跟踪，而磁盘上 `y/` 是
一个**嵌套仓库**（自己的 `.git`，里面还有一个被那个仓库跟踪的 `own.txt`）。

    before: y = dir:.git,own.txt   y/own.txt = 31bd767a79

| 那一条命令 | rc | 之后磁盘上 |
| --- | --- | --- |
| `reset --hard <t>` | **0** | `y` = 目标那个文件的字节，**`y/own.txt` = `absent`——整个仓库连同它的 `.git` 被销毁** |
| `checkout <t>` | 1 拒绝 | `y/` 与 `y/own.txt` 原样还在，HEAD 没动 |
| `switch --detach <t>` | 1 拒绝 | 同上 |
| `checkout <t> -- .` | **0** | 同样销毁，另外把 `y` 记成索引里的 `A` |
| `restore --source <t> --staged --worktree -- .` | **0** | 同上 |

这一例把 §6.2 那一条从"未跟踪的文件"升级到"别人的仓库"：`reset --hard` **不问就删**，
无警告、rc=0、事后 status 干净。Git 只把拒绝留给 `checkout`/`switch` 那两条——而它们兑现不了
"留在当前分支回到目标"。所以：

- **目标要写的那个路径，如果是某个未跟踪目录（`ls-files --others --exclude-standard -z`
  里以 `/` 结尾的那一条）的前缀，guit 必须在写之前拒绝**，而不是把这句话写进预览里问对方
  要不要继续。§6.7 那条"Git 会自己少删"的保护只在 `clean` 这一侧，`reset` 这一侧没有。
- 判定"那是个仓库"不需要碰文件系统：未跟踪读取给出的**折叠项就是仓库**——普通未跟踪目录在
  §6.6 那份夹具里被展开成 100 条逐文件条目，而 §6.4 的 `nested/` 在 `status -uall` 与
  `ls-files --others` 两条里都保持折叠。`clean` 也只在 `-ff` 那一档才肯列它（§6.4）。

### 6.9 这一节没量到的

- **不区分大小写的文件系统**：`GONE.txt` 那一例在那类宿主上是障碍还是不是，没问过一次。
  本宿主只有一块区分大小写的 ext4；Windows/macOS 上的 case-only、以及 `core.ignorecase`
  的影响，全无证据。
- **符号链接**：未跟踪的 symlink 挡住一个目标要写的路径、或 symlink 指向一个目录而目标
  要在里面放文件——一次都没造过。
- **稀疏检出、`skip-worktree`、`assume-unchanged`**：那三种索引状态下 `diff` 与 `status`
  各报什么，没问过。F03 若在它们之上照 §7 的并集算名单，算出来的是什么并不自知。
- **Git 自己保护的名字**：`core.protectNTFS` / `protectHFS` 那一类（`.git`、`HEAD`、
  保留设备名）没造过夹具。
- **模式位**：目标与磁盘只有可执行位不同时算不算覆盖，没问。
- **一个未跟踪的空目录**（`ls-files` 那两条名单都不列它；新加的那条"只给被忽略那一类"的读取
  在空目录这一格上没单独造过夹具。`clean` 会不会删它没问），以及**反过来的
  那一格**：目标把某路径当 gitlink（子模块）、而磁盘上那个位置是一个未跟踪目录——§6.8 量的
  是"目标是文件、磁盘是仓库"，那一条方向没走过。
- **`clean -ndffx` 在大夹具上的耗时**没量（§6.6 只量了 `-nd` / `-ndx`）。
- **一次都没渲染**：本节全是 Git 侧的答案。这份预览在真实窗口里长什么样、名单分组读不读
  得动，是 F05/F06 的事。

## 7. 这些事实决定了 F03 的预览怎么构造

§6 是测量，本节把测量变成规则。F03 动手前先读这一节；它自己的落地在实现时另起一节。

1. **受影响集合是六次读取的并，不是任何一次读取的子集**：
   `diff --name-status -z --no-renames HEAD <target>`（目标与当前的路径差，含 file↔dir 那种
   类型变化）、`ls-tree -r -z --name-only <target>`（目标自己持有哪些路径——覆盖判定问的是
   "磁盘上这个未跟踪路径在不在目标里"，两棵树之间的差答不了"两边都有但索引里被撤过"那一格）、
   `ls-files --others --exclude-standard -z`（未跟踪，逐文件）、
   `ls-files --others --ignored --exclude-standard -z`（被忽略的，逐文件；第 8 条那一个例外
   只能从这一条算）、
   `status --porcelain -z -uall`（工作树哪里不干净；这一问不新起进程，脏路径从会话已经发布的
   那份索引里取）、
   `clean -nd`（Git 同意删的是哪些）。少第一条会把"目标的版本动了哪些路径"说漏，少第二条会把一个
   已经被目标持有的路径说成没人在意，少第三条会漏掉障碍，少第四条会把"既被忽略又将被写入"
   那一句漏掉，少第五条会把正被丢弃的本地改动说成没有，少第六条会承诺一件 Git 不肯做的事。
2. **保护不能指望 Git 拒绝**：只有 `checkout <t>` 与 `switch --detach <t>` 会挡（§6.1、
   §6.2），而那两条把 HEAD 分离、且兑现不了"留在当前分支上回到目标树"。所以 F03 的动词
   只能是 `reset --hard` + 一次有界 `clean`，**保护必须是 guit 自己在写之前算出来的拒绝**。
   覆盖名单就是"目标树里的路径"与"磁盘上的未跟踪"这两个集合的相交，按第 3 条那条目录前缀
   规则放大；名单不为空就先说清，再问要不要继续。
3. **目录前缀规则是必需的**：目标的 `y` 对上磁盘上的 `y/nested`，`reset` 会销毁整个目录
   （§6.2 第二行），而任何按路径列的名单只会报 `?? y/nested`。名单必须按"完整名字相等，
   或目标的某条路径是它的目录前缀"来算。
4. **覆盖是范围，不是内容变化**：字节和目标一致的那个文件仍在名单上（§6.1 第 2 条、
   §6.3 第二行）；事后"字节没变"不许被写成"什么都没被覆盖"。
5. **"会被丢弃的本地改动"就是 `status` 里那一份脏的已跟踪路径全集**（§6.3 末那两格）。
   它**不是** `status ∩ diff HEAD <target>`：交集会在承诺"什么都不丢弃"之后丢掉一个文件
   （目标以来没动过、只在手里改脏的那条路径，diff 根本不列它，`reset --hard` 照样覆盖），
   也会漏掉只在索引里脏的那条（`git add` 后未提交的新文件，工作树没动过，`clean` 不列它，
   `reset --hard` 连磁盘一起清掉）。`diff HEAD <target>` 回答的是另一问：目标的版本动了
   哪些路径。这一条与本节第 1 条不冲突——第 1 条说的是受影响集合取哪些读取，这里说的是
   "丢弃本地改动"这一问由 `status` 单独回答。
6. **删除承诺只绑 `clean` 自己的答案**，并且**永远不加第二个 force**：嵌套仓库要 `-ff`
   才被列出、子模块在任何一档都不被列出、点名去删一个嵌套仓库时 `clean` rc=0 而什么都不做
   （§6.4、§6.5 第 4 条）。Git 不列的路径就写成"留下"，并说为什么留下。这条与 F01 同口径。
7. **折叠的目录不自己展开**，`--exclude-standard` 不可省：前者让交集算不出来
   （`ign/` 不是目标里的路径），后者让被忽略的东西混进删除名单（5 vs 3，§6.4）。
   需要逐文件的被忽略名单时用
   `ls-files --others --ignored --exclude-standard -z`，只在要算"忽略 ∩ 目标"时才读它。**这
   是本节原先点名的 `status --porcelain -z -uall --ignored` 的一次偏离，理由量在 §6.6**：两条
   给的粒度相同（`ign/nested/deep.txt` 逐文件，`ign/` 不折叠），但前者只回被忽略的那一类，
   后者要先把 101 条里那三个字节的表头认出来、再丢掉 100 条这一问不需要的状态，代价 1.9 ms
   对 8.9 ms。两条都跑过，答案在夹具上一致。
8. **默认保护忽略的东西，但要先算出那一个例外**：目标树跟踪了一个被 `.gitignore` 盖住的
   路径时，恢复会写它（§6.4 末）。`check-ignore` 当不了这个例外的判据，两个方向都不行：
   路径未跟踪时它答的是**模式**，路径一旦跟踪它就沉默（它默认先看索引，`--no-index` 才剥掉
   这层）。忽略 ∩ 目标因此从第 7 条那一条逐文件名单里算，算出来就要在写之前说：这一条路径
   既被忽略又将被写入。这一句是**说**而不是
   **拒**：例外之所以是例外，正因为恢复确实要写它。唯一的例外之外还有第 14 条——那条路径如果
   本身是一个仓库（在逐文件名单里以折叠的目录形式出现），被销毁的代价与忽略规则无关，仍然
   写前拒绝。
9. **边界不是路径级的**：gitlink 撤掉之后 `mod/` 会以 `??` 留下，`reset` 给它一句
   `warning: unable to rmdir`，而 `clean` 从此不列它（§6.4 末）。这类残留要按"留下，
   因为 guit 不进别人的仓库"来陈述，不能按失败来陈述。
10. **事后条件读两次，不是一个 bool**：`status --porcelain -z -uall` 为空 **且**
    `diff --quiet <target>` rc=0（§6.5）。两者可以相反，所以"恢复到干净"这句话要说按哪条
    成立、什么留在外面。逐路径的删除结果照 Git 事后的答案报"移除/未移除"——预览里承诺过的
    路径可能已经被目标树跟踪，那时 `clean` 沉默地不做任何事（§6.5 第 1 条）。
11. **目标解析复用 `resolve_target`**（§3、§5），`sequencer::validate_target` 仍然不动。
    票据绑定的事实同 [设计文档 §7.2/§7.3](02-design.md)：会话、解析后的 target oid、观测到
    的 HEAD、索引状态、目标与当前的路径差、脏路径、计划删除的未跟踪路径、覆盖名单、受保护
    名单。**`reset` 与 `clean` 不是原子的一步**，中间那一段必须被承认为一段并如实报告；
    这一步的动词序列与有界性归 F04，事后校验与部分执行归 F05。
12. **预算不是新的读放大**：一次预览自己起 7 条进程（§7 第 1 条那六次读取里除 `status` 之外的
    五条，加上目标的一次 peel 与一次 `rev-parse HEAD`，再加 `clean -nd`），§6.6 那份夹具上
    中位相加约 15 ms；贵的只有 `diff`/`ls-tree` 那一档（3.1／2.4 ms），两份未跟踪名单各
    2.0／1.9 ms，`clean -nd` 2.2 ms。`status` 那 10.6 ms 属于 refresh，不属于这次预览——脏路径
    从会话已发布的索引里取。
13. **删除名单按逐文件的粒度给，第二步之前重问一次 `clean`**：`clean -nd` 会把整个未跟踪
    目录折成一条，而那一格里可能有一个文件是要被**写入**而不是被删除的（§6.7）。预览不能
    说"这个目录会被删掉"，要拆成"这一个会被目标写入 / 那一个会被删掉"，粒度取
    `ls-files --others --exclude-standard -z` 那一条。执行前重问 `clean -nd` 会让折叠项自己
    缩小成逐文件那一条（§6.7 第 2 条），而 Git 对已跟踪文件的沉默少删要按"未移除"报出去
    （§6.7 第 4 条），既不报成失败也不报成成功。
14. **写前拒绝只有一条判据：一个仓库会被销毁或被写掉**。目标要写的那个路径如果是一个未跟踪
    折叠项（也就是一个仓库，§6.8）的目录前缀，`reset --hard` 会把那个仓库连同它的 `.git`
    一起删掉、rc=0、无警告，而拒绝它的 `checkout`/`switch` 又兑现不了"留在当前分支回到目标"
    ——所以 guit 必须自己先拒绝，说清那是一个 Git 仓库、guit 不往里写也不替它让路。子模块
    同理（§6.4：任何一档 `clean` 都不列它，`reset` 只留一句 `warning: unable to rmdir`）。
    被忽略的东西**不在这一条里**：目标要跟踪它时恢复就是要写它，那是第 8 条要"说出来"的一句
    话，不是一次拒绝。

F03 的落地要动 `main.rs` 的命令注册表与 `write.rs` 的 `Bound`；写这些之前本节是依据，
写完之后本节不补记实现——实现另起一节，像 §4 与 §5 那样。

本节两次落地（`7e5d5a1` 与紧接着的这一次）的证据都只有探针本身那几次运行：`exit=0`、
430 行、跑完在 `/tmp` 里不留一个目录，同一份量连跑两遍只差毫秒与一个 commit id。
Rust 与前端一行未动，所以这里不引用任何 build／fixture 数——写这段时共享树正被阶段 E 的
E04b 占着（`npm run build` 停在 `src/views/history.ts` 里那些还不存在的名字上，那是他们工作
树上未提交的改动，不是 HEAD 的红），而本节没有任何需要那条通道来证明的断言。等 §7 的规则
变成代码时，门禁数按 AGENTS.md 从独立 worktree 的已提交状态上取，并写进那一节的落地记录。

## 8. F03 的预览构造落地

`41639c8` 把 §7 的规则落成 `reset.rs` 里的 `plan_restore`：五个名单读取、六个集合、一条写前
拒绝，加 6 条跑真实 Git 并在事后读磁盘的用例。`a51a871` 补上那一份清单欠的第六条读取，于是
构造是**六个名单读取、七个集合**（多出"被忽略而目标仍要写"那一格）、8 条新用例，其间还纠正了
一条量错过的事实（§8.2 第二条）。**命令仍未注册**，所以这一片没有前端一行、没有渲染证据，也
没有新的探针——它还没有可画的界面。

### 8.1 §7 那十四条各自落在哪一处

| §7 的那一条 | 代码里的落点 |
| --- | --- |
| 第 1 条（并，不是子集） | `plan_restore` 依次走 `tree_differences`、`target_paths`、`tracked_dirty_set`（即 `write::status_index`，不新起进程）、`untracked_paths`、`write::clean_candidates`、`ignored_paths`——六次读取、七个集合，`status` 那一问不新起进程 |
| 第 2、14 条（保护必须自己算；写前拒绝只有一条判据） | `Restoration::guard()` → `reset_preview_repository`，一句里带那个路径的名字 |
| 第 3 条（目录前缀规则） | `claimed_by_target` 除完整名字相等外，逐 `/` 试前缀；`is_ancestor_dir` 要求第一个差异就是 `/` |
| 第 4 条（覆盖是范围，不是内容变化） | `overwritten` 只按名单算；整个构造一次都没读文件字节 |
| 第 5 条（丢弃 = status ∩ diff） | `discarded` |
| 第 6 条（删除承诺只绑 `clean` 自己的答案） | `removals` 只从 `clean_candidates` 那份名单里来；没被列出的落进 `left_behind`，`!item.repository` 那一格就是这条 |
| 第 7 条（折叠不自己展开；`--exclude-standard` 不可省） | 两条名单都把选项写死在 argv 里：`ls-files --others --exclude-standard -z` 与 `ls-files --others --ignored --exclude-standard -z`；同一套折叠判定（结尾的 `/` 就是"那是别人的仓库"）由 `as_untracked` 一处算 |
| 第 12 条（预算） | `ls-tree` 与那一条"只给被忽略那一类"的读取都是先量了再采用（§6.6 重测那一版）；进程条数随第 1 条那份清单走 |
| 第 13 条（逐文件粒度 + 第二步之前重问 `clean`） | 粒度已落；**重问归 F04**，构造里只有一次 `clean -nd` |
| 第 8 条（忽略 ∩ 目标那一个例外） | `Restoration::ignored_written`：那条逐文件名单里被目标持有（完整名字或目录前缀）的路径，**说**而不**拒**；同一条名单里的仓库仍按第 14 条进 `blocked` |
| 第 9、10 条（残留怎么陈述；事后两条条件） | 未落，归 F05 |
| 第 11 条（复用 `resolve_target`） | `plan_restore` 第一行；`sequencer::validate_target` 仍未动 |

`write::clean_candidates` 从私有变成 `pub(crate)`，为的是删除承诺只有一个来源——reset 不另
写一份 `clean -nd` 的解析，两份解析会在同一天各自漂移。

### 8.2 六条动手时才定下来的判断

- **`ls-tree` 是不可省的那一条读取**：覆盖判定问的是"磁盘上这个未跟踪路径在不在目标里"，
  而 `diff HEAD <target>` 恰好**不列**两棵树都持有且一致的那条路径——索引里被撤过、磁盘上
  又躺着同一个名字时，差里看不见它。§6.3 的 `predict()` 一直用它，这一版才把它的代价量出来
  （2,001 条 2.4 ms），§7 第 1 条那份读取清单因此加了一条。
- **那条夹具原来没造出它要问的那一格**：§6.4 末"目标树跟踪一个被忽略的路径"这一例，第一次
  是用 `git add -A` 造的，而那条规则正好盖住那个文件——它从未进过树，`git rm --cached` rc=128
  而探针不看返回码，后面四行量的是"一个未跟踪的忽略文件"。改成 `add -f` 之后先把目标自己的
  `ls-tree` 打印出来当证据，`rm --cached` 的 rc 也打出来。跟着改的是结论：`check-ignore`
  在写完之后**不再**报那条规则（它默认先看索引，`--no-index` 才剥掉这层），本节早先记的恰好
  相反。构造一次都没问 `check-ignore`，所以代码不受这条纠正影响，但"它答模式不答跟踪"这句
  依据从此是错的——一个只有失败路径读它的设计会在这里读错方向。
- **"忽略 ∩ 目标"用哪一条命令读，量过两个来源**：`status --porcelain -z -uall --ignored` 与
  `ls-files --others --ignored --exclude-standard -z` 在夹具上给出同一批路径、同一粒度，前者
  8.9 ms 里 101 条只有 1 条是 `!!`，其余 100 条是这一问不需要的状态、每条还要先剥掉开头那三个
  字节；后者 1.9 ms 只回被忽略那一类。取后者；这也让
  折叠判定只有一套（两条名单都以结尾 `/` 认仓库，`as_untracked` 一处算）。
- **读取失败的三条分支都拒绝**：起不来的进程交回 `runner` 自己的码，Git 说不是
  `reset_preview_failed`，装不下是 `reset_preview_too_large`；没有一条走"于是这份名单是空的"。
  bound 跟 `status` 同一条（`runner::STATUS_OUTPUT_LIMIT`），理由写在 `submodules.rs:41`：约一千
  个文件就超 64 KB，那种仓库会整片报成"什么都没挡着"。
- **不认识 diff 的字母就整份拒绝**，而不是跳过那一项：`--no-renames` 已经把 `R`/`C` 挡在外面
  （pair 记录是另一种 `-z` 形状），真出现别的字母说明 Git 与这段解析对不上，而那个字母正是
  "目标里有没有这条路径"的判断依据，跳过它就是猜操作会做什么。
- **例外那一格是"说"，不是"拒"，除非它是个仓库**：被忽略而目标要写的普通文件进
  `ignored_written`，预览欠它一句"这条既被忽略也将被写入"；同一条名单里如果那是一个仓库（忽略
  规则盖住的一个 `y/`，目标把 `y` 当文件），第 14 条那条判据照旧成立——被销毁的东西与规则说
  什么无关。用例因此两条：一条把 `reset --hard` 真跑一遍、断言写回的是目标的字节，一条断言
  拒绝之后 `y/own.txt` 还在（拒绝什么都不做）。

### 8.3 门禁与度量

门禁数从 detached worktree 的 `a51a871` 上取（共享树当时带着阶段 E 在飞的一批前端文件，
`npx tsc --noEmit` 在共享树里报的每一行都出自那些文件——那是他们工作树上的改动，不是 HEAD 的
红，所以那一条通道只在 worktree 里读）：`cargo test` **381 passed / 0 failed**（`reset` 28 条，
两次提交合计新增 8 条）、`cargo fmt --check` 零 diff、`cargo clippy --locked --all-targets`
**0 告警**、`npm run build` ✓ **47 modules transformed**、`npm run test:fixture`
**402 pass / 0 fail**（含 shipped-copy 与 ipc-surface 两道门；这一片没动前端，所以这条数与
上一次相同）、`color-contrast.py` fails=0、`responsive-check.py` fails=0。探针在 worktree 里
同一次运行 `exit=0`、**441 行**（比上一版多 9 行：两条新名单读数与那条夹具证据），跑前跑后
`/tmp` 里都是 0 个 `guit-clean-reset-*`。

`plan_restore` 自己的墙钟**没量**：到这一片为止没有任何调用方起过它一次。§6.6 末那个加和是
表里对应那几行各自中位数的相加，不是这条通道上的一次读数——它要在 F04 把预览接进 `write.rs`
之后才有可量的对象。新加的那一条读取不是免费的，也不是没账的：它在同一份夹具上量得
1.9 ms（1.9–1.9），比它替代的那一条 `status --ignored` 便宜 7 ms。

### 8.4 这一片没做完的

- **命令注册**：`preview_restore` 与它的确认必须与前端 `invoke` 字面量同一次提交落地
  （`ipc-surface.mjs` 那条门），`reset.rs` 里七处 `allow(dead_code)` 因此还挂着——五个字段、
  `guard()`、`plan_restore`。
- **F04**：`Bound` 的新变体要绑 §7 第 11 条列的那几样（会话、解析后的目标 oid、观测到的
  HEAD、路径差、脏路径、计划删除的未跟踪路径、覆盖名单、受保护名单，加上这一片新算出来的
  "被忽略而目标要写"那一份），动词序列
  `reset --hard` + 有界 `clean`，**第二步之前重问一次 `clean -nd`**，同路径变化重查。
- **F05**：事后两条条件（`status -z -uall` 空 **且** `diff --quiet <target>` rc=0）、
  取消／超时／部分完成的如实报告、预览续约。
- **F06**：更改区的提交号输入、预览分组、确认文案与焦点，以及这份预览的渲染证据。
- **第 8 条例外现在有了落点，但它的新形态仍未量**：那一份名单在真实窗口里怎么说出来（F06），
  以及它读的是不是那类宿主上同一批路径。§6.9 那一整列——不区分大小写的宿主、符号链接、
  稀疏检出与 `skip-worktree`、`core.protectNTFS` 那一类名字、可执行位、未跟踪空目录（新加的
  这条"只给被忽略那一类"的名单在空目录这一格上没单独造过夹具）、目标是 gitlink 而磁盘是
  未跟踪目录那一反向格——仍未量；Windows/macOS 仍只是构建配置。
