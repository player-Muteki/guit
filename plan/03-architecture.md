# 03 系统架构与接口

## 组件边界

```text
TypeScript UI
  ├─ 视图状态、筛选、键盘与窗口布局
  └─ Tauri 命令/事件协议
Rust 应用层
  ├─ Commands：参数校验、授权范围、响应格式
  ├─ RepositoryManager：会话、快照、刷新、监听、操作队列
  ├─ GitEngine：进程运行器、机器输出解析器、语义操作
  ├─ ExternalTools：文件、diff、merge 工具启动
  └─ Settings：设置读取、迁移、原子保存
系统边界：Git CLI / 文件系统 / WebView / OS 窗口与程序关联
```

模块单向依赖：UI 不直接调用进程 API；Commands 不解析 Git 文本；语义操作不负责 DOM；解析器不触发写入。外部程序返回后由 RepositoryManager 安排刷新，而不是让 UI 猜文件状态。

## 建议目录

```text
app/
  src/
    main.ts
    bridge/          # 类型化命令/事件调用
    state/           # 当前仓库与请求序号
    components/      # 仓库头、文件组、操作栏、通知
    views/           # 主视图、历史、分支、远端、设置
    styles/          # 设计变量、响应式布局
  src-tauri/src/
    commands/        # Tauri 对外动作
    git/             # runner, status, refs, history, operations
    repository/      # session, refresh, watcher, queue
    external_tools/
    settings/
    errors/
  tests/             # 集成测试夹具与临时仓库
```

目录仅约定边界；实现时不为了满足目录层级而创建空模块。

## 数据契约

| 类型 | 必需字段 | 说明 |
| --- | --- | --- |
| `RepositoryIdentity` | `id`, `root`, `git_dir`, `kind` | `id` 是当前应用会话标识；`root` 为可显示路径；裸仓库无工作树。 |
| `HeadState` | `branch?`, `oid?`, `detached`, `upstream?`, `ahead?`, `behind?` | 缺少上游或未出生分支须单独表示，不填假值。 |
| `FileEntry` | `id`, `display_path`, `index_status`, `worktree_status`, `old_display_path?` | `id` 映射后端原始路径；同一文件可同时有暂存与未暂存改动。 |
| `RepositorySnapshot` | `revision`, `identity`, `head`, `staged[]`, `unstaged[]`, `untracked[]`, `conflicts[]`, `operation?` | 每次刷新完整替换；`revision` 防止旧结果覆盖新结果。 |
| `OperationResult` | `operation_id`, `kind`, `outcome`, `exit_code?`, `message`, `details?`, `snapshot?` | `outcome` 区分成功、失败、取消、状态未知。 |

展示路径和操作路径分离。前端永不回传任意文件系统路径去执行 `restore`/`clean` 等动作，而是回传当前快照的文件 ID。后端确认 ID 属于对应会话和快照，再取出原始路径。快照变化后旧 ID 失效，要求用户刷新选择。

## 命令 API 草案

| API | 输入 | 输出/事件 |
| --- | --- | --- |
| `open_repository` | 用户选择的路径 | 仓库身份与首个快照 |
| `clone_repository` | URL、目标目录 | 操作 ID；进度事件；完成后快照 |
| `refresh_repository` | 会话 ID | 新快照 |
| `stage_files` / `unstage_files` | 会话 ID、快照版本、文件 ID 列表 | 操作结果和新快照 |
| `commit_changes` | 会话 ID、消息、是否 amend | 操作结果和新快照 |
| `run_repository_action` | 受控动作类型和经验证的参数 | 操作结果/进度；不接受裸命令串 |
| `open_external_tool` | 会话 ID、文件 ID、用途 | 启动结果；后续刷新事件 |
| `set_always_on_top` | 布尔值 | 应用后的实际窗口状态 |

动作命名和序列化格式在首个原型中以测试固定下来。长任务事件携带 `operation_id`、仓库 ID、阶段、进度文本及最终状态；UI 只接收当前任务的事件。

## 仓库会话生命周期

1. 通过 Git 探测所选路径：工作树根、Git 目录、裸仓库与 worktree 关系。失败时不创建会话。
2. 建立会话并读取首个快照。监听工作树和 Git 元数据；Git 目录可能在工作树外，不能只观察 `.git` 文件。
3. 文件事件防抖合并，窗口获焦和手动刷新也触发读取。若已有刷新运行，合并需求并保留最后一次有效结果。
4. 切换仓库时取消旧会话的后台读取和监听；正在写入的动作须有明确的完成/取消策略，不能丢失进度。
5. 关闭窗口时停止监听与后台任务，完成必要的设置保存和子进程处理。

## 并发和一致性

同仓库写入串行；跨仓库写入可并行但受全局进程上限保护。只读请求可并行，但同类高成本刷新合并。每次刷新分配递增修订号，只有当前会话且修订号较新的快照才能替换 UI。写入前后都可读取关键状态；Git 失败、取消或外部工具返回时一律重新读取，必要时显示“状态未知，正在重试”。

运行器需要边读取输出边等待进程，避免 stdout/stderr 管道填满造成死锁。Rust 同步 `std::process` API 可放在受控后台任务中，或改用经验证的异步进程 API；两者都不能阻塞 UI 线程。记录任务超时与取消令牌，清理临时文件，并禁止重复提交或重复强推。

## 错误模型

错误类型至少区分：Git 缺失/不支持、路径不存在或非仓库、受保护状态拒绝、命令启动失败、Git 非零退出、认证失败、网络失败、用户取消、输出解析失败、外部工具失败。给用户的短提示说明下一步；展开详情保留脱敏后的 Git stderr、动作及退出码。解析失败不能伪装成空仓库。

