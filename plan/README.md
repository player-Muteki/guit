# guit 开发计划索引

本目录将根目录的 [TECHNICAL_DESIGN.md](../TECHNICAL_DESIGN.md) 展开为可实施的设计与验收清单。根文档是产品和技术约束的来源；本目录负责说明具体实现顺序、接口、异常路径和验证方式。如两者发生冲突，先更新根文档并记录决策，再修改这里。`git/` 是独立克隆的 Git 源码参考，不进入 guit 的版本控制和产品包。

## 阅读顺序

| 文件 | 内容 | 主要产出 |
| --- | --- | --- |
| [01-product-scope.md](01-product-scope.md) | 用户任务、功能矩阵、边界和风险等级 | 明确做什么、何时算完成 |
| [02-technology-stack.md](02-technology-stack.md) | 技术栈、依赖原则、平台前提与验证实验 | 固定最小技术组合 |
| [03-architecture.md](03-architecture.md) | 模块、数据流、接口、会话和并发模型 | 可直接拆分的代码结构 |
| [04-git-engine.md](04-git-engine.md) | Git 命令、解析、路径、写入与认证 | 安全可靠的 Git 操作层 |
| [05-desktop-ux.md](05-desktop-ux.md) | 页面、窗口、外部工具和无障碍行为 | 可实现的交互规格 |
| [06-development-roadmap.md](06-development-roadmap.md) | 里程碑、任务依赖、交付物与退出条件 | 开发执行顺序 |
| [07-quality-release.md](07-quality-release.md) | 测试矩阵、性能测量和三平台发布 | 质量门槛与发布步骤 |
| [08-task-backlog.md](08-task-backlog.md) | 按阶段编号的实施任务、依赖与证据 | 可直接跟踪的开发待办 |
| [M0-validation.md](M0-validation.md) | M0 本机环境、已执行检查与平台缺口 | 真实验证记录 |
| [M1-validation.md](M1-validation.md) | M1 本机环境、自动化测试与 AT-SPI 运行时验证、键盘注入限制 | 真实验证记录 |
| [M2-validation.md](M2-validation.md) | M2 写入路径（暂存/提交/丢弃/clean）、外部工具通道与运行时验证 | 真实验证记录 |
| [M3-validation.md](M3-validation.md) | M3 历史、引用与分支操作的测试矩阵与运行时验证 | 真实验证记录 |
| [M4-validation.md](M4-validation.md) | M4 stash、序列器、reset、worktree、子模块的验证记录 | 真实验证记录 |
| [M5-validation.md](M5-validation.md) | M5 远端同步（fetch/pull/push/删除/强推/askpass）的验证记录 | 真实验证记录 |
| [M6-validation.md](M6-validation.md) | M6 性能基线、打包试装、恢复、文档与发布门槛的验证记录 | 真实验证记录 |
| [M0-platform-setup.md](M0-platform-setup.md) | 三平台环境准备与运行验收步骤 | 可复现的 M0 检查表 |

## 全局原则

1. 用户能从 GUI 完成目标文档列出的 Git 工作流；界面不显示文件正文或差异正文，也不内置文本编辑器。
2. 系统 Git 是唯一 Git 执行来源；不编译、不捆绑根目录 `git/` 源码。所有命令经 Rust 后端的受控动作接口执行，不经 shell。
3. GUI 展示的是 Git 实际状态。写入动作后重新读取状态，不假定命令成功就等于期望结果已发生。
4. 低资源占用是测量目标：在相同设备与仓库上记录启动、空闲、刷新和峰值指标，再设可复现的发布阈值。
5. 跨平台不是“能编译”即可：窗口、外部工具、进程取消、路径、凭据和打包均须在 Windows、macOS、Linux 分别验证。

## 需求追踪

| 根文档要求 | 实施说明 | 验收所在 |
| --- | --- | --- |
| 轻量、跨平台 | 02、03、06 | 07 性能与平台矩阵 |
| 完整的目标 Git 工作流 | 01、04、06 | 07 集成场景 |
| 自适应窗口、可置顶 | 05、06 | 07 桌面检查 |
| 不内置查看器/编辑器 | 01、05 | 07 外部工具检查 |
| 路径和命令安全 | 03、04 | 07 解析与操作测试 |

## 执行约定

阶段任务写为可观察的交付物和退出条件。依赖版本、最低 Git 版本、性能阈值等尚无实测依据的数字标记为“待验证”，不能在开始编码时默认为已确定。改变架构边界、路径协议或高风险命令语义时，在对应文档写明原因和验证结果。
