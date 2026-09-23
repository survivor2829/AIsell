# B4a 网关：新增火山 AI MediaKit 画质增强（大模型版）固定路由与独立凭证

分支：`codex/gateway-mediakit-enhance`

**顺序**
- 本卡只改 `server/provider-gateway/`，与 T1–T5、B0–B3、B5a–B5c 的桌面文件不重叠，可以立即开工。
- B4b（产品片接入）、B4c（数字人接入）依赖本卡的路由契约；它们开发时用 fake，不需要本卡已部署。
- B5 拆分后负责"APIMart 出站长期可用"的那张卡（未出卡）也会改 `service.py`。后合并的一方负责 rebase。

## 背景

- 用户已决定画质方案：480p 生成，再用火山画质增强（大模型版）提升到 1080p。
- 网关目前没有这条路由。`service.py:604-627` 的 `_route` 只支持 DeepSeek、百炼、Ark 对话和生图、ASR、TTS、APIMart。
- 火山官方文档（docs.volcengine.com/docs/6448/2407223，2026-09-23 只读核对）的要点：
  - 产品：AI MediaKit（智能处理），主机为 `mediakit.cn-beijing.volces.com`。
  - 提交：`POST /api/v1/tools/enhance-video-generative`，正文 `{"video_url": 公网地址, "resolution": "1080p"}`。
    - `resolution` **默认是 720p**，可选 1080p、2k、4k。
    - 可选参数：`fps`（不填则沿用原帧率）、`bitrate`、`bitrate_level`。
    - 返回：`{success, task_id, request_id}`。
  - 查询：`GET /api/v1/tasks/{task_id}`。完成时返回：
    - `status:"completed"`；
    - `result.video_url`：带 `auth_key` 的签名地址，24 小时有效；
    - `result.duration`、`result.resolution`、`result.fps`、`expires_at`。
    - 文档没有列出其他状态值，也没有给出失败时的响应结构。
  - 鉴权：`Authorization: Bearer <AI MediaKit API Key>`。这个 Key 要在 MediaKit 控制台单独创建，**不是 Ark Key**。
  - 输入约束：短边 360–1080，长边 360–1920，只接受 SDR，必须是公网 URL。
  - **没有幂等键**。防止重复付费提交只能依靠我们网关的 operation 回执。
  - 实时率约 15–20，即 30 秒视频约需 7.5–10 分钟。
- 价格：调研核查报告引用计费页 6448/2486473，1080P（≤30fps）为 5 元/分钟，按毫秒计费。这个页面靠脚本渲染，本次（2026-09-23 复核）仍没能抓到正文，由 B6 在控制台核实。

## 现状（HEAD 258e37a，已逐行复核）

- **凭证与能力**
  - `from_environment` 中的 keys 在 `:269-276`，origins 在 `:281-287`；`__post_init__` 的默认 origins 在 `:301-308`；`capabilities()` 在 `:311-323`。
  - `configured(provider)`（`:325-326`）按 provider 名查 capabilities。因此新 provider 名必须同时是 capabilities 的一个键。
  - Bearer 注入在 `_upstream_headers`（`:642-643`）。
- **operation 回执**
  - `_proxy` 只有在客户端**带了**合法 `X-Xiaoxi-Operation-Id` 时才建立回执（`:792`）。不带时直接转发，断线后无法核对是否已提交。
  - 回执存储：`ReceiptStore.begin/finish`，`:381-419`。上游返回后，回执在 `_proxy` 的 `finally` 里写入（`:876-881`）。
  - 同一 operation id 的回执重放在 `:805-806` 直接返回，不再访问上游。
- **租户隔离**
  - 上游 Key 是所有授权共用的。人物素材库已经按授权主体加前缀做隔离（`:724-739`、`:767-782`）。
  - MediaKit 的 `task_id` 形如 `amk-tool-enhance-video-generative-987654`（文档示例，看起来可以枚举）。如果不做绑定，任何持证客户端都能查询别人的任务，拿到别人成片的签名地址。
