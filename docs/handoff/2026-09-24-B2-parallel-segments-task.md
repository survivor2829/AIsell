# B2 产品效果视频：改为 ≤30 秒分段、并行生成，显式参考模式并保留尾帧

分支：`codex/product-video-parallel-segments`

## 依赖与顺序

- 开工前以下卡须已合并：T2（product-video 自检已注册）、B0、T3（3a `outcome_unknown` 核对出口，3b 启动续跑）、**B1a（时间轴结构，含 `planVideo` 回退路径）**。B1a 卡尚未出，本卡需要它提供的字段见"要做"第 1 项。
- 与其他卡的文件重叠：
  - `product-video-service.cjs`：T3；B1a/B1（`create()` 接入导演）；后续 B3（`assemble()`）、B4（`enhanceVideo`）；
  - `product-video.self_check.cjs`：T2、T3、B0、B1a；
  - `ProductVideoPage.tsx`：T3、B0、B1；
  - `video-directors.cjs`：B0、B1a 会改，本卡不改。
- 后续卡：
  - B3 负责拼接、接缝、配音、字幕和 AIGC 标识，本卡保留现有 `concat -c copy`；
  - B4 负责逐段画质增强；
  - B2b（首尾帧局部修补）等 B6 第 4 项付费小样有结果后再出卡。
- 与微信线的 T1、T4、T5 没有文件重叠。

## 背景

- 用户已定：
  - 30 秒 1 次调用，45 秒 2 次，60 秒 2 次，两段并行生成；
  - 旁白统一用 TTS（B3 实现），视频模型只出环境声和设备声。
- APIMart seedance-2.5 文档核实结果（2026-09-23 抓取 https://docs.apimart.ai/en/api-reference/videos/seedance-2-5/generation）：
  - `duration`：取值 4–30，或 `-1`（按 30 秒预扣）；**不传时默认 5 秒**。
  - `resolution`：480p/720p/1080p，默认 720p。
  - `size`：默认 `adaptive`。首尾帧、edit、extend 必须用 `adaptive`；reference 模式不限，可用 `9:16`。
  - `omni_reference_task_type`：默认 `auto`。显式传 `reference` 时**提交时同步校验**，违规直接返回 400，不建任务、不扣费。
  - `return_last_frame`：默认 false。为 true 时，结果在 `data.result.videos[].last_frame_url`。
  - `generate_audio`：默认 true，只有开和关两档，**没有"只要环境声"的开关**。"只要环境声"只能写在提示词里（由 B1 编译），是否被遵守由 B3 用 ASR 检查。
  - 失败任务不收费；文档没有给出并发限额。
- 产品视频由 `900ed7c` 引入，异机 1.1.53（`b85997b`）是它的祖先提交，没有带上产品视频。T3 已确认本机没有 `product_video` 任务，所以不需要迁移在途数据。

## 现状（HEAD 258e37a）

以下未注明文件的行号均指 `desktop/src/main/product-video-service.cjs`。

1. **串行生成**：`advance()`（:171-206）每次只处理 `currentShot`。:200-201 要等当前镜下载完，才提交下一镜。
2. **请求体（:178-181）**：
   - 没有 `omni_reference_task_type` 和 `return_last_frame`；
   - :179 `resolution: task.plan.sourceResolution || "1080p"`：缺字段时会静默按 1080p 计费，单价约为 480p 的 4 倍（`video-directors.cjs:26-27`）。
3. **15 秒分段写死**：`video-directors.cjs:45` 是 `count = durationSeconds / 15`，:76 每镜 15 秒，:79 提示词写死"单镜头15秒"，并让模型念旁白。这些由 B1a 改掉，本卡不动。
4. **操作日志（`operation()`，:111-130）**：
   - 以 `shot_${index}` 为键，POST 之前先落盘（:121-122）；
   - :114 的条件是 `prior && !prior.rejected`，所以**已被拒的记录在下一次调用时会新建记录并重新 POST**。串行时由 `pause()` 挡住；改成并行后，如果一段被拒、另一段还在生成，下一轮就会自动重投被拒的那段。本卡必须堵住这个口子。
   - `retryShot`（:236-246）在 :240 直接删除旧的操作记录。
