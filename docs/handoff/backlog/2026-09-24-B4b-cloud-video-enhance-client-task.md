# B4b 桌面端：增强模块 + 产品效果视频按段云端增强（"AI 增强至 1080p"），失败时回退 Lanczos

分支：`codex/cloud-video-enhance`

## 顺序与依赖

- **开工前须已合并**：
  - B4a：只需要代码合并，开发用 fake，不需要部署；
  - T2：`product-video.self_check.cjs` 已注册进 `check:self`（HEAD 上没有注册，`desktop/scripts/run-self-checks.cjs` 的 `checks` 列表里没有它）；
  - B0：改 `ProductVideoPage.tsx`、`docs/video-quality-480p.md`；
  - T3：`outcome_unknown` 的 verify 出口和启动续跑；
  - B1a：方案信封（含 `plan.enhancement` 字段）；
  - B2：`task.segments[]`（v2）；
  - B3（未出卡）：配音与合成。本卡要插在 B2 的"分段下载"之后、B3 的"合成"之前。
- **后续**：B4c（数字人接入）在本卡合并后开始，复用本卡的 `video-enhance.cjs`。
- **文件重叠**：`product-video-service.cjs`（T3、B1a/B1b、B2、B3）；`product-video-ipc.cjs`、`product-video-preload.cjs`（T3、B2）；`ProductVideoPage.tsx`（T3、B0、B1、B2）；`main.cjs`（B4c，只改构造参数）；`run-self-checks.cjs`（T2、B1a）；`digital-human-provider.cjs`（B5a–B5c 改提示词，本卡只新增探测函数）。与 T1、T4、T5 无重叠。
- 下文行号是 HEAD 258e37a 的现状。开工时请按合并后的代码、按函数名重新定位，并在 result 里列出新旧位置对应关系。

## 背景

- **用户决定**：480p 生成后接火山画质增强（大模型版）；每段单独增强，再由 B3 做接缝合成；增强失败时回退 Lanczos；界面标注"AI 增强至 1080p"。
- **为什么按段增强**：
  - B2 已不以"尾帧接首帧"为主方案，接缝放在景别切换或句间停顿处，由 B3 在增强**之后**剪切、交叉淡化。
  - 整片一起增强，硬切会被送进时序模型；而且要等所有段都生成完才能开始。
  - 例外：B2b（首尾帧局部修补，未出卡）的补片与相邻段是连续画面，分开增强后接缝纹理可能跳变。放进 B6 小样检查。
- **耗时**：实时率约 15–20（见 B4a），15 秒一段约 4–5 分钟，30 秒一段约 7.5–10 分钟。增强必须是能断点续跑的**步进**逻辑，不能在一次调用里阻塞等待。
- **输入地址**：火山要求公网 URL，候选是 APIMart 返回的镜头结果地址。有效期**没有定论**：APIMart 生成接口文档说长期 CDN，模型页写 72 小时，GitHub 写 24 小时。本卡不假设长期有效：提交前用免费的 GET 重新取一次地址并核对。
- **尺寸**：核查报告引官方分辨率表，Seedance 2.5 的 9:16 480p 是 480×854（未实测）。增强到 1080p 后短边 1080，长边约 1921，不一定正好是 1920。

## 现状（HEAD 258e37a，已逐行复核）

以下未注明文件的行号均指 `desktop/src/main/product-video-service.cjs`。

- **注入点**
  - `enhance()` 在 `:163-170`，`:166` 为 `options.enhanceVideo || upscaleTo1080Size`；数字人对应 `digital-human-service.cjs:220-227`（`:223`，由 B4c 处理）。
  - 签名只有 `{source, destination, ffmpegPath}`，是本地文件到本地文件的一次性调用，没有请求日志，也没有远端地址。调研里"只要换掉这一个函数"的说法不成立。
  - 现有自检的 fake 返回 `undefined`（`product-video.self_check.cjs:29`，`digital-human.self_check.cjs:91`）。
