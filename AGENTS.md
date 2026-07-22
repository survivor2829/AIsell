# Repository Guidelines

## 项目定位

这是一个面向个人微信 `4.1.11.54` 的 Windows Electron 桌面应用。当前修复主线先恢复联系人同步、自动回复和主动触达的可重复验收，再继续扩展朋友圈自动化。能力与验证状态只以 `PROJECT_STATUS.md` 为准。

## 结构与边界

- `desktop/src/renderer/`：React 界面与展示状态，不直接操作微信或读取密钥。
- `desktop/src/main/`：Electron 主进程、IPC、运行协调、AI 与本地数据入口。
- `desktop/rpa/`：联系人同步、微信窗口适配和业务执行器。
- `desktop/scripts/`：self-check、构建和便携包生成。
- `release/`：生成物，不直接编辑；只从 `desktop/` 重建。

运行状态必须按业务隔离：`contact_sync/`、`active_touch/`、`auto_reply/`、`moments/` 分别保存；`wechat_adapter/` 只保存共享适配信息，不保存业务发送结果。

## 开发与验证

在 `desktop/` 运行：

```powershell
npm.cmd install
npm.cmd run desktop
npm.cmd run check:self
npm.cmd run build:test
npm.cmd run build:delivery
```

生成便携包前运行 `npm.cmd run release:test` 或 `npm.cmd run release:delivery`。真实微信验收不能由 self-check 或构建结果替代。

## 代码约定

TypeScript/JavaScript 使用 2 空格缩进和双引号；CSS 类名使用 kebab-case。微信/RPA 操作必须经过主进程 IPC 和本地执行器。优先复用共享适配器，避免在功能模块中散落窗口尺寸、DPI、坐标和微信版本判断。

## 安全与发布

- 未经用户明确授权，只运行 self-check、dry-run 或只读诊断；授权后的真实发送仅限明确的测试账号和联系人。
- 发送结果不确定时不得自动补发；运行态波动应隔离当前对象，不得伪装成成功。
- DeepSeek Key 不进入源码、Git、日志或 ZIP，只保存在当前 Windows 用户的加密运行目录。
- 不从 dirty worktree 对外发布。提交、构建、包内 manifest 和实机验收必须指向同一版本。
- 删除旧运行时、构建目录、旧脚本或发布物前，先提交清理候选报告并取得用户确认。
