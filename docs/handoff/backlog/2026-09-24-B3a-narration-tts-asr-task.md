# B3a 产品效果视频：统一 TTS 旁白（火山配音 + ASR 定位），并用 ASR 核对分段"无人声"

分支：`codex/product-video-narration-tts`

## 拆分与顺序

计划里的 B3（统一配音与合成）拆成两张卡，按顺序做：
- **B3a（本卡）**：付费的云端音频步骤：TTS 旁白、ASR 回听与定位、分段人声核对，以及它们的操作日志和"结果不明"出口。
- **B3b**（`2026-09-24-B3b-single-pass-compose-aigc-task.md`）：纯本地的一次 ffmpeg 合成和 AIGC 标识，读取本卡的产出。

**依赖**：开工前须已合并 T3（3a/3b）、B1a、B2。
- 本卡只通过下列读取函数使用 B1a/B2 的数据，字段名不同时只改这些函数：
  - B2 的 `segmentsOf(plan)`：段秒数、声音策略（B1a `segments[].audioPolicy`）、字幕文案（B1a `segments[].subtitle`）；
  - 本卡新增的 `seamsOf(plan)`：读 B1a 的 `director.timeline.seams[]{afterSegment, type}`。
- B1a/B2 合并后的实际字段与上面不符时，停下写异议，不在本卡改导演或分段逻辑。
- B1b 卡建议的顺序是 B2 → B1b → B3a → B3b。B1b 没合并也可以开工，后合并的一方 rebase。

**文件重叠**：
- `product-video-service.cjs`、`product-video.self_check.cjs`、`ProductVideoPage.tsx`：T3、B0、B1a（仅自检）、B1b、B2、B3b、B4b；
- `product-video-ipc.cjs`、`product-video-preload.cjs`：T3、B1b、B2（可能）、B4b；
- `main.cjs` 的产品片注册块（:676-698）：B1b、B3b、B4b；
- 内容引擎登记处（`creative_domain.py`、`service.py`、`protocol.py`、`content-engine-sidecar.cjs`）：B3b。

**后续卡**：B3b 紧接本卡；B4b 按其卡片要求排在 B3 之后。

**发布约束**：B3a 和 B3b 都合并之前不发布。B1a 之后模型不再念旁白，只合并 B3a 的成片既没有旁白也没有字幕。

## 背景

- 用户已定：旁白统一用 TTS 配音并加字幕；视频模型只出环境声和设备声（计划 B3；T3 卡的 3d 改为指向本卡）。
- 计划顺序：导演写旁白 → TTS → 用 ASR 时间戳定时 → 视频只生成环境声 → 用 ASR 检查成片里没有人声 → 合成。
- 本卡在用户确认开始之后、任何视频 POST 之前做 TTS 和 ASR。旁白放不进对应段时就停下，只花掉很少的配音费，视频费为 0。

## 现状（HEAD 258e37a，已逐行复核；T3/B1a/B2 合并后按函数名重新定位，并在 result 里对照）

1. **旁白由视频模型念**
   - `desktop/src/main/video-directors.cjs:73-75` 生成每镜旁白，:79 的提示词写着"同一位……旁白说：${narration}"；
   - `product-video-service.cjs:180` 设 `generate_audio:true`。
   - B1a 已改为 `ambient_only` 段的提示词只写环境声、不含任何句子原文（B1a 卡第 4 步）。本卡只加断言守住这一点，不改导演文件。
2. **TTS 只在内容引擎里有**
   - `desktop/sidecars/content-engine/content_engine/volcengine_tts.py:186-344` 只返回 24kHz 单声道 PCM，封装成 WAV 后原子落盘（:313-325），**不带任何时间戳**，所以定时要再付一次 ASR。
   - 模型只能是 seed-tts-1.0/2.0（:42），音色必须来自 persona（:80-91）。
   - 结果不明时抛 `auto_mix_voice_outcome_unknown`（:72-77）。
   - 网关操作号取自 usage context（:206-209、:224），格式受 :48 的 `OPAQUE_HEADER` 约束。
   - 调用入口：`creative_analysis.py:1212-1227` 把火山 persona 交给 `VolcengineTTSProvider`。
