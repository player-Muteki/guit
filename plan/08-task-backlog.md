# 08 实施任务清单

本清单把 [06-development-roadmap.md](06-development-roadmap.md) 的 M0–M6 拆成可独立评审的任务。方括号用于实施时跟踪；M0、M1 已完成（Linux 证据分别见 [M0-validation.md](M0-validation.md) 与 [M1-validation.md](M1-validation.md)，Windows/macOS 运行时验证为遗留交接门槛），M2 进行中（M2-01 已完成，Linux 单平台）。每项完成时应附对应代码、自动化测试或平台验证记录，而不是只勾选功能演示。

## M0 工程与技术探针

M0 已于 2026-09-23 在 Linux 主机完成并记录证据，详见 [M0-validation.md](M0-validation.md)。Windows/macOS 仅准备了 CI 工作流（`.github/workflows/m0.yml`），运行时验证待矩阵执行，不构成三平台通过声明。

- [x] **M0-01** 建立 Tauri 2、TypeScript、Rust 工程和锁文件，验证开发/生产构建命令；产出可启动空窗口。证据：`app/` 工程 + `package-lock.json`/`Cargo.lock`；`npm run build`、`cargo test --locked`、`tauri build --bundles deb,rpm` 通过；发布二进制窗口经 AT-SPI 运行时确认。
- [x] **M0-02** 设计受控前后端命令协议和统一错误响应；验证错误能在 UI 中展示并在后端日志中脱敏。证据：`ProbeError{code,message}` 统一结构；URL userinfo/query 脱敏单元测试；UI 错误区展示 + `eprintln` 后端日志。
- [x] **M0-03** 检测 Git 可执行文件、版本与关键命令能力；缺失时给出安装/路径配置提示。证据：`probe.rs` 隔离临时仓库探测 `status --porcelain=v2 -z --branch`；缺失/过旧 Git 的结构化错误与提示（单元测试覆盖）。
- [x] **M0-04** 在 Windows、macOS、Linux 验证 WebView 和系统依赖；记录干净环境安装步骤。证据：Linux 实测（依赖版本见 M0-validation）；`M0-platform-setup.md` 记录三平台安装/运行步骤；CI 矩阵已准备未运行，Windows/macOS 运行时验证遗留为交接门槛。
- [x] **M0-05** 验证置顶、最小尺寸、DPI、多屏及窗口恢复；记录不一致的系统行为与降级策略。证据：AT-SPI 驱动确认置顶、340×400 最小尺寸、紧凑/恢复、最大化；HiDPI scale=2 下外层尺寸增长问题根因与修复（视口像素+边框增量保存）；负原点多屏钳制单元测试；NVIDIA Wayland 置顶差异记入平台笔记。
- [x] **M0-06** 验证 Git 子进程进度管道、超时和取消；确认 UI 线程无阻塞。证据：`runner.rs` 进程组 + 有界 64KiB 捕获；取消/超时（含持有管道的后代进程）Rust 测试；`clone --progress` 经 `probe-progress` 事件流式上报，运行中 UI 可继续交互。
- [x] **M0-07** 验证系统默认文件打开、`git difftool`、`git mergetool`；记录无配置和退出码情况。证据：xdg-open + gnome-text-editor 中文文件名实测；fixture 测试覆盖 difftool `--trust-exit-code` 成败/工具缺失、mergetool 失败保留冲突/成功解决；无配置时 UI 报告未配置状态。
- [x] **M0-08** 设计临时仓库测试夹具、隔离 Git 配置和 CI 最小门槛。证据：`tests/helpers/git.mjs` 剥离 GIT_* 并设置 NOSYSTEM/GLOBAL/TERMINAL_PROMPT；`node --test` 夹具通过；`.github/workflows/m0.yml` 三平台 lint/test/build 门槛。

## M1 只读仓库工作台

M1 已于 2026-09-23 在 Linux 主机完成交付验证，详见 [M1-validation.md](M1-validation.md)：60 项 Rust 测试、9 项 node 测试、`tsc && vite build`、`cargo fmt --check` 与 `tauri build --bundles deb,rpm` 全部通过；发布版二进制经 AT-SPI 运行时验证会话恢复、监听自动刷新、分组列表、克隆卡片门控与进度事件。键盘快捷键与克隆完整点击流因 Wayland 合成输入限制仅由单元/集成测试覆盖，列为交接门槛。

