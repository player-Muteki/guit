# 阶段 E 契约依据与记录：匹配口径、命中地址与折叠成本

实施日期：2026-09-30。基线提交：`a085b59`（阶段 D 的 D04 收口之后）。本文既固定
E02–E04 必须遵守的匹配口径，也逐段记下已经落地的部分：E01 的纯 matcher 见 §5，E02 的
扫描通道见 §8，E03 的读取协议与前端模型见 §10——三处都是本文与代码同一次提交。
**§1–§4 描述的是那一半只有单元测试的实现**；到 E03 为止它的调用者仍是扫描通道自己，
`app/src-tauri/src/main.rs` 里除模块声明外没有命令注册，前端搜索框要到 E04 才存在。

主机条件同 [A01 基线](05-baseline-a01.md)：Linux x86_64、Git 2.53、WebKitGTK、
Node 26、rustc 1.96.1。**本文没有 Windows/macOS 证据**，那两个平台仍只是构建配置。

并行开发状态：写 §1–§5 时阶段 D 的 D05 正在 `app/src/` 的图表侧推进（`headModel.ts`、
`shell.ts`、`dom.ts`、`views/branches.ts`、`views/history.ts` 与其夹具），E01 只新增
`app/src-tauri/src/fuzzy.rs`，与他的在飞文件无交集。到 E03 为止这个交集依然为空：D 已
收口，他在做阶段 F，在飞与刚落地的是 `views/changes.ts`、`dialogs/preview.ts`、
`fileModel.ts`、`state.ts` 与其夹具，本文这四份文件没有一个和他重叠。E04 会和他相遇在
`shell.ts` 的顶栏与 `views/history.ts` 的行定位，届时按仓库规则从独立 worktree 度量已
提交状态——E03 的度量已经在那么做了，见 §10。

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

## 9. E03 动手前要先拿到的事实

E03 的验收是"旧 query/旧仓库的结果不覆盖新结果；超限有原因，不能解析截断流"。后半句
E02 已经落地（异常一律整窗拒绝），前半句要先问清四件事，每件都决定一个接口而不是实现细节：

1. **一次读取只绑一个域，而一个答案同时带两个域的东西**。`session::bind_read` 收单个
   `ReadDomain`；搜索绑的是图域（偏移是图的语言），可它的答案里还有名字。名字的新鲜度
   因此不能塞进 context，只能作为**值**报出，并且要在列出名字*之前*读
   `refs_generation`：如果扫描途中一次 refresh 动了名字，这个答案就故意显得比它实际的
   更旧，前端据此丢掉名字而不是合进一条已经改名的分支。丢掉名字是安全的方向，把已经
   改名的分支留在屏上不是。→ 接口：`SearchPage.refs_generation`。
2. **裸仓库没有 branch 快照**。`capture_inner` 对 bare 直接返回
   `(PathTable::default(), None, Vec::new(), None)`——Git 拒绝在 bare 里跑 status，于是视图
   里根本没有分支名，`pinned_head()` 也就是 None。但历史确实在那儿，且面板必须能搜。
   实测口径照 `history::pinned_rev`：`rev-parse --verify HEAD` 非零退出就是没有提交可走。
   → 接口：锚点回落为"HEAD 解析出的完整 id"，它同时就是 `SearchPage.head`；解析不出提交
   是 `search_head_unresolved` 这句原因，绝不是一窗"没搜到"。
3. **session id 在同一个 `SessionState` 内单调，换仓库不回零**。queryId 是前端自己的计数，
   新会话从 1 起。若通道只按 queryId 判新旧，第二个仓库的第一次按键会被上一个仓库还在
   跑的第 9 次判为"已被压过"而永远搜不了。→ 接口：`SearchState` 的槽位按
   `(session_id, query_id)` 二元组判，跨会话直接占位并把旧旗标置真；同一 query 的两个窗口
   共用一面旗标（续窗若换新旗标就会取消它自己正在走的那趟）。测试
   `a_second_repository_starts_its_own_count`。
4. **扫描序不是图形序**。搜索的 `log` 不带 `--topo-order`（E02 的量得结果：全仓排序另付
   代价，而结果列表没有沟槽要对齐），图的那页带。两条序只在"新→旧"这一个方向上重合，
   `offset` 数的是扫描走过的记录，不是屏上的行。→ 接口：命中定位只按身份，
   `history_page(oid, start = 0)` 从那个提交自己起读一页，前端模型因此根本不收 offset。

