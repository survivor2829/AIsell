# 构建重复副本与回收状态修复

基线：main `1955245e0b86c4165bd35f85b7c354af100356f9`。分支：`codex/build-storage-reuse`。原桌面工作区及其它任务改动保留。

## 问题和实现

旧链路为D缓存→C临时staging→D候选，两个跨卷阶段都回退为物理复制；不同工作树还各保留自己的缓存。1.2.12上传约18.27MB，本地构建范围净增约1.657GiB。另有回收入口只重试release父目录，未重试实际持账的components/test子目录；归属请求成功也曾被误当作已完成删除。

- 新的 `release-build-storage.cjs` 为同用户、同共同Git仓库、同发布目标卷选择短路径共享构建目录。验证卷、目录所有权及链接边界，完整构建串行持锁，空间预检和报告使用实际共享位置；不静默回C盘临时目录。
- 新建缓存和命中缓存的不可变runtime payload均优先硬链接；候选继续使用原不可变构建范围，基线规范化用独立文件替换。清单、来源回执、可写应用文件与Electron图标修改保持独立。
- 旧本地缓存只在指纹、manifest和来源/内容验证通过后作为只读输入，向新受管cache建立新目录项；不改变旧缓存归属账，也不扫描其它任务目录。
- 构建前和结束后分别重试本发布根、components/test以及新受管cache/staging的既有账。sidecar及打包临时目录都登记在原保留器，cache校验失败且文件被占用时也保留回收归属；持共享构建锁后先释放崩溃遗留staging引用，回收后再检查空间。旧本地cache只读；仍占用时报告 `cleanup.complete=false` 及pending路径/原因，不杀进程。
- 共享缓存首次初始化、依赖或源码改变仍会新增必要内容；不承诺零占用。历史清理范围见[仅清单](2026-10-24-storage-cleanup-candidates.md)，本轮未清理。

## 验证

先在旧缓存实现上运行新增的“首次缓存不产生第二份物理副本”断言，实际因不同文件身份失败；修复后通过。

现有三项定向检查通过：

- `release-runtime-cache.self_check.cjs`：首次构建、跨staging共享命中、只读旧cache迁入、新来源回执、cache→staging→candidate同一inode、候选独立替换不会改坏cache，以及失败cache保留回收归属。
- `artifact-retention.self_check.cjs`：真实Windows独占文件句柄下仍报告pending，解除句柄后重试完成；历史未登记文件保留。
- `internal-release.self_check.cjs`：默认同卷短路径、共享构建互斥、受管staging回收、components/test子根重试、当前候选与未登记历史保护，及原有发布/底座检查。

相关CJS语法检查、installer-release、product-detail-release-runtime、content-engine-release-runtime、release-capabilities及 `git diff --check` 通过。独立只读审查发现的参数检查顺序、空间门禁顺序、测试真实目录隔离和崩溃staging引用均已逐项修正并补定向验证。本次为构建工具修改，没有重复构建renderer或制造新的GB级发布候选，没有发布、操作微信或付费调用。完整云端CI结果随关联PR记录；未用这些隔离夹具宣称真实新版安装或整套发布已验收。
