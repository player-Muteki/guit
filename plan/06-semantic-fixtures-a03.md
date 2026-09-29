# A03 核心语义夹具记录

任务:A03 — mtime、连续写入、跨仓库同 HEAD、Tag 变动、深历史、多轨道与 reset 阻挡路径夹具。
对应产品目标:G04(mtime 计时)、G07(图表/引用)、G06(干净重置)、G09(持续写入仍刷新)、G10(边界诚实)。
起止提交:A01 记录提交之后开始;随本阶段提交结束。
变更文件:`app/tests/helpers/semantic.mjs`、`app/tests/semantic-fixtures.mjs`。

## 输入条件与 fixture

- 全部用例使用真实 `git` 二进制(2.53)在 `mkdtemp` 一次性仓库中执行;隔离配置沿用既有模式:`GIT_CONFIG_NOSYSTEM=1`、仓库内空 `GIT_CONFIG_GLOBAL`、`GIT_TERMINAL_PROMPT=0`、固定夹具身份。不 mock Git。
- mtime 一律显式打 stamp(基准 `EPOCH=1700000000`),不依赖墙钟与 sleep,结果确定可重现。
- 宽/深拓扑用对象库管线(`hash-object`/temp-index `read-tree`+`update-index --cacheinfo`/`write-tree`/`commit-tree`)构造,无工作树写入;1000+ Git 进程的用例总耗时约 4.5s。

## 场景与固定的语义(逐条为实测 Git 行为)

| 夹具场景 | 固定的事实 | 服务的后续任务 |
| --- | --- | --- |
| mtime 最大值 | "最近修改"是候选现存文件 mtime 的最大值;干净树上仍有值;删除最大值后按现存候选重算 | C02/C03、G04 |
| 保留 mtime 的重写 | 内容变化、mtime 不变:Git 看到脏(`M`),mtime 计时不动 —— 事件时间不能代替 mtime | C03 |
| staged-only / ignored | staged-only 在 porcelain 前置列(`M `);ignored 目录对 status 不可见但候选 mtime 仍可测(须先提交 `.gitignore` 才生效) | C02、G04 |
| 未来 mtime | 差值按 0 钳制,不产生负数或"刚刚之后"的伪值 | C04 |
| 连续写入(120 步) | 每一步新的较新 stamp 都推进最大值,单调、无遗漏 | C01(事件流不停摆的数据侧真值) |
| 同 HEAD 跨仓库 | 克隆后 HEAD OID 与当前分支名全部相同,仅凭 HEAD/分支名无法区分会话 | B05、D01 |
| Tag 变动 / unborn | `update-ref` 移动标签不改 HEAD;`v^{})`  peel 到 commit;无提交分支 `rev-parse HEAD` 失败(无身份可钉) | D02、G07 |
| 深历史 400 提交 | 单父链逐条可达,`rev-list --count` 为真值 | D01/D03 |
| 多轨道 26 分支汇聚 | 参考轨道模型 `peakLanes` 峰值 ≥25,超过现有 24 轨道降级线;八进合并三父提交可达 | D03 |
| 干净树的目标差异 | `porcelain` 为空时 `git diff --name-only main target` 仍列出两个文件:现有 `tracked_dirty_set` 预览不足以覆盖受影响集合 | F03 |
| 未跟踪阻挡 | 目标分支新增文件在主分支为未跟踪时,checkout **拒绝**(区分大小写地:即使字节内容完全相同也拒绝——Git 只比较存在性);拒绝后 HEAD 与文件原样保留 | F03/F04 |
| 文件↔目录转变 | 干净跟踪文件让位于目标目录,checkout 成功且落点精确等于目标树(不假设类型转换必然阻挡) | F03 |
| pathspec clean | `clean -fd <zone>` 只删界内;ignored 不出现在 `-nd`,`-ndx` 出现,`-fdx` 真删 —— ignored 保护依赖 `-x` 决策 | F03/F04 |

## 实现行为与异常路径

- helper 的 `tryGit` 不.assert 成功,拒绝路径(阻挡 checkout、unborn HEAD)以退出码与 stderr 为证据;`git()` 失败即断言失败并携带 stderr。
- 两个"当前预期与直觉相反"的更正被固化为测试:字节相同的未跟踪文件同样被拒绝;干净类型转换不被拒绝。设计文档若假设其一为阻挡条件,应在 F 阶段前核对。

## 运行命令与退出码

| 命令 | 退出码 |
| --- | --- |
| `node --test tests/semantic-fixtures.mjs` | 0(14/14) |
| `npm run test:fixture`(全套) | 见 A02 记录复跑行 |

## 未解决限制

- `peakLanes` 是参考模型而非 guit 引擎输出;D03 需以它对照真实渲染几何,不以本模型自证。
- 连续写入夹具只固定数据侧真值;watcher 队列饥饿(C01)需应用内事件流证据,A 阶段无桌面条件未测。
- 特殊字符/非 NFC 路径未入本批夹具(E01/F03 需要时补)。

## 回退方式

删除两份新文件即可,不触碰既有测试与应用源码。

## 结论

完成(桌面相关证据按路线图留给后续阶段标记未测)。