- **部署与文档**
  - 部署模板：`install.sh:28-37` 是凭证占位行。
  - README：路由列表在 `README.md:14-22`，凭证分离说明在 `:57-61`。

## 要做

1. **凭证与能力**
   - 新增 env `XIAOXI_GATEWAY_VOLCENGINE_MEDIAKIT_API_KEY`，对应 `keys["volcengine_mediakit"]`。**不**回退使用 `XIAOXI_GATEWAY_VOLCENGINE_API_KEY` 或 Ark Key。
   - 新增 origin `mediakit`：`_official_origin(env.get("XIAOXI_GATEWAY_VOLCENGINE_MEDIAKIT_ORIGIN", ""), "https://mediakit.cn-beijing.volces.com", "mediakit.cn-beijing.volces.com")`。`__post_init__` 的默认值同步加上。
   - capabilities 增加 `volcengine_mediakit` 和 `volcengine_video_enhance` 两项，含义都只是"凭证和路由已装好"。
   - `_upstream_headers` 对 `volcengine_mediakit` 注入服务端 Key，格式为 Bearer。
2. **固定路由（`_route`）**
   - `POST /volcengine/mediakit/enhance-video` → `<mediakit>/api/v1/tools/enhance-video-generative`
   - `GET /volcengine/mediakit/tasks/<id>`（id 须匹配 `[A-Za-z0-9._-]{1,255}`）→ `<mediakit>/api/v1/tasks/<id>`
   - 其他方法返回 405，带任何查询参数返回 400。
3. **提交校验**：全部在调用上游之前完成，任何一项失败都不访问上游。
   - 必须带合法的 `X-Xiaoxi-Operation-Id`，否则返回 400 `operation_id_required`。付费路由不允许没有回执的提交。
   - Content-Type 必须是 `application/json`，正文不超过 8KB。
   - 正文必须是 JSON 对象，键集合**恰好**为 `{video_url, resolution}`。
   - `resolution` 必须等于 `"1080p"`：缺省、`720p`、`2k`、`4k` 都拒绝；`fps`、`bitrate`、回调等字段也拒绝。
   - `video_url` 的要求：
     - 是字符串，长度不超过 2048；
     - 协议为 `https`，有主机名，不含用户名和密码，端口为空或 443；
     - 主机不能是 IP 字面量、`localhost` 或 `.local`。
   - 校验通过后，由网关按规范重新序列化正文再转发。
   - 校验失败统一返回 400 `invalid_enhance_request`，不回显 URL。
4. **任务归属（租户隔离）**
   - 提交请求上游返回 2xx、且 `task_id` 合法（`[A-Za-z0-9._-]{1,255}`）时，在回执库新增一张表（例如 `mediakit_tasks(subject_hash, task_id, created_at)`）记录归属，保留 7 天。
   - **归属必须先于回执落盘**：新增一个 `ReceiptStore` 方法（例如 `finish_with_task`），在同一把锁、同一事务内先写归属、再按 `finish` 的原规则写回执；`finish` 本身不改。否则客户端断线后能从 `/operations/<id>` 拿回 `task_id`，查询时却得到 404，只能等超时。
   - 查询前先核对归属。任务不属于当前主体或不存在时，返回 404 `not_found`，**不访问上游**。
   - 回执重放（`:805-806` 路径）不能重复写入这张表，也不能报错。
   - 上游 2xx 但没有合法 `task_id`：照常保存回执，不写归属（客户端会按结果不明处理）。
5. **文档**
   - README：补充路由、能力项、Key 独立、只接受 1080p、POST 必须带 operation id、任务按主体隔离。
   - `install.sh`：在 `:37` 后加一行占位 `# XIAOXI_GATEWAY_VOLCENGINE_MEDIAKIT_API_KEY=`。已有的 env 文件不会被覆盖；不改 `upgrade.sh`。

## 允许改动

- `server/provider-gateway/service.py`
- 新增 `server/provider-gateway/test_mediakit_routes.py`（沿用 `test_digital_human_routes.py` 的写法：`import test_service`，复用 `test_service.py:18` 的 `FakeResponse` 和 `GatewayTest.session`；重启用例参照 `test_service.py` 的磁盘回执库写法）
- `server/provider-gateway/README.md`
- `server/provider-gateway/install.sh`（只加占位注释行）

