# 阶段 E 契约依据与记录：匹配口径、命中地址与折叠成本

实施日期：2026-09-30。基线提交：`a085b59`（阶段 D 的 D04 收口之后）。本文既固定
E02–E04 必须遵守的匹配口径，也是 E01 的实施记录；E01 的落地见 §5（本文与代码同
一次提交）。**§1–§4 描述的是 E01 已经实现并且只有单元测试的那一半**：matcher
今天没有任何调用者，`app/src-tauri/src/main.rs` 里除模块声明外没有命令注册，前端
搜索框不存在。

主机条件同 [A01 基线](05-baseline-a01.md)：Linux x86_64、Git 2.53、WebKitGTK、
Node 26、rustc 1.96.1。**本文没有 Windows/macOS 证据**，那两个平台仍只是构建配置。

并行开发状态：阶段 D 的 D05 正在 `app/src/` 的图表侧推进（`headModel.ts`、
`shell.ts`、`dom.ts`、`views/branches.ts`、`views/history.ts` 与其夹具），E01 只新增
`app/src-tauri/src/fuzzy.rs`，与他的在飞文件无交集；共享树里唯一在飞的 Rust 改动是
`main.rs` 中本文作者加的那一行模块声明。E04 会和他相遇在 `shell.ts` 的顶栏与
`views/history.ts` 的行定位，届时按仓库规则从独立 worktree 度量已提交状态。

## 1. 三件事必须只有一个答案，否则搜索不成立

设计文档已经写出统一搜索的范围与协议；落到代码前有三处口径不能由调用方各自决定，
全部固定进 matcher：

1. **什么算同一个字符串**：两侧都按扩展字素簇做规范化与大小写折叠，折叠不改写原文。
2. **一次命中有多好**：精确→前缀→连续→有序非连续四档，档内比窗口宽度。
3. **命中的位置怎么交出去**：Rust 按字节切，WebView 侧的 JS 字符串按 UTF-16 单元切，
   两者对任何 astral 字符都不同，因此两个偏移一起给，且永远落在整簇边界上。

第 3 条不是细节。提交说明里出现 emoji 不算罕见，一个只在 Rust 侧成立的偏移会画出
半截 emoji 或错位的高亮；一个把命中改写成一串小写文本的 matcher 则丢掉了原文——
搜索框下面显示的必须是仓库里那句话本身。

## 2. 折叠口径，以及它明确不做的事

`fold_cluster`（`app/src-tauri/src/fuzzy.rs`）对一个簇做三步：NFC 合成、逐码点
`to_lowercase`、再补两处 Rust 的全量小写映射与默认 case folding 分岔的地方——
`ß` 展开成 `ss`，词尾 `ς` 归到 `σ`。这两处是**读者会当成 bug 的差异**，不是
CaseFolding.txt 的全部差异：`ÿ`、`ſ`、兼容区的那些分岔没有处理，本阶段不承诺。

选 NFC 而不是 NFKC，因此等价的只有规范等价的写法：`L'école`（预组合）与
`L'e\u{0301}cole`（分解）互相命中，而 `ecole` **不**命中 `école`，反向也不。
这条由 `a_mark_is_not_stripped_from_either_side` 钉住，它是**声明**而非意外：去掉
声符会让一次搜索静默变宽，用户打的是带重音的分支名却拿到不带重音的全部命中。

没有拼音、没有翻译、没有语义匹配。`xiudeng` 找不到 `修复登录`，这是范围而不是缺陷。

提交号不在这里匹配：对象名要由后端解析成对象，不能拿模糊分数当写入目标。matcher
因此从不特化 OID——那是调用方的分流，见 §6。

簇折叠还带来一条必须写清的行为：**匹配按码点进行，报告按簇对齐**。家庭 emoji
`👨‍👩‍👧` 是一个簇、折叠成 5 个码点，所以只打 `👩` 也算命中，但它拿到的片段是整个
家庭 emoji 的字节区间——渲染层永远不会收到一个画不出来的半簇。这与"`ecole` 不命中
`école`"不矛盾：规则始终是一条，折叠后的码点序列里能不能找到 needle，片段再由
`owner` 吸附到簇边界。

## 3. 命中地址：两种偏移，一次换算

`Field::new` 逐簇走一遍原文，同时记下每簇的字节区间、UTF-16 单元区间，以及每个折叠
码点属于哪一簇。`Fragment` 把这两个区间一起交出去。簇是唯一被寻址的单位，
因此：

- 连续命中（精确/前缀/连续档）的码点必然落在同簇或相邻簇上，`run_hit` 恒产出一个片段：
  `build` 在 `fix build graph` 里是**一段**高亮，不是五个字母。