另外两条是约束而非未知，写在这里是为了让"为什么 E03 到此为止"有一个交代：取消旗标必须
交给 `runner`（E02 的读窗已经收 `&AtomicBool`）；命令注册必须与它的前端调用者同一次提交
落地，因为 `app/tests/ipc-surface.mjs` 要求每条 bound read 都有对应的 `invoke` 字面量——
这就是 E03 不碰 `main.rs`、`search.rs` 与 `fuzzy.rs` 的两个模块级 `allow(dead_code)` 还要
活到 E04 的原因。

## 10. E03 实施记录

```text
任务：E03 搜索读取协议——session 绑定、查询通道、翻页合并与纯前端模型（不含命令注册，
  不含任何界面）
对应产品目标：G03 统一模糊搜索。本阶段的验收句是"旧 query/旧仓库的结果不得覆盖新结果；
  超限有原因，不能解析截断流"。后半句 E02 已经落地，本阶段做的是前半句。
起止提交与变更文件：起始代码基线 `e62e90d`（E02 落地）→ 本文与代码同一次提交。测量点是
  `29be513` 加这四份文件，并且在独立 worktree `/tmp/guit-e03`（`git worktree add --detach`
  + 私有 `CARGO_TARGET_DIR`）里度量：共享树当时带着并行开发者的 F 阶段在飞前端改动，
  `cargo fmt` 一旦需要就地改写就会碰到他的文件。变更文件：app/src-tauri/src/search.rs
  （E03 块：`SearchPage`、`Claim`、`SearchState`、`Ticket`、`search_rev`、`page`、
  `page_inner`，加 9 个单元测试，模块内 28 个）、app/src-tauri/src/fuzzy.rs（`Tier` 加
  `Serialize` 与 camelCase，删掉只服务本地打印的 `tier_name`）、app/src/searchModel.ts
  （新增纯模型）、app/tests/search-model.mjs（新增 20 条夹具）、本文 §9–§10。不碰
  `main.rs`、不碰 `app/tests/ipc-surface.mjs`、不碰任何 view 与样式，因此没有新增命令、
  没有新增 DOM；Cargo 无变更。
输入条件及 fixture：9 个新 Rust 单元测试加 20 条夹具测试。Rust 侧沿用 E02 的
  fast-import 线性历史，新加两种会话形状：`open_session(Fixture)`（有 work tree，快照
  pin 住 head，锚点因此是一个已经持有的数而不是一个进程）与 `bare_fixture`
  （`init --bare`：Git 拒绝在裸仓库里跑 status，快照没有 branch，锚点必须回落成一次
  rev-parse）。取消那条是真起了一个 Git 进程再置旗标
  （`a_newer_query_stops_the_scan_under_way_at_the_process_boundary`），不是原地读一个
  bool。夹具测试的输入全是 wire 形状的镜像对象：`SearchPage` 由 `page()`/`read()`/
  `window()` 三个 builder 造，head 是同一个字母重复 40 次——"一个完整的对象 id"正是这
  个模型收到的唯一身份形式。
实现行为与异常路径：后端一次窗口 = `bind_read(Graph)` → `lane.begin` → `page_inner` →
  `ticket.finish`。绑定失败时 Git 一次都不问（`read_no_session`、`read_stale_context`，
  两条都沿用 session.rs 已有的话）。通道按 `(session_id, query_id)` 二元组判：同会话里
  更小的 query 是 `search_superseded`，相等的续窗共用同一面旗标（换新旗标就会取消它自己
  正在走的那趟），更大的或另一个会话的先置真旧旗标再占位；`finish` 只在槽位仍是自己那次
  claim 时清空，否则第三个搜索会在第二个还在走的时候拿到空槽。锚点：快照 pin 住 head 就
  用它，pin 不住就问一次 `rev-parse --verify HEAD`，非零退出是 `search_head_unresolved`
  这句原因、读回来的不是完整 id 是 `search_protocol_error`，两条都不是"没搜到"；那一次
  进程吃的是同一面取消旗标，所以一次按键压过查询之后没人等它。`refs_generation` 是**值**
  而不是 context 的一部分：它在列名字之前读，扫描途中一次改名只会让这份答案显得更旧。
  前端模型只做四件不碰 DOM 的事：数 query（`nextQueryId` 按 session 分别计数）、判一条
  答案该丢该留（`dropReason` 依次问 session、query、generation）、把窗口拼成结果
  （`mergePage`：`scanned` 累加，`complete`/`stoppedBy`/`nextCursor` 一律取最新那窗，
  head 与 refsGeneration 取第一窗——续窗若换了 head，generation 那一维先把它拒了；
  `hitsTruncated` 是粘性或；名字只在游标 0 那一窗有；属于另一个 query 的续窗拒收为
  `window`）、把三种拒绝和"无结果"分开（`outcomeOf` 的 overtaken/closed/refused，
  与 `nothingMatched` 互不越权）。定位只按身份：`locateCommit` 在这一页里有它就是行号，
  没有就交给 `history_page(oid, start=0)`，因为扫描序与拓扑序只在"新→旧"上重合。高亮按
  UTF-16 单元切、按簇边界收，`segments` 丢掉越界与倒置的片段而不是画半截。
运行命令、退出码、日志位置：全部在 `/tmp/guit-e03/app` 与 `/tmp/guit-e03/app/src-tauri`
  （`CARGO_TARGET_DIR=/tmp/guit-e03-target`）执行，退出码都是 0，输出不落盘（终端即日志）。
  计数：cargo test 368 passed（其中 search::tests 28）、`cargo fmt -- --check` 零 diff、
  clippy `--locked --all-targets` 0 条告警、npm run build 45 modules
  （`index-cbBH50LX.js` / `index-C6_rx0ho.css`）、npm run test:fixture 388 pass / 0 fail
  （其中 search-model 20 条；用户可见文案 gate 在这 388 条里，它扫 `app/src-tauri/src`
  的注释）、两个样式 gate fails=0。fixture 比 E02 记的 375 多 13 条，全部来自测量点那个树
  上的前端夹具，不是本阶段的数；这条数会随任何前端提交继续挪，所以它只属于它注明的那个测
  量点。
桌面/性能证据与环境：无桌面证据——本阶段没有任何界面，不新增 DOM、样式或交互面；
  `searchModel.ts` 被 tsc 检查过，但没有被任何 view import，因此在产物里查不到它的任何
  字符串（`grep -c` 在 `dist/assets/index-cbBH50LX.js` 上对 `search_scan_capped` 与
  `outcomeOf` 都是 0）。布局探针与两个引擎探针本轮没跑：跑它们测不出新东西。度量都在
  本宿主、release 档（E02 记的是 unoptimized 档，两个数并排是换算的出处而不是猜测的依
  据）：首窗 warm p50 9.22 ms、2,000 条整趟 17.37 ms、首窗 99,991 字节对 8,388,608 上
  限；`search.head` 在快照 pin 住 head 时 0.0 ms（三次，无进程），裸仓库 0.8–1.0 ms
  （九次，中位 0.9，一次 rev-parse）。这两句是 E03 唯一新增的耗时面：一次按键最坏多付
  一个进程。
未解决限制：命令仍未注册——`search_repository` 的注册、`ipc-surface.mjs` 的 bound read
  条目、前端那条 `invoke` 字面量与 `app.manage(search::SearchState)` 必须同一次提交落
  地，所以 `search.rs` 与 `fuzzy.rs` 的两个模块级 `allow(dead_code)` 还挂着；
  `SessionRead<SearchPage>` 今天还没有把它送出进程的 Tauri 命令，`process_cancelled`
  在前端已被归为"被压过"，但那条路目前只有单测走过。取消仍是被动的（新 query 抢槽），
  没有 `cancel_search` 这条命令，所以清空输入框之后已开始的那趟会走到自己那一窗结束。
  `refs_generation` 只能让名字显得旧，不能让已经画出来的提交行显得旧——那是 refresh 的
  事。顶栏输入、IME 组合期不发半成品查询、结果浮层、把高亮画到屏幕上、键盘导航与图定位
  属于 E04；验证目标里"输入到候选反馈 warm p95 ≤150ms、首批 p95 ≤500ms"要到 E04 才有
  可量对象，本节的 9.22 ms 是后端单窗，不含 IPC 与渲染。Windows/macOS 仍只是构建配置。
  度量基线是 `29be513`：那之后共享树里又出现的在飞改动不在这组数里，也不属于它。
回退方式：删除 app/src/searchModel.ts 与 app/tests/search-model.mjs，把
  app/src-tauri/src/search.rs 退回 `e62e90d` 那份、fuzzy.rs 的 `Tier` 去掉 `Serialize`
  与 camelCase 并恢复 `tier_name` 即可。不触碰任何共享模块与命令面；本轮没有 Cargo 变更，
  前端新文件无人 import，回退不改变发布产物。
结论：完成（验收句的两端都有钉住的数：一条答案丢不丢、丢在哪一维、三种拒绝各自说什么、
  第二仓库从 1 开始计数、裸仓库从 HEAD 解析出的那个提交搜。阶段退出门槛仍差 E04）
```


