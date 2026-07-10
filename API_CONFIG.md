# AI 配置（当前阶段）

当前采用用户自有 DeepSeek API Key：用户只在“账号管理 > DeepSeek API”填写 Key，Electron 主进程用 Windows DPAPI（`safeStorage`）加密保存到当前 Windows 用户目录。renderer、preload 和开发者工具只能取得掩码状态，不能读取已保存的明文。

AI 文案由主进程直连 DeepSeek；缺少 Key、无效 Key、余额不足或超时都会明确暂停任务，绝不静默回退固定模板。

## 延期的服务端方案

腾讯云 SCF、PostgreSQL、服务端网关、许可证和服务端额度系统均延期。本文件是未来服务端方案的唯一保留说明；当前项目不保留任何可运行的网关、SCF 部署或固定 gateway origin 链路。
