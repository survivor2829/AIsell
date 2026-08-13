# 内容生产 Sidecar

这是内容生产底座的本地 worker，只使用 Python 标准库。它原地索引用户已有的素材，绝不复制或删除原始视频、图片。

运行：

```powershell
python worker.py --data-dir C:\absolute\path\to\content-engine-data
```

进程先输出一行 `ready` JSON，之后每个 stdin JSON 请求对应一行 stdout 响应；每个响应都会回显请求 `id`。公开的素材、归档、任务和成片 DTO 均不包含原片或输出的绝对路径。

公开方法：

- `health`、`import_files`、`import_folder`、`resume_import_folder`
- `list_assets`、`archive_asset`、`reveal_asset`
- `probe_asset`、`probe_pending`、`update_asset_rights`
- `create_task`、`update_task`、`list_tasks`
- `register_finished`、`list_finished`、`get_setting`、`set_setting`
- `create_mix_project`、`update_mix_project`、`get_mix_project`、`list_mix_projects`
- `calculate_mix_combinations`、`generate_mix_candidates`、`list_mix_candidates`
- `review_mix_candidate`、`list_publish_queue`、`update_publish_queue_item`
- `render_mix_candidate`、`list_export_packages`

`import_folder` 每次只处理受限批次，返回 `task_id` 与 `has_more`；使用同一任务 ID 调用 `resume_import_folder` 直到完成。已处理且未变化的文件由 SQLite checkpoint 记录，重启不会重复哈希。

媒体探测与授权：

- `probe_asset` 对单个已索引素材调用可用的 `ffprobe`，记录时长、分辨率、帧率、音频状态及可解释的失败码。
- `probe_pending` 默认及硬上限均为 10，只在用户明确触发后分批探测；导入成功不会同步等待媒体分析。
- `update_asset_rights` 只表达素材版权/使用权，接受 `unknown`、`owned`、`licensed`、`restricted`、`expired` 五种状态。人物肖像、声音和用途同意必须由后续独立 `ConsentRecord` 表达，不能用版权状态替代。
- `ffprobe` 是动态能力：worker 只在运行环境发现可信的绝对路径可执行文件时公布 `asset_media_probe=true`。固定 runtime 仅在构建时同时显式配置 `XIAOXI_FFMPEG_PATH` 和 `XIAOXI_FFPROBE_PATH` 才捆绑两项工具；未配置的干净机器会诚实显示媒体探测和混剪渲染不可用。索引、任务、版权登记、项目配置和候选审核仍可使用。

仅主进程可用的方法：

- `resolve_asset_path`
- `resolve_finished_path`
- `resolve_export_package_path`

这三个方法才会返回 `absolute_path`，并且只返回 Electron 主进程。其响应绝不能经过 preload IPC 到 renderer；主进程最多将路径交给 `shell.openPath` 或 `shell.showItemInFolder`。公开 DTO、运行日志和任务列表不得泄露原片或输出的绝对路径。

数据保存在 Electron edition 对应的 `userData/content-engine/`，包括 SQLite 索引、任务、成片登记和缓存设置。原片位置仅以内部索引方式保存；归档素材只从素材库视图隐藏，不会删除磁盘文件。

构建固定运行时（在 `desktop/` 下）：

```powershell
npm.cmd run build:content-engine
node scripts/content-engine-release-runtime.self_check.cjs
```

构建输出位于忽略目录 `.build/content-engine-runtime/`。构建程序拒绝覆盖已有固定运行时，避免新源码误混入旧构建。默认开发启动还会核对 manifest 源 commit 与当前 Git HEAD，并要求该 sidecar 源目录没有未提交改动；不一致时显示运行时不可用，而不会静默启动旧 EXE。

测试（在 `desktop/` 下）：

```powershell
python -m unittest discover -s sidecars/content-engine/tests -v
node src/main/content-engine-sidecar.self_check.cjs
node src/main/content-engine-ipc.self_check.cjs
node src/main/content-engine-desktop-integration.self_check.cjs
npm.cmd run build:test
```