3. **ASR 同样只在内容引擎里有**
   - `volcengine_media.py:265-287` 的 `transcribe` 通过 `asr_sentences`（:251-263）返回带逐字时间的句子；
   - 服务状态 20000003（静音）时返回空 utterances（:59-60）；
   - 单个文件不超过 20MB（:269-270）；
   - 结果不明时抛 `volcengine_outcome_unknown`（:169、:188、:210）。
4. **Node 主进程没有 TTS/ASR 客户端**
   - 网关凭证和地址只注入给内容引擎子进程（`main.cjs:572-586`，允许的变量名见 `content-engine-sidecar.cjs:14-45`）。
   - 产品片注册（`main.cjs:676-698`）没有接内容引擎。对比数字人：:668-674 用 `importBaseVideo` 和 `getTask`。
5. **现成的"TTS → 回听 → 对齐"组合不能直接用**
   - `creative_domain.py:4873-5099` 的 `_synthesize_and_verify_auto_mix_phrase` 已经做了：TTS → `cloud.transcribe` → `verify_spoken_phrase`（`auto_mix_v2.py:866`）→ `align_narration`（`narration_alignment.py:81`）。未决记录一律按结果不明处理（:4931-4935）。
   - 但它的日志表 `auto_mix_stage_artifacts_v2.run_id` 外键指向 `auto_mix_runs_v2`（`database.py:522-525`），必须先建创意项目和混剪 run，产品片用不了。
   - 所以本卡复用它的下层函数和"先落盘再调用、未决即结果不明"的写法，不复用这个组合本身。
6. **`sentence_shot_budgets`（`narration_alignment.py:179-209`）不适合本场景（计划假设更正）**
   - 它按"旁白决定画面长度"设计：首条 binding 从 0 开始，每条的预算截止到下一条开口的时刻，末条截止到"音频时长 + `pause_ms`"（:193-194），超出可用时长返回 `None`（:197）。
   - 它**无法**给 Seedance 单次调用内的各个镜头分配时长，因为段内切点由模型决定。
   - 在段这一级用它，会把先付费生成的固定长度段（B2：30 秒 1 段，45/60 秒 2 段）裁到旁白长度，带来两个问题：
     - 每段超出旁白的尾部被剪掉，B1a 为接缝设计的收尾状态（`endState`）和收尾镜头随之丢失；
     - 成片比用户选择并付了费的时长短。例如 60 秒片、旁白 45 秒，成片约 46 秒，第 1 段尾部约 9 秒被剪。
   - 结论：本卡**不用**它定时长，段长保持方案不变。ASR 时间只用于三件事：把每段的旁白放进该段、检查放不放得下、生成字幕。
   - 复用 `aligned_binding_spans`（:161-176）取每条 binding 在配音里的起止，用 `reference_caption_cues`（:255）做字幕分页。
7. **音色**
   - 已批准音色由 `creative_domain.py:4361-4383` 的 `_approved_auto_mix_voice_persona` 选取，但结果里也包括百炼音色。
   - 火山路径会拒绝非火山音色（`volcengine_media.py:245-248`）。
8. **引擎重启与外部操作**
   - 重启时 `service.py:458-481` 把 `analyzing`/`rendering` 中的任务改为 `paused`（`application_restarted`）；恢复入口是 `content-engine-sidecar.cjs:1102-1118`。
   - 新任务会和 `import_base_video` 一样出现在内容工作台的任务列表里。`content-engine-ipc.cjs:2552` 不按类型过滤，:2617-2630 的暂停、取消、继续可以作用于任意任务号。这不会绕过引擎日志，但主进程必须处理 `cancelled`（见第 6 项）。
9. **"人工确认后重试"的先例**：`narrated_batch.py:984-1030`，要求用户明确确认，写审计记录，只作废未决的那条。
10. **产品片现状**
    - 状态集合在 `product-video-service.cjs:13-18`，8 秒一次的调度在 :214-230；
    - `start` 在 :231-235；受信点击在 `product-video-ipc.cjs:47`，payload 键白名单在 :48；
    - 页面 `ACTIVE` 在 `ProductVideoPage.tsx:34`；确认按钮只显示视频费用（:135）。

