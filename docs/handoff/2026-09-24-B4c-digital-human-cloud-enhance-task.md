# B4c 数字人：接入云端画质增强（复用 B4b 模块），修正"原生1080p"标签

分支：`codex/digital-human-cloud-enhance`

## 顺序与依赖

- **开工前须已合并**：B4b（`video-enhance.cjs`）、T2（数字人自检已注册）、B5a、B5b（同样改 `digital-human-service.cjs:60-73`、`:284-314` 和 `DigitalHumanPage.tsx`）。
- **与 B5c 的关系**：B5c 卡写的是"B4 已合并时走 B4 的 `enhanceVideo`，否则走 Lanczos"。
  - B5c 先合并：本卡对它的两段分别增强；
  - 本卡先合并：B5c 按它自己的卡调用本卡的逐段入口。
  - 后合并的一方 rebase，并在 result 里说明。
- **文件重叠**：`digital-human-service.cjs`、`digital-human-ipc.cjs`、`digital-human-preload.cjs`、`DigitalHumanPage.tsx`、`digital-human-types.ts`（B5a–B5c）；`main.cjs`（B4b，只改构造参数）。与 T1、T4、T5 无重叠。
- 下文行号是 HEAD 258e37a 的现状，开工时按函数名重新定位，并在 result 里列出对应关系。

## 背景

- 用户决定与增强流程见 B4b。数字人 ≤30 秒是 1 段（B5b），60 秒是 2 段（B5c）。
- 数字人成片含本人肖像。接入后，这段视频会发到火山 AI MediaKit 处理，这是新增的数据去向，需要在确认时告知用户（见"需用户本人验收/授权"）。

## 现状（HEAD 258e37a，已逐行复核）

以下未注明文件的行号均指 `desktop/src/main/digital-human-service.cjs`。

- **增强步骤**：`:218` 对 480p 转 `enhancing`；`:220-227` 调 `options.enhanceVideo || upscaleTo1080Size`（`:223`），`:226` 把 `baseVideoFile` 换成放大文件，并写 `enhancement: 'lanczos_resize'`。
- **任务号**：视频任务号保留在 `videoTaskId`（`:204-205`），可以重新查询取结果地址。
- **付费请求日志 `operation()`（`:92-114`）**：已有条目时只查 `/operations/{id}`（`:98-103`），任何查询错误都包装成 `outcomeUnknown`（`:101`）；POST 明确失败时条目标 `rejected`（`:111`）。B5b 禁止改这一段，本卡也不改。
- **`refresh()`**（`:315-331`）：`outcome_unknown` 恢复为 `resumeStatus` 后调度（`:325-329`），由 `operation()` 只查回执。
- **`resume()` 会被卡死**：`:337` 只要有任一条目 `rejected` 就拒绝继续。增强被拒并已回退 Lanczos 后，如果打包再失败，用户点不了"继续"。B5c 依赖 `:337` 挡住被拒的 `video_2`，所以只能对"已回退的增强条目"放行。
- **付费确认**：`confirm`（`:309-314`）只校验预览版本；IPC 在 `digital-human-ipc.cjs:30`，键白名单为 `id(payload, ['previewRevision'])`；受信点击列表在 `:43`，`:48` 删掉 `clickToken`；preload 的点击门在 `digital-human-preload.cjs:4`。页面没有任何费用显示（确认按钮 `DigitalHumanPage.tsx:170-171`）。
- **标签**：状态名"本地放大画面"（`:16`）；`:70` 对非 480p 任务标"原生1080p"，从未核实；页面 `DigitalHumanPage.tsx:134,176`。
- **轮询**：`:356-361` 每 15 秒调度一次 `POLLING_STATES` 中的任务。
- **ffprobe**：`main.cjs` 数字人构造参数（`:647-675`）只传 `ffmpegPath`（`:651-653`）。

## 要做

1. **确认绑定所选增强方式**
   - `confirm` 的 payload 增加 `enhancementMode`（`'volcengine_generative'` | `'lanczos_resize'`）：`digital-human-ipc.cjs:30` 改为 `id(payload, ['previewRevision', 'enhancementMode'])`，preload 透传，`digital-human-types.ts` 同步。
   - 主进程校验与 B4b 相同：选 AI 增强时能力 `volcengine_video_enhance` 必须为 true，否则拒绝，任务停在 `preview_ready`。所选值写入 `task.enhancementMode`。
   - 没有 `enhancementMode` 的旧任务一律只走 Lanczos，不产生增强 POST。
   - `task.enhancement`（`:226`）改为记录实际结果：全部云端为 `volcengine_generative`，全部回退为 `lanczos_resize`，混合为 `mixed`。不要拿它当所选方式。
   - 界面：确认按钮旁加单选和"AI 增强约 ¥x（按 5 元/分钟估算，以账单为准）"，金额由主进程算；选 AI 增强时显示"成片将发送到火山引擎做画质增强"。本卡不补视频生成费用的显示。
2. **接入增强**
   - `enhancing` 阶段对每段调用一次 B4b 的 `enhanceVideo`，`providerTaskId` 用 `videoTaskId`（B5c 用各段的任务号），operation 名 `enhance_<段号>_try_1`。全部完成后才进入 `packaging`（B5c 时先进入它的接缝步骤）。
   - 回退或完成的文件替换 `baseVideoFile` 的方式沿用 `:226`。
   - 回执查询沿用 `operation()` 现状：查询失败或回执为 4xx 时都保持 `outcome_unknown`，由用户选"改用本地放大继续"。
