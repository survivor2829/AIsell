# 批量上传 UX 快赢实施计划

> 日期：2026-05-27
> 状态：已实施，无依赖静态/语法/运行时 smoke 通过，待真实浏览器手动验证
> 目的：在不花 API 费用、不触碰生产环境的前提下，优先修复批量上传阶段的“卡住感”和文件夹选择点击不稳问题。

## 背景

`PROJECT_STATUS_批量生成.md` 阶段八曾记录：87MB 批次上传时只有纯文字反馈，用户容易误以为页面卡死。同时文件夹 picker 的图标/文字点击在部分 Windows Chrome 场景下不稳定。

实施前代码复核：

- `batch_processor.py` 已有 `_publish_stage()`，每产品阶段进度事件已落地。
- `templates/batch/upload.html` 已支持 stage pill 和 WebSocket 刷新。
- `templates/batch/upload.html` 仍使用 `fetch('/api/batch/upload', ...)`，无法拿到 upload progress。
- `.picker .icon/.hint/.sub` 目前没有 `pointer-events: none`，也没有 picker click 兜底触发 `folderInput.click()`。

## 目标

1. 点击 picker 的图标、文字、空白区域都能稳定打开文件夹选择。
2. 上传 zip 时显示百分比、速度和预估剩余时间。
3. 上传失败时保留当前错误信息，不吞后端返回。
4. 不改变后端 API，不引入新依赖，不触发真实 AI 调用。

## 非目标

- 不改 JSZip 打包策略。
- 不做客户端图片压缩。
- 不改批量处理后端队列。
- 不改 AI 精修阶段进度逻辑。
- 不 deploy，不跑 prod。

## 改动范围

| 文件 | 改动 |
|---|---|
| `templates/batch/upload.html` | picker 点击稳定化；上传从 `fetch` 改为 `XMLHttpRequest`；新增进度文案 |
| `tests/test_batch_upload_ux.py` | 新增源码守护测，防止回退到无进度上传 |
| `scripts/verify_batch_upload_ux_static.py` | 新增无 pytest 依赖的标准库静态验证脚本 |
| `scripts/verify_batch_upload_inline_js_syntax.js` | 新增无 Flask 依赖的内联 JS 语法检查脚本 |
| `scripts/verify_batch_upload_runtime_smoke.js` | 新增无 Flask 依赖的上传页运行时 smoke |
| `scripts/verify_batch_upload_ux_all.js` | 新增一键运行无依赖上传 UX 验证入口 |
| `docs/2026-05-27_upload-ux-browser-validation-runbook.md` | 新增真实浏览器验收 runbook |

## 实施步骤

### Step 1：picker 点击稳定化

CSS：

```css
.picker .icon,
.picker .hint,
.picker .sub {
  pointer-events: none;
}
```

JS：

```js
picker.addEventListener('click', (e) => {
  if (e.target !== folderInput) folderInput.click();
});
```

注意：

- `folderInput` 仍保留在 `label` 内。
- 避免在 input 自己触发时重复 click。
- 手测点击图标、文字、空白区域三处。

### Step 2：抽出 XHR 上传 helper

新增函数建议：

```js
function uploadBatchForm(fd, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/batch/upload');
    xhr.setRequestHeader('X-CSRFToken', csrfToken);
    xhr.upload.onprogress = onProgress;
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data, statusText: xhr.statusText });
    };
    xhr.onerror = () => reject(new Error('网络异常'));
    xhr.send(fd);
  });
}
```

### Step 3：显示上传速度和 ETA

在 `btnUpload` click handler 中记录：

- `uploadStart = performance.now()`
- `lastLoaded`
- `loaded / total`
- `speed = loaded / elapsed`
- `remaining = (total - loaded) / speed`

文案示例：

```text
上传中 37% · 2.1 MB/s · 剩余 45s
```

边界：

- `e.lengthComputable === false` 时显示 `上传中 ${(loaded/1024/1024).toFixed(1)} MB`。
- `speed <= 0` 时不显示 ETA。
- 上传完成后继续沿用现有 `识别完成: N 个有效产品 / M 个跳过` 文案。

### Step 4：保留错误行为

XHR 返回非 2xx 时，应保持现在的错误语义：

```js
setStatus(`上传失败 ${status}: ${data.error || statusText}`, 'error');
```

### Step 5：新增守护测

`tests/test_batch_upload_ux.py` 建议覆盖：

- picker 子元素必须 `pointer-events: none`。
- picker 必须有 click 兜底调用 `folderInput.click()`。
- `/api/batch/upload` 上传不再使用 `fetch`。
- 必须出现 `XMLHttpRequest`。
- 必须使用 `xhr.upload.onprogress`。
- 上传文案必须包含百分比/速度/剩余时间相关逻辑。

## 验证清单

### 自动验证

受当前本机限制，`python` / `py` 暂不可用。恢复 Python 后运行：

```bash
python -m pytest tests/test_batch_upload_ux.py -q
python -m pytest tests/test_batch_progress_ui.py tests/test_batch_pipeline_smoke.py -q
```

当前环境若没有 pytest，可先运行轻量静态验证：

```bash
python scripts/verify_batch_upload_ux_static.py
node scripts/verify_batch_upload_inline_js_syntax.js
node scripts/verify_batch_upload_runtime_smoke.js
```