- [x] **M1-01** 用 Git 命令探测工作树根、Git 目录、裸仓库与 worktree；测试 `.git` 为文件的情况。证据：`app/src-tauri/src/repo.rs`（`rev-parse` 逐项探测 + `util::same_path` 规范化比较），7 个临时仓库测试覆盖普通/嵌套目录/裸仓库/`.git` 文件链接 worktree/非仓库/缺失路径/状态输出采集。
- [x] **M1-02** 实现文件选择、打开仓库、最近仓库和会话关闭；无效路径不残留半成品会话。证据：`app/src-tauri/src/session.rs` 打开流程先探测并采集快照、全部成功后才替换会话（失败测试证明旧会话保持不变；裸仓库跳过 Git 拒绝的 status）；`recent.json`/`session.json` 原子写入，最近列表去重置顶限量 10，重启自动恢复、仓库消失则清除；前端 `main.ts` 新增仓库卡片（文件夹选择器、最近列表、分组文件清单、关闭按钮）。Rust 43 项测试、tsc/vite 构建、3 项夹具测试通过（Linux 单平台）。
- [x] **M1-03** 实现 `status --porcelain=v2 -z --branch` 字节解析，分别覆盖 `1`、`2`、`u`、`?` 和分支头。证据：`app/src-tauri/src/status.rs` 字节级语法解析（含重命名双路径、元数据字段校验、任何语法异常报 `status_parse_failed` 而非“干净”）；真实 Git 冲突/重命名/中文空格路径端到端解析测试；`--untracked-files` 必须用 `=` 形式的回归教训已固化。
- [x] **M1-04** 建立原始路径到文件 ID 的后端映射；验证重命名、中文、空格和无法往返路径。证据：`app/src-tauri/src/model.rs` `PathTable` 以后端 `Vec<u8>` 原始路径表按不透明 `FileId` 分配/回查；测试覆盖重命名双路径同一 ID、非 UTF-8（`bad\xffname.txt`）字节精确回查、中文空格路径经显示名转义。
- [x] **M1-05** 实现分支、上游、领先/落后与分离 HEAD 展示；无上游和未出生分支有独立状态。证据：`model.rs` `BranchView`/`HeadState`（分支/分离 HEAD/未出生三分立，无上游时领先/落后为 `None`）；纯数据解析测试 + 真实 Git 端到端测试（clone 0/0、fetch 后落后 1、本地提交分叉 1/1、`checkout HEAD~1` 分离、全新 init 未出生）。
- [x] **M1-06** 实现仓库快照、版本号、请求合并和旧结果丢弃；快速连续刷新保持顺序。证据：`session.rs` 快照带单调 `version`（文件 ID 仅对产生它的快照版本有效）；刷新领导者/跟随者门闩（leader/rerun/epoch Condvar）合并并发请求——测试证明跟随者不触发额外 Git 采集、错误唤醒仍返回上一快照；会话被打开/关闭取代后过期采集结果被身份守卫丢弃（三个线程竞态测试）；前端按版本号丢弃旧结果。Rust 48 项测试通过，会话并发测试重复 5 轮稳定（Linux 单平台）。
- [x] **M1-07** 监听工作树和实际 Git 目录，增加防抖、窗口获焦刷新、手动刷新和监听失败轮询。证据：`watch.rs` 用 `notify` 8.2.0（引入理由与资源影响已记录于 02-technology-stack.md）递归监听工作树、git dir 与 common dir（规范化去重）；250ms 静默期防抖，突发事件合并为单次刷新（注入信道测试 count==1）；监听器创建失败自动回落 5 秒轮询（无事件也周期触发测试）；每会话单个监督线程，open/restore 重启、close 停止，刷新经 M1-06 合并门闩，会话消失即退出；后端推送 `repo-refreshed`/`watch-status` 事件，前端版本守卫渲染并在窗口获焦时静默刷新，UI 显示监听方式。Rust 54 项测试通过（含真实 inotify 冒烟测试），watch 测试重复 3 轮稳定，`tsc && vite build` 与 fixture 测试通过（Linux 单平台；macOS/Windows 监听行为未实测）。
- [x] **M1-08** 实现工作区、暂存区、未跟踪与冲突文件组、计数、折叠和列表虚拟滚动。证据：纯逻辑模块 `src/fileModel.ts`（冲突/暂存/工作区/未跟踪固定顺序分组、计数、折叠行展开），`tests/file-model.mjs` 5 项 node 测试通过（含折叠隐藏文件行、视口窗口两端钳制、5 万文件仅渲染有界切片）；`main.ts` 以固定行高 30px + 6 行 overscan 的虚拟列表渲染，滚动/窗口尺寸变化重算窗口，组标题点击折叠/展开且跨刷新保持，超长路径省略号 + title 提示；后端无改动，Rust 54 项测试保持通过，`tsc && vite build` 通过（Linux 单平台）。
- [x] **M1-09** 实现窄窗口布局、键盘导航、字体缩放、置顶切换和窗口状态保存。证据：≤480px 媒体查询下卡片/按钮收紧、列表高度改 45vh；变更列表 `tabindex=0` + 方向键在文件行间移动（跳过组标题、两端钳制）、Home/End 跳转、Enter 折叠/展开所在组，选择跨刷新按文件 ID 保持（`fileModel.ts` 新增 `nextSelectableRow`/`revealScroll` 纯函数，node 测试 9 项通过含边界用例；选中滚动进视口）；全局快捷键 Ctrl+R 刷新、Ctrl+O 打开仓库、Ctrl +/−/0 字体缩放（12–24px 钳制，rem 基准随 `documentElement.fontSize` 生效，localStorage 持久并在启动恢复）；置顶切换与窗口位置/尺寸保存沿用 M0 实现并在回归中保持。`tsc && vite build` 通过（Linux 单平台，运行时交互验证在 M1 交付验证中执行）。
- [x] **M1-10** 实现 `clone --progress`：目标目录选择、进度、取消、失败后的残留目录提示。证据：`clone.rs` 用 `user_git_command`（沿用用户 Git 配置、`GIT_TERMINAL_PROMPT=0`）以参数数组执行 `clone --progress -- <source> <name>`，无超时硬上限；`runner.rs` 进度回调泛化为 `FnMut(bool, &[u8])`，stderr 按 `\r`/`\n` 切分为逐行事件 `clone-progress` 推送前端，每行经 `redact` 脱敏 URL 凭据（测试证明 `user:secret@` 不外泄）；目标目录名由后端 `suggested_dir_name` 推导并拒绝越界/空名，占用非空目标在 Git 运行前拒绝（`clone_target_occupied`）；取消复用同一 `AtomicBool`（挂起取消请求即中止并收割进程组，测试覆盖）；无论成功、失败或取消都重读实际状态——成功经 `repo::detect` 验证新仓库并可一键打开，失败/取消后如留下非空残留目录则在 `residue` 字段中报告路径，UI 明示 guit 不会自动删除（符合不静默清理约束）。前后端命令 `clone_repository`/`cancel_clone` 带单飞 `running` 门闩；前端“Clone”卡片提供 URL 输入、目标文件夹选择、进度行、取消按钮与结果提示。Rust 60 项测试通过（新增 6 项克隆测试：本地克隆端到端流式+检测、取消、目标占用、残留判定、名称推导、脱敏），`tsc && vite build` 与 9 项 fixture 测试通过（Linux 单平台，运行时交互验证在 M1 交付验证中执行）。