## 11. E04 动手前要先拿到的事实

E04 的验收是三句："搜索没有 Git 写副作用；范围外引用说明清楚；原图拓扑不被过滤破坏"。
落到这套界面上有六件事先要问清，每件都决定一个接口：

1. **输入框在 Main 页，不在 app bar。** `shell.ts` 的那一行已经装了字标、仓库名、分支
   chip、四个会话按钮、提交钮、More 与四只窗控，而它在 340 宽与放大档下的换行行为是被
   阶段 G 的探针逐档钉住的（`zoom-reflow-check.py` 记的就是"18 起两行、四只钮贴右边界"）。
   再加一个输入框等于重测那一整段，而搜索恰恰只在有会话时有意义——它属于 Main，欢迎态
   里根本没有它。→ 接口：`createSearchView(deps)` 交出 `element`，由 `main.ts` 作为
   `.main-panel` 的第一个子元素交给 `createMainPanel`，形状与另两个区域一样（`sync()` +
   `render()`）。
2. **结果层不能借 shell 的那一个 overlay 槽。** `registerOverlay` 只存一份内容与一个
   `onShow`，今天被分支选择器占着；而 `escapeStack` 那句"菜单 → overlay → 对话框"是按
   一层写的。两个页面级浮层同时可开会让她变成一句谎。→ 接口：结果层是搜索模块自己的
   绝对定位元素，和 `.menu` 同档（z 序 40，`--surface-raised` + `--line`），开合与焦点
   归还在模块内闭环，Escape 到它就停。
