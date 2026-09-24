# B3b 产品效果视频：一次 ffmpeg 合成（剪切、接缝、调色、混音、字幕），并在最终封装时加 AIGC 标识

分支：`codex/product-video-compose-aigc`

## 依赖与顺序

- **开工前须已合并**：B3a（旁白任务的产出、`checking_audio` 状态、`seamsOf(plan)` 和时长常量）。B3a 本身又依赖 T3、B1a、B2。
- **架构决定**：沿用 B3a 卡"架构决定"一节：合成放在 Python 内容引擎里，Node 只负责调度。
- **文件重叠**：
  - `product-video-service.cjs`、`product-video.self_check.cjs`、`ProductVideoPage.tsx`：T3、B0、B1b、B2、B3a、B4b；
  - `main.cjs` 的产品片注册块：B1b、B3a、B4b；
  - 引擎登记处（`creative_domain.py`、`service.py`、`protocol.py`、`content-engine-sidecar.cjs`）：B3a；
  - `docs/video-quality-480p.md`：B0、B4b。
- **后续卡**：
  - B4b 在 `checking_audio` 和 `composing` 之间插入逐段增强，见 B4b 卡"接入两个服务"一节。
  - B-roll 接缝和 J/L cut 属于 B5 数字人，本卡不做。
- **本卡不发起任何付费调用。**

## 背景

- 计划要求：
  - 一次 ffmpeg 完成以下各项，全程只编码一次（libx264）：
    - 剪入出点；
    - 接缝：硬切，或 0.3–0.5 秒交叉淡化；
    - 基于 signalstats 的色彩对齐；
    - 环境声交叉淡化；
    - TTS 主轨的侧链压缩和响度标准化；
    - 按 TTS 时间戳烧录 ASS 字幕；
  - 最终封装时按 GB 45438-2025 加上显式角标和隐式元数据。
- 画质增强（B4）按段做，发生在本合成**之前**。本卡的输入可能是 480p 原片，也可能是 1080p 增强片，两种都要支持。
- **时长规则**（与 B3a 一致）：段长保持方案不变，旁白放进各段，不按旁白裁短成片。原因见 B3a"现状"第 6 项。

## 现状（HEAD 258e37a，已逐行复核；B2/B3a 合并后请重新定位行号，并在 result 里对照）

1. **合成**
   - `product-video-service.cjs:142-162` 的 `assemble()` 用 `concat -c copy`（:151-152）拼接，B2 保留了这一做法，留给本卡替换。
   - 现在没有剪切、接缝处理、调色、混音，也没有烧录字幕。
2. **放大**
   - 拼接不重新编码（`-c copy`）。之后对整片执行 `enhanceVideo || upscaleTo1080Size`（:163-170），`video-upscale.cjs:5-21` 在这一步编码一次（libx264，:11）。
   - 剪切、转场和烧字幕都必须重新编码，`-c copy` 做不到。所以改为一个滤镜图加一次编码，放大也并入这一次。
3. **字幕**：导出的 SRT 按每 15 秒一块写死（:259-260，B2 改为按段）。画面里没有字幕。
4. **AIGC 标识**：全仓库没有任何实现。`git grep -i aigc` 只命中两类：
   - 百炼的接口路径：`creative_analysis.py:777`，以及 `tests/test_provider_security.py`；
   - `product-detail/app/ai_image.py:10` 的 dashscope 导入。
