# A01 可比较基线记录

采集时间:2026-09-29(本地)。执行人:阶段 A 实施会话。本文是工程记录,不是产品承诺;运行证据与未验证项分开陈述,报告中不含凭据与用户仓库文件内容。

## 1. 环境与提交基线

| 项 | 值 |
| --- | --- |
| 基线提交 | `8a7c0c261b169052620cbc17f438e12d4cfd3de2`(计划文档撰写时的 `97b61dc` 之后一个 docs 提交) |
| 工作区状态 | `git status --porcelain=v1` 为空(单工作树 `master`) |
| origin/master 关系 | 本地领先 7 个提交(按上次 fetch 的本地跟踪引用计算,未联网核对) |
| OS | Ubuntu 26.04.1 LTS,内核 7.0.0-34-generic,x86_64 |
| 桌面会话 | GNOME / Wayland |
| CPU | Intel Core i9-14900HX,32 逻辑核 |
| 内存 | MemTotal ≈ 15.2 GiB |
| Git | 2.53.0 |
| rustc / Cargo | 1.96.1 / 1.96.1 |
| Node(本次 shell) | v22.22.2(nvm) |
| npm | 10.9.7 |
| Python | 3.14.7 |
| WebKitGTK / GTK | 2.52.6(pkg-config 读取)/ GTK 3 |

## 2. 与既有记录的差异

- 撤下的 `docs/known-limitations.md`（由阶段 G 的文档清理删去，此处保留当时的读取结论）声明的验证宿主为"Node 26";本次执行 shell 经 nvm 解析为 Node v22.22.2,与 `AGENTS.md` 环境记录(Node.js v26.3.0)也不同。全部 Node 门禁已在 v22.22.2 下实际执行并通过(见 A02),该版本差异记录为工具链事实,不改写历史证据。
- 调研发现 `git worktree list` 存在残留条目 `/tmp/guit-verify`(detached `1bbf761`,prunable),来自更早的验证会话,未清理。它不影响本仓库工作区清洁判定;记录待 H 阶段环境重置时处理,本阶段不删除他方创建的临时产物。
- 撤下的 `docs/known-limitations.md` 关于平台覆盖、输出上限、手动门禁未闭合等陈述与本次静态读取一致,未发现与代码相矛盾的过时陈述(origin 存在性已在 `97b61dc` 前的指导文件修正)。

## 3. origin 与 CI 状态核对

- `origin` 为 GitHub HTTPS 地址,存在于本地 Git 配置;本次仅读取本地引用,**未执行任何 fetch/ls-remote,未查询远端 CI**。
- `.github/workflows/` 存在 `ci.yml` 与 `release.yml` 配置文件。配置文件存在不证明任何一次运行通过;沿用"不得宣称 CI 已通过"的记录口径。
- 本地 Git 配置中存在代理项与 credential helper 条目;仅记录其存在,值与本路径不进入本报告。产品范围退出远程操作不改变用户 Git 配置,本次未做任何修改。

## 4. 证据分类

| 类别 | 状态 |
| --- | --- |
| 本次直接测量(gates、命令清单、夹具) | 记录于 A02/A03/A04 交付物 |
| 历史运行证据(Linux 桌面点击、包安装) | 当时的登记文件已随 `docs/` 撤下,结论按上文与指导文件保留,未重测 |
| Windows / macOS | 从未运行,维持"构建配置仅"结论 |
| CI | 未核验,不宣称通过 |