## M2 日常提交闭环

- [x] **M2-01** 实现同仓库写入队列、操作 ID、防重复提交和写入后强制刷新。证据：`app/src-tauri/src/write.rs` `WriteState`（busy CAS 单槽，第二请求得 `write_queue_busy`；操作 ID 单调递增；`cancelled` 复用 runner 进程组终止）；`session.rs` `resolve_files` 写入前校验快照版本精确匹配（`write_stale_snapshot`）、非裸仓库（`write_bare_repo`）、FileId 属于当前快照（`write_unknown_file_id`，混入非法 ID 整单拒绝）；路径以 Git 原始字节经参数数组传给 `git add --`（Unix `OsString::from_vec` 无损，Windows UTF-8 不可表示则 `write_path_unrepresentable`）；成功/失败/取消/拒绝后必调 `session::refresh` 并在 `OperationResult.snapshot` 返回重读状态。`probe.rs` 增加 `hasRestore` 能力位（版本 ≥2.23，旧 Git 得到结构化拒绝依据而非崩溃）。7 项 write 测试（暂存成功且快照版本递增、旧版本请求未触 Git、混合 ID 拒绝、并发拒绝、中文空格路径字节精确、取消后仍重读、裸仓库拒绝）+ 2 项 probe 测试；全量 68 项 Rust 测试、`tsc && vite build`、`cargo fmt --check` 通过（Linux 单平台；前端按钮在 M2-02 接入）。
- [ ] **M2-02** 实现按文件暂存与取消暂存；同一文件两侧都有改动时分别正确更新。
- [ ] **M2-03** 实现批量/全部暂存；路径从当前快照 ID 获取，旧 ID 不可复用。
- [ ] **M2-04** 实现外部文件打开、工作区 diff、暂存 diff；工具失败和返回后有明确反馈。
- [ ] **M2-05** 实现丢弃工作区改动的影响预览、状态复查和确认。
- [ ] **M2-06** 实现 `clean` 预览与执行目标一致性检查；候选集合变化时重新确认。
- [ ] **M2-07** 实现多行提交消息、临时文件权限/清理、提交与 amend；钩子失败保留输入。
- [ ] **M2-08** 建立提交、丢弃、取消、钩子拒绝、签名失败的临时仓库测试。