5. **内容引擎里可复用的部件**（未注明文件的行号均指 `desktop/sidecars/content-engine/content_engine/creative_render.py`）
   - **字幕**：
     - `_caption_cues`（:2543）：`reference_narration` 走 `reference_caption_cues`，单行；
     - `_write_ass`（:2739）：传入 `cues=` 时直接使用；reference 预设 64 号字（:2754），位置 `\an5\pos(540,1421)`（:2810）；
     - `_write_srt`（:2894）；
     - `_subtitle_filter`（:2536-2540）：负责路径转义。
     - 以上都是类方法或静态方法。
   - **混音参数**：
     - :373 `sidechaincompress=threshold=0.04:ratio=8:attack=15:release=250`，:374 `amix=...:normalize=0`；
     - :1360 `loudnorm=I=-16:LRA=11:TP=-1.5`，后接 :1361 `alimiter`。
     - 计划写的"`:373` 的侧链压缩和 loudnorm"不准确：:373 只有侧链压缩，loudnorm 在 :1210 和 :1360。
   - **字体**：打包版里，libass 和 drawtext 用到的字体只在内容引擎子进程的环境中配置：
     - `content-engine-media-tools.cjs:111-143` 物化字体，并写入 `FONTCONFIG_FILE`；
     - `content-engine-sidecar.cjs:14-19` 放行这些变量；
     - drawtext 的字体参数由 `_drawtext_font_option`（:2501-2506）生成。它是**实例方法**，要用 FFmpeg renderer 实例调用，取法同 `video_presentation.py:101` 的 `getattr(domain.renderer, "ffmpeg_renderer", domain.renderer)`。
     - 结论：Node 直接 spawn 的 ffmpeg 没有这些变量，这是合成必须放在引擎里的原因之一。
   - **编码器**：
     - 引擎现有渲染固定用 `h264_mf`（:67、:246-265），不是 libx264。libx264 的先例是 `video-upscale.cjs:11`。
     - 打包的 media-tools ffmpeg 是 8.1.1 gyan essentials，编译参数含 `--enable-gpl --enable-libx264 --enable-libass --enable-fontconfig`。
     - 已在本机用 `.build/content-engine-runtime/media-tools/ffmpeg.exe -encoders/-filters` 核实，以下都在：libx264、xfade、acrossfade、signalstats、lutyuv、sidechaincompress、loudnorm、subtitles、drawtext、adelay、apad。
   - **原子输出**：先渲染到临时目录，再整体替换（:289-341）。
6. **B3a 已经提供的数据**（都在旁白任务的私有 payload 里，按任务号读取）：
   - wav；
   - 每条 binding 所属的段、在 wav 里的音频区间和开口时刻；
   - `lead_ms`/`tail_ms`；
   - 相对各段开口时刻的 cue。

## 要做

### 1. 内容引擎：新模块 `content_engine/product_video_compose.py`

- **任务类型** `product_video_compose`：登记方式与 B3a 相同（`CREATIVE_TASK_TYPES`、分派、`_public_task`、`PROVIDER_TASK_TYPES`，保证重启后走 `resume_creative_task`）。
  - payload 写 `required_capabilities: []`，这样工作台"继续"时不检查云端能力（`content-engine-ipc.cjs:124-140`）。
- **协议方法**（两个都只供主进程调用，都不加入 `content-engine-ipc.cjs`）：
  - `create_product_video_compose`；
  - `resolve_product_video_compose_paths`：返回 mp4 和 srt 的绝对路径。按 README"仅主进程可用的方法"一节的规则，这个返回值不得经过 preload。

### 2. 准入

**入参**
- `source_id`、`attempt`。
- `narration_task_id`：必须是同一个 `source_id`、状态为 `completed` 的 `product_video_narration` 任务。wav、音频区间、开口时刻、`lead_ms`/`tail_ms` 和 cue **只**从该任务的私有数据里读取，不接受调用方传入。
- `segments[]`：`{index, seconds, path, mute_ambience}`。
  - `seconds` 是方案里的段秒数，4–30 的整数；
  - `path` 按 `creative_domain.py:413-417` 的规则校验；
  - **准入时复制**到 `data_dir/product-video/<source_id>/compose-<attempt>/inputs/`（参照 :427-429），并记录 sha256。
- `seams[]`：`{after_index, type, xfade_ms}`。
  - `type` 只接受 `hard_cut` 或 `xfade`，其他值直接拒绝（B1a 的类型由 Node 的 `seamsOf` 映射，见 B3a 第 6 项）；
  - `xfade_ms` 在 300–500 之间。
- `trims`：`{head_ms, tail_guard_ms}`，由 Node 传入 B3a 的常量（250、300）。
- `aigc`：`{content_producer, produce_id}`，两者都必须匹配 `[A-Za-z0-9._:-]{1,128}`。

**幂等**：同一个 `(source_id, attempt)` 重复调用时原样返回已有任务，不改其状态。规则同 B3a 第 2 项。

### 3. 执行（全部本地，不调用任何付费接口）

