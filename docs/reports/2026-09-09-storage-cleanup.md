# 项目目录清理记录

用户已确认按清单清理 41 项候选。先执行 dry run，删除前再次检查绝对路径在当前仓库内、无重解析点、大小未变化且无进程使用候选路径；随后用 PowerShell `Remove-Item -LiteralPath` 删除。41 项全部完成，复查候选残留为 0。

## 体积变化

以下为可读取文件的逻辑大小，单位 GiB；6 个权限受限临时目录未计入，也未清理。不是磁盘分配块或精确可用空间测量。

| 范围 | 清理前 | 清理后 |
|---|---:|---:|
| 项目合计 | 62.69 | 30.13 |
| `release/` | 36.11 | 5.82 |
| `desktop/` | 11.53 | 9.26 |
| `outputs/` | 13.62 | 13.62 |
| `.git/` | 1.32 | 1.32 |

候选逻辑体积合计 **32.55 GiB**。扫描发现部分临时更新文件为硬链接；按文件标识去重后的内容大小约从 61.94 GiB 降为 30.13 GiB。因此不把逻辑减少量直接宣称为操作系统实际腾出的字节数。

当前 Git 跟踪的 842 个文件合计约 **72.59 MiB**，包含业务源码、文档和静态资源。这次膨胀的主因不是源码冗余。

## 删除和保留范围

删除：旧 `.staging-test-*`、`.installer-staging-*`，较早的 `.backup-target-*`、`.backup-zip-*`、旧安装程序/版本清单副本，以及 3 个 `desktop/.build/update-runtime-*` 临时运行时。

保留并核对存在：当前 1.1.6 安装包和便携版、最近一套便携/ZIP/安装包/版本清单回滚副本、当前组件制品、业务数据、素材与验收证据、构建依赖、Git 历史。没有删除任何跟踪源码。

剩余主要占用：

- `outputs/wechat-feedback-20260909/pre-1.1.6-release/` 约 11.19 GiB：升级前完整备份，包含用户数据及当时的组件副本，不按普通缓存处理。
- `desktop/.build/` 约 8.47 GiB：当前构建运行环境、可复用缓存和验收资料。包括 Python、视频渲染、浏览器、FFmpeg 等运行依赖，不能因不是业务源码就整目录删除。
- `release/` 约 5.82 GiB：当前可交付版本、最近回滚制品及组件归档。

## 为什么反复膨胀

发布脚本为避免覆盖旧包，原子替换前会保存便携目录、ZIP 和安装包副本；成功后 `retainedBackups` 仍被保留。组件验证模式也会保留暂存应用，失败或被中断的构建可能留下打包暂存目录。多轮构建复制相同的完整运行环境，再叠加升级验收的完整用户数据备份，体积迅速累积。`.gitignore` 只能防止提交，不能释放磁盘空间。

对应实现：`desktop/scripts/build-portable-release.cjs` 的 `publishStagedRelease`、`componentsOnly` 分支，以及 `desktop/scripts/build-installer-release.cjs` 的备份与暂存路径。

建议后续按“当前版 + 一套已验证回滚版”管理发布物；验收完成后按清单收尾暂存目录，失败证据只保留必要日志与明确需要的制品。用户数据备份应在业务保留复核后决定归档或删除，不与程序缓存共用删除规则。本次没有扩大为未来自动删除政策，也没有修改发布脚本去自动删除尚未确认的制品。

## 证据

- 原始路径与大小：[cleanup-inventory.json](../../outputs/workflow-repair-20260909/cleanup-inventory.json)
- 实际删除路径：[cleanup-removed.json](../../outputs/workflow-repair-20260909/cleanup-removed.json)
- 清理后盘点与保留项检查：[cleanup-after.json](../../outputs/workflow-repair-20260909/cleanup-after.json)
- 本轮执行脚本：[cleanup.ps1](../../outputs/workflow-repair-20260909/cleanup.ps1)

这些文件位于本机忽略目录，作为本次清理证据保留；不能用本次确认自动授权删除以后新生成的路径。
