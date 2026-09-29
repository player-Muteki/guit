# B04 仅本地范围收敛

任务：B04 — 清理 welcome 克隆、shell 同步、remotes 页面、强推/发布/认证重试、submodule 下载入口；核对 `main.rs` invoke 注册与事件路由；阻止 partial clone 隐式取对象。
验收口径（路线图）：“核心功能离线可用；直接调用已退出的 IPC 也不可用；本地 refs 可读，缺对象不联网”。
前置：B03 完成于 `d60f177`（释放登记与按域订阅，见 [B03 记录](12-two-tab-panel-b03.md)）；退出清单固定于 [A04 命令清单](07-local-scope-a04.md)。

## 1. 采用的结构决定（实施后续阶段不再自行解释）

- **“退出”是一个原子的三件事：入口、注册、实现。** `ipc-surface.mjs` 剥掉注释后按带引号的字面量匹配，所以分两步删必然有一步报孤儿命令。本阶段把 20 个命令的 UI 入口、`generate_handler![]` 条目和 Rust 实现在同一次改动里一起移除，并新增 `EXITED_COMMANDS` 清单做**反向**断言：一个已退出的名字既不得出现在注册面上，也不得再被任何前端字面量命名。注册命令数 78 → 58，新增 0。
- **退出清单就是 A04 §3 保留清单的补集。** 保留的是全部本地读写，包括 `stash_list`、`list_worktrees`、`submodule_status`；`run_transfer_probe` 按 A04 交给本阶段的第 4 项随克隆面一起退出。
- **远端跟踪引用降级为只读元数据。** 分支选择层仍列出 `refs/remotes/*`，但没有任何入口能改变远端；提交图的 `%D` remote 装饰同样保留。口径是“Git 上次替你记下的状态”，不是“远端现在的状态”——这句话同时写进文案和 `branches.ts` 的注释，避免下一个读者把它当成漏删的远端功能。
- **`OperationResult` 不再有 `category` 字段。** `netclassify` 整体删除：它唯一的用途是给一次网络失败分类，而所有构造点都硬编码 `category: None`。这改变序列化 JSON，`types.ts` 的 `kind` 联合同步收窄到 28 个本地种类，`PreviewKindKey` 收窄到 8 个本地票据。
- **唯一出口承担本地性。** 局部约束落在 `repo::user_git_command`：在所有子命令之前 prepend `-c submodule.recurse=false`（`switch`/`merge`/`reset` 不得隐式更新——也就是下载——子模块），在 `GIT_*` 剥离**之后**设置 `GIT_NO_LAZY_FETCH=1`（剥离会把它一起删掉，所以必须在后面才存活）。绕过 `repo::git()` 直接调 runner 的十几处调用点全部经过这个函数，因此不需要逐点加固，也不需要“记得加”。
- **失败仍是失败。** 因这两条控制而产生的 git 错误按原本的读写失败上屏，不折算成“仓库干净”。这条是既有“读不动的目录不是干净仓库”规则的延伸，不是新增规则。
- **共享的子进程清理与 askpass 无关，所以迁走而不是删掉。** `sweep_stale_config_temps` 从 `askpass.rs` 迁到 `main.rs`，连同它的两条测试：它保护的是 `window.json` 那套原子 rename 写的残留临时文件。argv 拦截随 `--guit-askpass` 一起消失。
- **`interactive` 参数随认证重试同批退出。** 后端签名先去掉，前端 `confirmTicket` 的 `{ nonce, interactive: false }` 同批改成 `{ nonce }`——留下前端在发送后端不再接收的字段，等于给下一位读者一个假的“这里有交互模式”的暗示。
- **诊断导出不再谈凭据。** `Facts` 去掉 `credential_policy` / `credential_helpers` 与远端 URL 段；Settings 的导出清单（那份清单就是确认动作本身）同步改成“包含 / 不包含”两组真实集合。凭据配置从此不被读取，而不是被读了再脱敏。
- **文案与实现同批走。** 中英文 README、`docs/credentials.md`、`docs/known-limitations.md`（后两者已随 `docs/` 撤下）、`CHANGELOG.md`、`CLAUDE.md` 一起改到不再有任何一句承诺克隆/fetch/push/认证重试；`user-facing-copy.mjs` 的门保持原样，不放宽。

## 2. 为什么门禁必须双向

只断言“注册面上的每个名字都有调用者”，退出的命令就无人看管：把按钮藏起来、把注册留着，`ipc-surface` 依然全绿，而窗口里任何脚本 `invoke("push")` 仍然能把带网络参数的命令送到 Git。这正是“直接调用已退出的 IPC 也不可用”这条验收要防的形状。反向断言必须有**清单本身**的自检（长度下限、每个退出族至少一个代表），否则清空 `EXITED_COMMANDS` 也能拿到绿灯——那和把注册表解析成空列表是同一类假绿。

