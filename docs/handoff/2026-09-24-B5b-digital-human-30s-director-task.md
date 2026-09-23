# B5b 数字人：单次最长 30 秒，口播字数按"时长 × 4.5"硬性限制，30 秒提示词不超过 500 字

分支：`codex/digital-human-30s`

## 顺序与依赖

- **开工前须已合并**：
  - **B1c**（数字人接入导演 v3），B1a、B1b 随之已合并；
  - **T2**：数字人自检已注册；
  - **B5a**：提供 `TITLE_SAFE_AREA`。
- **范围说明**：计划 B5 里的"数字人导演用 B1 schema、并入开头钩子和咨询引导、人物照片不发给大模型"由 **B1c** 负责，本卡不重复做。B1c 明确把"时长范围、160 字上限"留给 B5。
- **后续卡**：B5c 和 B4c 都在本卡之后（见 B4c 卡的"开工前须已合并"）。
- **文件重叠**：
  - `digital-human-service.cjs`、`DigitalHumanPage.tsx`：B1c、B4c、B5c；
  - `video-director-compiler.cjs`：B1a；
  - `video-director-guard.cjs`：B1a，本卡只加导出。
- **发布约束**：B1c 合并后、本卡合并前，新任务用的编译提示词还没有标题留白。这段时间不要单独发布数字人。
- **行号**：按 HEAD `258e37a`。B1c 合并后，按函数名重新定位。

## 现状（代码已复核）

**时长与字数**
- `create()` 只接受 10–15 秒的整数（`desktop/src/main/digital-human-service.cjs:288-289`）。
- 文案超过 160 字时报 `digital_human_script_required`（:292-293），这个错误码本来表示"没填文案"。
- 页面把 textarea 的 `maxLength` 写死为 160（`DigitalHumanPage.tsx:150`），时长只能选 10/12/15（:154-155）。
- 160 字放进 12 秒约为每秒 13 字，口型跟不上。
- Seedance 2.5 单次可生成 4–30 秒（调研已核实官方文档）。
- 网关的视频路由只校验请求方法、不过滤字段（`server/provider-gateway/service.py:740-746`），所以放开到 30 秒不需要改网关。

**检查缺口**
- `preview()` 只检查文案非空（:306）。
- `confirm()` 只检查预览修订号（:309-314）。
- 按旧规则保存、或已到 `preview_ready` 的超长任务，会直接进入付费请求。

**B1 系列留给 B5 的口子**（以 B1a、B1c 卡为准）
- B1a 守卫 R4 的语速计数：去掉空白和标点后计数。数字人句子等于用户原文时，只记 warning，原因是"硬性上限由 B5 负责"。
- B1a 编译器：数字人超过 500 字只记 warning `prompt_over_500`。
- B1a schema：
  - 数字人的 `durationSeconds` 由 `context.durationRange` 给，当前为 10–15，注明"B5 放宽"；
  - `visualDirection.textSafeArea` 有 `top_15` 这个值，但 B1a 卡没有要求编译器输出对应文字（合并后核实）。
- B1c：语速和措辞只提示、不拦截；不改预览提示词；B1c 自己的验收只覆盖"≤67 字时提示词 ≤500 字"。
- 按 HEAD 的旧模板实测：视频提示词不算文案有 651–665 字，所以 135 字文案要靠编译器真正压缩。

## 要做

1. **时长**
   - `create()` 接受 10–30 的整数。
   - 页面选项改为 10/15/20/30 秒；旧的 12 秒任务照常显示和续跑。
   - B1c 传给守卫和规划器的 `durationRange` 改为 [10, 30]。
   - 60 秒由 B5c 做，本卡拒绝超过 30 秒。

2. **口播字数上限** = floor(时长 × 4.5)
   - 计数复用 B1a 守卫 R4 的同一个函数。如果它没有导出，只在 guard 里加导出，不改它的判定。
   - 对应上限：10 秒 45 字，15 秒 67 字，20 秒 90 字，30 秒 135 字。
   - 超限时统一报新错误码 `digital_human_script_too_long`，提示"按 N 秒最多 M 字（每秒约 4.5 字），请删减"。
   - 以下四处都要校验，都必须在任何网关请求之前完成：
     - `create()`；
     - B1c 的 `plan()`：超限时不调用大模型；
     - `preview()`：拦截旧草稿；
     - `confirm()`：拦截 HEAD 时期已到 `preview_ready` 的超长任务。

3. **页面**
   - 实时显示"口播 X / M 字（每秒约 4.5 字）"，计数口径与主进程相同（主进程把上限随 `capabilities` 或 `publicTask` 下发，页面不自行定规则）。
   - 超限时，"请导演看稿"（B1c）和"生成人物预览"两个按钮都不可点。
   - `maxLength` 不再写死 160，改为宽松上限（如 400），以计数为准。