- **Lanczos 回退**：`video-upscale.cjs:5-21`，`scale=1080:1920:flags=lanczos,setsar=1`、libx264 CRF18、`yuv420p`，保留音轨。本卡不改它。
- **流程顺序**：480p 任务是先整片合成（`assemble()`，`:142-162`，`:159` 转 `enhancing`），再整片放大（`:205`）。本卡把新任务改成"先按段增强、再合成"。
- **镜头地址**：下载后 `:199` 执行 `shot.providerTaskId = ""`，结果地址也不保存。B2 的 `segments[]` 保留 `providerTaskId`，本卡以 B2 为准。
- **付费请求日志 `operation()`（`:111-130`）**：已有条目带 `rejected` 标记时，`:114` 的条件不成立，会在 `:121-122` **新建条目并重新 POST**。B2 已要求"被拒的段在用户点重做前不进入 `operation()`"。结论：增强请求一旦被拒，绝不能再以同名 operation 调用。
- **网关请求的错误分类**（`digital-human-provider.cjs:128-146`）：
  - POST 遇到网络错误（`:134-135`）、响应不是 JSON（`:138`）、5xx 或 409（`:143`）：标为 `outcomeUnknown`；
  - 404、429 及其他 4xx：明确失败。
  - `remoteUrl`（`:31-39`）和 `isPublicAddress`（`:40-49`）已导出；`safeLookup`（`:50-58`）未导出；`downloadMedia`（`:59-87`）最多跟 3 次跳转，默认上限 160MB。
- **付费确认**：`start` 在 `product-video-ipc.cjs:28`，受信点击在 `:47`，除 `create`/`import-image` 外所有通道只允许 `id`、`clickToken` 两个键（`:48`）。确认按钮只显示视频费用（`ProductVideoPage.tsx:122,135`）。
- **标签**：状态名"本地放大画面"（`:16`）；页面文案 `ProductVideoPage.tsx:106,122,132,136`；文档 `docs/video-quality-480p.md:5`；`video-directors.cjs:91` 在方案里写死 `enhancement: 'lanczos_resize'`（B1a 的信封保留该字段）。
- **ffprobe**：安装包里带 `media-tools/ffprobe.exe`（`desktop/scripts/build-content-engine-sidecar.cjs:312`；内容引擎的推导见 `content-engine-media-tools.cjs:124-125`），但 `main.cjs:682-684` 只给产品片服务传了 `ffmpegPath`。

## 要做

### 1. 新模块 `desktop/src/main/video-enhance.cjs`（B4c 也用）

每段一个可持久化的步进状态机。服务每次调度调用一次，**不在调用内阻塞等待**。

**契约**
- 调用：`enhanceVideo({ source, destination, ffmpegPath, ffprobePath, providerTaskId, operationName, journalEntry, state, operation, request, probeUrl, download, now })`。
  - `state`：这一段的持久化记录，由调用方保存；
  - `operation`：服务现有的带日志的 POST 助手；`request`：免费 GET；`journalEntry`：该 operation 名在任务日志里的现有条目（只读，可为空）；
  - `operationName`：`enhance_<段号>_try_<生成次数>`。段被 B2 重做后生成次数加 1，新文件用新名字，旧条目保留。
- 返回：`{ done: false }`，或 `{ done: true, method: 'volcengine_generative' | 'lanczos_resize', fallbackReason? }`。
- 兼容：注入的旧式函数返回 `undefined` 时视为完成，`method` 记 `lanczos_resize`（不把未知实现标成 AI）。现有 fake 不用改。
- 同一 tick 内多段逐个提交：前一段拿到 `task_id` 后才提交下一段；任一段结果不明或被拒，本 tick 不再提交。

**步骤**

a. **资格检查**：ffprobe 检查源文件——短边 360–1080、长边不超过 1920、不是 HDR（`color_transfer` 不是 smpte2084 或 arib-std-b67）。不满足：回退，原因 `source_ineligible`，POST 0 次。调用前再查一次能力 `volcengine_video_enhance`，为 false：回退，原因 `enhance_unavailable`，POST 0 次。

b. **取地址并核对**
- 用免费的 `GET /apimart/tasks/<providerTaskId>` 取一次新地址，经 `remoteUrl` 校验。
- 用 HEAD（不支持时用 `Range: bytes=0-0`）核对：可以访问，且总字节数等于本地该段文件大小。跳转最多 3 次，每一跳都走 `remoteUrl` 和与 `downloadMedia` 相同的 DNS 公网规则。
- 任一项不通过：回退，原因 `source_url_unavailable`，POST 0 次。

