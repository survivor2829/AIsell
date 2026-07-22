# DeepSeek 配置

当前应用由 Electron 主进程直连 DeepSeek。本文说明密钥、能力预检和失败回退；功能是否通过实机验收仍以 `PROJECT_STATUS.md` 为准。

## 密钥保存

- 用户只在应用侧栏的“API密钥”页面填写自己的 Key。
- 主进程使用 Electron `safeStorage`（Windows DPAPI）加密后写入运行根目录的 `deepseek-api-key.bin`。
- renderer、preload、开发者工具和普通状态接口只能看到是否已配置及掩码，不能读取明文。
- 加密内容绑定当前 Windows 用户；换电脑或换用户后必须重新填写，不能复制旧文件代替配置。
- Key、密钥文件、完整请求日志和含密钥的 `.env` 都不得进入 Git、源码包、便携目录或 ZIP。

测试版密钥位置：

```text
%APPDATA%\xiaoxi-active-touch-test\data\deepseek-api-key.bin
```

交付版密钥位置：

```text
%APPDATA%\xiaoxi-active-touch-delivery\data\deepseek-api-key.bin
```

## 生产能力预检

“测试连接”不是简单 ping。一次成功必须使用待保存或已保存的 Key 完成两条不发送微信的真实生成链路：

1. 主动触达：生成普通客户文案，并通过非空、清洗和长度校验。
2. 自动回复：生成严格 JSON 回复，校验 `reply`、`intent`、`intentReason`、`needsHuman`、`handoffReason` 的结构和回复长度。

只有两条链路都成功，界面才可显示连接正常。HTTP 可达、Key 已保存或模型返回任意文本，都不能单独视为能力可用。该预检也不等于微信窗口和真实发送已经验收。

## 固定话术 fallback

主动触达任务中的话术由用户在启动前确认并随任务冻结。DeepSeek 生成失败时：

- 仅当前联系人进入 fallback，不因一次 AI 失败暂停整批任务。
- 使用冻结的固定话术，替换可确认的 `{称呼}`；称呼不可靠时使用通用开场，不编造姓名。
- fallback 文案仍执行与 AI 文案相同的清洗、长度和发送前会话核验，并以 `ai_status: fallback` 记录原因。
- 固定话术为空或校验不通过时跳过当前联系人，不生成临时营销内容，也不冒险发送。

自动回复的 AI 临时错误使用保守确认话术并触发人工跟进；Key 缺失、无法解密、失效、余额不足或持久配置错误，在处理当前来信后明确暂停等待修复。自动回复的兜底记录不能被主动触达任务当作其发送结果。

## 当前服务边界

当前没有服务端网关、腾讯云 SCF、PostgreSQL、许可证、远程停用或服务端额度系统。任何未来网关方案都必须另行设计迁移和回滚，不能在当前客户端中硬编码 gateway origin，也不能改变“密钥不进包”的发布红线。
