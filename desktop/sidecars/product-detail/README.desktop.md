# 产品详情图桌面 Sidecar

此目录是“产品详情图”项目的冻结源码快照。桌面版通过
`app/desktop_entry.py` 启动，不使用原项目的 `app.py` 开发服务器。

## 启动契约

```powershell
python app/desktop_entry.py `
  --host 127.0.0.1 `
  --port 0 `
  --data-dir "D:\XiaoxiData\product-detail" `
  --bootstrap-token "<至少 32 字符的随机一次性令牌>" `
  --control-token "<至少 32 字符的随机控制令牌>"
```

启动成功后，stdout 只输出一行机器可读 JSON：

```json
{"event":"ready","host":"127.0.0.1","port":54321,"version":"2.0.0-desktop","capabilities":{}}
```

旧项目日志和请求日志不写 stdout；bootstrap/control token 也不会出现在响应或日志中。

桌面主进程随后访问：

- `GET /internal/health`
- `GET /desktop/bootstrap?token=...`（五分钟内、仅可使用一次）
- `POST /internal/shutdown`，请求头携带 `x-xiaoxi-control-token`

所有接口和服务端口仅允许 loopback。桌面模式隐藏普通注册及管理后台入口。

## 数据边界

模板与冻结静态资源从 `app/` 读取。首次运行只把缺失的静态资源复制到
`data-dir/static/`，已有文件永不覆盖。以下可变内容全部写入 `data-dir`：

- `database/wubaoyun.db`
- `static/uploads/`
- `output/`
- `static/outputs/`
- `static/cache/`
- `static/ai_refine_v2/`

可用下面的命令做不启动 HTTP 服务的环境检查：

```powershell
python app/desktop_entry.py --self-check --data-dir "D:\XiaoxiData\product-detail"
```

付费 API 未配置时 sidecar 仍可启动，`capabilities.paid_ai_ready` 为 `false`；
打开工作台不会触发任何付费调用。

## 验证

在 `app/` 下使用桌面构建虚拟环境：

```powershell
$env:PYTHONUTF8 = "1"
$env:PYTHONDONTWRITEBYTECODE = "1"
..\..\..\.build\product-detail-venv\Scripts\python.exe -m pytest -q
```

## 桌面安全收口

- `/static/uploads/<user>/` 与 `/static/outputs/<user>/` 只允许已登录的同一用户读取；批次文件继续走原有 owner 校验路由。
- `ai_refine_v2` 任务目录不通过公共 static 暴露。
- 原项目中允许客户端传密钥、文件路径或直接触发费用的 AI 接口，在桌面模式统一返回 `DESKTOP_PAID_ACTION_DISABLED`。只有完成费用预估、二次确认、幂等和单任务队列后才能逐项开放。
- SortableJS 1.15.6 与 JSZip 3.10.1 已固定版本并附许可证放入 `static/vendor/`；Google Fonts 网络引用已移除。
- Chromium 保持沙箱和 Web 安全开启；打包运行时内置受控 Playwright 浏览器。

## 构建与真实运行验收

在 `desktop/` 运行：

```powershell
npm.cmd run build:product-detail
node scripts/product-detail-runtime.integration.cjs
```

构建输出位于忽略目录 `.build/product-detail-runtime/`，根目录包含
`product-detail-server.exe`；同级 manifest 记录 EXE、整树哈希、冻结源版本和浏览器能力。
构建脚本采用 fresh-build：发现已有固定输出时拒绝覆盖，也不会自动删除任何旧构建目录。

当前完整 Python 回归结果为 `484 passed, 1 skipped, 134 subtests passed`；新增桌面契约、构建脚本自检和真实 EXE 集成验收均通过。冻结来源仓库未被修改，其 5 个已修改文件和 23 个未跟踪文件的哈希保存在 `source-snapshot.json`。

## 当前固定运行时边界

源码级本地 E2E 已验证上传、预览、PNG 导出与历史恢复；但现有 `.build/product-detail-runtime/` 固定运行时构建于离线工作流源码提交 `a17565f` 之前，不能当作该提交的正式交付物。当前构建/发布脚本会记录并复核本仓库产品详情图实际输入的 Git commit、scoped dirty 状态和确定性源码树哈希，因此旧 manifest 会被默认开发启动与正式发布前置检查同时拒绝，桌面端不会静默运行落后源码的默认 `.build` runtime。替换或删除这份旧 runtime 前，必须先向用户提交清理候选与影响说明并获得明确批准；获批后再从对应提交重新构建、复验，并以 `PROJECT_STATUS.md` 记录正式包状态。
