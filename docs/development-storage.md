# 开发与发布空间记录

日常界面调整只构建 renderer，依赖未变不重新安装，运行时未变复用已验证缓存。不要为 UI 验收复制完整安装目录、业务资料或新建完整 Python 环境。本轮使用既有依赖和 Python 环境，只有当前工作树负责集成。

## 自动记录

阶段同时记录单调时钟累计耗时、相邻观测间隔与扫描耗时，报告保存总历时。旧报告没有时间字段时保持未知，不从文件时间推算。日常任务记录方式见 [快速迭代标准](development-iteration.md)。

`build:test` / `build:delivery`、`run-release.cjs`、`release:internal` 和 `publish:internal` 自动在 `desktop/.build/space-usage/` 写 JSON。记录当前提交、版本、操作、开始/阶段完成/清理结束、目录逻辑大小、分区可用空间、观测峰值、净增量及新建 staging 的归属。只保留最近 30 份工具自己创建的空间报告，复用现有 artifact-retention，不建立另一套删除系统。

- renderer 只测自己的 dist；发布测 `.build`、`release` 和本次 staging。工作树外既有依赖、安装资料、旧备份不在这个自动统计范围，完整盘点另用下述只读命令。
- 峰值是阶段采样的最大值，不是连续采样；目录大小是逻辑文件大小，不是 NTFS 可释放量。硬链接按文件身份去重，junction 不跟随；读取失败会标记 incomplete。
- internal-release 包含其子命令，报告相互重叠，不能把 renderer、release、internal-release 的大小相加。判断该次构建净增长以外层记录为主，临时 staging 峰值看 release 记录。
- 成功发布记录真正执行成功上传的文件字节数（含清单、不含协议开销）；失败可能已有部分传输，保持未知，不写成零。仅创建包不算上传。绕过 publish:internal 的低层发布入口仍返回上传量，但不自动创建外层空间报告。
- 本机安装下载量与远端 CI 产物量默认 `null`，需要对应更新回执／CI artifact 证据。GitHub 云端 Windows runner 的占用不等于本机 C/D 占用。
- 记录失败不会阻塞构建；断电中断的记录保持 running，不能认作验收完成。不要用观测净增量推算整个版本全部成本。

## 回收与保留

发布 staging 沿用 `run-release.cjs` 现有 finally 回收；运行时缓存沿用按指纹复用及每种运行时两代保留。更新进程验收沿用已有 fixture-marker 和成功后程序副本清理，并回收该次测试 profile 内的组件 generations、program-backups 和助手缓存；失败保留现场。这里的程序备份属于隔离测试，不触碰安装版用户备份。不要因扫描到大文件就绕过这些归属检查。

本次产物成功完成后，回收本次明确创建的可重建临时副本；验收截图、结果和必要日志保留。仍供预览使用的隔离目录在关闭后才回收。历史工作树、备份、发布底座及唯一资料必须列出具体路径、引用、证据和大小，再确认清理；dirty 工作树不能整份删除。

## 只读盘点

在仓库根目录执行：

```powershell
node desktop/scripts/storage-inventory.cjs "D:/OpenAI/LocalInstallBackups" "D:/OpenAI/ReleaseBases"
```

显式传入目录；输出 JSON，不删除文件、不上传数据。包含一级子目录、版本（能读取时）、源码 dirty 状态和构建记录引用。父级与子级统计重叠，不可相加。`deletionAuthorized: false` 是固定事实，不能把扫描结果当作删除授权。

下一次获准发布，保留外层构建报告，补入安装更新回执、实际上传量和远端产物证据，才能回答该版本的完整空间账。本轮没有为了补这个数字再打整包或发布。