5. **错误分类**（`digital-human-provider.cjs:134-143`）：POST 的连接中断、5xx、409 为结果不明；400、429 等其他 4xx 为明确被拒。
6. **结果读取**：只取视频地址（`digital-human-provider.cjs:94-98` 的 `resultUrl`），不读 `last_frame_url`。
7. **合成与导出**：`assemble()` 从 `task.shots` 取文件（:144、:149）；导出字幕按每 15 秒一块写死（:259-260）。
8. **页面与网关**：
   - `ProductVideoPage.tsx:133` 显示"镜头进度"，:136 的重做按钮只针对"当前失败镜头"，不显示金额。
   - 网关对 `/apimart/videos/generations` 只校验请求方法（`server/provider-gateway/service.py:741-746`），非素材库请求体原样透传，**不需要部署**。
   - 网关回执指纹包含请求体哈希（`service.py:802-803`），所以同一个 operationId 不能换请求体。

## 要做

1. **段契约与校验**
   - 本卡只读 B1a 的以下字段，且只通过一个读取函数（如 `segmentsOf(plan)`）访问：有序段数组，每段含 `seconds`、`startSecond`、`endSecond`、`prompt`、声音策略（`ambient_only` | `silent`）、字幕文案（可为空）；以及 `plan.sourceResolution`。B1a 字段名不同时只改 `segmentsOf`。
   - 在 `create()` 和 `start()` 里校验以下各项，任一项不满足就抛 `product_video_plan_invalid`，**POST 次数为 0**：
     - 段数等于 `Math.ceil(durationSeconds / 30)`（30 秒 1 段，45 秒 2 段，60 秒 2 段）；
     - 每段是 4–30 的整数秒，从 0 开始首尾相接，总和等于 `durationSeconds`；
     - 每段提示词非空；
     - 每段的声音策略只能是 `ambient_only` 或 `silent`；
     - `plan.sourceResolution === "480p"`。确认按钮的金额和重做金额都按 480p 单价算，720p 没有单价常量，1080p 常量待 B6 核价；放开其他档位需另开卡。
   - B1a 的输出不满足上述契约时，停下，在 result 里写异议，不在本卡里改导演文案或分段规则。
2. **任务数据 v2**
   - 新任务 `version: 2`，新增 `task.segments[]`，每段包含：`index`、`seconds`、`startSecond`、`endSecond`、`status`、`attempt`、`operationKey`、`providerTaskId`、`file`、`lastFrameUrl`、`error`、`errorCode`。
   - `status` 取值：`queued`、`submitted`、`downloaded`、`failed`、`outcome_unknown`。
   - `read()`（:46）同时接受 1 和 2。
   - 操作记录键改为 `segment_<index>_try_<attempt>`，`attempt` 从 1 开始。
3. **请求体改为纯函数 `segmentRequestBody(task, segment)`**
   - 键集合**恰好**是：`model:"seedance-2.5"`、`prompt`、`duration`（段秒数）、`resolution`（取自已校验的 plan，不设默认值）、`size:"9:16"`、`output_format:"mp4"`、`omni_reference_task_type:"reference"`、`return_last_frame:true`、`generate_audio`（`ambient_only` 为 true，`silent` 为 false）、`image_urls`（当前只有 `[task.imageUrl]`）。
   - 不传 `seed`、`image_with_roles`、`video_urls`、`audio_urls`，`duration` 不用 `-1`。
4. **并行推进（v2，任务上传完成后状态直接为 `generating`）**
   - 每个 tick 做两件事：
     - (a) 在途段数小于 `MAX_IN_FLIGHT_SEGMENTS = 2`（单任务）时，**逐个**提交 `queued` 段：前一个 POST 拿到 task_id 之后才提交下一个。POST 明确被拒时该段转为 `failed`（`errorCode=product_video_segment_rejected`）；结果不明（含 `taskIdOf` 拿不到编号）时该段转为 `outcome_unknown`。出现这两种情况，本 tick 不再提交；
     - (b) 查询所有 `submitted` 段。完成的段下载后校验 `ftyp`，写入 `file`；云端失败的段标为 `failed`。**不取消、不重做其他段**。
   - 本 tick 结束后按以下优先级决定任务状态：
     1. 任一段 `outcome_unknown`：任务转为 `outcome_unknown`，`resumeStatus=generating`；
     2. 查询或下载出错：任务转为 `needs_attention`，`resumeStatus=generating`，该段保持 `submitted`；
     3. 没有在途段且有 `failed` 段：任务转为 `needs_attention`，`errorCode=product_video_segment_failed`；
     4. 所有段都是 `downloaded`：任务转为 `assembling`。
   - 除上述情况外，任务保持 `generating`。
   - `assemble()` 的 :144、:149 对 v2 改为按 `index` 顺序取 `segments[].file`；:151-152 的 ffmpeg 参数（`concat -c copy`）不变，留给 B3 替换。
