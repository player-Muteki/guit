# A04 仅本地命令清单与产品解释固定

任务:A04 — 固定产品解释及"仅本地"命令清单,确认现有调用依赖,逐项关联 G01–G10。
证据基线:提交 `8a7c0c2` 的源码静态读码(命令注册 `app/src-tauri/src/main.rs:1634-1713`,`tauri::generate_handler!` 共 **77 个唯一命令**,全部定义于 main.rs;无其他注册宏;数量已按注册表逐项复核)。行号随 B 阶段重构会漂移,本阶段后以模块名定位为准。

## 1. 产品解释固定(采用大纲第 8 节口径,实施不再自行解释)

- 面板只有 Main/Settings 两个顶级 Tab;欢迎页是 Main 的空状态(G01)。
- "最近文件修改"=  eligible 现存工作树文件的最大文件系统 mtime,不是最后事件/刷新/提交时间;ignored 项不进活动统计(G04,A03 夹具已固定行为)。
- "干净重置"= 目标树差异 ∪ 受影响脏路径 ∪ 阻挡与显式清理的未跟踪路径,受保护边界写前拒绝,部分结果如实上报(G06)。
- "搜索"= 当前分支范围内对消息/正文/OID/本地 refs 的字符序列模糊匹配,含未加载页;范围外命中必须说明(G03)。
- "仅本地"= 核心功能离线可用;读取已有 remote-tracking refs 是本地元数据,不声称远端最新;不隐式下载对象(G10)。
- 永不显示文件内容/差异,一律离开到外部工具(G10 定义性约束)。

## 2. 退出清单(远程、克隆、认证、可能下载的 submodule 操作)

以下命令及其 UI 入口、事件与自动路径按 B04 退出产品;实现内部 spawn 网络子命令或仅服务于远程面(证据为定义/实现行号):

| 命令 | 触网/归属证据 | 依赖的 UI 入口(退出面) |
| --- | --- | --- |
| `clone_repository` / `cancel_clone` | `clone.rs:169` `git clone`;`welcome.ts:111/92` | 欢迎页 clone 表单与 `clone-progress` 监听;`main.ts:168-171` 菜单重定向 |
| `fetch` | `network.rs:159` `git fetch --prune` | `remotes.ts` Fetch all/行内;`shell.ts:227` 菜单 |
| `pull` | `network.rs:498/711`(fetch leg + merge/rebase) | `remotes.ts:155`;`shell.ts:241-244` 策略菜单 |
| `push` | `network.rs:992`→push_leg | `remotes.ts:180`;`shell.ts:229` |
| `publish` | `network.rs:1102/1189` 首发 `--set-upstream` | `remotes.ts:216`;`shell.ts:230` |
| `force_push` / `preview_force_push` | `network.rs:1514`;预览 1421 | `remotes.ts:65/395`;`main.ts:244` 票据确认 |
| `delete_remote_branch` / `preview_delete_remote_branch` | `network.rs:1330/1355` `push --delete` | `branches.ts:297` "Delete on remote…" |
| `list_remotes` / `add_remote` / `set_remote_url` / `preview_remove_remote` / `remove_remote` | `remotes.rs` 读写 Git 配置(不触网但属远端管理面) | `remotes.ts` 全视图(侧栏第 7 页退出) |
| `set_upstream` | `network.rs:1621-1755`,校验本地 tracking ref | `branches.ts:140` 菜单项 |
| `submit_askpass` + askpass 桥整体 | `main.rs:1233-1250` 事件注入;`askpass.rs:275-279` GIT_ASKPASS;argv 自我拉起 `main.rs:1595-1601` | `dialogs/askpass.ts` 全部;`remotes.ts:64/394` "Retry with credentials";`state.ts:196/270-275` |
| `submodule_init_update` | `submodules.rs:449` `git submodule update --init --recursive` → 未初始化子模块会 clone/fetch | `worktrees.ts:136-150/204/285`(行内与 Update all) |
| (随上面一并复核)`pull_default`、`netclassify.rs`、askpass 诊断字段 | 均为远程失败分类/配置读面,无本地替代用途 | 诊断导出中的 remotes/credential 段(`main.rs:1516-1572`)按 H01 决定裁剪幅度 |

退出后必须新增"不可调用"契约检查(B04/IPC 测试):直接 `invoke` 已退出命令应命令不存在或明确不可用,不以隐藏按钮充当退出。