4. **30 秒提示词预算**（只改编译器的数字人分支）
   - 数字人方案的 `visualDirection.textSafeArea` 固定为 `top_15`。B1c 规划器回填和 `planDigitalHumanTemplate` 都这样处理。
   - 编译器在 `top_15` 时输出 B5a 的 `TITLE_SAFE_AREA`，并把它列为数字人的必保留项。
     - 常量可以移到编译器或 skill 的 `index.cjs`，`digital-human-provider.cjs` 重新导出，文字不变。
   - 最坏组合（3 场景 × 3 声音 × 135 字带标点的文案）编译后都 ≤500 字（`Array.from(prompt).length`），并保留以下必保留项：
     - 台词用 `JSON.stringify` 包裹，只出现一次；
     - "口型与话语同步，不添加额外台词"；
     - `TITLE_SAFE_AREA`；
     - 体量规则的语义（文字可压缩）；
     - B1a 列出的数字人必备约束。
   - 必保留项本身就超过 500 字时，停下，在 result 里写实测字数。不得删必保留项，也不得截断台词。
   - 运行时仍保持 B1a 的 warning 处理，不改成抛错。

5. **兼容**
   - 任务仍是 `version: 1`，不让旧记录变成 `digital_human_data_unreadable`（:47）。
   - 旧任务的 list、get、refresh、resume 行为不变。

## 允许改动

- `desktop/src/main/digital-human-service.cjs`：只改时长、字数校验，以及下发上限
- `desktop/src/renderer/DigitalHumanPage.tsx`（及 css）、`digital-human-types.ts`
- `desktop/src/main/video-director-compiler.cjs`：只改数字人分支
- `video-director-guard.cjs`：只加计数函数的导出
- `video-director-planner.cjs`、`video-directors.cjs` 的 `planDigitalHumanTemplate`：只改 `durationRange` 和 `textSafeArea`
- `desktop/src/main/digital-human-provider.cjs`：只改 `TITLE_SAFE_AREA` 的导出位置
- `desktop/src/main/digital-human.self_check.cjs`；`video-director.self_check.cjs` 只加数字人用例

## 禁止

- **付费确认不变**：预览仍要用户点击；视频仍要同时确认 `previewRevision` 和 `planHash`（B1c）。
- **结果不明的处理不变**：不改 operation journal（:92-114）和 `outcome_unknown` 恢复（:315-331）；结果不明时不自动重发。
- **不改 B1c 的导演行为**：不改写用户文案，不改钩子和引导的规则，不把人物照片或预览图发给大模型。
- 密钥不进 renderer，也不进日志。
- 不改成 TTS 驱动口型（等 B6 小样）；不做 60 秒（B5c）。
- 不改网关，也不改内容引擎。
- 不发起任何真实的大模型或 APIMart 调用。不运行 `npm.cmd run desktop` 或 `启动内部开发版.cmd`：B5d 合并前，这两个入口会自动建立 SSH 通道（`scripts/dev-electron.cjs:26`）。

## 验收（新增断言在当前 HEAD 258e37a 上必须失败）

1. **30 秒完整流程**：用 30 秒、135 字创建任务，经 fake provider 完整走到视频提交。
   - `videoPayload.duration === 30`；
   - 视频 POST 恰好 1 次。
   - HEAD 会在 `create()` 拒绝 30 秒。
2. **字数上限**
   - 12 秒 55 字被拒，错误码为 `digital_human_script_too_long`（HEAD 会接受）；12 秒 54 字通过。
   - 30 秒 136 字被拒。
   - 12 秒 160 字被拒（HEAD 会接受）。
   - "一、二。"计为 2 字。
3. **旧任务拦截**：预置按旧规则写入的 task.json（12 秒、100 字）。以下三处的错误码都必须是 `digital_human_script_too_long`，即字数检查排在方案检查之前：
   - `draft` 状态下，`preview()` 被拒，所有 POST 为 0；
   - `draft` 状态下，`plan()` 被拒，大模型请求为 0；
   - `preview_ready` 状态下，`confirm()` 被拒，视频 POST 为 0。
4. **编译**：3 场景 × 3 声音 × 135 字，编译后都满足：
   - 视频提示词 ≤500 字；
   - 只包含一次 `JSON.stringify(文案)`；
   - 包含"不添加额外台词"和 `TITLE_SAFE_AREA`；
   - `image_urls` 的顺序与改动前一致。
5. **旧任务**：预置旧任务（12 秒、没有方案），list/get/refresh/resume 行为照常，现有断言全部通过。
6. **命令**：`node src/main/digital-human.self_check.cjs`、`node src/main/video-director.self_check.cjs`、`npm.cmd run check:self`、`npm.cmd run build:test` 都通过。

## 需用户本人验收 / 授权

- **界面检查**：启动开发版会建立 SSH 通道，所以由用户执行或授权。检查计数、超限时按钮置灰、30 秒选项。
- **付费小样**：对应 B6 第 2 项"数字人 30 秒单次"，由用户授权后执行。人工检查：
  - 每秒 4.5 字时口型和音色是否自然；
  - 标题是否压脸（B5a）；
  - 产品体量是否正确。