**a. 探测**
- 执行前复核输入文件的 sha，不一致时任务失败，错误码 `product_video_input_changed`。
- ffmpeg `-encoders` 中没有 libx264 时，任务失败，错误码 `media_encoder_unavailable`。
- 对每段运行 ffprobe，记录宽、高、帧率、时长、有无音轨。
- 另记一个布尔值：上游是否带有 AIGC 元数据标签。

**b. 排布与时长核对**（毫秒；段号 i 从 0 开始，最多 2 段）
- 第 i 段取用源片的 `[head_ms, head_ms + L_i]`，其中 `L_i = min(实际时长_i, seconds_i×1000) − head_ms − tail_guard_ms`。
- `x_i` 是第 i 段之后那个接缝的 xfade 时长。硬切和最后一段为 0；`x_{−1} = 0`。
- 成片中第 i 段的起点：`S_0 = 0`，`S_{i+1} = S_i + L_i − x_i`。成片总长 `T = ΣL_i − Σx_i`。
- 第 i 段旁白的开口时刻 `P_i = S_i + x_{i−1} + lead_ms`，也就是转场结束后 `lead_ms`。
- 核对：每条旁白都要满足 `lead_ms + speech_ms + tail_ms ≤ L_i − x_{i−1} − x_i`。
  - B3a 已经按方案秒数核对过一次，这里按实际时长再核对一次。
  - 不满足时任务失败，错误码 `product_video_segment_too_short`，指出是第几段，不自动重做。

**c. 色彩对齐**
- 每个接缝：
  - 对 A 段取用区间的最后 1 秒、B 段取用区间的开头 1 秒，各跑一次 `signalstats`；
  - 这两次都是 `-f null` 分析，不编码；
  - 取 YAVG、UAVG、VAVG 的差值。
- 施加规则：
  - U/V（白平衡）偏移对所有接缝都施加，夹紧到 `±6`；
  - Y（亮度）偏移只对 xfade 接缝施加，夹紧到 `±10`。硬切两侧景别不同，亮度差本来就是内容差异。
- 偏移累计传给后续各段，用 `lutyuv` 施加。
- 测量值和实际施加值都写进结果。
- 夹紧值定义为常量，并注释"需用户肉眼验收，设为 0 即关闭"。

**d. 一个 `filter_complex`，只编码一次**

- **每段画面**
  1. `trim`/`atrim` 到取用区间；
  2. `setpts=PTS-STARTPTS`；
  3. `fps=24`；
  4. 尺寸不是 1080×1920 时，`scale=1080:1920:flags=lanczos`；
  5. `setsar=1,format=yuv420p,settb=AVTB`；
  6. 施加 `lutyuv` 偏移。
- **接缝**
  - 硬切：`concat`。
  - xfade：`xfade=transition=fade:duration=x_i:offset=S_{i+1}`。转场区间 `[S_{i+1}, S_{i+1}+x_i]` 两侧都不放旁白（由 b 的核对保证），所以接缝落在句间停顿里。
- **环境声**
  1. 每段 `atrim` 后 `aresample=48000`，转成立体声；
  2. `mute_ambience` 为真或没有音轨的段，替换为等长的静音；
  3. xfade 接缝用 `acrossfade`，时长与 xfade 相同；硬切接缝用 `concat`，两侧各加不超过 30ms 的淡入淡出，防止爆音；
  4. 衰减 `AMBIENCE_GAIN_DB`（常量，注释"需试听"）。
- **旁白主轨**
  1. 每条旁白从 TTS wav 里 `atrim` 出它的音频区间 `[a_k, b_k]`，`adelay` 到成片时刻 `P_i − (开口时刻_k − a_k)`；
  2. 各条 `amix=normalize=0` 合成一轨，转成 48k 立体声，用 `apad` 补齐到 `T`；
  3. 环境声以旁白为侧链做压缩（`sidechaincompress`，参数同 :373）；
  4. `amix=normalize=0`；
  5. `loudnorm=I=-16:LRA=11:TP=-1.5`（同 :1360）；
  6. `alimiter`。
