---
name: smoke
description: Quick 5-step sanity check — imports, app boot, key endpoints, e2e composer test. Run after any code change to catch breakage in <30s.
model: haiku
allowed-tools:
  - Bash
  - Read
---

# Smoke Test

Run these 5 steps in order. If any fails, STOP and report the failure with the offending step number.

## Step 1 — Module imports

```bash
python -c "import ai_image, ai_image_volcengine, ai_image_router, image_composer, theme_color_flows; print('OK imports')"
```

Expected: `OK imports`. Any traceback = fail.

## Step 2 — App boot

```bash
HTTPS_PROXY="" HTTP_PROXY="" python -c "import app; print('routes:', len(list(app.app.url_map.iter_rules())))"
```

Expected: `routes: N` (N >= 30). Import errors = fail.

## Step 3 — Start app in background

```bash
HTTPS_PROXY="" HTTP_PROXY="" python app.py
```

Run in background. Wait 3 seconds then proceed to step 4.

## Step 4 — Hit key endpoints

```bash
curl -s http://localhost:5000/ -o /dev/null -w "%{http_code}"
curl -s http://localhost:5000/api/ai-engines -o /dev/null -w "%{http_code}"
```

Expected: both `200`. Anything else = fail.

## Step 5 — E2E composer test + cleanup

```bash
python test_seamless_e2e.py
taskkill //F //IM python.exe
```

Expected: `OK -> ... 750 x 3370`. Then kill the background app.

## Report format

On success:
```
[smoke] PASS — imports OK, app boot OK, /=200 /api/ai-engines=200, e2e=750x3370 PNG
```

On failure (example):
```
[smoke] FAIL at step 3 — app boot returned ImportError on `from foo import bar`
```