## 架构决定（B3a 与 B3b 共用）

**音频和合成都放在 Python 内容引擎里，新增专用任务类型。** Node 的 `product-video-service` 继续负责状态机和视频付费日志，通过主进程专用的方法调用引擎。

理由：
- TTS/ASR 客户端、网关凭证、已批准音色、对齐与字幕算法、打包版的字体和 fontconfig（见 B3b）都只存在于引擎里，见上文第 2–7 项。
- 在 Node 里重写，等于把计费、结果不明判定和字体处理三套逻辑再复制一遍。

**不复用 `import_base_video` 渲染链**，原因：
- `creative_domain.py:406` 只接受 `digital_human_*` 编号；
- :413-415 只接受单个 mp4；
- `video_presentation.py:116-118` 要求底片口播与文案的 ASR 结果一致，只有环境声的产品片必然报 `digital_human_script_mismatch`；
- :121-127 固定走 Remotion 课程包装，且不允许回退；
- `creative_render.py:367` 固定 30fps 并补边；
- 它还会在素材库里新建创意项目（`creative_domain.py:431-432`）。

## 要做

### 1. 内容引擎：新模块 `content_engine/product_video_audio.py`

**登记**
- 任务类型 `product_video_narration` 和 `product_video_speech_check`：
  - 加入 `CREATIVE_TASK_TYPES`（`creative_domain.py:88-109`）；
  - 在 `_run_task_with_usage`（:6754）中分派，位置在 :6768 旁；
  - 在 `_public_task`（:11430）中暴露经 `sanitize_public_value` 处理的结果，参照 :11492 的 `import_base_video` 分支；
  - payload 写 `required_capabilities`（旁白 `["volcengine_tts","volcengine_asr"]`，核对 `["volcengine_asr"]`），这样工作台"继续"时会先检查能力（`content-engine-ipc.cjs:2624-2630`）；
  - 同步加入 `content-engine-sidecar.cjs:46-52` 的 `PROVIDER_TASK_TYPES`。
- 协议方法（在 `protocol.py` 的 `METHODS` 中登记，并加 `service.py` 包装，经 `_enqueue_creative_task`（`service.py:501`）入队）：
  - `create_product_video_narration`
  - `create_product_video_speech_check`
  - `get_product_video_narration_voice`（不产生付费调用）
- 这三个方法只供主进程调用，**不加入** `content-engine-ipc.cjs`。

### 2. 旁白任务：准入

**入参**
- `source_id`：格式与 `^pv_[a-f0-9-]{36}$` 一致；
- `attempt`：1–20 的整数；
- `segments`：`[{index, window_ms}]`，`window_ms` 在 1000–30000 之间（含义见第 6 项）；
- `bindings`：`[{segment_index, text}]`；
- `lead_ms`（0–1000）、`tail_ms`（0–2000）。

**校验**
- `segment_index` 严格递增，且都在 `segments` 里；
- 每条文本非空，且不超过 1000 字；总字数不超过 2000 字。

**幂等**
- 同一个 `(source_id, attempt)` 重复调用时，**原样**返回已有任务，不新建，也不改它的状态。
- 不要照抄 `creative_domain.py:420-425`：其中 :424 会把 `failed`/`paused`/`cancelled` 的任务改回 `queued`。
- 同键但入参的规范化哈希不同时，拒绝，错误码 `product_narration_request_conflict`。

**音色**
- 只取已批准、`provider='volcengine'`、模型为 seed-tts-1.0/2.0 的音色。条件在 :4361 的基础上加 provider 过滤，选取顺序与该函数一致（`_preferred_auto_mix_voice_persona`）。
- 选中的 persona id 记入私有 payload，重跑时沿用这一个。
- 找不到时，任务失败，错误码 `product_narration_voice_missing`，TTS 调用 0 次。

### 3. 旁白任务：执行

