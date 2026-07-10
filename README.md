# 小玺 AI 员工

Electron 桌面端，当前主线是客户版主动触达 V1：

```text
同步微信联系人 -> 填写触达话术 -> 启动程序 -> 悬浮窗显示进度 -> 微信逐个写入草稿
```

V1 安全边界：只打开会话、写入草稿并做预检，不自动真实发送。

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
node rpa\contact_sync\self_check.cjs
node rpa\active_touch\self_check.cjs
```

当前 portable 包：

```text
release\小玺AI员工\小玺AI员工.exe
```

## 当前能力

- 启动后默认进入工作台，不再被本地假登录页拦住。
- `同步联系人` 从微信通讯录同步联系人，运行数据保存在当前 Windows 用户目录。
- `主动触达` 只保留客户主流程：话术输入、本次触达人数、任务状态和联系人预览。
- 在“账号管理 > DeepSeek API”保存用户自己的 API Key 后，主动触达会生成个性化草稿；缺少、无效、余额不足或超时时会明确暂停，不会回退固定模板。
- 右下角 `启动程序` 创建触达任务，主窗口隐藏，右侧悬浮窗显示当前联系人、下一位、进度和暂停原因。
- 微信窗口驱动兼容 `Weixin`、`WeChat`、`WeChatAppEx`。
- 任务状态持久化到 `rpa/active_touch/touch_task.json`，暂停后可继续。

## 关键目录

```text
desktop/src/main/             Electron 主进程和 IPC
desktop/src/renderer/         React UI
desktop/rpa/contact_sync/     微信联系人同步执行器
desktop/rpa/active_touch/     主动触达状态机和窗口驱动
release/小玺AI员工/           当前 portable 包
```

## 数据文件

- `contacts.json`：同步后的联系人入口，主动触达直接读取（位于当前 Windows 用户运行目录）。
- `touch_task.json`：当前触达任务进度。
- `state.json`、`run_logs.jsonl`：执行器运行状态和日志。

这些是本地运行数据，不是产品源码。

## 暂不做

- 不做全量自动真实发送。
- 当前稳定链路仍只写草稿，不自动真实发送。
- 不接自动回复、朋友圈点赞评论、短视频获客真实链路。
