# 2026-05-27 上传 UX 浏览器验证 Runbook

> 目的：闭环 `templates/batch/upload.html` 的上传 UX 快赢改动。  
> 范围：只验证本地 `/batch/upload` 页面交互，不触发真实 AI 生成，不碰生产环境。
> 结果记录：填入 `docs/2026-05-27_upload-ux-browser-validation-report.md`。

## 验证目标

1. 文件夹 picker 的图标、文字、空白区域都能稳定弹出文件夹选择。
2. 浏览器打包阶段仍能正常生成 zip。
3. `/api/batch/upload` 上传阶段显示百分比、速度、剩余时间。
4. 后端返回错误时，页面保留 `上传失败 <status>: <error>` 文案。
5. 上传成功或失败后，按钮状态能恢复，不把用户卡死在禁用状态。

## 前置条件

- 本地 Flask 环境可启动。
- 已有本地可登录账号，且账号 `is_approved=True`；不要使用生产账号或生产密码。
- 有一个不含真实客户敏感信息的测试产品文件夹。
- 不填写、不使用真实生产 API key。
- 不连接生产数据库。

如果本机暂时没有可用 Python/Flask 环境，先只运行轻量验证：

```bash
node scripts/verify_batch_upload_ux_all.js
python scripts/verify_batch_upload_ux_static.py
```

也可以先运行只读环境探针，确认 PATH、`.venv`、Flask/pytest/Playwright 是否可用：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check_local_dev_env.ps1
```

若探针仍显示 Python/Flask 不可用，先按 `docs/2026-05-27_python-flask-env-recovery-options.md` 选择恢复路线。

授权创建本仓库 `.venv` 时，可使用：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap_local_dev_env.ps1 -ConfirmInstall
```

## 建议测试素材

可直接生成一份非敏感本地样本：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/make_upload_ux_sample.ps1
```

如需观察更明显的上传进度，可额外生成指定大小的填充文件：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/make_upload_ux_sample.ps1 -LargeMB 50
```

生成目录默认位于 `test_batch_input/upload_ux_sample`，该目录已被 `.gitignore` 忽略。一键交接检查会确认样本目录存在、被 git 忽略、包含 2 个产品目录和 6 个产品文件，且 `info.txt` 标记为 synthetic sample / no real customer data。`-LargeMB` 只会额外添加上传进度填充文件，不改变这 6 个标准产品文件的校验口径。

准备一个本地测试目录，例如：

```text
test_batch_input/upload_ux_sample/
  sample-product-a/
    main.png
    detail-1.png
    info.txt
  sample-product-b/
    main.png
    detail-1.png
    info.txt
```

素材要求：

- 图片可用任意非敏感测试图。
- 默认样本中的 `main.png` / `detail-1.png` 为合成 1x1 PNG，`info.txt` 不含真实客户数据。
- 先用小目录验证 picker 和成功路径。
- 再用 50MB+ 目录验证上传进度是否明显可见。

## 启动方式

优先使用项目原本的本地启动方式。若尚未恢复环境，先不要强行安装依赖或连接生产。

恢复环境后优先运行：

```bash
python -m pytest tests/test_batch_upload_ux.py tests/test_batch_progress_ui.py -q
python -m pytest tests/test_batch_pipeline_smoke.py -q
```

然后启动本地 Flask：

```bash
python app.py
```

确认登录态：

```text
http://127.0.0.1:5000/auth/login
```

说明：

- `/batch/upload` 受 `@login_required` 保护，未登录时会跳转到登录页；这不算上传页渲染失败。
- 如本地库里没有可用账号，环境恢复后可用项目 CLI 创建本地管理员账号：`flask --app app create-admin`。
- 若走注册页创建普通账号，还需要管理员审核通过后才能登录；不要为了手测改用生产账号。

打开：

```text
http://127.0.0.1:5000/batch/upload
```

## 手动验收步骤

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 打开 `/auth/login` 并登录本地测试账号 | 登录成功后可进入首页或目标页面 |
| 2 | 打开 `/batch/upload` | 页面正常渲染，无控制台初始化错误；若跳登录页，先处理账号/审核状态 |
| 3 | 点击 picker 图标 | 弹出文件夹选择 |
| 4 | 点击 picker 文字 | 弹出文件夹选择 |
| 5 | 点击 picker 空白区域 | 弹出文件夹选择 |
| 6 | 选择小测试目录 | 页面显示待上传文件/产品数量，上传按钮可用 |
| 7 | 点击上传 | 先显示浏览器打包状态 |
| 8 | 观察上传阶段 | 出现 `上传中 xx%`、速度、剩余时间 |
| 9 | 上传成功 | 显示有效/跳过数量，按钮恢复可用 |
| 10 | 使用错误素材或模拟后端错误 | 显示 `上传失败 <status>: <error>`，按钮恢复可用 |

## 通过标准

- picker 三种点击入口全部可弹出选择。
- 上传进度不是纯静态文案，能随 `xhr.upload.onprogress` 更新。
- 成功路径不影响后续批量阶段 UI。
- 失败路径不吞后端错误。
- 无真实 API 花费、无生产变更。

## 失败记录模板

```text
验证时间：
浏览器：
测试目录大小：
失败步骤：
页面文案：
控制台错误：
Network 响应：
是否可复现：
初步判断：
```

## 回滚判断

只有在真实浏览器验证发现以下问题时，才考虑回滚上传 UX 改动：

- picker 无法弹出文件夹选择，且不是浏览器权限限制。
- XHR 上传破坏 CSRF 或后端接收行为。
- 上传成功后批次无法创建。
- 失败后按钮长期不可用。

回滚范围见 `docs/2026-05-27_upload-ux-quick-win-plan.md` 的“风险与回滚”。