- 非连续命中把相邻簇合并，`fbg` 是三段。
- `unit_offsets_index_the_utf16_string_a_row_is_drawn_from` 用 `🔥 x` 钉住两种地址的
  差值（字节 5、单元 3），这是唯一一种能提前发现"前端直接拿字节当单元用"的夹具。

原文自始至终不被改写：所有测试用 `parts()` 把片段读回原串，断言的是**输入里那几个
字节**，大小写和重音保持用户看到的样子。

## 4. 排序键是键，不是判决

`Hit::rank()` 返回 `(档位, 覆盖的簇数, 覆盖的折叠码点数)`。档位由 `Tier` 的枚举顺序
直接给出，因此"能比较"和"四档的次序"是同一件事，不存在第二份优先级表。

调用方补上 matcher 不该知道的两件事：**命中来自哪个字段**（提交标题/正文/作者、
分支名、Tag 名各有优先级），**候选list本身的顺序**（提交按拓扑序、ref 按名字序）。
同键必须用稳定排序保持原序，由
`equal_ranks_keep_the_order_the_candidates_arrived_in` 钉住：`["a fix","fix","the fix"]`
排完是 `[1, 0, 2]`——精确的那条赢，剩下两条同键，保持它们到达的顺序。若这里换用不
保持等键的稳定排序，同一次搜索两次给出不同顺序，用户会以为结果在动。

`a_tighter_window_ranks_above_a_wider_one_at_the_same_tier` 钉的是"更紧"的定义：
`fix crash` 上的 `fc` 是 `(3,5,5)`，`fix a crash` 上的 `fc` 是 `(3,7,7)`。非连续匹配的
窗口取**最早完成**的那次扫描，再取该终点下最晚的起点，不回头找更窄但结束更晚的窗口
（`find_subsequence`）：回头会排名一个读者还没看到的命中，代价是每个起点都要再搜一遍。

## 5. E01 实施记录

