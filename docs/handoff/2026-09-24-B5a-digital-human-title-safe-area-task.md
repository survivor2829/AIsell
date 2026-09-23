# B5a 数字人成片：约第 10 秒标题压到人脸

分支：`codex/digital-human-title-safe-area`

## 顺序与依赖

- B5 拆成四张卡：B5a → B5b → B5c 串行，B5d 独立。
- 本卡不依赖 B1，与 T1/T4/T5/B0 的文件不重叠，可以立即开工。B5b、B4c 都要求本卡先合并。
- B1c 卡写"B1c 排在 B5 之前"，指的是 B5b/B5c；本卡可以先于 B1c 合并。两者都改 `videoPayload`（`digital-human-provider.cjs:104-117`），后合并的一方 rebase，保证旧提示词分支仍带 `TITLE_SAFE_AREA`。导演编译出的新提示词由 B5b 接入这个常量。
- `digital-human.self_check.cjs` 要等 T2 合并后才进 `check:self`。T2 未合并时，单独运行它（见验收第 4 项）。

## 现象

9-22 内部 12 秒样片：顶部标题在约第 10 秒压到人物面部（`docs/reports/2026-09-22-digital-human-gateway.md:48`）。

## 根因（代码已复核）

1. **标题由 Remotion 的 `VideoOutline` 绘制，不是字幕模块**（`desktop/remotion-packaging/video-template.tsx:452-464`）：
   - 位置固定为 `top: 156`；`topic_fixed` 模板下整段常驻（:456）；
   - 超过 18 字用 54px，否则 64px（:459）；
   - 文字上方还有 8px 色条和 16px 间距；
   - 不限行数。
2. 数字人任务没有标题时，取文案前 20 字作为标题（`desktop/src/main/digital-human-service.cjs:296`），而页面从不传标题。20 字按 54px 排成两行，占画面 156–约 312px，也就是顶部 8%–16% 这条带，整段都在。
3. 其他相关代码都不处理标题位置：
   - `video_presentation.py:14-32` 只计算 topic 和要点，不管位置；
   - `run_imported_video` 的 recipe（:119-127）不带任何版式信息；
   - `creative_render.py:3333` 把 presentation 原样交给 Remotion。
4. Remotion 合同里有 `protectedRects`（`contract.cjs:330-333`，只有事件避让用到，:363）。但生产代码里没有地方写 `packaging.protected_rects`：`creative_render.py:3338`、`creative_domain.py:6673` 都只是透传。`VideoOutline` 也不读它。内容引擎只用 Python 标准库，没有人脸检测。
5. **生成端没有给标题留位置**：
   - 预览图提示词只要求"画面下方保留字幕空间"（`digital-human-provider.cjs:102`）；
   - 视频提示词（:115）没有提上方留白；
   - 人物在中景里前倾或模型推近时，头部就会进入 8%–16% 这条带。

## 要做

1. **数字人成片使用"口播版式"**：在 `creative_render.py:3333`，当 recipe 带有 `imported_base_video` 时，给 presentation 加上 `layout: "talking_head"`。
   - 在渲染时推导，不改已保存的 recipe，这样旧的数字人成片重新包装后也能生效；
   - 其他成片不加这个字段，例如口播批量（`creative_domain.py:6110-6112`）。
2. `contract.cjs:400-407` 放行 `layout` 字段，只接受 `"talking_head"`，其他值一律丢弃；同步修改 `types.ts:98`。
3. **`talking_head` 下的 `VideoOutline`**：
   - 标题框限制在画面顶部 10% 以内（≤192px），整段位置不变；
   - 固定 top、字号和行高，最多 2 行（line clamp 加 overflow hidden）；
   - 具体数值由你定，但最坏情况下（32 字 topic，或 `key_points` 的 24 字要点）必须满足 `top + 色条高 + 色条间距 + 2 × 字号 × 行高 ≤ 192`。HEAD 的色条是 8px 加 16px 间距（:461）；`talking_head` 下也可以去掉色条；
   - 计算标题框的逻辑导出为纯函数，供自检调用；
   - 非 `talking_head` 的渲染结果必须与 HEAD 完全一致。