- **字幕**
  - B3a 的 cue 时间加上 `P_i`，换算成成片时间；
  - 调用 `_write_ass(path, [], recipe, cues=...)`，recipe 为 `{"caption_presentation":"reference_narration"}`；
  - 通过 `_subtitle_filter` 烧录进画面。
- **显式标识**
  - `drawtext` 写"AI生成"，位置在右上角，边距 40px；
  - 字高不小于画面短边的 5%，也就是字号至少 60；
  - 全片显示，带半透明底；
  - 字体用 `_drawtext_font_option`；
  - 不得与字幕区（:2810）重叠。
- **编码**
  - 视频：`-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r 24`；
  - 音频：`-c:a aac -ar 48000 -ac 2`；
  - 封装：`-movflags +faststart+use_metadata_tags`，`-metadata AIGC=<JSON>`，`-t` 设为 `T`。
  - 整个任务只允许这一次视频编码。
- **隐式标识 JSON**
  - `{"Label":"1","ContentProducer":…,"ProduceID":…,"ReservedCode1":"","ContentPropagator":"","PropagateID":"","ReservedCode2":""}`；
  - 字段名按 GB 45438-2025 的元数据隐式标识；
  - 字段取值待用户确认，见文末。

**e. 成片核对（ffprobe）**
- 1080×1920，24fps，h264 编码、yuv420p；
- 音频 aac，48k，双声道；
- 视频流时长等于 `T`，误差不超过 1 帧（42ms）；
- 音视频时长差不超过 50ms；
- format tags 中有 `AIGC`，JSON 可以解析，且 `Label="1"`。
- 任一项不通过：任务失败，错误码 `product_video_compose_invalid`，不保留成片。

**f. 输出**
- 先渲染到临时目录，再原子替换（参照 :289-341）。
- 同一目录下用 `_write_srt` 写出 `captions.srt`，cue 与烧录的完全相同。
- 公开结果只包含：时长、尺寸、每个接缝的类型和偏移、warnings、上游是否带 AIGC 标签。不含任何路径。

**g. 重启**
- 本任务没有付费调用，可以直接重跑。
- 输出目录已存在且核对通过时，直接完成。

### 4. 主进程与产品片服务

**接线**
- `content-engine-sidecar.cjs` 增加 controller 方法。`create` 在准入时要复制大文件，请求超时用 `renderTimeoutMs`（同 :996）。
- `main.cjs:676-698` 注入 `compose: { create, getTask, resolvePaths, resumeTask }`。
- 合成不需要调用 `beforeContentProviderWork`。

**v2 流程改动**
- B3a 的 `checking_audio` 完成后，进入 `composing`（"合成成片"）。它替代两处：
  - B2 保留的 `assembling`（`concat -c copy`）；
  - 整片 `enhancing`（:163-170）。
- v2 任务不再调用 `upscaleTo1080Size`，放大已经并入合成。
- 合成的每段输入统一通过 `composeInputOf(segment)` 取得：有增强后的文件就用增强文件，否则用原文件。B4b 只需要让这个函数返回增强文件。

**传给引擎的参数**
- 每段：`seconds`（取自 `segmentsOf(plan)`）、绝对路径（`contained(root, file)`）、`muteAmbience`；
- `seams`：来自 B3a 的 `seamsOf(plan)`；
- `trims`：B3a 的 `HEAD_TRIM_MS`、`TAIL_GUARD_MS`；
- `narration.engineTaskId`；
- `aigc`：
  - `content_producer` 取常量 `AIGC_CONTENT_PRODUCER`，默认 `com.aihuoke.desktop`（`desktop/product-brand.json:3` 的 `stableAppId`），待确认；
  - `produce_id` 取 `sha256("product_video:"+task.id+":"+attempt)` 的前 32 位。

**完成与导出**
- 调用 `resolvePaths` 拿到路径，把 mp4 和 srt 复制成 `${task.id}/final.mp4` 与 `${task.id}/captions.srt`：先写临时名，再改名。
- 然后设置 `finalFile`，任务转为 `completed`。
- `exportVideo`（:255-264）对 v2 任务改为复制 `captions.srt`；v1 任务保持原逻辑。