## M3 历史、分支和标签

- [ ] **M3-01** 设计固定字段的 `log` 输出协议和分页游标，测试含换行提交消息。
- [ ] **M3-02** 展示提交元数据、提交文件清单、复制 OID 与外部提交差异入口。
- [ ] **M3-03** 使用 `for-each-ref` 构建本地/远端分支及标签列表；引用名按 Git 规则校验。
- [ ] **M3-04** 实现分支创建、切换、重命名、删除；未提交改动与未合并提交显示正确拒绝/确认。
- [ ] **M3-05** 实现标签创建、查看、删除；轻量/附注标签的行为明确区分。
- [ ] **M3-06** 测试分离 HEAD、未出生分支、目标提交消失和外部终端改动后的刷新。

## M4 进阶本地操作

- [ ] **M4-01** 实现 stash 列表、保存、应用、弹出、删除及目标确认。
- [ ] **M4-02** 实现合并与变基的发起、进行中状态、继续和中止。
- [ ] **M4-03** 实现 cherry-pick 与 revert 的目标选择、冲突处理、继续和中止。
- [ ] **M4-04** 实现 reset 模式选择；`--hard` 单独高风险入口，不做默认选项。
- [ ] **M4-05** 集成外部 mergetool，返回后核对冲突文件是否真正解决。
- [ ] **M4-06** 实现 worktree 列表、新建、移除；处理外部 Git 目录和占用中的工作树。
- [ ] **M4-07** 实现子模块状态、初始化和更新；长任务可见且可取消。
- [ ] **M4-08** 对每项进阶动作建立正常、被 Git 拒绝、冲突、中止和状态变化的测试。

## M5 远端同步

- [ ] **M5-01** 实现远端列表、添加、修改、删除及 fetch/push URL 脱敏展示。
- [ ] **M5-02** 实现 fetch、上游设置、领先/落后刷新和目标引用显示。
- [ ] **M5-03** 实现 pull 策略选择及冲突状态衔接；遵循/覆盖 Git 配置的规则可见。
- [ ] **M5-04** 实现 push、发布分支、删除远端分支和受限的强推入口。
- [ ] **M5-05** 分类展示凭据、网络、非快进、保护分支及远端钩子拒绝。
- [ ] **M5-06** 验证系统凭据管理器和 SSH agent；确有交互需求时实现受控 askpass，不持久化秘密。
- [ ] **M5-07** 用本地裸仓库做双向、非快进、取消测试；用真实远端人工验证认证流程。

## M6 性能、打包和发布

- [ ] **M6-01** 采集冷启动、空闲 CPU/内存、状态刷新、历史分页与峰值内存基线。
- [ ] **M6-02** 在 100、1,000、10,000 文件仓库测量，确定未跟踪扫描和监听策略。
- [ ] **M6-03** 修复可复现的性能热点，重新测量并记录优化前后数据。
- [ ] **M6-04** 完成 Windows、macOS、Linux 安装包和干净环境试装。
- [ ] **M6-05** 验证配置版本迁移、窗口恢复、Git 缺失、外部工具缺失和异常退出恢复。
- [ ] **M6-06** 完成用户说明、外部工具/凭据配置说明、已知限制及诊断导出。
- [ ] **M6-07** 执行 [07-quality-release.md](07-quality-release.md) 的发布门槛检查，记录阻断项处理结果。

## 开始编码前的明确决策

以下问题保留为可验证决策，不凭空给出结论：最低 Git 版本、三平台 Tauri/WebView 打包依赖、Windows 路径编码往返、取消进程树能力、difftool/mergetool 的可用配置方式、首轮性能基线及发布阈值。M0/M1 的验证结果应反向更新 [02-technology-stack.md](02-technology-stack.md) 和相关设计。