3. **组合期不检索，这条今天整个仓库都没有实现过。** 全仓没有一处 `isComposing`：现有
   的"不误触发"靠的是普通键只挂在非输入元素的监听上（`/` 挂在 `listPane`）。中文输入法
   的候选串会以 `input` 事件一段一段进来，每一个都是"半个查询"。→ 接口：
   `compositionstart` 关闭发查询、`compositionend` 当作一次普通输入重新计时；120 ms
   的 debounce 写在纯模型里并可测，因为验证文档要求"不把 debounce 隐藏在统计外"。
4. **能在纯模型里钉的行为必须留在模型里。** 这个仓库的接线测试是**源码 gate**
   （`app/tests/changes-wiring.mjs` 读源文件比正则），没有 DOM shim，也没有 `invoke`
   桩。所以"这条答案该不该丢、这一窗怎么并、三种拒绝各说什么"只能在
   `app/src/searchModel.ts` 里被真的跑过——视图那一层留给源码 gate 检查形状。→ 接口：
   `views/search.ts` 里不许出现任何判断，只有 DOM 与事件；它 import 纯模型。
5. **图定位第一次真的用 `history_page` 的 `oid`。** 后端从 D01 就收这个参数（
   `main.rs:540` 先按完整 id 验），前端 `history.ts:989` 至今恒传 `null`。扫描序与图形序
   只在"新→旧"上重合（§9 第 4 条），所以命中要么在已加载页里（按 oid 找行），要么就以
   它为锚读一页并替换窗口——后一种必须让图头部说出"这一页是从这个提交画的"，并留下一条
   回分支头的路，否则读者以为自己在看分支。结果层永不写 `visible`，也不过滤任何行
   （验收第三句）。→ 接口：`HistoryView.reveal(oid)` 返回它走的是哪条路，搜索模块只决定
   要不要关自己。
6. **页内那个 `Find in loaded commits` 要被统一搜索替掉。** 它正是退出门槛点名的"仅前端
   已加载过滤"，而且它 `visible = filterCommits(...)` 会把非命中行删掉再画图——同一件事
   在统一搜索的验收里是禁止的。两个输入框也和 OUTLINE"一个输入框搜索…"冲突。→ 决定：
   统一搜索先落地（第一次提交，自己完整），删页内 find 与它的 `filterCommits` 调用点是
   第二次提交（它带着 `historyModel.ts` 的导出与一批夹具，独立成一次更容易回退）。