4. **生成端留出标题区**：
   - 在 `digital-human-provider.cjs` 新增导出常量 `TITLE_SAFE_AREA`，大意是：画面上方约 15% 保持为干净背景，作为标题区；人物头顶始终在这条线以下，所有镜头（包括中近景）都不进入；不推到头肩特写。
   - 拼入预览图提示词（:102）和视频提示词（:115）。
   - B1c 会把视频提示词改为由导演编译生成，B5b 再把这个常量接入编译器，文字不变。
   - 本卡不改 `rules.cjs` 和导演模块（B1a/B1c）。
5. 字幕 `BoldNarration`（`video-template.tsx:434-450`，`top: 72%`）不在本卡范围内。

## 允许改动

- `desktop/sidecars/content-engine/content_engine/creative_render.py`：只改 :3333 附近的 presentation 透传
- `desktop/remotion-packaging/contract.cjs`、`types.ts`、`video-template.tsx`
- `desktop/src/main/digital-human-provider.cjs`：只改提示词
- 测试文件：`desktop/sidecars/content-engine/tests/test_video_presentation.py`、`desktop/scripts/remotion-packaging.self_check.cjs`、`desktop/src/main/digital-human.self_check.cjs`

## 禁止

- 不引入人脸检测依赖，也不为版式增加任何供应商调用（看图模型、生图都不行）。
- 不改字幕、封面、`video_presentation.py` 的要点提取和 ASR 文案核对。
- 不改数字人服务的状态机、operation journal 和付费确认流程。

## 验收（新增断言在当前 HEAD 258e37a 上必须失败）

1. `test_video_presentation.py`：recipe 带 `imported_base_video` 时，经过 `HybridCreativeRenderer._public_props` 后 `presentation.layout == "talking_head"`；不带时没有 `layout` 字段。
2. `remotion-packaging.self_check.cjs`：
   - `normalizeMotionManifest` 保留 `layout:"talking_head"`，丢弃未知值；
   - 用导出的纯函数（或 `renderToStaticMarkup`）检查 `talking_head` 标题：32 字 topic、24 字 `key_points` 要点，`nowMs=10000` 时，标题框底边 ≤192px，且最多 2 行；
   - 没有 `layout` 时，标题仍是 `top:156` 的原样式（回归检查）。
3. `digital-human.self_check.cjs`：
   - 预览图提示词和视频提示词都包含 `TITLE_SAFE_AREA`；
   - 视频提示词仍用双引号包含完整文案。
4. 以下命令通过：
   - 在 `desktop/sidecars/content-engine` 下运行 `python -m unittest discover -s tests -p "test_video_presentation.py"` 和 `python -m unittest discover -s tests -p "test_remotion_renderer.py"`；
   - `node src/main/digital-human.self_check.cjs`（T2 未合并时 `check:self` 不会跑它），result 贴出它在 HEAD 上的失败输出；
   - `npm.cmd run check:self`
   - `npm.cmd run build:test`

   Codex 不要运行 `npm.cmd run desktop` 或 `启动内部开发版.cmd`：B5d 合并前，这两个入口会自动建立到测试服务器的 SSH 通道（`scripts/dev-electron.cjs:26`）。在真实应用里看效果前，要先重建内容引擎运行时和 Remotion 运行时，因为开发版要求运行时与 HEAD 一致（见 `sidecars/content-engine/README.md:51`）。这一步列在用户验收里。

## 需用户本人验收

- **重建运行时并启动开发版**：这一步会建立 SSH 通道，所以由用户执行或授权。
- **重新包装旧样片**：在制作记录里对 9-22 那条 12 秒样片执行"重新包装"，封面选本地帧或沿用原封面，然后看第 8–12 秒标题是否还压脸。
  - 预期这一步不调用任何供应商。如果界面提示需要 AI 服务，先停下来问用户。
  - 如果数字人成片不支持重新包装，Codex 在 result 里说明，改到 B5b 的付费样片上验收。
- **生成端留白**：效果要等下一条付费预览和样片才能看到，由用户授权后执行。
