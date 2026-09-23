# B5e 数字人成片加 AIGC 标识（与产品效果视频同一口径）

分支：`codex/digital-human-aigc-label`

## 依赖与顺序

- 在 **B3b** 合并之后开始。B3b 定义了显式角标（右上角"AI生成"、字高不小于短边 5%、全片显示）和隐式元数据 JSON（`-metadata AIGC=<JSON>`、`use_metadata_tags`），本卡直接复用，不另起一套。
- 与 **B5a**（标题安全区）都会改数字人的包装渲染，本卡排在 B5a 之后。角标不得和标题、字幕重叠。
- 合规口径（字高、显示时长、`ContentProducer` 取值）以用户或法务对 B3b 的确认为准。B3b 口径没确认之前，本卡不发布。

## 背景

- 数字人成片走内容引擎：`contentEngineController.importBaseVideo`（`desktop/src/main/main.cjs` 数字人 `packageVideo` 注入处）→ `creative_domain.py:401` 的 `import_base_video` → 渲染 → 登记为 generated video。
- 全仓库目前没有任何 AIGC 标识实现（B3b 第 42 行已复核）。数字人成片含合成人脸和合成语音，属于 GB 45438-2025 要求显式加隐式双标识的内容。

## 要做

1. **定位**：找到数字人成片最终写出 mp4 的那一次 ffmpeg 或 Remotion 输出（从 `import_base_video` 往下追），在 result 中写明 文件:行。
2. **显式角标**：在最终输出上加 B3b 同款"AI生成"角标。
   - 如果最终输出由 Remotion 渲染，就在 Remotion 模板层加，不额外转码。
   - 如果是 ffmpeg，就并入已有的那次编码。
   - **不允许为了加标识多一次有损编码。**
3. **隐式元数据**：最终封装加 `-movflags +faststart+use_metadata_tags` 和 `-metadata AIGC=<JSON>`。JSON 构造函数与 B3b 共用同一个实现，或者放在同一个模块里，`ProduceID` 使用数字人任务 id。
4. **校验**：成片 ffprobe 核对加一项：format tags 里有 `AIGC`，能解析，且 `Label="1"`。不通过时任务不得标记为 completed。
5. **封面**：封面图片是否也需要标识，待用户确认，本卡先不做，在 result 里提出。

## 允许改动

- 内容引擎中数字人包装、渲染相关文件（以第 1 步定位结果为准），以及 B3b 引入的 AIGC 公共函数所在模块（只能新增调用，不改语义）。
- 对应的 Python 单测和数字人 self_check。

## 禁止

- 不改创作工作台其他成片的输出。**创作工作台里用 TTS 配音的口播成片是否也要标识**，是一个更大的合规范围问题，需用户或法务决定，本卡不处理。
- 不改数字人的生成、审核、付费流程。

## 验收（新增断言在当前 HEAD 上必须失败）

1. 用一段本地生成的 3 秒测试视频走 `import_base_video` 的离线路径（沿用现有测试替身），输出文件的 format tags 含 `AIGC`，`Label="1"`，`ProduceID` 等于传入的任务 id。
2. 抽取第 1 秒的一帧，右上角角标区域与无角标版本的像素差明显。只用像素差判断，不用 OCR。
3. 视频编码次数与改动前相同（在命令记录里断言）。
4. 相关 Python 单测、`npm.cmd run check:self` 通过。

## 需用户本人验收/授权（Codex 不做）

- 确认 B3b 的合规口径同样适用于数字人；确认封面是否也要标识；确认创作工作台 TTS 成片的标识范围。
- 真实数字人样片的角标位置由用户目视检查（和 B5a 一起看）。