两条是约束：命令注册必须与它的前端 `invoke` 字面量同一次提交（`ipc-surface.mjs` 的
BOUND_READS 那条），所以 `search.rs`/`fuzzy.rs` 的两个 `allow(dead_code)` 在第一次提交里
一起撤；输入框的任何一条路径都不许碰写 lane——G03 的"没有 Git 写副作用"由"这个模块只
import `search_repository` 与 `history_page` 两条读"来担保，而 `history_page` 只在
`reveal` 里被 `history.ts` 自己调用。


## 12. E04a 落地记录

```text
任务：E04a 顶栏输入、IME、结果浮层、高亮、键盘导航与图定位——第一次提交，统一搜索自己
  完整（§11 第 6 条决定页内 find 留给第二次提交）
对应产品目标：G03 统一模糊搜索。本阶段的验收句是"搜索没有 Git 写副作用；范围外引用说明
  清楚；原图拓扑不被过滤破坏"。三句都有钉处：第一句是 `search-wiring.mjs` 数出这个 view
  只有 `invoke<` 一次且那条是 bound read，第二句是 `refRow` 把 `commitOid === null` 与
  `reachedFromHead` 的三种值分别写成三种话，第三句是 `reveal` 只换"从哪一页读"而不写
  `visible`。
起止提交与变更文件：起始代码基线 `a340cc7`（并行开发者的 reset 记录）→ 本文与代码同一次
  提交。测量就在共享树里做，因为那次之后他手上只有一份未跟踪的 `tools/bench/` 探针，
  Rust 侧与 `cargo fmt` 都没有在飞改动可碰；`cargo fmt -- --check` 与 clippy 都不写源码。
  变更文件：app/src/views/search.ts（新增：字段、层、行、键盘与计时，判断一律外置）、
  app/src/searchModel.ts（`SEARCH_DEBOUNCE_MS`/`typed`/`errorCode`/`DRAWN_COMMITS`/
  `drawnCommits`/`hiddenCommits`/`hasMark`/`drawCommit`/`drawRef`）、
  app/src/views/history.ts（`RevealRoute` 与 `reveal(oid)`、`anchorOid`、头行的
  `.history-anchored` 那条与"Branch head"回退钮、`loadPage` 在锚点中途变了之后重读一次）、
  app/src/views/mainPanel.ts（三区域签名，search 是第一个子元素）、app/src/main.ts、
  app/src/style.css、app/src/style/tokens.css（`--search-cap` 40vh，两档短窗收到 36/30vh）、
  app/tests/search-model.mjs（20→25 条）、app/tests/search-wiring.mjs（新增 8 条源码
  gate）、app/tests/ipc-surface.mjs（BOUND_READS 加 `search_repository`）、
  app/src-tauri/src/main.rs（注册命令 + `manage(search::SearchState::default())`）、
  app/src-tauri/src/search.rs 与 fuzzy.rs（撤掉两个模块级 `allow(dead_code)`；撤之后
  `Bare { root }` 那条 "field is never read" 才露出来，于是把它改成 `Bare::dir()` 读
  root，而不是再拿一条 attribute 把警告按下去）、tools/bench/responsive-check.py
  （`--search-cap` 进"declared"与"restated for a short window"两份清单）、CHANGELOG.md、
  本文 §11–§12。Cargo.toml 无变更。
输入条件及 fixture：Rust 侧 373 条测试没有新增一条——本阶段没有新读，只是把 E03 已经
  测过的读接上命令面。前端新增 13 条：5 条算得出结果的（等待、拒绝码、行宽、切分、名字
  行），8 条读源文件的（一个 invoke、不借 shell 的 overlay 槽、面板第一子元素、等待写在
  模型里、组合期不发、`locateCommit` 只在 history 侧、锚点那条句与回退钮、Escape 停在层）。
  高亮夹具把跨 subject/body 边界的那一段单独钉住：`frag(0, 8)` 打在 `"lane\nlane two"`
  上，subject 拿到 `"lane"`、body 拿到 `"\nlan"`，两段合起来仍是原串——这一条是"高亮不
  搬字母"的唯一证据。
实现行为与异常路径：一次按键 → `typed(field.value, composing, now)` → 到点才
  `send(query, 0, true)`；fresh 才 `nextQueryId`，"Search further back" 沿用同一个
  `queryId`，因为 `SearchState::begin` 把相等 id 认作同一趟扫描的下一窗并共用那面旗标，
  换新 id 会让 `mergePage` 以 `window` 拒收自己后半程。答案回来先问"这屏还是发起那一屏
  吗"（`requestSeq`、`contextMatches`），再让 `mergePage` 决定它属于哪个问题。三种拒绝
  各有一条路：closed 清空、overtaken 静默、refused 写一句"The search could not be read."
  并交给 `onError`。层的可见性是 `wanted && shown` 两个旗标，`shown` 不含"正在问"，所以
  首窗还在路上时屏上是字段旁的"Searching…"而不是一个空盒子；一个空的未完窗仍会打开层，
  因为它的页脚说的是"Nothing in the history read so far"而不是"Nothing matched"，而
  `isSettled` 之前那条 `nothingMatched` 永不成立。图定位两条路：已加载 → `revealRow` +
  `setCursor` + 开泡 + flash；未加载 → `anchorOid = oid` 后整页重读，头行写明"Drawn from
  <oid10> — not the branch head."，`sync()` 一律清掉锚点。
运行命令、退出码、日志位置：`npm run build` 退出 0（47 modules，产物
  `index-BTx7x47s.js` / `index-MT9q80KC.css`）、`npm run test:fixture` 402 pass / 0 fail
  （含 ipc-surface 9 条与 user-facing-copy 1 条）、`cargo fmt -- --check` 零 diff、
  `cargo clippy --locked --all-targets` 0 条告警、`cargo test` 373 passed / 0 failed、
  `responsive-check.py` 与 `color-contrast.py dist/assets` 都 fails=0。输出不落盘。
  `--search-cap` 走 tokens.css 那条正是 `color-contrast.py` 已有的
  `--accent on --surface-raised` 4.5:1 与 `--text-faint on --surface-raised` 4.5:1 覆盖
  的面，所以那一份 gate 没加新配对。
桌面/性能证据与环境：本轮没有任何渲染度量。`layout-probe.mjs` 需要 msedge，本宿主没有
  装（`which msedge/google-chrome/chromium` 全空），所以那九个尺寸上的
  overlap/overflow/invisible 三条与"两区域同时有盒子"那条，本阶段没有跑过——这一句是要在
  渲染探针那一步补的证据，不是"通过"。WebKit 那条通道倒是通的：
  `appearance-engine-probe.ts` 在本宿主 fails=0，说明写 `search-layer-engine-probe.ts`
  不需要新环境。读预算那个数（输入到候选 warm p95 ≤150ms）也还没量：它现在至少包含了
  120 ms 的等待，而等待之所以写在 `searchModel.ts` 里并写成导出的常量，正是为了这一条
  能被算进去而不是被藏起来。宿主：Ubuntu 26.04、Git 2.53、Node 26；Windows/macOS 仍只是
  构建配置。
未解决限制：页内那个 `Find in loaded commits` 还在，于是 Main 上暂时有两个输入框——§11
  第 6 条把它排成第二次提交，因为它要删 `filterCommits` 在 view 里的调用点并带走
  `historyModel.ts` 的导出与一批夹具。`cancel_search` 这条命令仍没有，清空字段只停止
  下一次提问，已开始的那一趟走到自己那一窗结束。`--search-cap` 在 340x400 上到底遮住
  多少没量过；`.search-view` 是 `.main-panel` 的 `flex: 0 0 auto` 兄弟，两个区域的地板
  加上它装不进短窗时按既有规则整面板滚，这条也是待量。键盘到搜索框的入口还没有：`/`
  今天仍绑在 `history.ts` 的 `listPane` 上，`focusField()` 交出去但没人调它——把它接成
  一个全局快捷键属于第二次提交删页内 find 的那一刀。
回退方式：删 app/src/views/search.ts、app/tests/search-wiring.mjs，把 mainPanel.ts 退回
  两参数签名、main.ts 退掉 createSearchView、history.ts 退掉 reveal/anchor 那条、
  searchModel.ts 退掉 §12 列的九个导出、tokens.css 与 style.css 退掉 `--search-cap` 与
  `/* --- search --- */` 整块，再把 main.rs 的注册与 `manage` 撤掉、恢复两个
  `#![allow(dead_code)]` 与 `Bare` 的三个字段即可。回退后 `ipc-surface.mjs` 与
  `responsive-check.py` 的两处条目要一起退，否则它们各自扫到一个不再存在的事实。
