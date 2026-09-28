# 工作区第二轮清理候选

生成时间：2026-09-20（Asia/Shanghai）  
状态：A-D 已按用户确认执行完成；E 按推荐方案保留。

## 结论

- Git 跟踪的 951 个现存文件合计约 74.02 MiB；源码不是磁盘占用主体。
- 当前主要占用来自 `release`（17.08 GiB）、`desktop/.build`（12.48 GiB）、`outputs`（4.75 GiB）和 `Temp`（1.81 GiB）。
- 本轮建议永久删除 14.58 GiB 历史生成物；另有 0.63 GiB 可重新下载的工具缓存可选删除。
- 本清单只列候选，尚未删除任何新增项目。

## A. 建议删除：旧发布物与旧安装备份（11.25 GiB）

以下均早于当前 1.1.53，且不属于保留策略中的最新一代回滚副本：

- `release/offline-diagnostic-1.1.34-Ye73L2`
- `release/offline-diagnostic-1.1.35-GflIej`
- `release/offline-diagnostic-1.1.37-draft-replace`
- `release/offline-diagnostic-1.1.38-search-image`
- `release/offline-diagnostic-1.1.39-image-timeout`
- `release/offline-diagnostic-1.1.40-profile-popup`
- `release/offline-diagnostic-1.1.41-search-rollback`
- `release/1.1.27`
- `release/.backup-target-42788-1788951313360-cucdfpm4w`（版本 1.1.7）
- `release/.backup-zip-42788-1788951313360-cucdfpm4w`
- 三份旧测试安装程序备份：标识 `15604`、`22920`、`6504`
- 与上述三份安装程序对应的三份版本清单备份
- 两个空目录：`release/.pd-sting`、`release/.artifact-retention-requests`

## B. 建议删除：旧测试候选包（2.32 GiB）

- `outputs/test-candidate-1.1.18-20260910`
- `outputs/test-candidate-1.1.19-20260910`

每份都只含旧安装程序、旧便携 ZIP 及其清单；当前 1.1.53 发布物不在其中。

## C. 建议删除：明确重复或一次性临时副本（0.90 GiB）

- `Temp/shim-test`：与保留的 `desktop/.build/product-detail-runtime` 均为 1,387 个文件，逐文件“长度 + SHA-256”多重集合摘要完全一致：`0c036e7d7727abc874691e23f5789af0cfc8ef3c4d04325421a94b2f42599ae3`。
- `Temp/pr-shallow-probe`：当天创建的浅克隆探测副本，不是已注册 Git worktree；`git worktree list` 只有当前主工作区。
- `Temp/single-file-test`：仅三个一次性测试文件。

## D. 建议删除：可重建测试缓存（0.10 GiB）

- `desktop/.build/test-runs`
- `desktop/.build/update-process-tests`
- `desktop/.build/update-helper-tests`
- `desktop/.build/component-tests`
- `desktop/.build/nsis-validation-20260915`
- `desktop/.build/installed-smoke-1.1.27-20260914T1524Z`
- `desktop/.build/installed-smoke-1.1.26-20260914T2118`

这些目录都是测试运行结果或旧安装冒烟副本，不参与当前运行。

## E. 可选删除：需要时会重新下载的工具缓存（0.63 GiB）

- `desktop/.build/product-detail-playwright`（0.44 GiB）
- `desktop/.build/electron-download-cache`（0.10 GiB）
- `.tmp/mingit`（0.08 GiB）

删除不会损坏源码或客户数据，但以后运行相应测试、构建或 Git 辅助流程时需要重新下载。因此默认建议保留，除非当前目标是尽可能腾空间。

## 明确保留

- 当前 1.1.53 便携版、测试安装程序和版本清单。
- 当前组件增量目录 `release/components/test`。
- 最新一代便携版回滚目录（1.1.52）和最新安装程序回滚副本。
- 正式版安装程序；它与测试版属于不同发布通道。
- `desktop/.build/runtime-cache`、`product-detail-runtime`、`product-detail-venv`、`remotion-runtime`、`content-engine-runtime`、模型文件和发布输入。
- `desktop/.build/internal-recovery-1.1.30`、`Temp/git-pack-backup-20260918`、`.git` 及其他恢复证据。
- `desktop/.build/brief-acceptance`、根目录 `.build`、其余 `outputs` 和近期 `Temp` 截图/诊断目录；这些含唯一验收或故障证据，不因体积大自动删除。
- 原始素材、客户成果、当前成片、运行数据与加密凭据。

## 预计释放

- 执行 A-D：15,653,205,103 字节（14.58 GiB）。
- A-E 全部执行：16,330,322,000 字节（15.21 GiB）。

执行时逐项解析了绝对路径并复核四组大小，只使用明确路径，没有使用通配符。

## 执行结果

执行时间：2026-09-20（Asia/Shanghai）

- A-D 共 30 个明确路径已永久删除，实际释放 15,653,205,103 字节（14.58 GiB）。
- 普通权限复核 `desktop/.build/test-runs` 时遇到一个旧测试缓存 ACL；首次流程在任何删除发生前停止。提升权限后重新完整核对 A-D，再执行删除。
- 删除后：`release` 约 5.82 GiB、`outputs` 约 2.42 GiB、`Temp` 约 0.91 GiB、`desktop/.build` 约 12.38 GiB。
- 当前源码和测试安装程序仍为 1.1.53；安装程序 SHA-256 仍与版本清单一致：`720ead5a4e209afe5c1d13bff5adc05c7ab0ad5fb9d82d95b4e3d9f8b1978f41`。
- 当前组件发布物、最新一代回滚副本、活动运行时、模型、产品详情虚拟环境、Git/recovery 备份、素材、成片、运行数据和本地凭据均已保留。
- E 组三个可重新下载工具缓存均按推荐方案保留。
- Git 状态没有出现被删生成物；既有源码修改没有被清理流程改动或回退。

连同第一轮已释放的 20.53 GiB，本阶段两轮累计释放 37,696,561,506 字节（约 35.11 GiB）。
