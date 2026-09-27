# guit

一个轻量、低占用的桌面 Git 客户端。它在一个紧凑的窗口里覆盖日常 workflows
——工作区状态、暂存、提交、分支、标签、stash、历史、合并与变基冲突、worktree、
submodule 以及远端同步——并可选置顶，方便和终端并排放着。

guit 用**你自己**安装的 `git`、**你自己的**配置运行。hooks、提交签名、凭据
helper 和 ssh-agent 的行为和在终端里完全一致，因为底下并没有藏着第二套 Git
实现。

## 它有意不做的事

**guit 从不显示文件内容和 diff。** 它不是编辑器。打开文件、查看 diff、解决冲突
这些动作一律交给你已经配置好的工具——`git difftool`、`git mergetool` 和系统
文件打开器。guit 不去和你真正读代码的地方抢位置。

也正因如此，guit 保持小巧：它持有的是你的仓库状态快照和能在这些状态上执行的操作，
而不是你工作区的内容。

## 环境要求

- `PATH` 上有 **Git 2.23 或更新版本**。（guit 启动时会探测是否支持 `git restore`；
  构建与验证使用的是 Git 2.53。）
- **Linux**，带 WebKitGTK 4.1 / GTK 3（包依赖会自动带入）。
- Windows 和 macOS 的包已配置、也能构建，但这个程序**从未在这两个平台上运行过**
  ——见 [docs/known-limitations.md](docs/known-limitations.md)。

## 安装（Linux）

```sh
sudo dpkg -i guit_0.0.1_amd64.deb     # Debian / Ubuntu
sudo rpm -i guit-0.0.1-1.x86_64.rpm   # Fedora / openSUSE
```

AppImage 也能跑，但构建和运行都需要设置 `APPIMAGE_EXTRACT_AND_RUN=1`，因为
`appimagetool` 挂载镜像需要 FUSE：

```sh
APPIMAGE_EXTRACT_AND_RUN=1 ./guit_0.0.1_amd64.AppImage
```

## 上手

首次启动时 guit 显示欢迎页，有两条进入路径：**打开**一个已经在磁盘上的仓库，
或者按 URL / 本地路径**克隆**一个。它会记住你打开过的仓库，下次启动自动恢复。

窗口布局类似编辑器的源码管理侧边栏：顶部应用栏显示仓库、当前分支和全局动作；
左侧活动栏在七个视图之间切换；底部状态栏承载正在进行的操作、文件监听模式和
界面缩放控件。

### 七个视图

| 视图 | 用途 |
| --- | --- |
| **Changes** | 你的工作区，按已暂存、未暂存、未跟踪分组。可就地暂存 / 取消暂存；每行的 `⋯` 菜单提供 diff、打开、丢弃、解决冲突；写完消息即可提交（可勾选 **Amend**）。 |
| **History** | 提交列表，最新在前，右侧可拖拽分隔的详情面板。**Load older** 逐页加载更早的历史，不会重建整个列表。 |
| **Branches & Tags** | 搜索、创建、切换、重命名、删除分支；创建附注标签或轻量标签；选择跟踪上游。破坏性操作先预览。 |
| **Stash** | 暂存当前改动，并列出已有的 stash。 |
| **Remotes** | 添加远端、fetch、pull、push。可选择 pull 策略（merge、rebase、仅快进，或用 Git 自身默认），以及发布分支。 |
| **Worktrees & Submodules** | 注册与清理链接的 worktree，以及初始化 / 更新 submodule。 |
| **Settings** | 主题、界面缩放、置顶、完整快捷键列表、环境检查（**Check again**），以及 **Export diagnostics…**。 |

即使没有打开仓库，Settings 也是唯一可用的视图，因此主题、缩放和诊断在冷启动下
依然可达。其余六个视图要打开仓库后才启用。

### 快捷键

| 快捷键 | 动作 |
| --- | --- |
| `Ctrl`/`Cmd` + `O` | 打开仓库 |
| `Ctrl`/`Cmd` + `R` | 刷新状态 |
| `Ctrl`/`Cmd` + `1`…`7` | 切换视图 |
| `Ctrl`/`Cmd` + `Enter` | 在消息框里提交 |
| `Ctrl`/`Cmd` + `=` / `−` / `0` | 界面放大 / 缩小 / 重置 |
| `Escape` | 关闭当前对话框或菜单 |

界面缩放范围 12–24px，主题默认跟随系统，也可手动覆盖。两种偏好在重启后都会保留。

## 破坏性操作绝不是一点即成

强推、硬重置、删除分支、丢弃改动都走同一条路径：guit 先算出**确切**会影响到什么，
把这份清单给你看；如果在你确认之前候选集发生了变化，确认会被直接拒绝。一次确认
是单次有效的，并且随进程一起消亡——在对话框中途退出 guit，不会给你留下一个待执行的
破坏性动作，等你重启后一头撞进去。

## 你的凭据还是你的

**guit 不保存任何凭据。** 没有 guit 自己的凭据文件，没有 keychain 条目，也没有
任何存活超过单次操作的内存缓存。它使用你已安装的 `git`，所以你现有的凭据 helper
和 ssh-agent 会自己完成认证。当某个操作需要密码时，guit 可以通过一个短命的
askpass 桥接提示输入，并在操作结束时清理掉——崩溃之后也会清理。SSH 密码短语
一律不提示，ssh-agent 是唯一支持的路径。见 [docs/credentials.md](docs/credentials.md)。

## 出问题时

Settings → Environment & diagnostics 里的 **Export diagnostics…** 会写出一份
纯文本报告。它会先给你看一份清单，说明这份文件**确切**包含什么：版本信息、你的
凭据*形态*（绝不是凭据本身）、把内嵌凭据脱敏后的远端 URL，以及近期事件摘要。
密码、token、提示文本、提交信息和文件内容从构造上就被排除在外，home 目录路径
也会被折叠掉。

## guit 会写哪些文件

配置放在你的平台配置目录，Linux 上是 `~/.config/dev.guit.desktop/`：

| 文件 | 内容 |
| --- | --- |
| `session.json` | 当前打开的仓库 |
| `recent.json` | 最近仓库列表 |
| `window.json` | 窗口位置、尺寸、最大化与置顶状态 |

这些文件**只向前迁移**。遇到比自己更新的 `schema_version` 时，guit 会拒绝读取
并原样保留字节，因此装上旧版 guit 绝不会改写较新的状态。只有更新的 guit 才会
写入更新的 schema，并且在写入时会把旧文件备份一份。

## 文档

以下文档目前**仅有英文版**：

- [docs/external-tools.md](docs/external-tools.md) — 如何配置 diff、merge 和
  文件打开工具，以及它们的退出码对 guit 意味着什么。
- [docs/credentials.md](docs/credentials.md) — guit 到底如何处理认证。
- [docs/known-limitations.md](docs/known-limitations.md) — 哪些已验证、哪些没有，
  以及平台矩阵。在假定某个功能在你的平台上可用之前，请先读它。
- [CHANGELOG.md](CHANGELOG.md) — 每个版本改了什么。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