结论：完成（三句验收都有钉处；阶段退出门槛仍差 E04b 的删页内 find 与 E04c 的渲染证据
  和读预算）
```

## 13. E04b 落地记录

```text
任务：E04b 撤掉页内 `Find in loaded commits`、删掉它在图里留下的第二份行列表，并把 `/`
  接到统一搜索的字段上（§11 第 6 条排定的第二次提交）
对应产品目标：G03 统一模糊搜索，也是阶段 E 退出门槛那句"原图拓扑不被过滤破坏"与 OUTLINE
  "一个输入框"这两条的正身。上一行（§12）把字段、层与定位做成了一件完整的事，但整个仓库
  同时还有一个会过滤行的框：它把 `filterCommits` 的结果写进 `visible`，然后 `renderRows`、
  `reveal`、键盘边界全都读那份 `visible`——图于是由"留下的行"画出来。本阶段不给自己加一条
  守卫，而是把那条路径连根删掉：判定留在模型里、行列表只有一份，验收第三句就此成为结构性
  事实而不是被绕开的风险。
起止提交与变更文件：起始代码基线 `8df9dad`（并行开发者的忽略清单测量）→ 本文与代码同一次
  提交。变更文件：app/src/views/history.ts（−174 行里带着字段、大小写/正则两个开关、上/下
  两个步进、计数、`findBox` 进 `listHead` 的那条、`find`/`visible`/`findOpen` 三个状态、
  `// --- finding ---` 整节、两处 `visible = filterCommits(...)`、两个 `findInput` 监听、
  `case "/"` 与 `else if (findOpen) closeFind()` 那条分支；剩下每个 `visible` 退回
  `commits`，头注释改为说明"问哪一个提交"的控制为什么离开了这个头部）、
  app/src/historyModel.ts（删 `FindQuery`/`commitMatches`/`filterCommits`/`findError`/
  `matchPosition`/`stepMatch` 六个导出与整节，`anchorRow` 的文档改成"每次滚动、每一页、
  每次分支换掉都整行重画"——过滤这一路不再是它要负责的一种重画）、
  app/src/main.ts（`/` 从窗口的 keydown 绑进：`isSessionActive() && activeView() === "main"`、
  事件的 `target` 不在 `input, textarea, select` 里、然后 `preventDefault()` +
  `search.focusField()`；`activeView` 因此进了 `./state` 的 import）、
  app/src/style.css（删 `.history-findbox` 与其 `[hidden]`、`.history-find` 与其
  `:focus-visible`、`.btn-quiet.active`、`.find-count` 与其 `[data-state="error"]`，
  flash 那条注释从"a find step or a write landed"改成"a reveal or a write landed"，气泡那条
  注释去掉"and filter"和"同 find box 一个理由"）、app/src/views/settings.ts（Shortcuts 那列
  加 `/` 一行）、app/tests/history-model.mjs（40→35：五条 find 夹具与它们的 `find`/`history`
  helper 一起走，namespace 读不到那条里两句关于 `commitMatches` 的断言留下）、
  app/tests/search-wiring.mjs（8→10）、
  tools/bench/commit-bubble-engine-probe.ts（并行开发者的文件，见下一段）、CHANGELOG.md
  （Removed 一条）、本文 §13、plan/README.md（E04a 行的"仍开着的"与本行）。
  没有 `Cargo.toml` 与 Rust 变更，所以本轮没跑 cargo 三条：共享树里他手上正有
  `app/src-tauri/src/reset.rs` 在飞，一个不写源码的 gate 也不该去碰别人的文件，而这次确实
  没有任何 Rust 侧事实要它回答。