3. **修复 `resume()`**：`:337` 的检查排除"名字以 `enhance_` 开头、且对应段 `enhance.fallback` 为真"的条目。其他条目（包括 B5c 的 `video_1`/`video_2`）行为不变。
4. **新动作"改用本地放大继续"**：新增 IPC `use-local-enhance`，加入 `digital-human-ipc.cjs:43` 的受信点击列表和 `digital-human-preload.cjs:4` 的点击门。可用条件、效果和提示文案与 B4b 相同。
5. **ffprobe**：`main.cjs` 数字人构造参数加 `ffprobePath`，取法与 B4b 相同。
6. **标签**
   - `:70` 的 `outputQuality`：
     - 480p 且全部云端增强："AI 增强至 1080p"；
     - 部分回退："AI 增强至 1080p（n 段本地放大）"；
     - 全部回退，或 480p 旧任务："1080p 尺寸·本地放大"；
     - 非 480p 旧任务："1080p 生成"，替换未经核实的"原生1080p"。
   - `:16` 的 `enhancing` 改为"画质增强"；`DigitalHumanPage.tsx:134` 同步改。
7. **不泄露**：`publicTask`、task.json 和日志里不出现火山结果地址、`auth_key` 或上游响应正文。

## 允许改动

- `desktop/src/main/digital-human-service.cjs`、`digital-human-ipc.cjs`、`digital-human-preload.cjs`、`digital-human.self_check.cjs`
- `desktop/src/main/main.cjs`：只改数字人服务的构造参数
- `desktop/src/renderer/DigitalHumanPage.tsx`（及 css）、`digital-human-types.ts`
- `video-enhance.cjs` 不改契约；需要改动时写进 result 交回，不在本卡扩大范围

## 禁止

- 不改 `operation()`（`:92-114`）和 `refresh()` 的回执恢复逻辑；结果不明或被拒后都不自动重新提交；同一段不能发出第二次增强 POST。
- `resume()` 只放行"已回退的增强条目"，不放宽其他被拒条目。
- 不跳过预览确认，不把旧任务升级为付费增强。
- 不直连火山，不接触任何火山 Key；结果签名地址不写盘、不进入渲染进程。
- 不发起真实调用，不部署，不发布。

## 验收（新增断言在当前 HEAD 上必须失败）

`digital-human.self_check.cjs` 通过 `create`/`preview`/`confirm`/`refresh`/`resume`/`use-local-enhance` 驱动，使用 fake 的 provider、ffprobe、ffmpeg、URL 探测、打包服务和可控时钟。**每个用例都断言增强 POST 次数。**

1. **正常流程**：480p 任务选 AI 增强，视频完成后增强 POST 1 次，完成后才调用 `packageVideo`，其输入是增强文件。`outputQuality` 为"AI 增强至 1080p"；`get()` 和 task.json 不含火山结果地址和 `auth_key`。
2. **结果不明**：增强 POST 抛 `outcomeUnknown`，任务转 `outcome_unknown`；`refresh` 查到回执后继续到 `packaging`，POST 仍为 1 次。
3. **回执无法确认**：回执 pending 时保持 `outcome_unknown`；没有受信点击时 `use-local-enhance` 被拒；有受信点击时走 Lanczos，POST 仍为 1 次，标签为"1080p 尺寸·本地放大"。
4. **被拒后仍能继续**：增强 POST 返回 400，自动回退；随后打包返回 `failed`，`resume()` 成功，POST 仍为 1 次。（改 `:337` 前，这一步会抛 `digital_human_request_rejected`。）
5. **其他被拒条目仍然挡住**：预置 `video` 条目 `rejected` 的 `needs_attention` 任务，`resume()` 仍抛 `digital_human_request_rejected`。
6. **确认环节**：选 AI 增强但能力为 false，`confirm` 被拒，任务仍为 `preview_ready`，所有 POST 为 0。
7. **旧任务**：预置 `enhancing`、没有 `enhancementMode` 的任务，走 Lanczos，增强 POST 为 0；预置非 480p 旧任务，`outputQuality` 为"1080p 生成"，任何任务的输出都不含"原生1080p"。
8. **两段（仅当 B5c 已合并）**：两段各 POST 1 次，名字为 `enhance_0_try_1`、`enhance_1_try_1`；一段 `failed` 时只有该段回退，标签带"（1 段本地放大）"。
9. `node src/main/digital-human.self_check.cjs` 在 HEAD 上失败（result 贴失败输出），本分支通过；`npm.cmd run check:self`、`npm.cmd run build:test` 通过。

## 需用户本人验收/授权

- **已拍板（2026-09-24）**：用户同意数字人也接云端增强，前提是页面提示。告知文案用"成片将发送到火山引擎做画质增强"。用户可以不选 AI 增强，改用本地放大。
- **B6 付费小样**（逐项批准）：同一条数字人 480p 样片分别做云端增强和 Lanczos，重点看脸、牙齿、口型和身份是否漂移。
- **前置与发布**：B4a 部署、`release:internal` 均需用户授权。