`submodules.rs` 侧同理：删除下载入口后，纯本地列举所需的 `literal_pathspec` 仍被保留路径使用，依赖图里“可一并删除”的判断以实测调用者为准，不以模块名为准。

## 3. 验证

| 门禁 | 结果 |
| --- | --- |
| `npm run build`（tsc --noEmit + vite） | 0（JS 81.78 kB / CSS 29.52 kB，B03 为 98.59 / 30.03 kB） |
| `npm run test:fixture` | 139/139（B03 记录 143：删除 askpass 提示套件与强推开关断言，新增 `ipc-surface` 的退出命令断言与清单自检） |
| `cargo fmt --check` / `cargo clippy --locked --all-targets` / `cargo test` | 0 / 无 warning / 249 通过（基线 353+5：差值是随模块删除的在文件内测试与被删的集成测试） |
| `color-contrast.py dist/assets` / `responsive-check.py` | fails=0 / fails=0 |
| `tools/bench/read-budget.mjs` | fails=0（17 项），开仓库时“没有页面的列表”仍为 0 次读取 |

Rust 侧净变化：删除 `clone.rs`、`network.rs`、`remotes.rs`、`askpass.rs`、`netclassify.rs` 与 `tests/askpass_e2e.rs` 共 6 个文件，`src-tauri` 合计 +122 / −8339 行。前端删除 `views/remotes.ts`、`dialogs/askpass.ts`、`dialogs/askpassPrompt.ts` 及其夹具；`shell.ts` 去掉同步菜单与克隆入口，`welcome.ts` 去掉克隆表单，`branches.ts` 去掉上游选择器，`worktrees.ts` 的子模块列表转为只读，`settings.ts` 去掉传输探测。

退出的 20 个命令：`clone_repository`、`cancel_clone`、`fetch`、`pull`、`pull_default`、`push`、`publish`、`force_push`、`preview_force_push`、`delete_remote_branch`、`preview_delete_remote_branch`、`list_remotes`、`add_remote`、`set_remote_url`、`preview_remove_remote`、`remove_remote`、`set_upstream`、`submit_askpass`、`submodule_init_update`、`run_transfer_probe`。

事件路由核对后只剩 `repo-refreshed` 与 `watch-status` 两个 emit，两侧配对；`clone-progress`、`sync-progress`、`submodule-progress`、`askpass-request`、`probe-progress` 无 emitter 也无 listener。`capabilities/default.json` 与 `tauri.conf.json` 不含命令名，无需改动。

## 4. 与并行开发的对齐

本阶段没有修改 `plan/08-gate-baseline-a02.md`、`plan/09-activity-contract.md` 等由另一条线推进的文件，也没有改动快照/版本协议本身，因此 B05 的会话标识与 D 阶段的引用代次不受影响。`snapshotBus` 的 `refsKey` 里仍带着 `upstream / ahead / behind`——这些字段来自本地跟踪引用的元数据，读它们不需要联网，保留是正确的；B05 换成会话身份时应当改键的来源，而不是删掉这些字段。

`OperationResult` 少了一个序列化字段，任何按旧 JSON 写出的夹具都要同步收窄；A03 的语义夹具不含该字段，未受影响。

## 5. 已知缺口

- `GIT_NO_LAZY_FETCH` 与 `submodule.recurse=false` 的拒绝形状**尚未在真实 partial clone 或带真子模块的仓库上观察过**；这条未验证现由本目录交付状态表的 B 行承担（原先记在已撤下的验证记录里）。
- 不认识 `GIT_NO_LAZY_FETCH` 的更旧 Git 会静默忽略它而不是报错，所以这条下界只有构建所依据的 Git 2.53 有证据。
- `stash_list`、`list_worktrees`、`submodule_status` 等本地命令仍在注册面上，靠已经没有页面的模块里的字面量满足门禁；实现与这些模块的彻底下线属于迁移收尾，本阶段不动，以免连带删掉仍被本地路径使用的写保护。
- 桌面探针（`tools/bench/layout-probe.mjs`、`view-smoke.py`、`narrow-smoke.py`）仍指旧结构与旧令牌，留给 B06。
- 运行证据仍只覆盖同一台 Linux 主机；Windows/macOS 只有构建配置。

## 6. 回退

回退 = revert 本次提交，且**必须整体回退**。分批 revert 会造出“注册留着、实现没了”或“入口回来了、命令不在了”的半退出状态，两者都会在生产者侧或消费者侧假绿。没有数据迁移、没有对用户仓库的写操作，因此不需要额外的恢复步骤。

## 结论

三条验收口径都有对应的门禁或记录：离线可用由 58 个命令全为本地读写支撑；“直接调用已退出的 IPC 也不可用”由 `EXITED_COMMANDS` 的双向断言加实现删除支撑；“本地 refs 可读，缺对象不联网”由只读的跟踪引用列表加 `repo::user_git_command` 的两条控制支撑，其中后者的失败形状仍是未验证项，记在限制文件里而不是这里。