c. **提交**
- `state` 已有 `fallback` 或 `taskId` 时不进入 `operation()`；`journalEntry.rejected` 为真时直接回退（`enhance_rejected`），也不进入 `operation()`。后一条专门堵 `:114` 的重投口子，不依赖调用方是否同步了 `state`。
- 调用 `operation(operationName, '/volcengine/mediakit/enhance-video', { video_url, resolution: '1080p' })`。提交前把 `submittedAt` 写进 `state`；拿到 `task_id`（复用 `taskIdOf`）后立即保存。
- 明确被拒（400、404——包括 B4a 未部署时的路由 404——、429 及其他 4xx）：回退，原因 `enhance_rejected`，`state.fallback` 置位，此后永不再调用这个 operation。
- 结果不明，或 2xx 但没有合法 `task_id`：抛出 `outcomeUnknown`，不自动重新提交。

d. **轮询**
- `GET /volcengine/mediakit/tasks/<id>`，同一段两次轮询至少间隔 20 秒（`state.lastPolledAt` 加注入的 `now`）。
- `completed`：进入下载。`failed`、`error`、`cancelled`、`canceled`、`expired`：回退，原因 `enhance_failed`。
- 其他状态视为处理中；GET 出错（含 B4a 归属校验的 404）视为暂时性问题，下次再查。
- 超过期限 `max(10 分钟, 40 × 段秒数)`：任务转 `needs_attention`，错误码 `video_enhance_timeout`。用户点"继续"只接着轮询原 `task_id`。

e. **下载并核对**
- `result.video_url` 带签名：不写盘、不进 publicTask 和日志，每次从最新查询结果里取，下载到临时文件（maxBytes 160MB）。
- 下载失败：未过 `expires_at` 视为暂时性，下个 tick 重新查询再下；已过期则回退，原因 `enhance_result_expired`。
- ffprobe 核对：短边等于 1080；宽高比与源相差不超过 1%；帧率与源相同；时长差不超过 `ENHANCE_DURATION_TOLERANCE_FRAMES = 1` 帧（常量，B6 实测后校准）。不通过：回退，原因 `enhance_output_invalid`，不重新提交。

f. **统一格式并配回音轨**（火山文档没写输出是否保留音轨）
- 视频取增强结果，音频取源段：`-map 0:v:0 -map 1:a?`，`-movflags +faststart`。
- 增强结果正好是 1080×1920 的 H.264 `yuv420p` 时视频流 `-c:v copy`；否则按 `video-upscale.cjs:10-11` 的同一组参数重编码（`scale=1080:1920:flags=lanczos,setsar=1`、libx264 CRF18、`yuv420p`）。音频一律 `-c:a copy`。
- 这样两条路径交给 B3 的都是 1080×1920 H.264 `yuv420p`，本卡不改 B3 的合成参数。

g. **回退**：调用 `upscaleTo1080Size`，记录 `method: 'lanczos_resize'` 和原因。

**单价常量**：`CNY_PER_MINUTE_ENHANCE_1080P = 5`，注释写明来源（计费页 6448/2486473 经调研核查报告转述），并注明"待 B6 核实"。

### 2. 产品片：付费确认绑定所选增强方式

- `start` 的 payload 增加 `enhancementMode`（`'volcengine_generative'` | `'lanczos_resize'`）。`product-video-ipc.cjs:48` 的键白名单改为按通道区分，只对 `start` 放开这个键；preload `start` 透传。
- 主进程校验：选 `volcengine_generative` 时，网关当前能力 `volcengine_video_enhance` 必须为 true，否则拒绝（提示刷新），任务不开始。不允许静默降级后继续，也不允许静默升级为付费。所选值写入 `task.enhancementMode`。
- **旧任务**：没有 `task.enhancementMode` 的任务一律只走 Lanczos，不产生增强 POST，并保持合并前的状态顺序。`plan.enhancement`（`video-directors.cjs:91` 及 B1a 信封）**不作为依据**。
- **界面**：单选"AI 增强至 1080p"/"本地放大（不收费）"。能力可用时默认 AI 增强，确认按钮同时显示视频费用和"AI 增强约 ¥x（按 5 元/分钟估算，以账单为准）"。能力不可用时只显示本地放大。金额由主进程算好，页面不自行计算。

