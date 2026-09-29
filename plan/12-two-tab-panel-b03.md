# B03 组件 dispose 与按域订阅

任务:B03 — 建立组件 dispose 与按域订阅,旧视图停止初始化与自动查询。
验收口径(路线图):"不再一轮 snapshot 读取全部高级列表;Tab 往返不增加 timer/listener 数量"。
前置:B02 完成于 `57f5af8`(更改区与提交图同屏,见 [B02 记录](11-two-tab-panel-b02.md))。

## 1. 采用的结构决定(实施后续阶段不再自行解释)

- **`src/lifecycle.ts` 是唯一的释放登记处。** `onDispose(task)` 在 attach 的那一行旁边登记,返回反注册函数;`disposeAll()` **后 attach 的先 release**,并吞掉抛错的 teardown(一个部件松不开手,不是跳过其余部件的理由);`pendingTeardowns()` 是给探针用的计数。集合按 task 引用去重,因此重建的组件不能把同一个 `disconnect` 叠成两份。
- **释放由真实的关闭路径触发,不是由某个"切换仓库"分支触发。** `window.ts` 的 `onCloseRequested` 在 `persistWindowSettings()` 之前调用 `hooks.onClosing()`,`main.ts` 把它接到 `disposeAll()`。
- **`src/snapshotBus.ts` 的域是 `"graph" | "refs"`,每域一个纯由快照字段算出的内容键。** 键不变就不通知——**快照的单调 `version` 被刻意排除在键之外**,因为"同一内容的新版本"恰恰是不该产生读取的那一件事。`graphKey = openPath + name + headState + oid`;`refsKey` 再加 `upstream / ahead / behind / operation.kind`。
- **`publishSnapshot(null)` 是"会话结束"在总线里的唯一翻译点,它通知每一个域。** 结束不是一次读取,而是一次清空:仓库已经不在了,画布上还留着它的提交就是说谎。同时清掉记住的键——下一个仓库不得继承这个仓库"已经看过什么"。前端会话结束的唯一出处仍是 `state.ts` 的 `applySnapshot(null)`(关闭仓库、恢复被拒、以及任何不携带快照的写结果),三处都收敛到这一个动作。
- **职责切分:总线管"这个域动了没有",组件管"这个回答还该不该上屏"。** `history` 在发起分页请求时记下 `openPath + head oid`,回来时身份变了就丢弃;`branches` 保留"一轮接受的快照最多一次读取"的自我节流,并且选择器在打开时重读名字——所以关着的选择器不需要订阅,也不需要被读取。
- **覆盖层的可见性归 shell 管。** `registerOverlay(content, onShow?)` 与 `isOverlayOpen()`:refs 订阅问一句"名字此刻在屏上吗",而不是让选择器自己知道它被关掉了。
- **旧视图不再初始化。** `main.ts` 不再 import/构造 stash、worktree、submodule 视图;remotes 视图改为第一次同步动作时惰性创建(同步菜单仍可用)。构建产物 JS 从 105.11 kB 降到 98.59 kB——这是"未被引用"的直接后果,不是优化目标。
- 每轮接受快照的读取:改前 **6 次**(`list_refs`、`stash_list`、`list_remotes`、`pull_default`、`list_worktrees`、`submodule_status`,其中 4 次属于已经没有页面的模块),改后 **0 次(内容未动)或 1 次(仅移动的那个域)**。

## 2. 为什么身份必须写在键里

`graphKey` 最初只到 `openPath + name + oid`。夹具"裸仓库是一种自己的状态,不是一个空名字"当场失败并给出 `[0, 1]`:裸仓库与未诞生分支都只有空 `name` 与空 `oid`,两个键折叠成同一个,于是第二个仓库的快照被认为"内容没变"而无人通知。把 `headState` 写进键才是对的——裸仓库、未诞生分支、游离 HEAD 是对一段没有提交的历史的三种不同说法。

这条与阶段 A 的结论同源:同一 HEAD OID 加同一分支名,在克隆出来的两个仓库里完全相同,所以**身份只能靠快照字段带出来,不能靠猜**。B05 的会话标识落地后,这些键应改用同一个身份,而不是在第二处再定义一份。

## 3. 验证

| 门禁 | 结果 |
| --- | --- |
| `npm run build`(tsc --noEmit + vite) | 0(JS 98.59 kB / CSS 30.03 kB) |
| `npm run test:fixture` | 143/143(新增 `tests/snapshot-bus.mjs` 8 条、`tests/lifecycle.mjs` 5 条) |
| `cargo fmt --check` / `cargo clippy --locked --all-targets` / `cargo test` | 0 / 无 warning / 353+5 全过(Rust 侧未改) |
| `color-contrast.py dist/assets` / `responsive-check.py` | fails=0 / fails=0 |
| `tools/bench/read-budget.mjs` | fails=0(17 项) |

新增夹具钉住的行为:同一内容更高 `version` 不产生读取;graph 只跟随它所画的那个分支/head;refs 对计数、操作、detached 作反应;换仓库全部重读;会话结束通知每个域且带的是 `null`,并忘记记住的键;同一 handler 两次注册是一次订阅;25 轮 subscribe/detach 后 `domainSubscriptions()` 回到原值;裸仓库与未诞生分支是两个不同状态;`disposeAll` 后 attach 的先 release、抛错者不停下别人且不被留在集合里、已反注册的不再被询问、teardown 期间登记的留到下一轮。

