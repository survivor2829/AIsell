# B5c 数字人 60 秒：两段并行生成，接缝用产品 B-roll 做 J/L cut

分支：`codex/digital-human-60s-segments`

## 顺序与依赖

- **B5b 合并后开始**。B5b 之前的 B1a、B1b、B1c、B5a、T2 也都已合并。
- **与 B4c（数字人云端增强）的顺序不限**，B4c 卡已写明这一点：
  - B4c 已合并：逐段调用 B4c 的增强入口，operation 名沿用 B4c 的 `enhance_<段号>_try_1`；
  - B4c 未合并：逐段调用现有注入点 `options.enhanceVideo || upscaleTo1080Size`（`digital-human-service.cjs:223`）。
  - 后合并的一方 rebase，并在 result 里说明。
- **文件重叠**：
  - `digital-human-service.cjs`、`digital-human-provider.cjs`、`DigitalHumanPage.tsx`、`digital-human-types.ts`：B1c、B5b、B4c；
  - `main.cjs` 数字人构造块：B1c 加 `visionImage`，B4c 加 `ffprobePath`；
  - 导演模块：B1a 的编译器和 `planDigitalHumanTemplate`，B1c 的 `planDigitalHuman`。
- **不改 B2、B3 的文件**。B2/B3 已有 ffmpeg 执行或探测工具时可以直接调用，但不修改它们。
- **行号**：按 HEAD `258e37a`，前序卡合并后按函数名定位。

## 现状（代码已复核）

**只有一次视频调用**
- operation 名固定为 `'video'`（`desktop/src/main/digital-human-service.cjs:204`）。
- 只有一个 `videoTaskId`（:205）和一个 `base.mp4`（:210-216）。
- `POLLING_STATES`（:11）里没有接缝这一步。

**防重复提交**
- `operation()`（:92-114）按名字记录 journal。已有待确认的条目时，只查 `/operations/{id}` 回执，不会重新 POST。
- `resume()` 在有任一被拒条目时拒绝继续（:337）。
- 本卡两段各用一个独立名字，复用这套机制。

**导演（B1a/B1c）**
- 守卫规则：
  - R1：段数 = ceil(durationSeconds/30)，每段 4–30 秒，首尾相接，总和 = durationSeconds；
  - R2：数字人每段 ≤3 镜，每镜 ≥4 秒；
  - R3：接缝的 `afterSentence` 必须是前一段的最后一句；
  - R4：每段可读字数 ≤ floor(4.5 × 段秒数)。
- schema 的 `seams[].type` 有 `broll_cover`。
- B1c：句子由代码按用户原文拆出；规划骨架只有 1 段；`videoPayload` 取 `segments[0].prompt`。
- `planDigitalHumanTemplate` 也只出 1 段。

**包装端**
- 接受 1–180 秒的视频（`video_presentation.py:104-105`）。
- 用 ASR 核对整段确认文案，不一致时报 `digital_human_script_mismatch`（:116-118）。接缝后的成片会整体经过这一步核对，漏字会被拦下。

**ffmpeg / ffprobe**
- 数字人服务只收到 `ffmpegPath`（`main.cjs:651-653`），没有 `ffprobePath`。
- 打包时 ffmpeg.exe 和 ffprobe.exe 必须同时存在（`scripts/build-content-engine-sidecar.cjs:312`）。

**CI**
- `.github/workflows/ci.yml` 在 windows-latest 上跑 `npm run check:self`，但没有安装 ffmpeg 的步骤。所以真实 ffmpeg 的测试不能注册进 `check:self`。

**不用尾帧串联**
- 首帧和全模态参考两种模式互斥，用了首帧就不能再带参考图。
- 含真人脸的帧还必须先入素材库。
- 这两点调研已核实。

## 要做

### 1. 60 秒入口与切段

- 时长选项加入 60 秒，`create()` 接受 60。计数口径沿用 B5b。
- **60 秒的字数范围**：可读字数须 >135（否则提示"不超过 135 字，请选 30 秒"），且 ≤260。
  - 上限是 260 而不是 270：每段要给接缝留约 1 秒停顿，所以单段最多 floor(4.5 × 29) = 130 字。
  - 这一点与计划"60 秒 × 4.5 = 270 字"不同，在 result 里说明。