### 3. 接入产品片服务

- **状态顺序（新任务）**：B2 的所有段都 `downloaded` 后进入 `enhancing`，每个 tick 对每个未完成的段调用一次 `enhanceVideo`；全部完成后才进入 B3 的合成。合成读取每段的增强文件，回退的段用回退文件。B3 若有整片放大步骤，新任务跳过。
- **段状态**：放在 `segments[i].enhance`。operation 名按段和生成次数区分，某一段被拒、失败或结果不明只影响这一段的结果。
- **与 T3 verify 衔接**：对增强条目查询 `/operations/{id}`：
  - 查到 2xx 回执：记录 `task_id`，继续轮询；
  - 回执状态为 400–499（401、404、409 除外，这三个是网关自身对查询的答复）：该段回退（`enhance_rejected`），`state.fallback` 置位，**不转** `needs_attention`；
  - pending、`receipt_not_found` 或查询失败：保持 `outcome_unknown`。
- **新动作"改用本地放大继续"**
  - 新 IPC `use-local-enhance`：走现有发送方校验，**并加受信点击门**（加入 `product-video-ipc.cjs:47` 的列表，preload 用 `createTrustedClickGate`）。这个动作会放弃一个可能已计费的请求，必须由用户亲手点。
  - 只在任务为 `outcome_unknown` 或 `needs_attention`、且 `resumeStatus === 'enhancing'` 时可用。
  - 执行后未完成的段标为 `lanczos_resize`（原因 `user_chose_local`）并调度。原日志条目保留，不删除，不重新提交。
  - 按钮旁提示"如果云端已受理，这次增强仍可能计费"。
- **ffprobe**：`main.cjs` 产品片构造参数（`:677-698`）增加 `ffprobePath`：打包时与 `ffmpegPath`（`:682-684`）同目录的 `ffprobe.exe`，开发环境 `process.env.XIAOXI_FFPROBE_PATH || "ffprobe"`。B3 已传则复用。

### 4. 标签（如实，不夸大）

- publicTask 新增 `outputQuality`：
  - 全部段云端增强："AI 增强至 1080p"
  - 部分段回退："AI 增强至 1080p（n 段本地放大）"
  - 全部段回退，或旧任务："1080p 尺寸·本地放大"
- 状态名 `enhancing` 改为"画质增强"。`ProductVideoPage.tsx:136` 的"继续本地放大画面"改为"继续画质增强"。
- `ProductVideoPage.tsx:106,122,132` 与 `docs/video-quality-480p.md` 的"当前实现"一节同步更新。不得写"媲美原生 1080p""接近原生 1080p"或"原生 1080p"。

### 5. 不泄露地址和响应内容

- 错误文本一律经过 `cleanMessage`。
- publicTask、task.json 和日志里不出现火山结果地址或 `auth_key`，也不出现上游响应正文（`task_id` 除外）。

## 允许改动

- 新增 `desktop/src/main/video-enhance.cjs`、`video-enhance.self_check.cjs`，并在 `desktop/scripts/run-self-checks.cjs` 注册（串行组）
- `desktop/src/main/product-video-service.cjs`、`product-video-ipc.cjs`、`product-video-preload.cjs`、`product-video.self_check.cjs`
- `desktop/src/main/digital-human-provider.cjs`：只允许新增 HEAD/Range 探测函数或导出 `safeLookup`；不改现有函数行为
- `desktop/src/main/main.cjs`：只改产品片服务的构造参数
- `desktop/src/renderer/ProductVideoPage.tsx`（及 css）
- `docs/video-quality-480p.md`

## 禁止

- 不改 `video-upscale.cjs`，不改 B3 的合成参数，不改 `video-directors.cjs`（B1），不改数字人服务（B4c）。
- 不改请求日志规则：已有条目只能通过 `/operations/<id>` 的回执恢复；结果不明或被拒后都不自动重新提交；任何路径都不能对同一段同一生成次数发出第二次增强 POST。
- 不绕过开工前的付费确认，不把旧任务升级为付费增强。
- 不直连火山，不读取也不保存任何火山 Key。结果签名地址不写盘，不进入渲染进程。
- 不发起真实的 APIMart 或火山调用，不部署，不发布。