输入条件及 fixture：前端净减 3 条（402→399）——5 条算得出过滤结果的夹具走了，2 条读源文件的
  gate 进来。新 gate 一条钉"这页只有一个 search 字段、那个会过滤的盒子确实没了"：三个 Main
  区域（`views/changes.ts`/`views/history.ts`/`views/mainPanel.ts`）都不许出现
  `type: "search"`，`views/search.ts` 必须出现；`historyModel.ts` 里不许再有
  `filterCommits|commitMatches|FindQuery`；`history.ts` 里不许再有 `find-mod|find-step|
  history-find|find-count` 这四个类名；CSS 里不许再有 `.history-find|.find-count|.btn-quiet.active`
  ——那两个开关本来没有自己的规则，它们骑在 `.btn-quiet` 上、只靠 `.active` 变色，所以这条
  gate 查的是那条 `.active`。另一条钉"这一个键从页面的任何地方都到得了字段，但从一个正在写的
  框里到不了"：读 `main.ts` 里那条监听的五件事（键、三个修饰键、两个前置条件、`closest`
  的排除、`preventDefault` 与 `focusField`）。写这条 gate 时它自己先红过一次：我原来的前提是
  "全仓只能有一个 `type: "search"`"，而 `views/branches.ts:58` 的分支选择器正当持有这样一个
  框——它问的是"这些名字里要哪一个"，对象是内存里已经有的列表，不是"哪一个提交"。被修正的是
  gate 的射程（三个 Main 区域），不是那个框，理由写进了夹具的注释。