```text
任务：E01 明确 Unicode 规范化/大小写折叠/命中位置和排序规则；实现纯 matcher
对应产品目标：G03 统一模糊搜索（消息正文、OID、Tag、Branch；Unicode 非连续匹配）
起止提交与变更文件：基线 `a085b59` → 本文与代码同一次提交。
  新增 app/src-tauri/src/fuzzy.rs；app/src-tauri/src/main.rs 加一行 mod fuzzy;
  （唯一一行，命令注册不在本任务）；app/src-tauri/Cargo.toml 与 Cargo.lock
  声明 icu_normalizer（default-features = false, compiled_data）与
  unicode-segmentation。
输入条件及 fixture：14 个 Rust 单元测试，全部在 matcher 内，不需要 Git、不需要
  临时仓库、不需要显示环境。类簇覆盖中文非连续、英文缩写、中英混排不误命中、
  大小写与 İ、预组合与分解两种写法、声明的"不去声符"边界、ß 与词尾 ς、
  ZWJ 家庭 emoji 整簇、🔥 的字节/UTF-16 偏移差、空与超长 query、折叠确定性、
  同档紧凑度、等键稳定序。
实现行为与异常路径：空 needle 与 needle 长于字段返回 None（不是"无结果"的谎，
  Query::is_empty 让调用方自己区分"没输入"和"输入折叠后为空"）；档位按
  精确→前缀→连续→非连续判定，命中恒为整簇片段；原文不被改写。异常路径里没有
  任何来自 Git 的输入，因此本任务不涉及"截断流不得解析成有效记录"那条——它属于
  E02 的读取面，见 §6。
运行命令、退出码、日志位置：全部从 app/ 执行，退出码 0，输出不落盘（终端即日志）。
  共享命令：`cargo test`、`cargo fmt --check`、
  `cargo clippy --locked --all-targets`、`npm run build`、`npm run test:fixture`、
  `python3 ../tools/bench/color-contrast.py dist/assets`、
  `python3 ../tools/bench/responsive-check.py src/style.css src/style/tokens.css`。
  计数：cargo test 334 passed（其中 fuzzy 14）、fixture 355 pass / 0 fail、
  build 45 modules、两个样式 gate fails=0、clippy 无输出即无告警。
  **度量位置有一处不是共享树**：写这一段时并行开发者正在改
  `app/src/views/history.ts`，共享树上的 `npm run build` 因他那一处尚未闭合的
  `MenuItem` 导入而失败（TS2304，两行）。按仓库规则改从独立 worktree 度量
  （`/tmp/guit-e01`，分离头指针 `a085b59` 之上只叠本任务的四个文件与一个软链
  的 `node_modules`），上列 JS 侧四条命令在那里全部通过，产物哈希与共享树此前
  一次成功构建一致（`index-BuLgC7xc.js`、`index-BVMWWpFe.css`）。Rust 侧三条命令
  在共享树度量：他当时没有未提交的 Rust，cargo 也不读 `app/src/*.ts`，那次前端
  失败与 Rust 结果无关。
桌面/性能证据与环境：无桌面证据（本任务没有任何 UI）。布局探针
  `tools/bench/layout-probe.mjs` 与两个引擎探针本轮没跑：本任务不新增 DOM、样式
  或交互面，构建产物哈希与改动前一致，跑它们测不出新东西。折叠吞吐在本宿主用
  cargo test a_batch_of_subject_lines -- --nocapture 跑 20 次 warm：
  10,000 行中英混合提交说明，构造 Field + 一次 find 合计 79–92 ms（p50 约 81 ms），
  **是 unoptimized + debuginfo 档**；release 档没量过，不做换算推测。
  这条只说明 matcher 自身不是预算的瓶颈，不等于搜索达标：一次真实批次还要付
  Git 读取，D03a 量到的是每页 20.3 ms 中位
  （[阶段 D 契约依据](16-graph-contract-d.md) §6.1）。验证目标
  （输入到候选反馈 warm p95 ≤150ms、首批 p95 ≤500ms）要到 E04 才有可量的对象。
未解决限制：matcher 今天没有调用者，main.rs 里用模块级 allow(dead_code) 承接，
  E02 接上搜索通道时必须撤掉它；CaseFolding.txt 的分岔只补了两条；正文扫描、
  refs、批次与取消属于 E02；queryId 与旧结果不得覆盖新结果属于 E03；IME 组合期
  不发半成品查询、结果浮层与图定位属于 E04；Windows/macOS 仍只是构建配置。
回退方式：删除 fuzzy.rs、main.rs 那一行与两条依赖声明即可，不触碰任何共享模块，
  不影响现有命令面；Cargo.lock 的图没有增长（见 §6 末），因此回退不改变发布产物。
结论：完成（E01 的交付物与验收条件全部由测试与测量支撑；阶段退出门槛仍差 E02–E04）
```

## 6. E02 动手前要先拿到的事实

按分量排，每条都会决定一个接口，而不是实现细节：

1. **一次 `log` 能带回多少条正文而付多少代价**。`history::page` 现在每页 20.3 ms 中位，
   扫全历史要另一条读法。E02 的批次大小必须由实测的"读 N 条元数据的耗时"倒推出来，
   不能先定 50 条再祈祷它达标；每批上限 50 是**显示**上限，扫描上限、结果条数上限、
   内存上限是三个独立的数。
2. **正文和作者走哪条读**。`--format` 里带 `%b` 会不会让既有夹具的解析器撞上多行正文，
   要用真实仓库量；作者只能作为附加命中字段，不能替代必需字段。
3. **截断的输出永远不解析**。`runner` 的 `truncated` 一旦出现，这一批是错误而不是
   "部分结果"；单条超大提交说明超限要报告，不能悄悄给一条被切的记录。
4. **取消的边界**。新查询取消旧任务靠的是既有 `cancelled` 标志；`session` 的
   `historyGeneration`/`refsGeneration` 决定什么算过期回声，搜索必须复用
   `ReadContext`/`SessionRead` 而不是自造一代计数器。`queryId` 在 B05 里被明确留给
   搜索自己，`generation: null` 的含义是"没有归属域"，不是"待办的 0"。
5. **缓存的边界**。同一固定历史可以复用已读的元数据，但保留必须有界，且 HEAD 移动
   即整批作废；常驻数据库或向量索引不是本阶段的方案。

依赖面：两个 crate 都已在构建图里（`icu_normalizer` 经 `url → idna_adapter`、
`unicode-segmentation` 经 `muda → keyboard-types`）。把 `icu_normalizer` 声明成直接
依赖时**必须**带 `default-features = false`：它的默认 feature 会引入 `utf16_iter` 与
`write16` 两个此前没被解析进来的包。带上之后 Cargo.lock 只在 `guit` 的依赖清单里多出
两行，包图零增长，发布产物不多一行代码。

## 7. §6 那五条事实的量得结果

逐条对上 §6，因为每一条都改了一个接口，而不是一个常量：

1. **一次 `log` 的代价**。在 6,524 条真实历史上量 `--skip` 的再走一遍：skip 0 的 p50 是
   8.9 ms，skip 6000 是 34.2 ms（九次 warm）。所以窗口不能窄——按 50 条翻页会把整段
   历史重走 N 次，扫描变成二次；`WINDOW_RECORDS = 1_000` 是"一次进程读够一批正文"的
   那个数，游标按整窗前进。另两条一起量的：`--topo-order` 在同一次 50 条读取上是
   34.6 ms 对 5.9 ms，而搜索结果列表没有对齐的图沟要保持，于是扫描只要新→旧。
   三个上限各自独立：读 1,000 条（扫描批）、报 100 条提交（结果）、报 50 个名字
   （refs），第四个是 100,000 条的行走天花板。
2. **正文与作者的读法**。用 `%B` 单字段带回整条说明，不用 `%b`：正文和标题是同一段
   字节里的两行，解析端按第一个 `\n` 划出 subject 边界并同时给出字节与 UTF-16 两种
   坐标，一次读取两种标签。记录用 `-z`（`\0`）分隔、字段用 `0x1f` 分隔并按
   `splitn(4)` 切，因此多行正文不会打乱解析——夹具里就有带空行和 emoji 的多行正文。
   作者 `%an` 是独立的第四个字段命中，只作为附加命中字段，永不替代正文。
3. **截断不解析**。`truncated` 一旦为真，整窗拒绝为 `search_truncated`，不返回被切的
   记录；形状不符（切不出四段、id 不是 id）是 `search_protocol_error`。窗口上限
   8 MiB，本夹具首窗 99,991 字节——本仓库自己 218 条提交的全部 `%B` 读取是
   208,441 字节（平均约 956 字节/条），据此一个真实仓库的 1,000 条窗口约 1 MB，
   仍只占上限的八分之一，一条超大说明挤爆窗口的路径是被拒绝而不是被截短。
4. **取消是取消，不是空答案**。复用既有 `cancelled` 标志与 `runner`；取消返回
   `process_cancelled`（夹具钉住它不得伪装成"没搜到"）。本节**没有**引入新的代计数器：
   `ReadContext`/`SessionRead` 的接线在 E03，因此 E02 的 `scan` 只把 `rev` 当参数再校验
   一次完整 oid，把它交给 Git 之前不假设调用方已经钉住。
5. **没有缓存**。一个窗口一次读取，续读靠 `next_cursor`；HEAD 移动即游标作废这件事由
   E03 的 session 绑定负责，本模块不自建保留集，因此也没有"有界保留"要证明。

窗口语义里唯一容易被写错的一条：`hits_truncated`（这个窗口还有更好的没送来）和
`complete`（历史走完了）是两个不同的断言，只有后者能支撑"无结果"那句文案。夹具把
它们分开了：2,500 条全命中、窗口 1,000、上限 100，第一窗被截断且未完，最后一窗才完。

## 8. E02 实施记录

```text
任务：E02 新 search.rs：当前历史消息/正文/提交号 + 仓库 refs，批次、取消、输出界限
对应产品目标：G03 统一模糊搜索（消息正文、OID、Tag、Branch；能找到面板没加载的旧提交）
起止提交与变更文件：基线 `e9c5a1a` → 本文与代码同一次提交。
  新增 app/src-tauri/src/search.rs（scan/read_window/ref_hits/probe_reachable 与 19 个
  单元测试）；app/src-tauri/src/main.rs 加一行 mod search;（唯一一行，命令注册不在本
  任务）；app/src-tauri/src/fuzzy.rs 给 Fragment 加 `Serialize` 与 camelCase 重命名
  （含一行 `use serde::Serialize;`），使命中片段可以随结果出后端，并把它的模块级承接
  注释改写成"随命令注册一起撤"。无 Cargo 变更：serde 早已是直接依赖。不改任何既有命令
  面、不动 session/write/runner 的实现。
输入条件及 fixture：19 个 Rust 单元测试，需要 Git 与临时仓库，不需要显示环境。夹具是
  一次 `git fast-import` 写的线性历史（每提交秒递增，"新→旧"因此是夹具规定的事实而非
  请求的运气），五个提交覆盖中文标题、多行正文、emoji、作者名；跨窗口的历史用
  deep(count, positions, needle) 生成，positions 是**扫描序偏移**（"HEAD 往回第几条"），
  因为那是窗口报告的数，而流是旧→新写的，所以消息按偏移选好再倒序交给 fast-import。
  这里踩过两次坑，记下来免得重踩：`data <len>` 的 len 把结尾换行算在内，再补一个换行
  就是 commit 的终止空行，随后的 `M 100644 inline lane` 会被当成顶层命令而报
  "unsupported command"；`--done` 需要流末尾真的有 `done`；同一分支的连续 commit 自动
  接前一个作父，`from` 只在跨分支或首提交时用，写 `from refs/heads/main^0` 会被拒
  （"invalid ref name or SHA1 expression"），写分支自身会被拒（"can't create a branch
  from itself"）。
实现行为与异常路径：查询先 trim 再折叠，折叠后为空是 search_query_empty（"没输入"和
  "输入折叠没了"都由调用方判，不是"无结果"）；长过 256 字符是 search_query_too_long；
  rev 不是完整 oid 是 search_target_invalid；游标越过天花板是 search_scan_capped 且带
  "历史没被搜完"这句话。七位以上纯十六进制才按对象 id 前缀处理，且 id 命中永远是
  exact/prefix、不参与模糊评分。一条记录内：oid、消息（一次，标题/正文按落点标签）、
  作者名各成一命中，按字段优先再按 matcher 的键排；稳定排序让等键保留 Git 的新→旧。
  refs 只在游标 0 读一次（`refs::list` 的 fail-closed 三条照用），按它自带的 rank 排序
  并截到名字上限，可达性用 `merge-base --is-ancestor` 问 Git（0 是、1 否、其它是
  search_reach_failed），最多探 8 个，`oid == rev` 免进程直接判是。异常路径全部落在
  "整窗拒绝"：截断、非零退出、非四段形状、id 不像 id。
运行命令、退出码、日志位置：全部从 app/ 执行，退出码 0，输出不落盘（终端即日志）。
  共享命令同 §5 那份：`cargo test`、`cargo fmt --check`、
  `cargo clippy --locked --all-targets`、`npm run build`、`npm run test:fixture`、两个
  样式 gate。计数：cargo test 353 passed（其中 search 19）、fixture 355 pass / 0 fail、
  build 45 modules、两个样式 gate fails=0、clippy 无告警。fmt 本轮必须跑：新文件写完
  `cargo fmt --check` 报了 18 处 diff，`cargo fmt` 后只差 `search.rs` 一个文件（共享树
  当时只有我的三个文件在飞，`git status --short` 复核过，没有碰到并行开发者的内容）。
  用户可见文案 gate 也在扫描 `app/src-tauri/src` 的注释，355 条里包含它，通过。
桌面/性能证据与环境：无桌面证据（本任务没有任何 UI，不新增 DOM、样式或交互面，构建
  产物与改动前同源）。布局探针与两个引擎探针本轮没跑，理由同 §5：跑它们测不出新东西。
  扫描吞吐在本宿主 cargo test a_batch_of_two_thousand -- --nocapture --test-threads=1
  量到：2,000 条合成历史上首窗（1,000 条 + 1 备用）warm 九次 p50 23.9 ms，整趟三窗
  48.7 ms，首窗 99,991 字节；**是 unoptimized + debuginfo 档**，release 档没量过，不做
  换算推测。对照 D03a 每页 20.3 ms（[阶段 D 契约依据](16-graph-contract-d.md) §6.1）：
  一个搜索窗的成本约等于一页图的成本，这正是"按整窗翻页"能成立的依据。
  度量都在共享树做：并行开发者当时没有未提交的 Rust 文件。
未解决限制：`scan` 今天没有调用者，两个模块级 allow(dead_code) 一起承接，E03 注册
  `search_repository` 时必须同时撤掉并按 BOUND_READS 归类（ipc-surface.mjs 要求每条
  bound read 都有前端 invoke 字面量，这就是 E02 不注册命令的原因）；`queryId`、
  ReadContext 绑定与"旧 query/旧仓库的结果不得覆盖新结果"属于 E03；顶栏输入、IME
  组合期不发半成品查询、结果浮层、高亮、键盘导航与图定位属于 E04；验证目标里
  "输入到候选反馈 warm p95 ≤150ms、首批 p95 ≤500ms"要到 E04 才有可量对象，本节的
  23.9 ms 是后端单窗，不含 IPC 与渲染；Windows/macOS 仍只是构建配置；可达性探测
  上限 8 个意味着一个第 9 个匹配上的名字会以"未知"报出，这是有意的取舍，不是漏项。
回退方式：删除 search.rs、main.rs 那一行与 fuzzy.rs 的三处改动（Fragment 的
  Serialize 派生、use、承接注释）即可，不触碰任何共享模块，不影响现有命令面；本轮
  没有 Cargo 变更，回退不改变发布产物。
结论：完成（E02 的交付物与验收条件由测试与测量支撑：未加载的旧提交在第 1,050 条被
  找到并带偏移；完整扫描之前没有任何窗口能说"无结果"。阶段退出门槛仍差 E03–E04）
```