## 验收（新增断言在当前 HEAD 上必须失败）

`video-enhance.self_check.cjs` 测模块本身；`product-video.self_check.cjs` 通过 `create`/`start`/`refresh`/verify/`use-local-enhance` 等服务入口驱动，不直接调用内部函数。使用 fake 的 provider、ffprobe、ffmpeg、URL 探测和可控时钟。**每个用例都断言增强 POST 次数。**

1. **正常流程**（60 秒，两段）：每段提交 1 次，轮询两次 pending、第三次 completed；下载、核对、配回音轨后才进入合成，合成收到两段增强文件。`outputQuality` 为"AI 增强至 1080p"。`JSON.stringify(get())` 和 task.json 里都不含火山结果地址和 `auth_key`。
2. **尺寸统一**：fake 输出 1080×1922 时走重编码参数，输出 1080×1920 H.264 时走 `-c:v copy`；两种情况的 ffmpeg 参数里都有 `-map 1:a?`。
3. **提交时连接中断**：POST 抛 `outcomeUnknown`，任务转 `outcome_unknown`。重建服务后 verify 拿到回执里的 `task_id`，继续轮询到完成。POST 仍为 1 次。
4. **回执无法确认**：回执 pending 或 `receipt_not_found` 时保持 `outcome_unknown`。没有受信点击时 `use-local-enhance` 被拒；有受信点击时该段走 Lanczos，POST 仍为 1 次，标签为"1080p 尺寸·本地放大"。
5. **网关明确拒绝**：POST 返回 400、404、429 各测一次：该段自动回退，之后多次 `refresh`，POST 仍为 1 次；verify 读到 400 回执时同样回退，不转 `needs_attention`。另预置 task.json：增强条目带 `rejected`、段状态没有 `fallback`，重建服务并 `refresh` 后该段回退，POST 为 0 次。
6. **增强结果不合格**：火山返回 `failed`、输出为 720×1280、时长差 3 帧，三种情况各自回退且原因正确，POST 都是 1 次。
7. **不应发出付费请求**：以下每种情况 POST 0 次、走 Lanczos：HEAD 返回 403；字节数不符；源文件是 HDR；增强时能力变为 false；旧任务没有 `enhancementMode`。
8. **确认环节**：`start` 选 `volcengine_generative` 但能力为 false：被拒，任务仍是 `draft`，视频和增强 POST 都为 0。payload 带其他未知键仍被拒。
9. **部分成功**：两段一段成功、一段 `failed`：只有失败段回退，标签为"AI 增强至 1080p（1 段本地放大）"，合成收到两段文件。
10. **轮询节奏与超期**：距上次轮询不足 20 秒不发 GET；超期后 `needs_attention`（`video_enhance_timeout`）；"继续"后只轮询原 `task_id`，POST 不增加。
11. **段重做**：B2 重做第 2 段后，新文件使用 `enhance_1_try_2`，`enhance_1_try_1` 条目仍在。
12. `node src/main/video-enhance.self_check.cjs`、`node src/main/product-video.self_check.cjs` 在 HEAD 上失败（result 贴失败输出），本分支通过；`npm.cmd run check:self`、`npm.cmd run build:test` 通过。

## 需用户本人验收/授权

- **前置**：B4a 已部署、服务器已配置 MediaKit Key，均需用户授权。
- **B6 付费小样**（逐项批准）：
  - 同一条 480p 段分别做云端增强和 Lanczos，并排对比；
  - 用 ffprobe 记录实际输出的尺寸、帧率、编码、位深、时长差和是否带音轨，据此校准 `ENHANCE_DURATION_TOLERANCE_FRAMES`；
  - 核对账单单价和计费时长；
  - 肉眼检查 logo、小字、地面纹理，以及补片接缝处的纹理。
- **免费核对**：取一条已完成的 APIMart 任务，在 24 小时和 72 小时后分别用 HEAD 检查结果地址是否仍可访问。结果决定是否需要下面的"自有存储中转"。
- **需要拍板（未出卡）**：地址失效时是否建设"自有存储中转"（火山 TOS/VOD 或网关托管）。涉及新凭证、存储费用和客户素材存放位置。本卡的处理是地址失效就回退 Lanczos。
- **发布**：走 `release:internal`，需用户授权。
