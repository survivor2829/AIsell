# 统一 AI 供应商网关

这是桌面端测试频道使用的独立、仅回环监听的供应商网关。公网 443 仍由
`ai-maintenance` 提供 TLS；维护服务只把 `/v1/provider-gateway/` 原样转发到
`127.0.0.1:8444`。

## 协议

- `GET /v1/provider-gateway/health`：不需要授权，只返回服务存活状态。
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

火山引擎支持统一 Key：设置 `XIAOXI_GATEWAY_VOLCENGINE_API_KEY` 后，网关会将
同一把 Key 用于 Ark、TTS 和 ASR；只有确实需要拆分凭据时才使用后缀为
`_ARK_API_KEY`、`_TTS_API_KEY` 或 `_ASR_API_KEY` 的覆盖变量。ASR 的独立 APP ID
和 Access Token 仅在服务器确实采用该鉴权方式时配置，本测试频道不随客户端迁移。

## 初次部署和更新

在服务器上以 root 执行本目录的 `install.sh`。已存在的维护服务用其自身的
`server/maintenance/upgrade.sh` 更新 443 转发代码；网关代码用本目录的
`upgrade.sh` 更新。两个脚本都会保留旧代码并在启动失败时恢复，环境文件不会被
覆盖。

初次安装会生成 root 拥有、`ai-gateway` 组可读的环境文件。供应商 key 只能在
服务器上通过受控运维方式写入该文件，不能放入源码、安装包、日志或聊天消息。