若当前环境只有 Node，可直接运行：

```bash
node scripts/verify_batch_upload_ux_all.js
```

该入口会强制运行内联 JS 语法检查和运行时 smoke；如果环境里能找到 Python，额外运行静态验证；在 Codex Desktop 环境中，即使 PATH 没有 Python，也会回退到捆绑 Python 跑标准库静态检查。

### 手动验证

详细步骤见 `docs/2026-05-27_upload-ux-browser-validation-runbook.md`。

- [ ] 使用本地测试账号登录，不使用生产账号或生产密码。
- [ ] 打开 `/batch/upload`。
- [ ] 点击文件夹图标，弹出文件夹选择。
- [ ] 点击“选择产品文件夹”文字，弹出文件夹选择。
- [ ] 点击 picker 空白区域，弹出文件夹选择。
- [ ] 选择一个 50MB+ 测试批次。
- [ ] 打包阶段显示“打包中”。
- [ ] 上传阶段显示百分比、MB/s、剩余秒数。
- [ ] 上传完成后显示有效/跳过数量。
- [ ] 后续批量处理 stage pill 正常变化。

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| XHR JSON 解析失败 | catch 后给空对象，保留 statusText |
| CSRF 头漏传 | 守护测检查 `setRequestHeader('X-CSRFToken', csrfToken)` |
| 重复触发文件选择 | click handler 避免 `e.target === folderInput` |
| 浏览器目录上传行为差异 | 只增强点击入口，不改 input 属性 |

回滚：

- 恢复 `fetch('/api/batch/upload', ...)` 原上传段。
- 删除 `uploadBatchForm()` 与进度文案逻辑。
- 删除 picker click 兜底和 CSS pointer-events。

## 决策建议

若暂时没有 P5.6 真测样本或费用授权，优先实施本计划。它不烧钱、不依赖 AI 服务，且能改善当前最容易被用户感知的等待焦虑。

## 实施记录

2026-05-27 已完成：

- `templates/batch/upload.html` 增加 picker 子元素 `pointer-events: none`。
- `templates/batch/upload.html` 增加 picker click 兜底，使用 `preventDefault()` 后触发 `folderInput.click()`。
- `/api/batch/upload` 上传从 `fetch` 改为 `XMLHttpRequest`。
- 上传阶段新增百分比、速度、剩余时间文案。
- 新增 `tests/test_batch_upload_ux.py` 源码守护测。
- 新增 `scripts/verify_batch_upload_ux_static.py`，用于无 pytest 环境的轻量静态验证。
- 新增 `scripts/verify_batch_upload_inline_js_syntax.js`，用于无 Flask 环境的内联 JS 语法检查。
- 新增 `scripts/verify_batch_upload_runtime_smoke.js`，用最小 DOM/XHR stub 模拟 picker 点击、文件选择、XHR 上传进度文案、上传成功路径、后端错误路径，以及成功/失败后的按钮恢复。
- 新增 `scripts/verify_batch_upload_ux_all.js`，用于一键运行当前环境可执行的无依赖上传 UX 验证；PATH 无 Python 时可回退到 Codex 捆绑 Python 跑静态检查和源码守护测；一旦找到 Python，这些 Python 检查失败会让 wrapper 失败退出。
- 新增 `docs/2026-05-27_upload-ux-browser-validation-runbook.md`，把真实浏览器验收拆成可执行步骤。

验证状态：

- 已用 `rg` 静态确认关键实现存在，且 `fetch('/api/batch/upload'` 不再出现。
- 系统 PATH 下 `python -m pytest tests/test_batch_upload_ux.py -q` 未运行成功：当前本机 PowerShell 找不到 `python` 命令。
- Codex 捆绑 Python 可用，但未安装 pytest；已用标准库 runner 直接执行源码守护断言：
  - `tests/test_batch_upload_ux.py`：6 tests run
  - `tests/test_batch_progress_ui.py`：4 tests run
- Codex 捆绑 Node 已对 `templates/batch/upload.html` 的 1 个内联脚本做语法编译检查：`compiled inline scripts: 1`
- Codex 捆绑 Node 已运行 `scripts/verify_batch_upload_inline_js_syntax.js`：`compiled inline scripts: 1`
- Codex 捆绑 Node 已运行 `scripts/verify_batch_upload_runtime_smoke.js`：`batch upload runtime smoke passed`
- Codex 捆绑 Node 已运行 `scripts/verify_batch_upload_ux_all.js`：`compiled inline scripts: 1` / `batch upload runtime smoke passed` / `using Python static verifier: C:\Users\Scott\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe` / `batch upload UX static checks passed` / `stdlib source guard tests passed: 10 tests across 2 files` / `all batch upload UX checks passed`
- 未发现项目内 `.venv` / `venv`，也未发现 PATH 可用的 `python` / `py` / `pip`；完整 pytest 与 Flask 浏览器验证需先恢复项目 Python 环境。
- Codex 捆绑 Python 已运行 `scripts/verify_batch_upload_ux_static.py`：`batch upload UX static checks passed`
- 曾尝试连接 Codex in-app browser 做 file-level 验证，但当前浏览器 runtime 未能启动；此项不视为页面代码失败，仍需后续用真实浏览器登录本地测试账号后打开 `/batch/upload` 手测。