**日志规则（本卡所有付费步骤通用）**
- 每一步都**先**把 `submitted` 和稳定的 `operation_id` 写进任务的 payload，**再**发起调用。写法参照 `creative_domain.py:8864-8867`；连接是自动提交的（`database.py:915`）。
- `operation_id` 用 `usage_scope` 设定，格式如 `pvn-<source_id>-<attempt>-tts`，须满足 `OPAQUE_HEADER`。
- 成功后把结果写回私有 payload（TTS：sha256、时长；ASR：识别分段）。重跑时，已 `completed` 的步骤直接用保存的结果，不再调用。
- 调用中抛出 `auto_mix_voice_outcome_unknown` 或 `volcengine_outcome_unknown` 时：该步骤记为 `outcome_unknown`；旁白任务以 `product_narration_outcome_unknown` 失败，核对任务以 `product_speech_check_outcome_unknown` 失败。

a. **TTS**
- 所有 binding 的文本按顺序拼成一段，只合成 1 次，保证全片同一音色、同一语气。
- 每条文本末尾不是"。！？"时补"。"，保证条与条之间有停顿、ASR 能分开。
- 输出到 `data_dir/product-video/<source_id>/narration-<attempt>.wav`。

b. **ASR 回听**
- 对上述 wav 调用 `cloud.transcribe`，再做 `verify_spoken_phrase` 和 `align_narration`。
- `verify_spoken_phrase` 必须 `matched`；不匹配时任务失败，错误码 `product_narration_mismatch`，不自动重新合成。
- 对齐的 `source` 必须是 `asr_words` 或 `asr_sentences`（同 `video_presentation.py:117`），否则任务失败，错误码 `product_narration_timing_unaligned`。

c. **放置核对**
- 用 `aligned_binding_spans`（`phrase.sentenceBindings = [{text}]`）取每条 binding 在 wav 里的开口时刻 `start_k` 和结束时刻 `end_k`；返回空时失败，错误码 `product_narration_timing_unaligned`。
- 讲话时长 `speech_ms = end_k − start_k`。要求 `lead_ms + speech_ms + tail_ms ≤` 对应段的 `window_ms`。
  - 不满足时任务失败，错误码 `product_narration_too_long`，并指出是第几段。这是明确失败，不是结果不明。
- 切分：相邻两条之间取停顿的中点作为切分点。每条的音频区间是 `[max(前一切分点, start_k−150), min(后一切分点, end_k+150)]`（wav 时间），存进私有 payload，供 B3b 裁切。
- `lead_ms + speech_ms + tail_ms < 0.5 × window_ms` 时加一条 warning："第 N 段旁白约 x 秒，其余时间只有环境声"。

d. **字幕 cue**
- 对整段调用一次 `reference_caption_cues([{text, alignment}], 0, max_width=26)`。
- 每个 cue 按起点归入所属 binding，时间改为相对该 binding 的 `start_k`。
- 有 cue 跨越两条 binding 时，任务失败，错误码 `product_narration_timing_unaligned`。

e. **公开结果**
- `voice_name`、`duration_ms`、`timing_source`、`warnings`；
- `bindings:[{segment_index, speech_ms, window_ms}]`；
- `cues:[{segment_index, text, start_ms, end_ms}]`，时间相对该段开口时刻。
- 以下只留在引擎的私有 payload 里：wav 路径和 sha256、每条的音频区间和 `start_k`、`lead_ms`/`tail_ms`。B3b 按任务号读取。

f. **中断恢复**
- 再次执行时，如果某步骤是 `submitted` 且没有结果：该步骤记为 `outcome_unknown`，任务失败，错误码 `product_narration_outcome_unknown`，**不再调用**。
- 唯一例外：TTS 是 `submitted`，但目标 wav 已经原子落盘（`volcengine_tts.py:321-325`，先写临时文件再 replace）。这说明响应已完整收到，视为完成，并补记 sha256 和时长。
- ASR 没有这个例外。

### 4. 人声核对任务

