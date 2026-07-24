# AI获客

Windows Electron 桌面应用。当前唯一验收目标是个人微信 `4.1.11.54`；能力是否可用、是否经过本机或异机实测，以 [PROJECT_STATUS.md](PROJECT_STATUS.md) 为准。正式交付优先使用 `release/AI获客-安装程序.exe`；`release/AI获客.zip` 只作为免安装备用包。

## 本地运行

环境要求：Windows 10/11 x64、Node.js、已安装并登录的个人微信 `4.1.11.54`。

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

以下命令均在 `desktop/` 运行：

```powershell
npm.cmd run check:self
npm.cmd run build:test
npm.cmd run build:delivery
```

生成便携包：

```powershell
npm.cmd run release:test
npm.cmd run release:delivery
```

生成正式离线安装器：

```powershell
npm.cmd run release:installer
```

安装器按当前 Windows 用户安装到 `%LOCALAPPDATA%\Programs\AI获客`。后续拿到新安装器后直接双击即可覆盖升级，不需要先卸载或删除旧目录。程序文件与 `%APPDATA%\xiaoxi-active-touch-delivery\data` 中的 API Key、联系人、AI 专家资料、任务状态和诊断日志相互独立；覆盖升级不会删除这些数据，控制面板中的普通卸载也默认保留这些数据。

当前安装器尚未购买商业代码签名证书，Windows 可能显示“未知发布者”；分发前应同时提供安装器版本清单和 SHA256，验收人员核对后再运行。

`release:*` 会先执行 self-check 和对应 renderer 构建，再生成目录与 ZIP 并检查包内运行依赖和隐私文件。便携包必须完整解压后运行，不能只复制 EXE。构建通过不等于实机验收通过，也不自动获得“可分发”状态。

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

`data/deepseek-api-key.bin` 由 Electron `safeStorage` 使用当前 Windows 用户凭据加密；`data/ai-expert.json` 保存规范化后的 AI 专家资料。运行数据、密钥、联系人和任务状态都不得打入源码包或 ZIP，也不应在两台电脑之间直接复制。