5. **只重做失败段**
   - `retryShot`：沿用 IPC 通道 `retry-shot` 和受信点击门（`product-video-ipc.cjs:47`、`product-video-preload.cjs:5`）。
   - 对 v2 任务：
     - 只把 `failed` 段改回 `queued`，`attempt+1`，并换新的 `operationKey`；
     - **保留**旧的操作记录，删除 :240 那种直接删记录的做法；
     - 已 `downloaded`、`submitted`、`outcome_unknown` 的段一律不动；
     - `resumeStatus` 为 `uploading`/`assembling`/`enhancing` 时沿用现有 :243 的恢复路径。
   - 被拒或失败的段，在用户点击重做之前绝不进入 `operation()`。
6. **结果不明按段核对**：T3 新增的 verify 对 `upload_image` 保持原样；对 v2 生成阶段改为逐段查询该段 `operationKey` 的 `/operations/{id}`：
   - 查到结果并拿到 task_id：该段转为 `submitted`；
   - pending 或查询失败：保持 `outcome_unknown`；
   - 明确被拒（判定与 T3 相同）：转为 `failed`。
   - 全部段都不是 `outcome_unknown` 后，任务恢复 `resumeStatus` 并调度。
   - 全程不为结果不明的段重新 POST。重启后，T3 的续跑对已落盘但没有回执的段只查询回执（沿用 `operation()` :114-119）。
7. **尾帧**：完成时读取 `provider.nodeOf(payload).result.videos[0].last_frame_url`，用 `remoteUrl()` 校验后存入 `segment.lastFrameUrl`，供质检和 B2b 使用。
   - 缺失或校验抛错时记为 null，**不算失败**；
   - `publicTask` 只暴露布尔值 `lastFrameReady`，不把远程地址交给 renderer；
   - 本卡不下载尾帧图片。
8. **导出字幕**：v2 的 :259-260 改为按段的 `startSecond`/`endSecond` 输出，文案取第 1 项契约里的段字幕文案。v1 保持原逻辑。精确字幕由 B3 负责。
9. **页面**：
   - `ProductVideoPage.tsx:133` 改为"分段进度 x / n"，并显示各段状态；
   - :136 在 v2 有失败段时显示"重做失败分段（第 N 段）· 约 $X"。金额由 `publicTask` 在主进程算好（失败段秒数之和 × `USD_PER_SECOND_480P`），页面不自行计算；
   - `publicTask` 的 `currentShot`/`completedShots`（:56）对 v2 改为 `segments` 摘要（v1 任务仍按旧字段展示）。
10. **v1 任务只读**：
    - `list`、`get`、`media`、`export` 保持可用（B0 的旧 social 任务用例继续通过）；
    - 未完成的 v1 任务不再推进：`refresh`、T3 的启动续跑都跳过它，不发任何请求；`start`、`retryShot`、verify 对 v1 返回 `product_video_legacy_task`，提示新建任务；`publicTask` 对它给出 `canRetry:false`；原文件保留。

## 允许改动

- `desktop/src/main/product-video-service.cjs`
- `desktop/src/main/product-video.self_check.cjs`
- `desktop/src/renderer/ProductVideoPage.tsx`：只改上面第 9 项涉及的进度、按钮和类型

如果 T3 的 verify 通道需要改返回字段，可以改 `product-video-ipc.cjs` 和 `product-video-preload.cjs`，但不新增没有受信点击门的付费通道。

## 禁止

- 不改 `video-directors.cjs`、导演 skill、提示词文案（B1），不改数字人服务和 `digital-human-provider.cjs`（B5），不改网关。
- 不做接缝、交叉淡化、调色对齐、配音或混音（B3），不做画质增强（B4），不做首尾帧修补和 extend（B2b），不新增参考图种类（如场景定妆帧）。
- 不为结果不明的段自动重新 POST；被拒或失败的段只能由用户点击重做；不因一段失败而丢弃、重做或重新下载其他段。
- 不跳过或弱化开始生成前的用户确认，不新增自动开始；不放开 480p 以外的档位。
- 不发起任何真实 APIMart 调用。

## 验收（新增断言在当前 HEAD 上必须失败）

