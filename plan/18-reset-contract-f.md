# 阶段 F 契约依据与记录：提交、单文件清理与干净重置

实施日期：2026-09-30。基线提交：`e9c5a1a`（阶段 D 的 D05 收口之后）。本文既固定
F01–F06 必须遵守的口径，也是它们各自的实施记录。§1–§3 是动手前先拿到的事实，
§4 是 F01 的落地（`9e3cac4` 后端、`29be513` 前端、本次收口）；F02 之后的落地各起一节，
写到时才存在，不要按编号去找还没有的小节。

主机条件同 [A01 基线](05-baseline-a01.md)：Linux x86_64、Git 2.53、WebKitGTK、
Node 26、rustc 1.96.1。**本文没有 Windows/macOS 证据**，那两个平台仍只是构建配置。

并行开发状态：阶段 E 在同一棵共享工作树上推进，E02 已落在 HEAD（`e62e90d`），在飞的是
`app/src-tauri/src/{fuzzy,search}.rs` 与 `app/src/searchModel.ts`、`app/tests/search-model.mjs`。
本文的所有度量只针对**已经提交**的状态，阶段 F 的每次落地只 `git add` 自己改过的那些路径。

一次记录在这里，因为它改变的是整棵树的门禁读数：收口 F01 时 `npm run test:fixture` 是红的，
红的不是阶段 F 的用例——`tests/search-model.mjs` 从 `searchModel.ts` 导入了一个当时还没有的
名字，整个文件在装载期就失败，于是 `node --test` 的汇总少了它全部的用例，看起来只是"总数
变了"。那次运行用排除该文件的办法证明阶段 F 自己全绿（369 通过、0 失败），排除项与被排除的
文件都写在这里；共享树上跑门禁时，先看清红的是谁。

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
