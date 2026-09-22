# 统一 AI 供应商网关

这是桌面端测试频道使用的独立、仅回环监听的供应商网关。公网 443 仍由
`ai-maintenance` 提供 TLS；维护服务只把 `/v1/provider-gateway/` 原样转发到
`127.0.0.1:8444`。

## 协议

- `GET /v1/provider-gateway/health`：不需要授权，返回服务存活状态、运行时版本标识和上游超时契约。
- `POST /v1/provider-gateway/session`：提交当前软件的已签名授权码和安装元数据，
  返回短期会话令牌及能力布尔值。授权码只在内存中校验，不写日志或数据库；
  为跨重启读取回执，仅保存会话令牌摘要、过期时间和授权主体，不保存令牌原文。
- `GET /v1/provider-gateway/capabilities`：需要会话令牌，只返回能力布尔值。
- 需要会话令牌的固定供应商路由：
  - DeepSeek：`/deepseek/chat/completions`、`/deepseek/v1/chat/completions`
  - 百炼：`/bailian/*`
  - 火山方舟：`/volcengine/ark/chat/completions`、`/volcengine/ark/images/generations`
  - 火山语音识别：`/volcengine/asr/recognize/flash`
  - 火山语音合成：`/volcengine/tts/sse`
  - APIMart：`/apimart/uploads/images`、`/apimart/images/generations`、
    `/apimart/tasks/<task-id>`、`/apimart/videos/generations`、
    `/apimart/seedance2/private-avatar/assets`（人物素材登记与列表，按授权主体隔离）

`apimart_video` 与 `apimart_avatar_assets` 能力表示路由及服务端凭据已配置，不代表上游网络、模型权限、人物审核或真实生成已验收。视频入口只接受 POST；人物素材入口只接受 GET/POST，GET 仅允许当前授权主体下的 `group=dh_<任务 UUID>` 定向查询，POST 拒绝查询参数及不符合约定的登记数据。

网关只接受上述固定路径，绝不把客户端提供的 URL 当作上游地址。客户端的
`Authorization`、`X-Api-Key` 等凭据不会转发；服务端从
`/etc/ai-maintenance/provider-gateway.env` 注入供应商凭据。请求体、授权码和
供应商响应不写入服务日志，响应大小和并发均有上限。带 operation ID 的
POST 响应会短期保存在仅网关服务账号可读的本地回执库中，用于断线恢复；
响应正文最多保留 24 小时，之后只保留防重复提交的标记至第 90 天。

所有上游供应商共用 `XIAOXI_GATEWAY_UPSTREAM_TIMEOUT_SECONDS`，默认 180 秒，
允许配置 30～180 秒；维护转发等待 240 秒，桌面供应商请求等待 270 秒，避免客户端先放弃仍在处理的请求。
health 默认返回运行文件的摘要标识，也可通过 `XIAOXI_GATEWAY_RUNTIME_REVISION` 指定发布标识；
标识和超时元数据用于诊断，不能替代能力声明或导致兼容客户端关闭全部 AI 功能。

### APIMart 专用出站

可在上述受保护的服务端环境文件中配置 `XIAOXI_GATEWAY_APIMART_PROXY_URL`，
让 APIMart 固定路由通过受控 HTTP CONNECT 代理出站。未配置时沿用原出站路径；
配置后不会被系统 `NO_PROXY` 绕过，不影响 DeepSeek、火山或其他供应商。
目标始终是官方 `https://api.apimart.ai`，证书和主机名校验保持开启；专用出站
禁止所有重定向，连接失败也不换路重发，原 operation 回执及未知结果停止规则保留。

当前标准库实现只接受 `http://` 代理地址（可含代理认证，凭据同样只存受保护配置），
APIMart 请求内容仍在 CONNECT 内通过 TLS 加密。`https://` 代理需要额外的代理层 TLS，
当前实现明确拒绝，避免静默降级；无效配置只报 `apimart_proxy_config_invalid`，不回显地址。
不要将工作站临时 SSH 转发或诊断 IP 配置为长期服务依赖。部署此代码不会自动启用代理，
需先确认长期可用的受控出站，再通过免费只读请求验收；不得以付费重试测试网络。

相同 operation ID 只在同一认证主体、目标、请求正文及相关请求头都一致时
共用持久回执；`GET /v1/provider-gateway/operations/<operation-id>` 可在断线后
查询原结果（处理中返回 202）。没有回执或回执状态不明时仍禁止自动重提；
网关升级前发生的请求无法追溯。已确认的 429 限流不保留回执，允许原有的有界重试。

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