**准入**
- 入参：`source_id`、`attempt`、`segments:[{index, segment_attempt, path, audio_policy}]`。
- `path` 由主进程给出，按 `creative_domain.py:413-417` 的规则校验：绝对路径、普通文件、不是符号链接、`.mp4`、不超过 500MB。
- 准入时记下每个文件的 sha256；执行前重新核对，不一致时任务失败，错误码 `product_video_input_changed`，ASR 调用 0 次。
- 幂等规则同第 2 项。

**执行**
- `silent` 段不调用 ASR。
- `ambient_only` 段：
  - 用 ffmpeg 抽出 16k 单声道 wav，写法参照 `video_presentation.py:109-114`，用完即删；
  - 按第 3 项的日志规则，**逐段**先落盘、再 `transcribe`。
- 判定：识别文字去掉标点后达到 `SPEECH_MIN_CHARS = 2` 个字时，记 `speech_detected = true`。
- 没有音轨的段记 `audio_missing = true`，不调用 ASR。

**结果**
- 只包含 `index`、`segment_attempt`、`speech_detected`、`recognized_char_count`、`audio_missing`。
- **不返回识别文本**，也不写进日志。

**中断恢复**：规则同第 3f 项。

### 5. 主进程接线

- `content-engine-sidecar.cjs` 增加以下 controller 方法，写法参照 :996 和 :1023：
  - `createProductVideoNarration`
  - `createProductVideoSpeechCheck`：准入时要给多个大文件算哈希，请求超时用 `renderTimeoutMs`（同 :996）
  - `getProductVideoNarrationVoice`
- `main.cjs:676-698` 给产品片注入 `audio: { voice, createNarration, createSpeechCheck, getTask, resumeTask }`。
- 创建付费任务之前先调用 `beforeContentProviderWork`（:609，参照 :671）：
  - 旁白：`["volcengine_tts","volcengine_asr"]`；
  - 人声核对：`["volcengine_asr"]`。

### 6. `product-video-service`（只处理 v2 任务）

**常量**（B3b 同用）
- `HEAD_TRIM_MS = 250`、`TAIL_GUARD_MS = 300`、`XFADE_MS = 400`；
- `NARRATION_LEAD_MS = 300`、`NARRATION_TAIL_MS = 500`。
- B1a 和 B2 都没有段级 trim 字段，一律用这些常量。

**`seamsOf(plan)`**（B3b 同用）
- 读取 B1a 的 `director.timeline.seams[]`，映射为 `{after_index, type, xfade_ms}`：
  - `scale_cut` → `hard_cut`；
  - `xfade` → `xfade`，`xfade_ms = XFADE_MS`（B1a 没有时长字段）；
  - `broll_cover` → `hard_cut`，并在 `task.warnings` 记"B-roll 接缝尚未实现，按硬切处理"。
- 没有数据时视为硬切。

**新状态 `narrating`（"生成配音"）**
- 位置：上传完成之后、`generating` 之前。B2 原本上传后直接进入 `generating`。
- **取旁白** `narrationBindings(task)`：只经 `segmentsOf(plan)` 读每段的字幕文案。
  - 字幕非空的段各一条 binding `{segment_index, text}`；
  - 空段不配旁白，只有环境声；
  - 全部为空时，`start` 直接拒绝，错误码 `product_narration_missing`，付费调用 0 次。
- **旁白窗口**：`window_ms = seconds×1000 − HEAD_TRIM_MS − TAIL_GUARD_MS − 前接缝的 xfade_ms − 后接缝的 xfade_ms`（硬切为 0）。也就是该段不处在转场中的那部分。
- **推进**：
  - `task.narration.engineTaskId` 为空时，调用 `createNarration`，**拿到返回后立即保存**；
  - 否则按现有调度轮询 `getTask`。
- **按引擎任务结果处理**：
  - `completed`：保存 `task.narration = {attempt, engineTaskId, voiceName, durationMs, bindings, cues, warnings}`，warnings 并入 `task.warnings`，然后转 `generating`。B2 在这之后才会 POST。
  - 失败码以 `_outcome_unknown` 结尾，或引擎任务为 `cancelled`（可能在内容工作台被取消）：任务转 `outcome_unknown`，`resumeStatus=narrating`。
  - 其他失败：任务转 `needs_attention`，保留原错误码。
  - `paused`：任务转 `needs_attention`。

