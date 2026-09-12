# AI获客 V1.0版本

Windows Electron 桌面应用。验收优先覆盖当前安装的主流个人微信，再用至少一个不同版本做兼容回归；具体实测版本、能力是否可用及是否经过本机或异机实测，以 [PROJECT_STATUS.md](PROJECT_STATUS.md) 为准。正式交付优先使用 `release/AI获客 V1.0版本-安装程序.exe`；`release/AI获客 V1.0版本.zip` 只作为免安装备用包。

## 本地运行

环境要求：Windows 10/11 x64、Node.js、已安装并登录的个人微信（优先使用当前主流版本；实际兼容范围按 [PROJECT_STATUS.md](PROJECT_STATUS.md) 的矩阵验收）。

```powershell
cd desktop
npm.cmd install
npm.cmd run desktop
```

浏览器预览只检查界面，不代表微信自动化可用：

```powershell
npm.cmd run dev
```

首次在任一电脑使用时，在应用中依次完成：

1. 保存并测试自己的 DeepSeek API Key。
2. 导入 AI 专家资料。
3. 同步当前微信账号的联系人。
4. 按 `PROJECT_STATUS.md` 的实机验收顺序测试，不直接使用历史任务状态。

## 检查与构建

日常内部更新统一优先采用组件增量，按 [内部更新标准](docs/internal-release.md) 执行：提交并通过 CI → `npm.cmd run release:internal` 构建增量候选 → 本机增量切换与数据保留验收 → 部署依赖服务 → `npm.cmd run publish:internal` 发布测试频道。首次安装、底座确实不兼容或需要离线安装器时才显式使用 `--full`。GitHub CI 与客户更新是两个独立阶段；推送代码不会自动给客户安装未经确认的版本。

以下命令均在 `desktop/` 运行：

```powershell
npm.cmd run check:self
npm.cmd run build:test
npm.cmd run build:delivery
```

构建本地内容能力的固定运行时：

```powershell
npm.cmd run build:product-detail
npm.cmd run build:content-engine
```

生成便携包：

```powershell
npm.cmd run release:test
npm.cmd run release:delivery
```

交给用户覆盖旧正式安装版时使用 `release/AI获客 V1.0版本-安装程序.exe`，并同时核对 `release/AI获客 V1.0版本-安装程序-版本清单.json`。收尾后的 `release/` 只保留当前安装器和清单；需要内部便携包时从当前源码重新运行发布命令，不再长期堆放旧 ZIP 和解压目录。

生成正式离线安装器：

```powershell
npm.cmd run release:installer
```

安装器按当前 Windows 用户安装到 `%LOCALAPPDATA%\Programs\AI获客`。后续拿到新安装器后直接双击即可覆盖升级，不需要先卸载或删除旧目录。程序文件与 `%APPDATA%\xiaoxi-active-touch-delivery\data` 中的 API Key、联系人、AI 专家资料、任务状态和诊断日志相互独立；覆盖升级不会删除这些数据，控制面板中的普通卸载也默认保留这些数据。`product-detail/` 和 `content-engine/` 同样保存在该 edition 的用户目录中，不写入安装目录。

产品详情图运行时已包含 `deepseek-v4-flash` 和 APIMart `gpt-image-2`/`https://api.apimart.ai/v1` 配置，用户在桌面“API 密钥”中分别填写两把 Key 后，可单击直接执行一键生成和 AI 精修；真实 Key 不会进入安装包。2026-08-03 用户已完成真实生成和结果下载到桌面的验收，详细边界以 `PROJECT_STATUS.md` 为准。

当前安装器尚未购买商业代码签名证书，Windows 可能显示“未知发布者”；分发前应同时提供安装器版本清单和 SHA256，验收人员核对后再运行。

`release:*` 会先执行 self-check 和对应 renderer 构建，再生成目录与 ZIP 并检查包内运行依赖和隐私文件。包含内容生产入口的正式 release 还必须同时使用与当前提交对应的 `product-detail` 和 `content-engine` 固定运行时；不能拿历史 runtime 与新源码混合打包。便携包必须完整解压后运行，不能只复制 EXE。构建通过不等于实机验收通过，也不自动获得“可分发”状态。当前各能力的真实状态仍只以 `PROJECT_STATUS.md` 为准。

## 本地数据目录

内部测试构建和正式交付构建使用不同的 Windows 用户目录：

```text
测试版：%APPDATA%\xiaoxi-active-touch-test\data
交付版：%APPDATA%\xiaoxi-active-touch-delivery\data
```

业务状态按目录隔离：

```text
contact_sync/    联系人同步过程状态
active_touch/    联系人清单、主动触达任务和发送账本
auto_reply/      自动回复监听、消息去重和诊断
moments/         朋友圈观察与动作账本
wechat_adapter/  共享微信窗口和适配信息，不保存业务结果
runtime_archive/ 数据迁移前的只读归档证据
```

内容生产的可变数据保存在同一 edition 的 Electron `userData` 根目录下，与现有 `data/` 业务目录并列：

```text
product-detail/  产品详情图的数据库、上传、输出和缓存
content-engine/  素材索引、任务、成片登记和可重建缓存设置
```

素材仓库只保存原片的索引和元数据；原始视频、图片仍保留在用户选择的位置，不会复制进应用数据目录。

仓库根 `outputs/` 用于本机成片、截图和验收过程文件，已从 Git 排除；可维护的工具放在 `desktop/scripts/`，正式验收结论放在 `docs/`。清理该目录时只删除已确认无用的缓存，保留原素材、已认可成片与必要回滚证据；忽略文件不等于删除文件。

`data/deepseek-api-key.bin` 由 Electron `safeStorage` 使用当前 Windows 用户凭据加密；`data/ai-expert.json` 保存规范化后的 AI 专家资料。运行数据、密钥、联系人和任务状态都不得打入源码包或 ZIP，也不应在两台电脑之间直接复制。
