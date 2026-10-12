# 旧版更新故障：只读采集程序

用于确认另一台电脑实际安装的 1.1.64 程序及更新实现。采集本身不升级、不覆盖、不停止软件，也不需要管理员权限。

## 在出错电脑操作

1. 把 `collect-legacy-update-evidence.cmd` 与 `collect-legacy-update-evidence.ps1` 放进同一个文件夹；如果收到 ZIP，先解压。
2. 双击 `collect-legacy-update-evidence.cmd`，等待窗口显示结果。
3. 把桌面的 `AI-update-evidence-日期-编号.zip` 发回。若显示“部分采集”，也请发回 ZIP；报告会记录缺失项，不会把它冒充完整采集。

不需要卸载、重装或关闭正在使用的软件。旁边的同名文件夹只是采集副本，便于先检查内容；原文件不会移动。

默认安装位置为当前用户的 `AppData\Local\Programs\AI获客-测试版`。找不到时，在软件快捷方式右键选择“打开文件所在的位置”，使用该路径在 PowerShell 中运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\collect-legacy-update-evidence.ps1 -InstallDirectory 'D:\实际的软件安装目录'
```

## 采集边界

- 仅按已发布 `component-base.json` 清单复制程序的 `src/main`、`src/shared`、`dist`、软件包信息及版本清单，保存逐文件 SHA-256 核验结果；不执行采集到的源码。
- 读取更新选择记录仅用于定位当前活动的程序副本；只导出活动/前一个程序的散列 ID 和是否待启动确认，不导出原始选择记录、账户名或绝对路径。
- 不读取聊天、客户资料、授权、密钥、会话、原始素材、制作记录或业务备份；不打包 `node_modules`、Electron 或三个大型运行时。因此这个 ZIP 不能单独运行，不是完整安装备份。
- 拒绝目录链接及越界路径；凭据类文件、私钥和 `.env` 不采集。文件占用、缺失、摘要不符均记录为“部分采集”；不会强制解锁文件。
- 不联网、不修改系统执行策略；启动命令的 `Bypass` 仅作用于本次 PowerShell 进程。没有自动删除步骤。

开发验证可用 `-OutputDirectory '独立验证输出目录' -SkipActiveSelection` 对已验收制品采集，避免读取本机程序选择记录。退出码：`0` 完整，`2` 部分，`1` 未能生成完整报告 ZIP。开发制品采集通过不等于故障电脑原版采集、真实更新或失败回退已通过。
