# 小玺 AI 员工

Electron 桌面端只提供两个版本：

```text
测试版：同步联系人 -> 编辑默认话术 -> 单联系人验收或每批最多 50 人真实发送
交付版：同步联系人 -> 编辑默认话术 -> 启动程序 -> 每批最多 50 人真实发送
```

测试版包含内部单联系人验收入口；交付版隐藏开发入口。两个版本复用同一套真实发送事务和安全门禁。

## 启动

开发环境：

```powershell
cd desktop
npm install
npm run desktop
```

构建检查：

```powershell
cd desktop
npm run build
npm run build:test
npm run build:delivery
npm run check:self
npm run release:test
npm run release:delivery
```

便携包：

```text
release\小玺AI员工-测试版.zip
release\小玺AI员工-交付版.zip
```

必须解压完整 ZIP 后运行，不能只复制 EXE。目标环境为 Windows 10/11 x64，并需安装、登录已验证版本的个人微信（当前清单记录为 4.1.11.24）。新电脑只需本软件和个人微信，无需 Node、Python、Codex 或 `dt-ai-helper`；DeepSeek Key 需要首次重新录入。当前 EXE/Helper 未签名，仍需完成干净电脑 Defender/SmartScreen 人工验收。

## 当前能力

- 启动后默认进入工作台，不再被本地假登录页拦住。
- `同步联系人` 从微信通讯录同步联系人，运行数据保存在当前 Windows 用户目录。
- `主动触达` 只保留客户主流程：话术输入、本次触达人数、任务状态和联系人预览。
- 默认触达话术直接填入编辑框，可原地修改；联系人预览展示全部同步联系人，不再只显示前 8 人。
- 在“账号管理 > DeepSeek API”保存用户自己的 API Key 后，主动触达会生成个性化草稿；缺少、无效、余额不足或超时时会明确暂停，不会回退固定模板。
- 右下角 `启动程序` 创建触达任务，主窗口隐藏，右侧悬浮窗显示当前联系人、下一位、进度和暂停原因。
- 微信窗口驱动只绑定个人微信主进程 `Weixin`、`WeChat`。
- 测试版可由用户明确选择一个测试联系人完成真实发送；账号、窗口、会话或身份无法唯一确认时会阻断，未知结果不会自动重试。
- 交付版调用同一发送事务：每次点击前重验账号/PID/句柄/会话，先持久化 `prepared`，再验证最新完整消息气泡；每批最多 50 人，下一批必须再次由用户点击授权。
- 任务状态持久化到当前 Windows 用户的应用数据目录，暂停后可继续；源码和 ZIP 不包含运行任务。

## 关键目录

```text
desktop/src/main/             Electron 主进程和 IPC
desktop/src/renderer/         React UI
desktop/rpa/contact_sync/     微信联系人同步执行器
desktop/rpa/active_touch/     主动触达状态机和窗口驱动
release/小玺AI员工-测试版/ 内部测试 portable 包
release/小玺AI员工-交付版/ 正式交付 portable 包
```

## 数据文件

- `contacts.json`：同步后的联系人入口，主动触达直接读取（位于当前 Windows 用户运行目录）。
- `touch_task.json`：当前触达任务进度。
- `state.json`、`run_logs.jsonl`：执行器运行状态和日志。

这些是本地运行数据，不是产品源码。

## 暂不做

- 不做超过每批 50 人的公开规模化发送。
- 当前不做许可证、远程停用、安装器、代码签名或自动更新。
- 不接自动回复、朋友圈点赞评论、短视频获客真实链路。
