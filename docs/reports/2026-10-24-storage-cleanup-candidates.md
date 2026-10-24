# 历史空间清理候选（仅清单，未执行删除）

用户要求先修未来构建重复副本，历史文件只列清单，原素材和业务数据不动。以下为本轮只读实测；单位GiB，按文件身份去重的文件长度，不等于保证可释放空间。父子范围和跨目录硬链接有重叠，不相加承诺释放量。

## 可先核对的旧构建与验收程序

| 绝对路径 | GiB | 当前依据与处理前提 |
|---|---:|---|
| `D:/OpenAI/CodexHome/worktrees/9c3f/xiaoxi-active-touch/release/components/test/candidate-30252-1792722829478-21aw53d5o` | 0.410 | 已归属旧候选，EPERM后部分残留；当前两代不引用。先核对占用和基线引用，未删除。 |
| `D:/OpenAI/CodexHome/worktrees/9c3f/xiaoxi-active-touch/release/components/test/candidate-31908-1792723338081-27sjite08` | 0.410 | 同上，未删除；不因有旧账而在本次测试中重试真实目录。 |
| `C:/Users/Scott/Desktop/xiaoxi-active-touch/release/.backup-target-58956-1792576726058-bn56q9u9g` | 1.520 | 旧构建事务程序备份；须核实无回退/恢复引用和独有内容。 |
| `C:/Users/Scott/Desktop/xiaoxi-active-touch/release/AI短视频获客 V1.0版本-测试版-安装程序.exe.backup-38700-1792577406988` | 0.611 | 旧安装器事务备份；保留可用完整桥接安装器及其匹配清单后再评估。 |
| `D:/OpenAI/Acceptance/wechat-image-20261023/full-runtime` | 0.852 | 微信验收复制的运行文件；先核实没有开发引用或运行进程，保留诊断记录/截图。 |
| `D:/OpenAI/Acceptance/wechat-image-20261023/before-upgrade` | 1.185 | 微信升级前证据，可能含唯一数据；须先拆分程序与原数据，只评估可重建程序，不能整目录直接删。 |

当前D盘工作树跨树去重约19.783GiB；其中9c3f单独约10.200GiB、wechat-diagnostics-release单独5.311GiB、video-127-release单独2.518GiB。这些工作树的源码/未提交改动/候选/缓存用途不同，需分别收尾，不能按整个工作树大小直接清理。

## 完整验收备份：先核对恢复依赖与独有数据

| 绝对路径 | GiB | 状态与边界 |
|---|---:|---|
| `D:/OpenAI/LocalInstallBackups/test/5cb3b905-7c35-46e7-b7a6-858c99ae224d` | 16.131 | 1.1.104验收备份，registry confirmed，目标1.1.105；含完整userData，仍保护C盘旧组件。不能视为普通缓存。 |
| `D:/OpenAI/local-install-backups/product-detail-20261021/b52bb6d9-39ab-4f78-b44d-9845abbe10ef` | 16.063 | 1.1.101验收备份，registry仍为prepared；含业务数据，先核实未确认原因及独有资料，不能自动轮换或整份直接删。 |

后续若获准退役，应沿现有备份注册/独有数据保全流程处理引用；不能手动删目录后遗留C盘generation引用。本轮不更改注册表、资料或备份。

## 历史保全区：只列范围，不认定整目录可删

| 绝对路径 | 当前去重GiB | 仍需核对 |
|---|---:|---|
| `D:/OpenAI/StorageArchives/2026-10-10-project-history` | 32.782 | 唯一历史文件、源码、材料与恢复依据 |
| `D:/OpenAI/WorktreeBackups/closeout-20261020` | 23.361 | 多快照间共享硬链接、恢复bundle与引用 |
| `D:/OpenAI/CodexBackups/xiaoxi-video-20261009-1.1.64` | 23.228 | 完整旧业务资料及程序，不按普通构建缓存处理 |
| `D:/OpenAI/WorktreeCloseout/20261021-xiaoxi` | 19.028 | 工作树收尾时保全的唯一文件与原始记录 |

以上使用前一轮全局去重盘点；不同范围仍可能共享文件，不加总为可释放量。迁出工作树只改变位置，未获准删除的保全仍然占盘。

## 当前明确保护

- `C:/Users/Scott/Desktop/xiaoxi-active-touch/release/AI短视频获客 V1.0版本-测试版`：多工作树的accepted-base记录仍指向这里，底座1.1.105。
- 正在使用的安装程序、当前/上一代组件、仍被上述备份引用的generation，以及有效发布候选和底座。
- 用户目录下原素材、生成成片、详情图、费用凭据、授权、业务数据库；`content-engine/generated`约11.054GiB属于业务成片。
- Codex聊天记录、数据库与恢复副本；它们不属于本项目普通更新缓存。

本轮测试只回收本轮创建的隔离夹具，没有执行清单里任何历史目录的回收。
