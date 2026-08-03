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
打开工作台、读取本人历史结果和普通模板预览都不会触发付费调用。桌面端只要求
用户分别填写 DeepSeek 与 APIMart Key，密钥由当前 Windows 用户的 `safeStorage`
加密；DeepSeek 固定使用官方 `https://api.deepseek.com/v1/chat/completions` 和
`deepseek-v4-flash`，APIMart 固定使用官方 `https://api.apimart.ai/v1` 和
`gpt-image-2`，不允许在桌面界面改成其他供应商地址或模型。

## 验证

在 `app/` 下使用桌面构建虚拟环境：

```powershell
$env:PYTHONUTF8 = "1"
$env:PYTHONDONTWRITEBYTECODE = "1"
..\..\..\.build\product-detail-venv\Scripts\python.exe -m pytest -q
```

## 桌面安全收口

- `/static/uploads/<user>/` 与 `/static/outputs/<user>/` 只允许已登录的同一用户读取；批次文件继续走原有 owner 校验路由。
- `ai_refine_v2` 任务目录必须登录并通过任务 owner 校验；删除 Key 后本人仍可读取已完成的本地历史，其他用户返回 `403`。
- 原项目中允许客户端传密钥、文件路径或直接触发费用的旧 AI 接口继续返回 `DESKTOP_PAID_ACTION_DISABLED`。新的 AI 精修只有在 DeepSeek 与 APIMart 两把 Key 均可用时才开放；用户点击“AI精修”后直接开始，不再增加费用估算和二次确认步骤。按钮旁明确说明会调用 APIMart，打开页面本身仍不会发起付费请求。
- 付费任务使用持久化单任务账本；并发请求会被阻止，提交或轮询结果不明时状态写为 `outcome_unknown`，在用户核对 APIMart 并明确解除前不得自动重提。
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

当前产品详情图 Python 全量回归为 `550 passed, 1 skipped, 134 subtests passed`；APIMart 状态与单任务账本专项 `20 passed`。本地无头 Chromium 在 `1440px` 宿主下测得 iframe 内容宽 `1090px`、缩放 `0.7053`，在 `1920px` 宿主下测得 iframe 内容宽 `1570px`、缩放为 `1`；单个隐藏恢复、全部恢复、重启恢复和 PNG 导出均通过。“一键生成”连续触发两次仍只有一次解析和一次排版；“AI精修”连续触发两次仍只有一次提交、零费用弹窗、零费用估算请求。导出 PNG 为 `2,196,564` bytes，SHA256 为 `d6a7d882bac2a0fd8183658957ad1ade4f2ca372c09abe691d9842ebbf52b901`。本轮浏览器证据拦截了付费接口，没有使用真实 Key 调用模型。

## 当前固定运行时边界

2026-07-31 已按用户授权把旧固定运行时移入 `.build/backups/`，并从干净提交重新生成 `.build/product-detail-runtime/`。manifest 会复核 Git commit、scoped dirty 状态和确定性源码树哈希；默认开发启动与正式发布前置检查都会拒绝缺少这些证明或与当前提交不一致的 runtime。2026-08-03 源码已改为单击直接生成，并修复 APIMart `pending` 正常排队态误判；状态查询发生短暂断线时只会有界重查同一 task，不会重新 POST 生图。同提交固定运行时、便携包和安装程序已重新生成，并通过包内 sidecar 自检与发布包检查。安装包不含真实 Key；用户已使用本人 DeepSeek/APIMart Key 成功生成 AI 精修结果并确认整体流程验收通过。无 Python/Docker 净机复验属于非阻断工程补充，状态统一以 `PROJECT_STATUS.md` 为准。
