# 2026-05-27 Python/Flask 环境恢复选项

> 用途：为闭环 `/batch/upload` 真实浏览器验证选择本地运行环境恢复方式。  
> 范围：只规划本地开发环境，不代表已授权安装依赖、联网下载、启动生产、连接生产 DB 或真实 API。

## 当前探针结论

已运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check_local_dev_env.ps1
```

当前机器状态：

- `git` 可用。
- `node` 可用。
- `docker` / `docker-compose` 未检测到；Docker 路线当前不能直接执行。
- `python` / `py` / `pip` 不在 PATH。
- Codex Desktop 捆绑 Python 可用：`C:\Users\Scott\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`，仅用于标准库静态检查，不是项目 Flask 环境。
- 用 Codex Desktop 捆绑 Python 跑 import 探针时，`flask` / `pytest` / `playwright` 均为 MISSING。
- 仓库内没有 `.venv` / `venv` Python。
- 常见本机 Python 安装目录未发现可直接复用的 `python.exe`：`%LOCALAPPDATA%\Programs\Python`、`C:\Program Files\Python*`、`C:\Program Files (x86)\Python*`。
- 仓库内未发现可离线安装的 wheelhouse；本机只看到 pip HTTP cache，不能当作完整依赖源。
- `requirements.txt`、`app.py`、`tests/test_batch_upload_ux.py` 存在。

因此，上传 UX 的无依赖 Node 检查可以继续跑；当前 Codex Desktop 捆绑 Python 也可用于标准库静态检查。完整 pytest、Flask 本地启动、真实浏览器 `/batch/upload` 手测仍需要先恢复项目 Python/Flask 环境，并使用本地测试账号登录；不使用生产账号或生产密码。

边界说明：Codex Desktop 捆绑 Python 不是本仓库 `.venv`，不能视作 Flask/pytest/Playwright 项目环境，只能作为无依赖验证的补充执行器。

## 三条恢复路线

| 路线 | 适合情况 | 需要授权吗 | 说明 |
|---|---|---|---|
| A. 指定已有 Python | 机器上有 Python，但不在 PATH；或用户知道非标准安装路径 | 不需要联网；只需要提供路径 | 用 `-Python C:\path\to\python.exe` 跑探针和一键检查 |
| B. 创建本仓库 `.venv` | 本机没有可用项目环境，需要新建 | 需要授权安装依赖，通常需要网络 | 当前最可能路线；安装 `requirements.txt`、pytest、Playwright 依赖后再跑测试 |
| C. Docker 本地开发 compose | 机器有 Docker/Compose，且允许构建镜像 | 需要授权；通常需要网络下载 apt/pip/Playwright/rembg 资源 | 当前机器未检测到 Docker 命令；`docker-compose.dev.yml` 可用于本地开发验证，但构建成本比 `.venv` 更大 |
| D. 切到已配置机器/服务器 | 本机不适合装依赖，已有可运行环境 | 如果涉及服务器/SSH/prod 需要授权 | 只在非生产或明确授权环境执行验证 |

## 推荐顺序

1. 先确认是否有现成 Python 路径；当前自动探针没有在常见安装目录找到。
2. 如果有，运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check_local_dev_env.ps1 -Python C:\path\to\python.exe
powershell -ExecutionPolicy Bypass -File scripts/verify_2026_05_27_handoff_all.ps1 -Python C:\path\to\python.exe
```

3. 如果没有现成 Python，再决定是否创建 `.venv`。
4. 如果用户明确想走容器，再先确认 Docker/Compose 可用；当前机器探针显示不可直接执行。
5. 只有在用户明确授权后，才安装依赖、构建镜像或访问网络。

## 选 2 时的最小执行顺序

当下一步选择 `2. restore Python/Flask environment` 时，按下面顺序执行，避免把“环境恢复”和“真实业务验证”混在一起：

1. 用户先提供现成 Python 路径，或明确授权创建 `.venv` 并安装依赖。
2. 如果有现成 Python，先只读验证该解释器是否可用：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check_local_dev_env.ps1 -Python C:\path\to\python.exe
powershell -ExecutionPolicy Bypass -File scripts/verify_2026_05_27_handoff_all.ps1 -Python C:\path\to\python.exe
```

3. 如果没有现成 Python，且用户明确授权创建 `.venv`，再执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap_local_dev_env.ps1 -ConfirmInstall
```

4. 如果 Python 在非标准路径，且用户明确授权创建 `.venv`，使用：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap_local_dev_env.ps1 -Python C:\path\to\python.exe -ConfirmInstall
```

5. 环境恢复后，先跑项目侧 pytest，再启动本地 Flask：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_batch_upload_ux.py tests/test_batch_progress_ui.py -q
.\.venv\Scripts\python.exe -m pytest tests/test_batch_pipeline_smoke.py -q
```

6. 最后按 `docs/2026-05-27_upload-ux-browser-validation-runbook.md` 用本地测试账号登录后做 `/batch/upload` 浏览器手测。

## `.venv` 恢复草案

以下命令仅作为授权后的草案，不应自动执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap_local_dev_env.ps1 -ConfirmInstall
```

如果 Python 在非标准路径：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap_local_dev_env.ps1 -Python C:\path\to\python.exe -ConfirmInstall
```

等价手动命令：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt pytest
.\.venv\Scripts\python.exe -m pytest tests/test_batch_upload_ux.py tests/test_batch_progress_ui.py -q
.\.venv\Scripts\python.exe -m pytest tests/test_batch_pipeline_smoke.py -q
```

如果 Playwright 浏览器二进制缺失，需另行确认是否安装；这通常涉及网络下载：

```powershell
.\.venv\Scripts\python.exe -m playwright install chromium
```

## 恢复后验收入口

环境恢复后，按以下顺序闭环：

1. 跑一键交接检查。
2. 跑上传 UX 相关 pytest。
3. 启动本地 Flask。
4. 按 `docs/2026-05-27_upload-ux-browser-validation-runbook.md` 用本地测试账号登录后做 `/batch/upload` 浏览器手测。

## 不做的事

- 不连接生产 DB。
- 不读取或修改 `.env` / `instance/` 真实敏感文件。
- 不触发真实 AI/API 调用。
- 不做 deploy、SSH、服务器升配。
- 不在未授权情况下安装依赖或下载浏览器二进制。