## 禁止

- 不改现有路由，不改回执语义：`begin/finish`、429 不留回执、24 小时和 90 天的保留期都保持原样。不改 APIMart 专用出站。
- 不把客户端给的 URL 当作上游地址。`video_url` 只作为正文字段交给火山。
- 不借用 Ark Key 或通用火山 Key。Key 不得进入日志、响应或测试快照。
- 不部署，不在服务器写 env，不发任何真实请求。

## 验收（新增断言在当前 HEAD 上必须失败：目前这些路由返回 404）

在 `server/provider-gateway/` 下依次执行 `python test_service.py`、`python test_digital_human_routes.py`、`python test_mediakit_routes.py`（Windows 可用 `py -3`），全部通过。新测试至少覆盖：

1. **Key 独立**
   - 只配置 `XIAOXI_GATEWAY_VOLCENGINE_API_KEY` 或 Ark Key 时，`volcengine_video_enhance` 为 false；此时 POST 返回 503 `provider_not_configured`，上游调用 0 次。
   - 配置 MediaKit Key 后为 true。
   - `/session`、`/capabilities`、所有 4xx/5xx 响应正文和回执重放中都不含 MediaKit Key 字符串。
2. **合法提交**
   - 上游 URL 恰为 `https://mediakit.cn-beijing.volces.com/api/v1/tools/enhance-video-generative`。
   - `Authorization` 是服务端 Key；客户端自带的 Authorization 不被转发。
   - 转发的正文恰为 `{"video_url":…,"resolution":"1080p"}`。
3. **拒绝**：以下每一项都返回 400 或 405，且上游调用次数不变。
   - 缺 operation id；
   - `resolution` 缺省、为 `720p` 或 `2k`；
   - 多出 `fps` 字段；
   - `video_url` 为 `http://`、带用户名、是 IP 字面量或 `localhost`；
   - 用 GET 访问提交路由，或用 POST 访问查询路由；
   - 带查询参数。
4. **不重复提交**
   - 同一 operation id、同一正文先后 POST 两次（模拟断线后重发）：上游只调用 1 次，第二次拿到同一份回执。
   - `GET /operations/<id>` 返回同一结果。
5. **租户隔离**
   - 主体 A 提交后拿到 `task_id`。
   - 主体 B 查询这个 `task_id`：返回 404，上游调用 0 次。
   - 主体 A 查询：转发到 `https://mediakit.cn-beijing.volces.com/api/v1/tasks/<id>`。
   - id 含非法字符：返回 404。
   - 上游 2xx 但正文没有 `task_id`：回执照常可读，之后用任何 id 查询都是 404，上游调用不增加。
6. **重启后恢复**（磁盘回执库）：主体 A 提交成功后关闭并重建网关；A 用 `GET /operations/<id>` 拿回同一 `task_id`，再查询该任务被转发到上游；B 查询仍为 404；POST 上游调用总数仍为 1。
7. **Origin 校验**：`XIAOXI_GATEWAY_VOLCENGINE_MEDIAKIT_ORIGIN` 指向非官方主机时，回落到官方地址。

## 需用户本人验收/授权

- **开通与 Key**：在火山控制台开通 AI MediaKit 并创建 API Key。按 Ark Key 的同等保密规则处理：只写入服务器的 `/etc/ai-maintenance/provider-gateway.env`，不在聊天里发送。
- **部署**：授权后在服务器执行 `upgrade.sh`。之后做免费只读核对：
  - health 返回的 `runtime_revision` 已变化；
  - `/capabilities` 显示 `volcengine_video_enhance: true`。
- **首次真实调用**：放在 B6 付费小样中，逐项批准。本卡不做。
- **需要拍板**：`video_url` 是否只允许 APIMart 结果 CDN 的主机名（白名单）。本卡只做通用公网校验；白名单能防止持证客户端拿网关增强任意外部视频，但 CDN 主机名要先从真实结果地址里确认，确认后另开小卡。