**新状态 `checking_audio`（"核对环境声"）**
- B2 在所有段都下载完之后原本直接进入 `assembling`，改为先进入本状态。
- 只核对 `speechCheck.segmentAttempt !== segment.attempt` 的段。
- 引擎结果的处理规则同 `narrating`（`resumeStatus=checking_audio`）。
- 完成后：
  - 写入 `segments[i].speechCheck`；
  - `speech_detected` 为 true 时，置 `segments[i].muteAmbience = true`，并在 `task.warnings` 加一条："第 N 段模型生成了人声，合成时已静音该段环境声，旁白和画面不受影响"。**不自动重做**（B2 只允许重做失败段）。
- 然后转入 `assembling`（B3b 会改成 `composing`）。

**状态集合**：`RUNNING`（:13）和页面的 `ACTIVE`（`ProductVideoPage.tsx:34`）都加入这两个新状态，保证 T3 的启动续跑能接上。

**"继续"（现有 `retry-shot` 通道）对新状态的处理**
- 引擎任务 `paused`：只调用 `resumeTask`，重复提交由引擎日志挡住。
- 失败码表明没有发生计费：以 `attempt+1` 新建引擎任务。这类码如下，引擎模块须原样透传：
  - `product_narration_voice_missing`、`provider_gateway_unavailable`、`product_video_input_changed`（付费调用 0 次）；
  - `cloud_request_failed`、`volcengine_request_rejected`（明确被拒）。
- `product_narration_too_long`、`product_narration_mismatch`、`product_narration_timing_unaligned`、`product_narration_request_conflict`：
  - `canRetry=false`；
  - 提示"旁白放不进画面或回听不一致，请修改旁白后新建任务"。已开始的任务不能改方案（B1b）。

**结果不明的出口 `retry-audio`**
- 新 IPC 和 preload，带受信点击门，参照 `product-video-ipc.cjs:47` 和 `product-video-preload.cjs:4-5`。`:48` 的白名单只为这个通道放开 `confirmed` 键。
- 仅在 `outcome_unknown` 且 `resumeStatus` 为 `narrating` 或 `checking_audio` 时可用，并且要求 `confirmed === true`。
- 页面提示："上次配音/核对请求结果无法确认，重新发起可能重复计费一次"。
- 执行后：对应的 attempt 加 1，新建引擎任务；旧记录保留；在 `task.audioRetries[]` 中追加审计记录。

**T3/B2 的 verify（"核对请求"）**
- `resumeStatus` 为 `narrating` 或 `checking_audio` 时，不发任何请求，状态不变，返回提示"配音/核对请求无法在线核对，请确认后重新发起"。
- 页面对这两种 `outcome_unknown` 不显示"核对请求"，只显示 `retry-audio` 按钮。

**`capabilities()`**
- 增加 `narrationReady` 和 `narrationVoiceName`，数据来自 `get_product_video_narration_voice` 和网关能力（`volcengine_tts`、`volcengine_asr`）。
- 没有可用音色时，禁用开始按钮，并提示"请先在内容工作台确认一个火山配音声音"。

**确认按钮文案**（`ProductVideoPage.tsx:135`，B1b 会改这个按钮，以合并后的为准）：追加"另含火山配音与语音核对费用（按字数/时长计费，以账单为准）"。

## 允许改动

- `desktop/sidecars/content-engine/content_engine/product_video_audio.py`（新增）
- `creative_domain.py`：只改任务类型登记、分派、`_public_task` 结果字段
- `service.py`、`protocol.py`：只新增方法
- `desktop/sidecars/content-engine/tests/test_product_video_audio.py`（新增），以及测试用的本地假 TTS/ASR 服务
- `desktop/sidecars/content-engine/README.md`：只改方法列表
- `desktop/src/main/content-engine-sidecar.cjs`；`content-engine-sidecar.self_check.cjs`（如果它断言了任务类型清单）
- `desktop/src/main/main.cjs`：只改 :676-698
- `product-video-service.cjs`、`product-video-ipc.cjs`、`product-video-preload.cjs`、`product-video.self_check.cjs`、`ProductVideoPage.tsx`（及对应 css）

