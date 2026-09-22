# 创作工作台阶段清理前清单

生成时间：2026-09-20（Asia/Shanghai）  
状态：**已获准执行**。事故素材已完成测试通道复验并生成 102.22 秒成片，用户于 2026-09-20 明确确认“成片确实不错”并授权开始清理。

## 已锁定删除项（前置条件通过后执行）

| 绝对路径 | 现场版本 | 文件数 | 字节数 |
|---|---:|---:|---:|
| `C:\Users\Scott\Desktop\xiaoxi-active-touch\desktop\.build\hotfix-release-worktree-1.1.43` | 1.1.43 | 5,055 | 2,886,040,474 |
| `C:\Users\Scott\Desktop\xiaoxi-active-touch\desktop\.build\hotfix-release-worktree-1.1.44` | 1.1.44 | 4,974 | 2,885,242,964 |
| `C:\Users\Scott\Desktop\xiaoxi-active-touch\desktop\.build\hotfix-release-worktree-1.1.45` | 1.1.45 | 4,974 | 2,885,262,620 |
| `C:\Users\Scott\Desktop\xiaoxi-active-touch\desktop\.build\hotfix-release-worktree-1.1.46` | 1.1.46 | 4,974 | 2,885,215,978 |
| `C:\Users\Scott\Desktop\xiaoxi-active-touch\desktop\.build\tier1-release-worktree-1.1.42` | 1.1.42 | 5,139 | 2,886,780,756 |
| `C:\Users\Scott\Desktop\xiaoxi-active-touch\desktop\.build\release-source-1.1.26` | 1.1.26 | 4,903 | 2,883,855,359 |
| `C:\Users\Scott\Desktop\xiaoxi-active-touch\Temp\pd-testD` | 临时副本 | 1,387 | 788,493,042 |
| `C:\Users\Scott\Desktop\xiaoxi-active-touch\Temp\pd-sting` | 临时副本 | 1,387 | 788,493,042 |
| `C:\Users\Scott\Desktop\xiaoxi-active-touch\Temp\pd-copy-proj` | 临时副本 | 1,387 | 788,493,042 |
| `C:\Users\Scott\Desktop\xiaoxi-active-touch\Temp\hl-test` | 临时副本 | 1,387 | 788,493,042 |
| `C:\Users\Scott\Desktop\xiaoxi-active-touch\Temp\ab-test-named` | 临时副本 | 1,387 | 788,493,042 |
| `C:\Users\Scott\Desktop\xiaoxi-active-touch\Temp\ab-rename` | 临时副本 | 1,387 | 788,493,042 |

预计释放：22,043,356,403 字节（20.53 GiB）。

七份临时副本虽然目录层级不同，但均为 1,387 个文件、788,493,042 字节，忽略相对路径后的“文件长度 + 文件 SHA-256 多重集合”摘要均为：

`4f7f6cea07859c143e9ab6489dd3196589a2aa490166cfd4f60b23e7ba8033b5`

因此保留现场修改时间最新的 `C:\Users\Scott\Desktop\xiaoxi-active-touch\Temp\shim-test`（2026-09-18 12:19:50 +08:00），其余六份才进入删除项。目录树哈希不同来自包装层级不同，不代表存在唯一文件内容。

执行前复核（2026-09-20）：十二个待删目录的版本、文件数和字节数与上表全部一致。七份临时副本重新逐文件计算 SHA-256，并对“文件长度 + 文件 SHA-256”多重集合排序后汇总；七份摘要均为：

`0c036e7d7727abc874691e23f5789af0cfc8ef3c4d04325421a94b2f42599ae3`

本次汇总摘要的序列化方式与初次清单不同，因此摘要值不同；同一轮七份结果完全一致，证明待删六份没有保留副本之外的唯一文件内容。

## 明确保留

- 当前 `desktop/package.json` 版本 1.1.53。
- 当前 1.1.53 测试安装程序及版本清单；清单 SHA-256 为 `720ead5a4e209afe5c1d13bff5adc05c7ab0ad5fb9d82d95b4e3d9f8b1978f41`。
- `desktop\.build\runtime-cache`。
- 用户成果、原始素材、事故复验记录与验收证据。
- `Temp\git-pack-backup-20260918` 和其他 Git/recovery 备份。
- `desktop\.build\product-detail-venv`。
- 当前运行数据和本地历史加密凭据。
- 本清单以外的新发现大文件；只能另列候选，不能自动扩大范围。

## 删除门禁

1. APIMart 未知结果已人工核对，随后用一个新的、明确授权的操作完成一次真实能力验证；不得自动重提本次未知请求。
2. 同一批四个事故视频以最低 30 秒、目标 1 条完成测试通道复验，并检查声画、字幕、时长和镜头不重复。
3. 删除前再次解析以上每个绝对路径，复核版本、文件数、字节数和临时副本摘要。
4. 只删除表中十二条明确路径；不使用通配符，不删除保留项。
5. 删除后复核目录大小、Git 状态、1.1.53 发布物、`runtime-cache` 和必要运行文件。

该批目录永久删除后不可恢复。

## 执行结果

执行时间：2026-09-20（Asia/Shanghai）

- 已永久删除上表十二个明确目录，删除后逐项确认路径均不存在。
- 实际释放：22,043,356,403 字节（20.53 GiB）。
- `desktop\.build` 删除后可读取文件合计约 13,403,025,887 字节；`Temp` 删除后约 1,946,846,903 字节。统计忽略了一个原有的不可读测试缓存目录，没有对其执行任何操作。
- 当前源码版本仍为 1.1.53。
- 1.1.53 测试安装程序仍存在，大小 527,427,472 字节；实际 SHA-256 与版本清单均为 `720ead5a4e209afe5c1d13bff5adc05c7ab0ad5fb9d82d95b4e3d9f8b1978f41`。
- `runtime-cache`、`product-detail-venv`、`Temp\shim-test`、`Temp\git-pack-backup-20260918` 和 `.git` 均已复核保留。
- Git 状态中没有出现十二个被删目录的记录；它们均为忽略的历史生成物。既有源码改动与新增资源保持不变。
