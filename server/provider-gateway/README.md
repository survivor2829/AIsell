# 统一 AI 供应商网关

这是桌面端测试频道使用的独立、仅回环监听的供应商网关。公网 443 仍由
`ai-maintenance` 提供 TLS；维护服务只把 `/v1/provider-gateway/` 原样转发到
`127.0.0.1:8444`。

## 协议

- `GET /v1/provider-gateway/health`：不需要授权，返回服务存活状态、运行时版本标识和上游超时契约。
- `POST /v1/provider-gateway/session`：提交当前软件的已签名授权码和安装元数据，
  返回短期会话令牌及能力布尔值。授权码只在内存中校验，不写日志或数据库。
- `GET /v1/provider-gateway/capabilities`：需要会话令牌，只返回能力布尔值。
- 需要会话令牌的固定供应商路由：
  - DeepSeek：`/deepseek/chat/completions`、`/deepseek/v1/chat/completions`
  - 百炼：`/bailian/*`
  - 火山方舟：`/volcengine/ark/chat/completions`、`/volcengine/ark/images/generations`
  - 火山语音识别：`/volcengine/asr/recognize/flash`
  - 火山语音合成：`/volcengine/tts/sse`
  - APIMart：`/apimart/uploads/images`、`/apimart/images/generations`、
    `/apimart/tasks/<task-id>`

网关只接受上述固定路径，绝不把客户端提供的 URL 当作上游地址。客户端的
`Authorization`、`X-Api-Key` 等凭据不会转发；服务端从
`/etc/ai-maintenance/provider-gateway.env` 注入供应商凭据。请求体、授权码和
供应商响应不写入服务日志，响应大小和并发均有上限。

所有上游供应商共用 `XIAOXI_GATEWAY_UPSTREAM_TIMEOUT_SECONDS`，默认 180 秒，
允许配置 30～180 秒；维护转发等待 240 秒，桌面供应商请求等待 270 秒，避免客户端先放弃仍在处理的请求。
health 默认返回运行文件的摘要标识，也可通过 `XIAOXI_GATEWAY_RUNTIME_REVISION` 指定发布标识；
标识和超时元数据用于诊断，不能替代能力声明或导致兼容客户端关闭全部 AI 功能。

相同 operation ID 只在同一认证主体、目标、请求正文及相关请求头都一致时合并当前正在执行的请求。
这不提供跨重启去重，也不证明无回执的请求没有执行；结果未知时仍需核对已有服务记录，禁止自动重提。

火山方舟和火山语音的鉴权凭据不能按名称混用。`XIAOXI_GATEWAY_VOLCENGINE_API_KEY`
仅作为 Ark 的默认 Key；TTS 必须配置 `XIAOXI_GATEWAY_VOLCENGINE_TTS_API_KEY`，不借用 Ark Key。ASR 必须使用
`XIAOXI_GATEWAY_VOLCENGINE_ASR_API_KEY`（新版控制台）或同时配置
`XIAOXI_GATEWAY_VOLCENGINE_ASR_APP_ID` 与 `XIAOXI_GATEWAY_VOLCENGINE_ASR_ACCESS_TOKEN`
（旧版控制台）。ASR 资源 `volc.bigasr.auc_turbo` 也必须在火山语音控制台开通。

## 初次部署和更新

在服务器上以 root 执行本目录的 `install.sh`。已存在的维护服务用其自身的
`server/maintenance/upgrade.sh` 更新 443 转发代码；网关代码用本目录的
`upgrade.sh` 更新。两个脚本都会保留旧代码并在启动失败时恢复，环境文件不会被
覆盖。

初次安装会生成 root 拥有、`ai-gateway` 组可读的环境文件。供应商 key 只能在
服务器上通过受控运维方式写入该文件，不能放入源码、安装包、日志或聊天消息。