## 4. 运行证据:`tools/bench/read-budget.mjs`

读取预算是**运行时**问题(哪个命令该发,由跑着的前端决定),静态门与单元测试都看不见,所以补一个真实构建产物上的 CDP 探针。它不是 `npm run test:fixture` 的一部分(那没有浏览器也没有显示器)。启动方式写在文件头:先 `microsoft-edge --headless=new --remote-debugging-port=9222`,再 `node read-budget.mjs ../../app/dist 9222`。Rust 侧由计数桩替代,夹具形状取自 `types.ts` 的当前线格式。

实测(900×800):

- 开仓库:读历史 1 次,`list_refs` 0 次,四个"没有页面的列表" 0 次。
- 连点三次刷新且内容未动:**0 次读取**(只有 `refresh_repository` 本身)。
- HEAD 移动:只重读 graph(1 次),refs 0 次。
- 打开选择器:读名字 1 次;选择器在屏上时计数变化:refs 1 次;关闭后同样的变化:0 次。
- 只有文件变化:不请求任何列表。
- 12 轮 Main↔Settings 往返:`window 1→1`、`document 3→3`、`ResizeObserver 3→3`、`pending timers 0→0`、DOM 节点 `603→603`;往返之后再移动 HEAD 仍然只花 1 次 graph 读取——订阅叠起来的话,这一条会变成 13 次。
- 关闭会话:读取 0 次(只有 `close_repository` 本身),历史区回到空状态且 `[id^="commit-row-"]` 计数为 0。

监听计数只覆盖 `window`/`document`:行级监听随每次重绘生灭,把它们计入总数会在根本没有泄漏时也一直增长。

最后一条与 §1 的"结束要通知每个域"都是被这台探针抓出来的,不是想出来的:总线最初对 `publishSnapshot(null)` 只清键不通知,于是关闭仓库后提交图仍留在屏上(只有按钮被锁住);修完之后探针又抓出 `placeholder()` 不清 `rowsHost`,隐藏 listbox 里还挂着上一个仓库的 21 行和悬空的 `aria-activedescendant`。两者在单元测试与静态门上都不可见——它们分别是"谁该被通知"和"屏上到底画着什么"的问题。

## 5. 与并行开发的对齐

活动契约文档 §4.6 从这次尚未提交的工作树里读出了上述形状,并为定形活动(C04)定死四条接法。这里回应它所依据的两点,避免后续各自解释:

- **"活动值不进 snapshotBus 的域"是对的,且形状上必然如此。** `DOMAIN_KEY` 只接受 `SnapshotView`,活动不是快照字段。活动只借 `lifecycle.onDispose` 关掉计时器。
- **"tick 不能借这套 fan-out 实现"同样成立**,理由正是被夹具钉住的那条:键里没有 `now`,每 tick 全量通知就必须把 `now` 塞进键,而那会把"同一内容的新版本不读取"这条规则废掉。
- 它提出的身份分歧由本节 §2 收尾:键的身份在 B05 之后升级为一个会话身份,由 B05 定义一次;总线只是使用它。除 `publishSnapshot(null)` 外不应有第二处"会话结束"的判断,活动通道应当订阅同一处。

## 6. 已知缺口

- 证据取自 Chromium 桩化环境,不是 WebKitGTK。事件监听(`repo-refreshed`、`watch-status`)的**释放在桩里不可观察**:没有真实事件通道,`unlisten` 不会到达 Rust。探针只能证明注册数不增长;`onDispose(unlisten)` 的接法由代码位置与 `tests/lifecycle.mjs` 保证。桌面侧需要补一次真实关闭旅程。
- `disposeAll()` 只在窗口关闭路径上运行。Tab 往返并不销毁组件,所以"往返不增加 timer/listener"是由计数不增长证明的,不是由 disposeAll 证明的;往返本身在改前也不增长(组件不重建),本阶段新增的是**释放确实存在且可达**。
- `views/stash.ts`、`views/worktrees.ts` 仍在磁盘上,只是不再被入口引用。`tests/ipc-surface.mjs` 扫描磁盘上的命令字面量,因此那道门仍然有牙;真正的删除按"UI 入口 → 命令注册 → 实现"的顺序在下一阶段两侧一起做。
- 开着的选择器仍可能一轮一次 `list_refs`。快照只报告当前 head、它的上游计数与进行中的操作,不报告仓库里被别人移动的其它分支,所以选择器**不承诺**自己发现那种变化——它在打开时重读。
- 内容键的粒度是"快照字段",不是"用户看得见的一次变化":一次 `reset` 同时移动 head 与计数,graph 与 refs 各读一次,这是两次读取而不是一次。

## 7. 回退

`git revert` 本阶段提交即回到 B02 的 `sessionListeners` 形状(每轮接受快照对六个视图各调一次 `sync()`);`lifecycle.ts`、`snapshotBus.ts` 与两份夹具随同一提交消失,`main.ts`/`shell.ts`/`window.ts` 不留悬空引用。

## 结论

完成(一轮快照不再读取全部高级列表:未动不读、只读移动的那个域、关着的列表不读、会话结束通知每个域清空屏上内容;组件登记释放且释放由真实关闭路径触发;Tab 往返的监听、观察器、计时器与节点计数实测不变)。
