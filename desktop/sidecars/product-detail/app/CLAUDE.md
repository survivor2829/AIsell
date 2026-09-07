# 产品详情图桌面模块

遵循 [仓库规则](../../../../AGENTS.md)。本目录由 Electron 作为 Python/Flask sidecar 启动；原项目的云部署与自主推送约定不适用于当前仓库。

- 入口：`desktop_entry.py`；启动协议、数据位置和构建方法见 [README.desktop.md](../README.desktop.md)。不要用 `python app.py` 的固定端口开发服务替代桌面验收。
- `desktop_entry.py` 管理 loopback、一次性 bootstrap 与控制令牌；`app.py`/`routes/` 处理 Web 功能，`ai_refine_v2/` 处理精修，`templates/` 和 `static/` 处理页面。
- 可变数据库、上传、输出和缓存写入启动参数 `--data-dir`，模板与冻结资源从源码读取。桌面 API Key 由主进程加密保存并注入，不能恢复旧的客户端传 Key 链路。
- 原项目 `docs/`、`README.md`、`DEPLOYMENT.md` 保留来源记录；当前能力与实测状态以仓库根 `PROJECT_STATUS.md` 为准。
- 按变更选择现有离线检查；`.claude/skills/smoke/SKILL.md` 列出桌面协议检查入口。页面改动需在桌面宿主验证缩放、隐藏恢复和导出，不以导入 Flask 成功代替页面验收。