## 3. 保留的仅本地命令面(77 中其余 60 余个)

- 会话/读取:`open_repository`、`restore_repository`、`refresh_repository`、`close_repository`、`list_recent_repositories`、`history_page`、`commit_files`、`list_refs`、`show_tag`、`stash_list`、`list_worktrees`、`submodule_status`(纯本地读,`submodules.rs:330-390`)、`probe_git`、`probe_external_tools`、`run_process_probe`(`hash-object`)。
- 本地写:stage/unstage/commit、discard/clean(预览+确认票据)、branch 创建/切换/重命名/删除、tag 创建/删除、stash save/apply/pop/drop、merge/rebase/cherry-pick/revert 序列与 continue/abort/skip、reset 与 hard reset(将被干净重置协议替换)、worktree add/remove/prune。
- 其它:`save/restore_window_settings`、`open_external_tool`/`open_commit_diff`/`cancel_exttool`、`cancel_write`、`export_diagnostics`、`run_transfer_probe`(见不确定项 4)。

逐命令前端调用点已在本次核对:77 个注册命令全部有至少一个调用者,"零调用者"未找到——因此 B04 的删除顺序是先退 UI 入口、再撤命令注册,最后清理实现(路线图 §执行约束)。

## 4. 自动/后台路径分类(静态结论:无自动触网)

| 路径 | 内容 | 判定 |
| --- | --- | --- |
| `watch.rs:213-275` supervisor + run_loop | `session::refresh` → `git status` + inflight 检测 | 本地;C01 改造对象 |
| `main.ts:329` boot `restore_repository` | `session::open` | 本地 |
| 每个新快照的 `view.sync()`(`main.ts:219-221`) | list_refs/list_remotes/pull_default/stash_list/list_worktrees/submodule_status/history_page | 全部本地读,但违反 G09 低占用(B03 收敛);remotes 面随 B04 退出 |
| `settings.ts:258-267` 首轮 render | probe_git/probe_external_tools | 本地 |
| `window.ts:42/59` 防抖 | save_window_settings | 本地 |
| `main.rs:1615-1633` setup askpass sweeps | 纯文件清理 | 随 askpass 整体退出 |
| `main.rs:1595-1601` argv→askpass client | 仅远程 interactive 操作期间被 git 拉起 | 退出清单 |

## 5. 与 G01–G10 的关联

- G10:第 2 节即其退出清单;第 4 节证明"核心离线可用"的现存基础(自动路径全本地)。
- G01/G09:第 4 节 sync-all 与七视图注册是 B 阶段收敛对象。
- G04/G07/G03/G06/G08/G05/G02:均不依赖任何远程命令;干净重置(F02–F06)复用本地 `reset`/`clean` 通道,无需网络语义。

## 6. 不确定项(需运行验证或产品决策,不得静默放宽)

1. **hooks**:提交故意不 `--no-verify`(`write.rs:742`),用户 hook 可能联网——属用户配置的间接面,guit 不承诺 OS 级网络沙箱(与指导文件一致)。
2. **`submodule.recurse=true` 用户配置**:`switch/merge/reset` 可能被 Git 隐式加跑 submodule update 而触网。仅本地约束需要在剥离 `GIT_*` 后显式设 `submodule.recurse=false`(或等价 `-c`)并在受支持 Git 版本上验证——列入 B04/C 实施检查项。
3. **partial clone / promisor**:本地读取缺对象时 Git 可能隐式 lazy fetch;退出实现需带阻止开关并实测(AGENTS.md 同款要求)。
4. **`run_transfer_probe`**:`clone --no-local` 仅对本地临时源,不联外网,但走传输协议;B04 决定保留为本地传输探针或随远程面退出。
5. **askpass 残留面**:`credential_status` 诊断读取、docs/credentials.md 整篇,随远程退出后是否保留为纯诊断说明在 H04 文档任务决定。
6. **`delete_remote_branch`/`force_push` 固定 `interactive:false`**(读码事实):其票据流程从未建立认证桥;退出时无需为它们保留 askpass 兼容路径。

## 7. 结论与回退

清单为静态读码证据,行号基于 `8a7c0c2`;判定"触网"依据是 argv 级 Git 子命令,未宣称运行时网络测量。回退:本文档不影响代码。退出清单进入 B04 实施与 04-validation §3.2 场景矩阵核对。
