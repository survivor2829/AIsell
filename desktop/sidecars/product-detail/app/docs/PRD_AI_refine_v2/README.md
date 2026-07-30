# AI 精修 v2 PRD 证据包

> **冻结时间**: 2026-04-23
> **结论**: 方向 B 正式转正, 进入 PRD 阶段
> **相似度**: v1 demo 5/10 → v2 demo 8/10 (+3 分)

## 目录

| 文件 | 说明 |
|------|------|
| **`PRD_final.md`** | **PRD 最终版 (方向 D · 卖点驱动, 等用户 review 批准)** |
| `demo_gpt2_v2_dz600m.jpg` | v2 实测产出 (2.4MB, 1024x1024) |
| `demo_gpt_image2_v2.py` | 生成脚本 (edits-first 探测 + generations 降级) |
| `prompt_final_v2.md` | 四段 prompt 最终版 (PRESERVE/CHANGE/CONSTRAINTS/STYLE) |
| `endpoint_probe_results.md` | APIMart 端点探测实测结果 |
| `similarity_scoring.md` | 产品相似度 8/10 拆解 (对照参考图逐项打勾) |
| `cost_comparison.md` | v1 vs v2 成本/耗时/质量对照表 |

## 技术栈冻结

- **端点**: `/v1/images/generations` (APIMart, edits 不可用)
- **模型**: `gpt-image-2`
- **参数**: `thinking="medium"` + `reasoning_effort="medium"` (默认开)
- **尺寸**: `1:1` (1024×1024), 下版可试 `16:9`
- **输入**: base64 data URL of product cutout
- **成本**: ~¥0.7/张 (含 thinking 50% 溢价)

## 外部依赖

- **APIMart API Key**: 生产 `.env` 里 `GPT_IMAGE_API_KEY` 已配置
- **参考图**: `uploads/batches/batch_20260422_001_3858/测试/DZ600M无人水面清洁机新品1/product_cut.png`

## 不动的文件 (硬约束)

- `refine_processor.py` — 不动
- `.env` — 不动
- 任何执行 API 调用的路径 — PRD 阶段不跑

## 下一步

等用户回答 Phase 1 的 1-2 个封闭问题 → 生成方向 A/B/C 方案 → 再决定是否进入开发。
