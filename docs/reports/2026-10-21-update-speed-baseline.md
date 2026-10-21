# 更新速度与空间基线（2026-10-21）

源码基线 `b285e77`，已发布 test 源码 `265430d` / 1.1.104；未为测量重打历史包。只读扫描跳过 junction，以 NTFS 文件身份去重，逻辑字节不等于最终可释放空间。

| 范围 | GiB | 解释 |
|---|---:|---|
| desktop/.build | 7.469 | runtime-cache 3.001；release-inputs 0.987；其余含开发环境和验收证据，不可整体删除 |
| release | 7.666 | 含不同历史品牌目录、安装器、组件归档及候选；不是每次新增 |
| 已安装 test 程序 | 1.521 | 正常运行需要 |
| test 用户更新目录 | 9.433 | 已扣除与安装程序共享的文件；其独立统计为10.742 |
| 两个历史安装目录 | 各1.391 | local-pre-cloud-1.1.74、local-rollback-1.1.73，未授权删除 |

更新 components 内部去重：generations 7.996 GiB（8目录），archives 1.213，helper-runtime 0.443（1目录），jobs 0.005（132文件，29个job，26 complete / 3 error）。与安装根跨目录去重后 generations 新增占用6.687 GiB。不能用job文件数量推算助手副本数。

selection保留当前1.1.104与上一代。backup-registry另有1.1.97 confirmed备份和1.1.101 prepared验收备份，两者实际副本都在D盘，但引用的四个旧generation仍在C盘并受保护。其余两个历史generation未出现在当前保留器的owned清单，不能自动接管删除。

历史报告 `desktop/.build/space-usage/1792562940174-40400-internal-release.json`：632秒、净增1.637 GiB。其嵌套release报告：runtime-build-complete前532秒，构建及包验收再92秒；阶段占用11.37→14.08→13.01 GiB，临时staging已回收。两个报告重叠，不相加。此前main CI 39553627546成功；源码作业约9分钟的历史结论须与后续实际run比较。

结论：本机同时承担开发构建与客户端更新，存量副本叠加明显；现有数据不能证明单次更新净增十几GiB。上传到服务器和云端CI本身不等于C盘相同占用。重复哈希主要增加耗时，缓存失效、候选复制和保留引用才直接增加文件占用。

旧客户端实际prepare基线：使用安装根内协议4的component-store、真实签名1.1.104清单和本机已下载归档，在新建隔离目录调用prepare，耗时23,604ms；compose阶段23,094ms，下载0字节。测量文件 `desktop/.build/update-speed-client-baseline.json`，该次临时目录已回收。该数字包含组合、解压与重复检查，不包含助手切换和首启，不能当作完整更新耗时。

历史真实启动日志补证：`%APPDATA%/xiaoxi-active-touch-test/data/logs/diagnostics.jsonl`中2026-10-21T07:10:26.820Z的1.1.104更新首启，component_verification_started→finished为2,004ms，记录full verification；随后四次普通启动命中回执，分别45/62/40/38ms。未为测量重启用户应用。

尚缺：改前助手切换分段计时；改后构建、CI和真实更新结果。未执行任何历史目录删除，未进行付费或微信操作。

## 历史清理候选（未授权，未删除）

下列仅供确认，独立大小不等于联合可释放量；批准后仍需核实进程、引用、硬链接和唯一回滚内容，必要时先保全。安装程序、历史版本和失败证据不能按“缓存”整体删除。

| 具体位置 | 独立GiB | 依赖与唯一内容 |
|---|---:|---|
| `%LOCALAPPDATA%/Programs/AI获客-测试版.local-pre-cloud-1.1.74` | 1.391 | 历史本机程序副本；当前选择不引用，仍属回滚证据 |
| `%LOCALAPPDATA%/Programs/AI获客-测试版.local-rollback-1.1.73` | 1.391 | 历史本机程序副本；须确认不再需要该旧版 |
| `release/AI短视频获客-测试版` | 1.381 | 1.1.58完整底座，须先查所有已验收底座记录及可恢复副本 |
| `release/AI短视频获客-测试版.zip` | 0.689 | 1.1.58旧便携压缩包，须核实其与目录及安装器的恢复覆盖 |
| `release/AI短视频获客-测试版-安装程序.exe` | 0.499 | 旧版独立安装器，相关版本清单必须随同保留/处理 |
| `release/AI获客 V1.0版本-测试版-安装程序.exe` | 0.498 | 旧品牌测试安装器，不能按文件名认定与新版重复 |

两个未登记历史generation（1.1.57：`88133af128f327e6537626b4545fdd79976639525322871be9956f2d32bee54f`；1.1.74：`a319de5ede0424489420e73b724fb96aa9f392ab4c831f53207058fac25fcccf`）位于test用户目录的`data/cloud-maintenance/components/generations`，也是需确认的候选，不能由新版本自动接管。1.1.95/96/100/101则仍被上述备份引用，当前不列为可直接删除项。当前安装、1.1.103/104、最新候选、构建许可输入、手动备份及原素材继续保留。