- **切段**：纯函数 `splitTwoSegments(sentences)`。
  - 只在 B1c 由代码拆出的句子之间切，也就是句末标点"。！？；"处；
  - 选最接近全文一半的位置，两段各 ≤130 字；
  - 找不到就拒绝，提示"请在中间位置加一个句号"。
- **段时长**：`seconds = min(30, max(4, ceil(本段字数 / 4.5) + 1))`，多出的 1 秒留给停顿。
  - 任务的 `durationSeconds` 仍记 60，作为字数档位；
  - 方案的 `durationSeconds` = 两段之和，这样满足 R1。

### 2. 两段方案

`planDigitalHuman`（B1c）和 `planDigitalHumanTemplate` 在 60 秒时都按第 1 步输出两段：
- 分段 `G1`、`G2`；
- 接缝 `seams:[{afterSegment:"G1", afterSentence:<G1 末句>, type:"broll_cover"}]`；
- G2 首镜为 `MCU`。

大模型只能在这个骨架里填镜头，不能改切点。B1a 守卫对两种来源都必须零 error。

### 3. 编译（只改编译器的数字人两段分支）

- 每段提示词只包含本段台词（`JSON.stringify(本段文案)`）。
- **声音身份卡**：由 `VOICES[voiceStyle].prompt` 加固定的"中低音域或自然音域、语速约每秒 4.5 字、音量平稳"确定性生成。两段逐字相同，不取大模型输出。
- **停顿**：G1 结尾写"说完后自然停顿约 1 秒，保持看向镜头"；G2 开头写"先停顿约半秒再开口"。
- **机位**：G2 用中近景，看起来是有意换了机位，但仍保留 `TITLE_SAFE_AREA`。
- 130 字的最坏组合下，每段 ≤500 字，必保留项同 B5b。

### 4. 请求（`digital-human-provider.cjs`）

- `videoPayload(task, index)`：`prompt` 和 `duration` 取 `segments[index]`。
- 两段的 `image_urls` 完全相同（预览 asset、本人 asset、产品图，顺序不变），其余字段也相同。
- 30 秒以内的任务调用方式和请求体都不变。

### 5. 提交、轮询与恢复（付费请求）

- **提交**
  - 确认后依次提交 `video_1`、`video_2`，每个都经 `operation()` 先写 journal 再 POST。
  - `video_1` 拿到 task_id 后就提交 `video_2`，不等第 1 段生成完，两段在供应商那边并行生成。
- **结果不明**
  - 任一 POST 结果不明，整个任务进入 `outcome_unknown`。
  - `refresh` 只按各自的 operation id 查回执，**任何一段都不重发**。
  - 如果 `video_1` 结果不明，`video_2` 还没发过；等 `video_1` 回执确认后，`video_2` 的 POST 是它的第一次提交。
- **被明确拒绝**
  - `video_1` 被拒：不提交 `video_2`，任务转为 `needs_attention`。
  - `video_1` 已提交、`video_2` 被拒：先照常轮询并下载第 1 段（已计费的结果要保存到本地），再转为 `needs_attention`。界面写明"第 1 段已提交并会计费，第 2 段被拒"。
  - 按 :337 不能"继续"，也不自动重交。重做单段需要另开卡，参照 B2 第 5 项。
- **轮询与下载**
  - 两段分别轮询、下载，文件为 `base-1.mp4`、`base-2.mp4`，并校验 `ftyp`（沿用 :210-216）。
  - 一段失败时，另一段的文件保留。
- **确认前提示**：确认按钮旁显示"将提交 2 次视频生成（约 d1 秒 + d2 秒）"。

### 6. 增强

480p 时两段**分别**增强（入口见"顺序与依赖"），输出 `enhanced-1080-size-<段号>.mp4`，480p 原片保留。

### 7. 接缝

新增状态 `seaming`：加入 `POLLING_STATES`，`LABELS` 显示为"合成两段"。实现放在新模块 `digital-human-seam.cjs`。这一步全部在本地完成，不调用任何供应商。