**失败处理**
- 引擎任务失败：产品片任务转为 `needs_attention`，保留错误码。
  - 一般情况下，用户点"继续"时以 `attempt+1` 重新创建合成任务。这一步没有付费调用。
  - `product_video_segment_too_short`：`canRetry=false`，提示"该段实际生成时长放不下旁白，请新建任务"。重跑结果不会变。
- 引擎任务 `paused`：调用 `resumeTask`。

**页面**
- 显示新状态的文案；
- 成片完成后显示"已添加 AI 生成标识"；
- v2 任务不再出现"继续本地放大画面"。

### 5. 文档

`docs/video-quality-480p.md` 的"当前实现"一节改为新流程：TTS 旁白 → 分段 → 核对 → 一次合成 → AIGC 标识。增强相关的标签由 B4b 补。

## 允许改动

- `desktop/sidecars/content-engine/content_engine/product_video_compose.py`（新增）
- `creative_domain.py`：只改登记、分派和公开结果
- `service.py`、`protocol.py`：只新增方法
- `tests/test_product_video_compose.py`（新增）
- 内容引擎 `README.md`：只改方法列表
- `desktop/src/main/content-engine-sidecar.cjs`（及其 self_check，如果需要）
- `main.cjs`：只改 :676-698
- `product-video-service.cjs`、`product-video.self_check.cjs`、`ProductVideoPage.tsx`（及对应 css）
- `docs/video-quality-480p.md`

## 禁止

- 不调用任何付费接口；不重跑 TTS/ASR，只读取 B3a 的产出。
- 不改 `creative_render.py` 现有渲染路径和参数，只调用它的现有方法。
- 不改 `video-upscale.cjs`（数字人仍在用）；不改数字人链路和 `import_base_video`。
- 不在 publicTask、日志、renderer 中暴露成片或中间文件的绝对路径；新方法不加入 `content-engine-ipc.cjs`。
- AIGC 的显式标识和隐式标识都不得省略。成片核对不通过时，任务不得标为 `completed`。
- 不按旁白裁短段长，不改 B3a 的放置规则。
- 不做逐段增强（B4b）、B-roll 接缝和 J/L cut（B5）、首尾帧修补（B2b）；不改提示词（B1）。

## 验收（新增断言在当前 HEAD 上必须失败）

### Python：`test_product_video_compose.py`

在 `desktop/sidecars/content-engine` 下运行：`python -m unittest discover -s tests -p test_product_video_compose.py -v`。

- 用 `XIAOXI_FFMPEG_PATH`/`XIAOXI_FFPROBE_PATH` 指定的，或 PATH 上的 ffmpeg/ffprobe 做真实的小渲染，**不允许 skip**。本机缺少工具时在 result 中写明，视为未验收。
- 测试素材：
  - 用 lavfi 生成两段测试片，都是 480×854、24fps、6 秒（`seconds=6`）：A 段纯色偏暗，B 段纯色比 A 亮约 25，都带正弦音；
  - 5 秒的假 TTS wav，里面有两段"讲话"（音调），其余为静音；
  - 伪造一个 `completed` 的旁白任务：2 条 binding，带音频区间、开口时刻、`lead_ms=300`、`tail_ms=500` 和 cue。
- 通过协议方法 `create_product_video_compose` 驱动。

以 400ms xfade 为例：`L = 5450`，`T = 5450×2 − 400 = 10500`，第 2 段开口 `P_1 = 5050 + 400 + 300 = 5750`。

1. **成片规格**
   - 1080×1920、24fps、h264 yuv420p；
   - aac 48k 双声道；
   - 视频时长等于 `T`，误差不超过 42ms；
   - AIGC 标签的 JSON 可以解析，`Label="1"`，`ProduceID` 等于传入值。
2. **只编码一次**：记录引擎执行的全部 ffmpeg 命令。带 `-c:v` 的只有 1 条，且是 libx264；signalstats 的分析命令都是 `-f null`。
3. **调色**
   - xfade 接缝：测得 ΔY≈−25，实际施加 −10；成片中 B 段抽帧的 YAVG 等于输入 B 的 YAVG 减 10，误差 ±2。
   - 硬切接缝：Y 不施加偏移；U/V 有差异时施加，且夹紧到 ±6。
4. **接缝与总长**
   - 400ms xfade：成片时长为 10500，滤镜图中有 `xfade` 和 `acrossfade`；
   - 硬切：成片时长为 10900，滤镜图中没有这两个滤镜。