运行命令、退出码、日志位置：`npm run build` 退出 0（47 modules，产物 `index-ChZW8Nlx.js`
  128.34 kB / `index-CCZkac2X.css` 33.70 kB，对照 §12 记的 130.57 kB / 34.42 kB）；
  `npm run test:fixture` 399 pass / 0 fail；`responsive-check.py src/style.css
  src/style/tokens.css` 与 `color-contrast.py dist/assets` 都 fails=0。输出不落盘。
桌面/性能证据与环境：`tools/bench/commit-bubble-engine-probe.ts` 在真实 WebKitGTK 里重跑，
  24 条 ok、fails=0、退出 0（`/usr/bin/python3 ../tools/bench/webkit-engine-probe.py`）。
  它原来有 25 条，第 25 条"行被过滤掉之后气泡合上而不是跟过去"量的正是本阶段删掉的那条路：
  探针的 `filter` 助手向 `.history-find` 写字节，字段没了它只能红。改法是把那条 claim 与
  助手一起删掉并在原地写下为什么——留着一条永远拿不到断言的 stage 会让这份 24 变成假数，
  让它红着提交又是把并行开发者的文件弄坏。那个不变式本身没有失去证据：命中行被换掉时气泡
  合上而不是跟到新行，仍由 `historyModel.ts` 的 `anchorRow` 与它的夹具钉住，只是那不再是
  一个渲染度量（它当时也确实是靠页内 find 才在浏览器里可达的）。他 D04 交付行记的"25 条"
  同步改成 24 并写明那条去了哪里。除此之外本轮没有任何新的渲染度量：`layout-probe.mjs` 要
  msedge/chromium，本宿主 `which msedge google-chrome chromium` 仍全空。宿主：Ubuntu 26.04、
  Git 2.53、Node 26；Windows/macOS 仍只是构建配置。
未解决限制：结果层的渲染证据与"输入到候选 warm p95 ≤150ms"那个数仍归 E04c（等待已经是
  `SEARCH_DEBOUNCE_MS` 这个导出常量，正是为了能被算进那把尺子）。`cancel_search` 仍没有：
  清空字段只停止下一次提问，已开始的那一趟走到自己那一窗结束。`/` 现在只在 Main 且只在有
  会话时起作用，这是刻意的前置条件而不是遗漏，但它意味着从 Settings 按下去什么也不会发生——
  这一点没有度量、只有源码 gate 里那句前置条件。页内那个盒子还留在**一处注释里**：窄窗那条
  `.history-list-head { flex-wrap: wrap }` 的成立理由是"21px 顶出视口"，而那一次量的是头上还
  挂着 find 框的三件东西。删了框再让注释说"a count, a filter and the paging action"就成了
  指向不存在之物的话，所以那条注释改写成"这条规则是在比现在宽一档的行上量的，重测仍未做"——
  规则本身留着（少一件东西只会更早合行，不会更晚），但那个数不再是这一版排版的证据。同一句
  话也在 `views/history.ts` 里（气泡那段仍写"on every scroll, page and filter"），一并改掉。
  旧存档里如果有人在页面上记住了那个盒子所在的
  位置，本阶段之后那里只剩主线开关；没有保留任何"关掉新字段就退回旧盒子"的开关，那是两条
  互相矛盾的行的来源，不是兼容。
回退方式：把 §13 列的六个源文件与两个夹具文件按原样退回即可，一次 `git revert` 就够——这
  一刀没有引入任何新的存储格式、命令注册或后端状态，删掉的全是前端源码与它的夹具。需要注意
  `tools/bench/commit-bubble-engine-probe.ts` 与 `plan/README.md` 的 D04 那一行：回退这一刀要
  把第 25 条 claim、`filter` 助手和"25 条"那个数一起带回，否则探针与它的记录会说不同的话。
结论：完成（"一个输入框"与"原图拓扑不被过滤破坏"在本阶段之后是同一件事的两个说法；阶段退出
  门槛仍差 E04c 的渲染证据与读预算）
```
