---
name: smoke
description: Run focused offline checks for the embedded product-detail desktop sidecar and IPC contract.
---

# 产品详情图桌面离线检查

从仓库根的 `desktop/` 运行与改动相关的检查：

| 改动 | 命令 |
|---|---|
| sidecar 启停与协议 | `node src/main/product-detail-sidecar.self_check.cjs` |
| IPC 与付费任务状态 | `node src/main/product-detail-ipc.self_check.cjs` |
| 密钥注入 | `node src/main/product-detail-ai-settings.self_check.cjs` |
| 下载 | `node src/main/product-detail-download.self_check.cjs` |

Python 内部行为改动使用 [桌面运行说明](../../../../README.desktop.md) 中的虚拟环境，选择相关现有 pytest。不要启动原项目固定端口服务器或终止整机所有 Python 进程。

这些检查不调用真实付费 AI。检查通过只能说明离线契约通过；页面与导出须在实际桌面宿主检查。
