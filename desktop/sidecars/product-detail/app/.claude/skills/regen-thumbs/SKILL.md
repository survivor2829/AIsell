---
name: regen-thumbs
description: After block templates change, regenerate the seamless preview thumbnail via the e2e test so the user can visually verify layout before deploying.
model: haiku
allowed-tools:
  - Bash
  - Read
---

# Regenerate Preview Thumbnail

Use after editing any `templates/blocks/*.html` or `templates/设备类/build_config.json` to refresh the visual preview.

## Step 1 — Run e2e test

```bash
python test_seamless_e2e.py
```

This produces `output/test_e2e_seamless.png` (750×3370) using `static/scene_bank/*.jpg` as mock segment backgrounds. Real AI engines are NOT called — this is a layout-only check.

## Step 2 — Verify size

Output must be exactly `750 x 3370`. Different size = layout regression in `build_seamless_layout()` or `compose_final_detail_page()`.

## Step 3 — Report path + size

```
[regen-thumbs] output/test_e2e_seamless.png — 750x3370 — <KB> KB
```

User will open the file in a viewer to verify. Do NOT analyze the image yourself.

## When NOT to use

- For real AI background generation → use `/api/generate-ai-detail` via the workspace UI (costs API credits)
- For deploying changes → use `/deploy` skill
- For broken imports → use `/smoke` skill