## 禁止

- 不改 `volcengine_tts.py`、`volcengine_media.py`、`narration_alignment.py`、`auto_mix_v2.py` 的行为，只调用它们。
- 不改一键混剪、解说批量、数字人、`import_base_video` 的链路；不改 `content-engine-ipc.cjs`。
- 任何 TTS/ASR 都不自动重发。结果不明时，只能经用户确认的 `retry-audio` 以新的 attempt 重来。检测到人声时不自动重做视频段。
- 以下内容不写日志、不进 publicTask：识别文本、`provider_voice_id`、网关 token、wav 路径。用户确认过的旁白文案可以显示。
- 不改 B2 的请求体、并发和视频操作日志。配音失败时，视频 POST 必须为 0。
- 不改段长和 B2 的段契约，不按旁白裁短成片。
- 不改提示词和导演文件（B1）。不做合成、混音、字幕烧录、AIGC 标识（B3b）。
- 不发起真实的火山或 APIMart 调用。

## 验收（新增断言在当前 HEAD 上必须失败）

### Python（全部用假客户端）

在 `desktop/sidecars/content-engine` 下运行：`python -m unittest discover -s tests -p test_product_video_audio.py -v`。

1. **正常流程**：60 秒两段，硬切，两段的 `window_ms` 都是 29450（30000 − 250 − 300）。
   - 任务 `completed`；
   - 每条都满足 `lead + speech + tail ≤ window`；私有音频区间按顺序排列、互不重叠；
   - 每个 cue 都落在所属段的 `[0, speech_ms]` 之内；
   - TTS 调用 1 次，ASR 调用 1 次；
   - 用同一个 `(source_id, attempt)` 再次 create，返回同一任务，调用次数不变；同键换入参时返回 `product_narration_request_conflict`。
2. **旁白超长**：第 2 段 `window_ms=20000`，旁白 26 秒。
   - 任务失败，错误码 `product_narration_too_long`，并指出第 2 段；
   - TTS 1 次、ASR 1 次，没有第二次。
3. **只有一段有旁白**：第 2 段字幕为空，只有 1 条 binding，第 2 段没有 cue。
4. **回听不一致**：ASR 结果少了一个数字。
   - 错误码 `product_narration_mismatch`；
   - TTS 不重试。
5. **中断恢复**
   - payload 里 TTS 是 `submitted` 且没有 wav：错误码 `product_narration_outcome_unknown`，TTS 0 次；
   - payload 里 TTS 是 `submitted` 且 wav 已落盘：继续做 ASR，TTS 0 次；
   - 预置一个 `failed` 的旁白任务，用同键再 create：原样返回，状态仍是 `failed`，调用 0 次。
6. **没有火山音色**：只有已批准的百炼音色时，错误码 `product_narration_voice_missing`，TTS 0 次。
7. **人声核对**
   - 静音段判为 false；识别出"欢迎选购"的段判为 true；
   - `silent` 段 ASR 0 次；
   - 结果 JSON 中不含识别文本；
   - 输入文件在准入后被改动：错误码 `product_video_input_changed`，ASR 0 次。

### 真实入口：worker 协议

- 用子进程启动 `worker.py`，与主进程的调用方式相同。
- 把 `XIAOXI_VOLCENGINE_TTS_API_URL` 和 `XIAOXI_VOLCENGINE_ASR_ENDPOINT` 指向 127.0.0.1 上的假服务：
  - SSE 格式按 `volcengine_tts.py:112-184` 构造；
  - ASR 返回按 `volcengine_media.py:251-263` 构造；
  - 其余变量用与 `main.cjs:572-586` 同名的假值。
- 测试用已批准音色的准备方式：可以通过协议的现有方法走假服务，也可以直接写库。后者须在 result 中说明。