**ffprobe**
- 在 `main.cjs` 的数字人构造块加 `ffprobePath`：
  - 打包版：与 ffmpeg 同目录的 `ffprobe.exe`；
  - 开发版：`XIAOXI_FFPROBE_PATH || "ffprobe"`。
- 取法与 B4c 相同，后合并的一方复用。

**找切点**（ffmpeg `silencedetect`，阈值常量默认 -35dB、0.25 秒）
- `a1`：第 1 段最后一段静音的开始时间。这段静音须持续到文件末尾（差值 ≤0.15 秒）。
- `a2`：第 2 段从 0 秒开始的那段静音的结束时间。
- **找不到时用保守回退**，保证不截掉任何语音：
  - `a1 = d1 − 0.1 − P/2`；
  - `a2 = P/2`；
  - 记 `seamFallback: true`，页面提示"接缝处未检测到停顿，请检查衔接"。
  - 包装端的 ASR 核对照常把关。
  - 不转 `needs_attention`：那样"继续"后还会失败，付费结果就卡死了。

**时间线**（常量 L=1.2s、J=0.4s、P=0.4s；`d1`、`d2` 为两段时长）

```
B-roll 时长 = L + P + J = 2.0 秒
视频 = 段1[0, a1−L] + B-roll + 段2[a2+J, d2−0.1]
音频 = 段1[0, a1+P/2] + 段2[a2−P/2, d2−0.1]，两个接点各做 30ms 淡入淡出
```

- 第 1 段最后 L 秒的话落在 B-roll 上（L-cut）。
- 第 2 段开头 J 秒的话先于画面出现（J-cut）。
- 画面切回人物时，口型与声音同步。
- 时间线计算导出为纯函数。

**B-roll**
- 用本任务的产品原图（本地 `productAssetId`，经 `asset()` 校验哈希）。
- 产品按比例完整显示；背景用同一张图放大、模糊后填满 1080×1920。
- 缓慢推近，幅度 ≤8%。
- 不叠加文字。

**编码与核对**
- 两段先统一为 1080×1920、24fps、yuv420p、48kHz。
- 每段音频先做 loudnorm 再拼接。
- 接缝这一步只编码一次：libx264 crf18、aac、`+faststart`。
- 用 ffprobe 核对：1 条视频流、1 条音频流、24fps，时长等于计算值 ±0.2 秒。
- 输出写为 `baseVideoFile`，之后照常进入 packaging，`confirmed_script` 是完整文案。

### 8. 进度展示

- `publicTask` 增加每段的状态（已提交 / 生成中 / 已下载）和 `seamFallback`，不带路径和 URL。
- 页面显示"第 1 段 / 第 2 段"的进度。

### 9. 不影响 30 秒以内的任务

≤30 秒任务的请求体、operation 名 `video`、状态和文件都不变。

## 允许改动

- `desktop/src/main/digital-human-service.cjs`、`digital-human-provider.cjs`
- 新增 `desktop/src/main/digital-human-seam.cjs`
- 新增 `digital-human-seam.self_check.cjs`：只做纯函数和命令构造，注册到 `scripts/run-self-checks.cjs`
- 新增 `digital-human-seam.ffmpeg_check.cjs`：真实 ffmpeg，**不注册**
- `desktop/src/main/main.cjs`：只在数字人构造块（:647-675）加 `ffprobePath`
- 导演模块只改数字人两段分支：
  - `video-director-compiler.cjs`；
  - `video-director-planner.cjs` 的 `planDigitalHuman`；
  - `video-directors.cjs` 的 `planDigitalHumanTemplate`
- `desktop/src/renderer/DigitalHumanPage.tsx`（及 css）、`digital-human-types.ts`
- `desktop/src/main/digital-human.self_check.cjs`；`video-director.self_check.cjs` 只加数字人用例

## 禁止

- 不用尾帧串联、extend 或首尾帧模式。
- 不改成 TTS 驱动口型，这要等 B6 小样。
- 不自动重做任何一段；结果不明时不重发；不放宽 :337。
- 不改 `operation()` 和 `refresh()` 的回执恢复逻辑。
- 不改内容引擎、包装端、网关，也不改 B2/B3/B4c 的模块。
- 不发起任何真实调用。不运行 `npm.cmd run desktop` 或 `启动内部开发版.cmd`：B5d 合并前，这两个入口会自动建立 SSH 通道。