5. **旁白放置**
   - 两段都设 `mute_ambience`，对成片音频跑 `silencedetect`：第二段"讲话"在 5750±50ms 处开始；
   - `captions.srt` 中第 2 段的第一个 cue 从 `5750 + 该 cue 的相对时间` 开始，误差不超过 1ms。
   - HEAD 上没有这个协议方法，此条必然失败。
6. **静音段**：`mute_ambience` 的段在滤镜图中被替换为静音，其他段不受影响。
7. **角标确实画上了**：背景是均匀灰色；成片右上角裁剪区域的 signalstats YMAX 不低于 200，而同一区域在输入里的 YMAX 约等于背景灰度。
8. **准入与失败**
   - 第 2 段声明 `seconds=6`、实际只有 3 秒：错误码 `product_video_segment_too_short`，不产出成片；
   - 输入在准入后被改：错误码 `product_video_input_changed`；
   - `narration_task_id` 属于其他 `source_id`，或该任务未完成：准入时直接拒绝；
   - `seams` 里出现 `broll_cover`：准入时拒绝。

### Node：`product-video.self_check.cjs`（用假的 compose，经服务入口驱动）

9. **v2 流程**
   - 状态依次是：下载完成 → `checking_audio` → `composing` → `completed`；
   - `assembleVideo`（concat）和 `upscaleTo1080Size` 各调用 0 次；
   - compose 的 create 调用 1 次，入参包含 2 段的 `seconds` 和绝对路径、`muteAmbience`、由 `seamsOf` 映射后的接缝（B1a 的 `scale_cut` 变成 `hard_cut`）、旁白任务号和 `aigc.produce_id`；
   - 导出的 SRT 与引擎 `captions.srt` 字节一致。HEAD 上导出的是 15 秒一块，所以这一条会失败。
10. **合成失败**
    - 一般失败：任务转为 `needs_attention`；点"继续"后以 `attempt+1` 重新创建合成；APIMart、TTS、ASR 的调用次数都不增加。
    - `product_video_segment_too_short`：`canRetry=false`，`retryShot` 被拒。
11. `JSON.stringify(publicTask)` 中不含绝对路径。
12. **整体检查**
    - `npm.cmd run check:self`、`npm.cmd run build:test` 通过；
    - 在 `desktop/sidecars/content-engine` 下运行 `python -m unittest discover -s tests`，与 HEAD 相比没有新增失败。

## 需用户本人验收/授权（Codex 不做）

- **付费小样**（需要授权）：与 B3a 的真实配音、B6 第 1 项小样合并执行。用真实的两段 480p 片子加真实 TTS 旁白走完整流程，由用户看和听，确认以下几项：
  - 硬切和 xfade 两种接缝；
  - 调色有没有反而变差（变差时把夹紧值设为 0）；
  - 环境声的音量和压低效果；
  - 每段旁白是否在该段画面（有转场时为转场结束后）约 0.3 秒开口，字幕和语音是否同步；
  - 旁白较短的段，段尾只有环境声，观感是否可以接受（见 B3a 文末"成片时长跟谁走"）；
  - "AI生成"角标的位置和大小。
- **AIGC 合规口径**（由用户或法务确认）：
  - 显式标识：
    - 文字和位置；
    - 字高：本卡按不小于短边 5%；
    - 显示时长：本卡全片显示。标准对视频的要求是起始画面至少 2 秒。
    - 以上数值凭记忆写入，以标准原文为准。
  - 隐式标识各字段的取值，尤其是 `ContentProducer` 用哪个名称或编码（本卡暂用 `com.aihuoke.desktop`）；
  - 是否要用第三方检测工具（例如 AigcTotal，需要下载）复核。
- **上游标识**：APIMart 原片是否自带 AIGC 元数据，本卡只记一个布尔值，据此判断是否需要填写传播者字段。
- **不在本卡范围**：数字人成片（`import_base_video` 经 Remotion 输出）同样没有 AIGC 标识，应在 B5 或单独的卡里补上。
- **发布**：B3a 和 B3b 都合并、上述小样验收通过之后，才走 `release:internal`，需要授权。