8. `create` 后反复 `get_task`，直到 `completed`；假服务收到的 TTS 请求数为 1。
9. 假服务在 TTS 响应中途挂起时，杀掉 worker，然后重启并调用 `resume_creative_task`：
   - 任务失败，错误码 `product_narration_outcome_unknown`；
   - 假服务收到的 TTS 请求**总数仍为 1**。

### Node（`product-video.self_check.cjs`，用假 audio 和假 provider，经服务入口驱动）

10. **v2 60 秒**：`start` 后先进入 `narrating`；配音完成之前 APIMart POST 为 0，完成后才 POST。`createNarration` 收到的 `window_ms` 按上文公式计算，`xfade` 接缝两侧的段各减 400。
11. **配音结果不明**
    - 任务转为 `outcome_unknown`；引擎任务为 `cancelled` 时同样如此；
    - 连续 10 个 tick 后，`createNarration` 仍只有 1 次，APIMart POST 仍为 0；
    - verify 对该任务不发任何请求，状态不变；
    - `retry-audio` 缺受信点击或缺 `confirmed:true` 时被拒；
    - 确认后第 2 次 `createNarration`，`attempt=2`，旧记录保留。
12. **"继续"的范围**
    - `product_narration_too_long`：任务转为 `needs_attention`，`canRetry=false`，`retryShot` 被拒，APIMart POST 为 0；
    - `product_narration_voice_missing`：`retryShot` 后第 2 次 `createNarration`，`attempt=2`。
13. **人声核对**
    - 所有段下载完后进入 `checking_audio`；
    - 第 2 段检出人声时：`segments[1].muteAmbience=true`，出现 warning，POST 次数不变；之后进入 `assembling`；
    - 预置 task.json：第 1 段的 `speechCheck.segmentAttempt` 等于该段 attempt，第 2 段 `attempt=2` 而 `speechCheck.segmentAttempt=1`。重建服务后，`createSpeechCheck` 只收到第 2 段。
14. `JSON.stringify(publicTask)` 中不含 `.wav`、绝对路径、`http`，也不含识别文本。
15. B1a 方案中每个 `ambient_only` 段的提示词都不含该段旁白原文。HEAD 上这一条会因 `video-directors.cjs:79` 失败；B1a 合并后如果仍然失败，停下写异议，不在本卡改。
16. **整体检查**
    - `npm.cmd run check:self`、`npm.cmd run build:test` 通过；
    - 在 `desktop/sidecars/content-engine` 下运行 `python -m unittest discover -s tests`，与 HEAD 相比没有新增失败；
    - 如果要在桌面上实际走一遍，按内容引擎 README 重建运行时。开发启动会核对运行时与源码是否一致。

## 需用户本人验收/授权（Codex 不做）

- **真实 TTS + ASR 各 1 次**（需要授权，按字数和时长计费）：用一条 60 秒两段的旁白走完 `narrating`。核对以下几项：
  - 音色与内容工作台一致；
  - 回听通过；
  - 各段 `speech_ms` 与 `window_ms` 合理，"旁白较短"提示与实际相符；
  - 页面上的费用提示。
  - 建议与 B3b、B6 第 1 项小样合并执行。
- 在 B6 第 1 项小样中统计"只要环境声"的实际遵守率，也就是人声核对的真实命中率，据此决定 `SPEECH_MIN_CHARS` 是否需要调整。
- **需要拍板：成片时长跟谁走。**
  - 本卡的做法：段长保持用户选择的 30/45/60 秒（每段只去掉约 0.55 秒的首尾余量），旁白放在各段开头，旁白短时段尾只有环境声。
  - 另一种做法（调研报告曾建议"约 N 秒 ±2 秒"）：按旁白长度裁短各段。好处是没有空白，代价见"现状"第 6 项：已付费的画面被剪、接缝处的收尾状态丢失。
  - 如果改选后者，需要改本卡和 B3b 的放置规则，并与 B1a/B2 的段设计一起调整。
- **发布**：B3a 与 B3b 都合并、小样验收通过之后，才走 `release:internal`，需要授权。
