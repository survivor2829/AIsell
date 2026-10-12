# 2026-10-12 客户更新故障与三版界面样稿

## 当前状态

工作分支：`codex/visual-guidance-update-recovery`，从 `origin/main` 的 `4ac0e8b` 创建。没有推送、合并、部署或发布。正式频道与付费搜索状态未改。

用户要求先看三版高保真图再选 UI 方向；生产 UI 未改，原制作流程未改。更新问题独立诊断并修复源码，不能把源码通过说成旧客户已能升级。

## 更新故障

用户另一台电脑截图：1.1.64 → 1.1.77，“备份业务数据失败”，`EPERM`，错误位置为安装目录 `resources`。这表示失败发生在安装前备份阶段。截图未包含 `failure.syscall`，尚不能排除该电脑另有 ACL/占用问题。

高度吻合的代码链：产品详情在资料目录 `product-detail/.runtime-links` 建立指向安装 `resources` 的 junction；旧 `fs.cp` 复制链接时未指定 junction 类型，普通用户缺少 symlink 权限会失败。本机启用 Developer Mode，之前本机成功不能覆盖普通电脑权限。

已完成四文件最小修复：

- `desktop/src/main/update-storage.cjs` 精确排除可重建运行时链接，统一 `copyProfile`；正常业务目录链接显式按 junction 复制，不遍历外部素材树。
- `desktop/src/main/update-backups.cjs` 与 `desktop/scripts/backup-local-install.cjs` 复用该复制方式；业务链接目标变更会阻止淘汰旧备份。
- 在现有 `desktop/scripts/update-backups.self_check.cjs` 增加本次故障链验证，没有新增整套测试框架。

语法检查、`node scripts/update-backups.self_check.cjs`、`node scripts/update-helper.electron.self_check.cjs` 均退出 0 且有 passed；`git diff --check` 通过。无 symlink 权限为故障注入，真实 junction 在非提升进程创建；本机 Developer Mode 未改，未声称真实普通客户环境通过。离线目标/文件 symlink 仍可能受权限限制，失败保持数据与诊断。

旧 1.1.64 不能只靠最新完整包修复：第一次备份仍是旧代码。1.1.58 底座桥接增量能避开首次资料备份，随后活动 application 中的修补可用于下一次完整升级；但还未制作、发布、完成这条真实链路。58/75/77/79 不同底座的旧请求均不带自身版本/底座，单份 v2 清单不能可靠分流。完整矩阵和下一步边界见 [更新兼容补充](../update-compatibility.md)。不要用 IP 猜客户底座，不绕过验签或降级保护。

## 供用户选择的 UI

样稿位于本机：

`D:/OpenAI/CodexHome/visualizations/2026/10/11/01a12b43-4ec5-7172-a60d-d533396fee9b/ui-options/`

- `A.png`：边看边做，左侧短演示、右侧完成当前操作。
- `B.png`：三步制作，上传素材 → 选择画面 → 确认制作。
- `C.png`：先选效果，先看方向示例，再放入人物与产品。
- `index.html`：可点击浏览三版、首页、详情图、素材库、教程、AI混剪和产品效果视频；上传/制作仅明确提示为样稿，不调用业务或付费接口。

共同设计：角色头像/标题对齐；成片中心移至吐槽上方；首页五角色；详情图完整上半身融入背景，工作区首屏同页；原草稿、历史、录音、文案确认与高级设置保持可访问。教程角色暂用品牌吉祥物占位，不是最终教学人物。素材/场景图片均为项目已有资源，人物原文件未修改。正式上线仍需各流程和常用窗口尺寸验收。

内置生图工具首轮及重试均发生网络错误，未产生可交付新图。三张高保真图由真实素材的浏览器界面样稿截图获得，不是已经上线的软件。独立复核修正 B 预览为约 9:16，以及 C 底部导航裁切；复验通过。未将概念样稿检查当作产品功能验收。

参考官方交互资料：

- [HeyGen 素材上传](https://help.heygen.com/en/articles/7951425-add-media-in-ai-studio)：拖放上传与可视素材选择。
- [Synthesia 预览](https://help.synthesia.io/en/articles/9184645-how-do-i-preview-my-video-before-generating-it)：区分编辑预览与生成后人物表现。不能把我们尚未生成的示例当作真实预览结果。

## 待用户选择和下一步

1. 选择 A/B/C 或明确组合；确定录屏主要时长/大小，以设计独立教程上传，而非复用现有 24 MB 素材上传限制。
2. 完成并验证旧底座实际升级路径；1.1.64 的桥接须使用真实原制品证明，不以协议验签替代完整升级。
3. 按选定界面实施，保留核心任务和数据链；最终走本机定向验收 → CI → main → 内部 CD，正式频道与付费搜索保持关闭。