`product-video.self_check.cjs` 改用假 provider：记录每次请求的路由、方法、请求体和在途数量；任务查询返回 `processing`，直到测试放行。旧断言（:28 两镜、:38、:49-50 和 :52 的两次提交、:55 的 `00:00:15,000`）按新行为改写。每个场景先断言段数和 `duration`，确保在 HEAD 上必然失败。所有场景都通过 `create`/`start`/`refresh`/`retryShot`/verify 等服务入口驱动，不直接调用内部函数。

1. **30 秒**：只 POST 1 次；请求体键集合与第 3 步完全一致，`duration=30`，`omni_reference_task_type="reference"`，`return_last_frame=true`，`resolution="480p"`，`size="9:16"`；最终完成，`assembleVideo` 收到 1 个文件。
2. **60 秒**：POST 2 次，每次 `duration=30`；**两段都已提交时，还没有任何一段完成**；在途数量始终 ≤2。
3. **45 秒**：POST 2 次，每段在 4–30 之间，总和为 45。
4. **尾帧**：`last_frame_url` 写入对应段的 task.json；`get()` 和 `list()` 的返回值里不含该地址；缺少尾帧或地址非法时任务照常完成。
5. **只重做失败段**：
   - 60 秒任务中第 2 段由云端报失败、第 1 段完成：第 1 段下载完之后任务才转为 `needs_attention`，`get()` 给出的重做金额为 30 × 480p 单价；
   - 调用 `retryShot` 后：
     - POST 总数为 3，第 3 次只针对第 2 段，使用 `segment_1_try_2`；
     - `segment_1_try_1` 的记录仍在；
     - 第 1 段文件的哈希不变，也没有被重新下载。
6. **被拒不自动重投**：第 2 段 POST 返回 400（再测一次 429）、第 1 段仍在生成时，连续多个 tick 的 POST 次数不变；第 1 段完成后任务转为 `needs_attention`。
7. **结果不明**：
   - 第 1 段 POST 结果不明时，本 tick 不提交第 2 段，任务转为 `outcome_unknown`；
   - verify 分三种情况：查到回执后继续；pending 时保持；被拒时转为该段 `failed`；
   - 全程 POST 次数不增加；
   - 预置 task.json：第 1 段已提交在生成，第 2 段已落盘操作记录但没有回执。用同一个目录重建服务：对第 2 段只发 `GET /operations/{id}`，第 1 段只发任务查询，POST 次数为 0。
8. **非法方案**：先正常创建一条任务，再改写其 task.json 的 plan，调用 `start`，以下任一情况都返回 `product_video_plan_invalid`，POST 次数为 0：
   - 60 秒却有 3 段；
   - 某段 31 秒；
   - 各段总和不等于时长；
   - 缺少声音策略；
   - `sourceResolution` 缺失或为 `1080p`（不能再默认成 1080p）。
9. **导出字幕**：60 秒任务的 SRT 以 `00:00:30,000` 为分界，不再出现 `00:00:15,000`。
10. **v1 只读**：预置一条 `submitting` 且有 `shot_0` 操作记录（无回执）的 v1 任务，和一条 `completed` 的 v1 任务。重建服务并多次 `refresh` 后，provider 请求数为 0；对前者 `start`/`retryShot` 返回 `product_video_legacy_task`；后者可 `list`、`get`、导出，SRT 仍含 `00:00:15,000`。
11. **命令**：
    - `node src/main/product-video.self_check.cjs` 在 HEAD 上失败（result 里贴出失败输出）、在本分支上通过；
    - `npm.cmd run check:self` 和 `npm.cmd run build:test` 通过。

## 需用户本人验收/授权（Codex 不做）

- **付费小样**（480p，按代码单价估算，以账单为准；按 T3 修订，B6 原定在 B1–B3 完成后做，是否在 B2 合并后先做由用户定）：
  - B6 第 1 项：30 秒单段，约 $2.9。核对 APIMart 接受 `reference` 加 `return_last_frame` 加 `9:16` 的组合，并返回 `last_frame_url`；肉眼验收段内多镜头质量。
  - **计划外的补充项**：45 秒两段并行，约 $4.3（比 60 秒省 $1.4）。核对两段同时提交不会返回 429（如果会，把 `MAX_IN_FLIGHT_SEGMENTS` 改为 1）；两段用 `concat -c copy` 合成后，ffprobe 核对时长、帧率、尺寸和音轨；肉眼验收接缝。需用户单独批准。
- 网关不需要部署（透传已核实）。如果实测被拦截，再单独申请部署授权。
- 发布：B2 合并后模型只出环境声，配音要等 B3；建议与 B3 一起走 `release:internal`，需用户授权。
