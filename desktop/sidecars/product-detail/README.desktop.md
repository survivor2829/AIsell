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

模板与冻结静态资源从 `app/` 读取。静态资源按受控资源同步规则更新；用户上传及生成数据保留。以下可变内容全部写入 `data-dir`：

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
打开工作台、读取本人历史结果和普通模板预览都不会触发付费调用。当前桌面入口由
主进程按软件授权取得短期网关会话，向 sidecar 注入固定的 DeepSeek/APIMart 网关
地址和会话令牌；供应商原始密钥保留在服务器受保护配置，不进入客户安装包。
当前新精修使用 DeepSeek 策划与 APIMart `gpt-image-2.5-ext`（sunburst、2K）生图。模型组合在任务创建时冻结，报价、生成和重做复用同一组合；缺少组合字段的历史任务仍使用 `gpt-image-2/1K`。历史客户自配密钥
说明不代表当前平台网关模式；不能因旧设置文件存在就推断正在直连供应商。

完整连接是“安装软件 → 本机工作台 → 平台网关 → 模型供应商”。工作台源码、
产品上传、任务记录和导出都在本机，不依赖原详情图网站的域名或进程。停旧网站前
仍须保留其唯一历史数据，且不能一并关闭承载更新、授权或供应商网关的共用服务。
`paid_ai_ready` 只说明当前配置具备调用条件，不证明供应商网络、账户模型权限或
实际生图已经通过。服务器必须有独立可用的出站连接，不得依赖开发电脑临时转发。

2026-10-09 已按授权在现有服务器配置独立 `apimart-egress` 服务，网关使用受保护配置
中的专用回环代理；不改变系统代理、不要求客户安装代理软件。服务仅允许 APImart
的 HTTPS 接口，开机启动已启用且进程重启后查询通过。网关上传与无代理下载原图已
验证；这不替代模型出图、完整长图导出和异机安装验收。出口仍依赖现有网络服务的
有效节点与订阅，节点失效时在服务器维护，不把凭据下发到客户。部署与回滚记录见
`docs/handoff/2026-10-08-installed-closeout.md`（仓库根目录）。

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
- 原项目中允许客户端传密钥、文件路径或直接触发费用的旧 AI 接口继续返回 `DESKTOP_PAID_ACTION_DISABLED`。当前 AI 精修须具备 DeepSeek 与 APIMart 的平台调用能力；不要求客户再填写供应商原始密钥。打开页面本身不会发起付费请求，用户启动生成后按实际张数核价并预留预算。
- 付费任务使用持久化单任务账本；并发请求会被阻止，提交或轮询结果不明时状态写为 `outcome_unknown`，在用户核对 APIMart 并明确解除前不得自动重提。
- 新网关生图请求在 POST 前保存操作编号；断线或重启只查询原网关回执和原供应商任务。旧记录没有编号时不补造编号、不自动重新生成。下载失败只恢复已有图片，不能按失败图片重新计费购买。
- 新任务在购买策划前实际检查参考图上传通道；核价失败后继续仍保留待检查标记。上传失败不购买策划，已有策划或付费回执的旧任务按原记录恢复。免费 GET 在连接异常时可尝试有效直连路线，付费 POST 不因此重复发送。
- SortableJS 1.15.6 与 JSZip 3.10.1 已固定版本并附许可证放入 `static/vendor/`；Google Fonts 网络引用已移除。
- Chromium 保持沙箱和 Web 安全开启；产品详情图复用便携包 `resources/content-engine/browser/chrome.exe` 这一份受控 Chromium，不再在 Python sidecar 内重复携带浏览器。

## 构建与真实运行验收

在 `desktop/` 运行：

```powershell
npm.cmd run build:product-detail
node scripts/product-detail-runtime.integration.cjs
```

构建输出位于忽略目录 `.build/product-detail-runtime/`，根目录包含
`product-detail-server.exe`；同级 manifest 记录 EXE、整树哈希和冻结源版本。上述独立集成检查验证 sidecar 启停；完整的 Chromium 启动验证由 `npm.cmd run release:test` 在便携包内执行。若要在独立检查中同时验证浏览器，先显式设置 `XIAOXI_PRODUCT_DETAIL_BROWSER_PATH` 为经审计的绝对 `chrome.exe` 路径。
构建脚本采用 fresh-build：发现已有固定输出时拒绝覆盖。成功后清理本次生成的工作、规格及自检临时目录，已有历史构建不自动删除。

### 2026-09-09 本地修复（未发布）

- 桌面工作台分为编辑资料、选择模板、查看大图；窄窗口按内容高度堆叠，保留滚动入口。
- 上传产品图使用包内 ONNX Runtime 与 ISNet 模型离线抠图；透明图片直接保留。失败时显示明确提示并保留原图，不在客户电脑下载模型。
- 构建前运行 `node scripts/prepare-cutout-model.cjs` 下载并校验配置中固定 SHA256 的模型（约 170 MiB）。模型、运行库和许可证随组件打包，构建自检要求离线抠图能力可用。
- 本轮实际组件已验证透明 PNG 上传结果及 1500 × 3632 PNG 导出；付费模型接口未调用。历史全量验证数字属于下述当时版本，不代表本轮重跑。

当前产品详情图 Python 全量回归为 `550 passed, 1 skipped, 134 subtests passed`；APIMart 状态与单任务账本专项 `20 passed`。本地无头 Chromium 在 `1440px` 宿主下测得 iframe 内容宽 `1090px`、缩放 `0.7053`，在 `1920px` 宿主下测得 iframe 内容宽 `1570px`、缩放为 `1`；单个隐藏恢复、全部恢复、重启恢复和 PNG 导出均通过。“一键生成”连续触发两次仍只有一次解析和一次排版；“AI精修”连续触发两次仍只有一次提交、零费用弹窗、零费用估算请求。导出 PNG 为 `2,196,564` bytes，SHA256 为 `d6a7d882bac2a0fd8183658957ad1ade4f2ca372c09abe691d9842ebbf52b901`。本轮浏览器证据拦截了付费接口，没有使用真实 Key 调用模型。

## 当前固定运行时边界

2026-07-31 已按用户授权把旧固定运行时移入 `.build/backups/`，并从干净提交重新生成 `.build/product-detail-runtime/`。manifest 会复核 Git commit、scoped dirty 状态和确定性源码树哈希；默认开发启动与正式发布前置检查都会拒绝缺少这些证明或与当前提交不一致的 runtime。2026-08-03 源码已改为单击直接生成，并修复 APIMart `pending` 正常排队态误判；状态查询发生短暂断线时只会有界重查同一 task，不会重新 POST 生图。同提交固定运行时、便携包和安装程序已重新生成，并通过包内 sidecar 自检与发布包检查。安装包不含真实 Key；用户已使用本人 DeepSeek/APIMart Key 成功生成 AI 精修结果并确认整体流程验收通过。无 Python/Docker 净机复验属于非阻断工程补充，状态统一以 `PROJECT_STATUS.md` 为准。