## 验收（新增断言在当前 HEAD 258e37a 上必须失败）

1. **60 秒请求**：用 60 秒、260 字完整走一遍。
   - 恰好 2 个视频 POST；
   - 两段 `image_urls` 深相等；
   - 两段提示词都含同一个"声音身份卡"字符串；
   - 两段 `duration` 都 ≤30，并等于第 1 步的公式；
   - 第 1 段提示词里没有第 2 段的句子。
   - 在 HEAD 上，60 秒会被 `create()` 拒绝。
2. **切段与字数**
   - 切点落在句末标点上；
   - 60 秒 120 字被拒（提示选 30 秒），261 字被拒；
   - 无法切成两段各 ≤130 字时被拒。
3. **方案**：60 秒的模板方案和 fake 大模型方案都满足以下各项。
   - `reviewPlan` 零 error；
   - `plan.durationSeconds === d1 + d2`；
   - 接缝类型为 `broll_cover`。
4. **结果不明**：注入故障，让第 2 个 POST 断线（`outcomeUnknown`）。
   - 任务进入 `outcome_unknown`；
   - 重建服务再 `refresh`，两段各自只 POST 过 1 次；
   - 回执可用后，任务继续直到 `completed`。
5. **被拒**
   - 第 1 段被明确拒绝时，第 2 段的 POST 计数为 0。
   - 第 2 段被拒时：第 1 段文件已下载，任务为 `needs_attention`，`resume()` 抛 `digital_human_request_rejected`，两段 POST 各为 1 次。
6. **接缝纯函数**（`digital-human-seam.self_check.cjs`，进入 `check:self`）
   - 时间线公式；
   - silencedetect 输出的解析：用固定的 stderr 文本做 fixture；
   - 回退切点：`a1 = d1−0.3`、`a2 = 0.2` 时，音频覆盖段 1 的 [0, d1−0.1] 和段 2 的 [0, d2−0.1]。
7. **真实 ffmpeg**（`node src/main/digital-human-seam.ffmpeg_check.cjs`）
   - ffmpeg 从 `XIAOXI_FFMPEG_PATH` 或 PATH 查找，找不到就报错退出，不静默跳过。result 贴出完整输出。
   - **素材**：
     - 用 lavfi 生成两段 6 秒片段：第 1 段红色画面，0–4.0 秒为测试音，之后静音；第 2 段蓝色画面，0–1.0 秒静音，之后为测试音；
     - 另生成一张绿色产品图。
   - **断言**：
     - 输出时长为 9.3 秒 ±0.2；
     - 在 2.7 秒、2.9 秒、4.7 秒、4.9 秒取帧，颜色依次为红、绿、绿、蓝；
     - 3.5 秒处有第 1 段的测试音（L-cut）；
     - 4.0–4.4 秒为静音；
     - 4.6 秒处已有第 2 段的测试音，而画面仍是绿色（J-cut）。
8. **不影响 30 秒以内的任务**：30 秒任务的请求体和 operation 名与 B5b 合并后一致，现有断言全部通过。
9. **命令**：`node src/main/digital-human.self_check.cjs`、`node src/main/video-director.self_check.cjs`、`npm.cmd run check:self`、`npm.cmd run build:test` 都通过。

## 需用户本人验收 / 授权

- **付费小样**：60 秒数字人，即 2 次约 30 秒的 480p 生成。
  - 按 `USD_PER_SECOND_480P` 计，视频约 $5.8；另有预览图和素材登记费用。
  - **计划 B6 的 5 项小样里没有这一项，需要用户单独批准。**
- **人工检查**：
  - 两段音色是否一致（已知风险）；
  - B-roll 接缝是否自然，是否触发了 `seamFallback`；
  - 切回人物后口型是否同步；
  - 包装端 ASR 文案核对是否通过；
  - 标题是否压脸。
- **界面检查**：由用户启动开发版查看（会建立 SSH 通道）。
