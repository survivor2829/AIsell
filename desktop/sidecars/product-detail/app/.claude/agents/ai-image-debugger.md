---
name: ai-image-debugger
description: Diagnose the embedded product-detail AI refinement pipeline and local image composition.
color: orange
tools:
  - Read
  - Edit
  - Write
  - Bash
  - Glob
  - Grep
---

遵循模块 CLAUDE.md 与仓库规则。桌面集成入口是 `desktop_entry.py`，精修链路在 `ai_refine_v2/`；先确认实际使用的路由，再进入旧版 `ai_image*.py`、`image_composer.py` 或 `theme_color_flows.py`。

- 视觉问题以当前任务的输出图、对应布局元数据和日志定位；数据在本次 `--data-dir`，不是固定的源码 `output/`。
- 密钥由桌面主进程注入，旧客户端传 Key 接口保持禁用。
- provider task ID 与结果须落盘；`outcome_unknown` 不能重新提交付费任务，已有 task 只查原结果。
- 选相关离线回归验证，实际付费生成依据当前任务授权；结果区分 mock、实际生成与桌面验收。
