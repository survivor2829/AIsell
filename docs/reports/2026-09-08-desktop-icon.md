# 桌面图标替换

采用用户提供的机器人图片，原样保存为 `desktop/public/app-icon.png`，仅做格式转换，生成包含 16、24、32、48、64、128、256 像素尺寸的 RGBA/DIB `app-icon.ico`。

桌面的「AI获客 V1.0版本」及测试版快捷方式均指向项目中的 `desktop/public/app-icon.ico`。启动目标和参数保持不变，原快捷方式备份在 `outputs/experience-refinement-20260908/desktop-icon-backup/`。当前桌面图标依赖该项目文件，移动或删除项目后需要重新设置图标。

用户反馈空白后，实际桌面对照显示：同一 ICO 放在 `%LOCALAPPDATA%/AIhuoke/Branding/` 时显示空白，放在项目目录时显示正常；DLL 资源也出现相同路径差异。清理图标缓存、转换 ICO 编码并未单独解决问题。已改用实际显示成功的项目 ICO 路径；尚未确定原目录不能显示的底层原因，不将它归因为已证实的编码错误或缓存损坏。

最终验证：两个真实快捷方式统一引用项目 ICO 后，读取确认启动目标未变，发送定向刷新通知，再直接截取 Windows 桌面，正式版和测试版均显示机器人图标。截图为 `outputs/experience-refinement-20260908/desktop-icon-cache-repair/actual-desktop.png`。此前的原生图标提取结果只能证明资源可解析，不能替代桌面显示验收。

源码中的主窗口使用构建资源 ICO；便携版打包脚本在独立 EXE 中嵌入图标；正式版和测试版 NSIS 配置引用同一图标。此前主进程与打包脚本语法检查、`npm.cmd run build:test` 已通过，构建 ICO 与源码一致，Electron EXE 隔离副本上的图标嵌入成功。当前已安装 EXE 未重写，未重建安装包，也未发布。

## 圆角透明修订

用户确认保留机器人和红黑圆角底板，只去掉最外圈灰色背景，并授权本地精确裁切。最终使用原图像素与沿底板轮廓绘制的抗锯齿透明蒙版，未采用图片生成工具产生的棋盘格背景版本。原图备份为 `outputs/experience-refinement-20260908/desktop-icon-cache-repair/original-icon-with-gray-background.png`；可复现处理脚本为同级上层的 `prepare-rounded-icon.py`。

已更新 `desktop/public/app-icon.png` 和 `app-icon.ico`，透明 PNG 为 1186 × 1186，ICO 含 16–256 像素七个尺寸。两个桌面快捷方式改用同内容的 `desktop/public/app-icon-rounded.ico`，避免继续引用旧图标缓存；仍依赖项目路径。当前构建目录同步相同资源，源码及安装配置引用的 `app-icon.ico` 保持不变。本次仅修改图标资源，无需重复源码构建；未重新打包安装程序。

已确认 PNG 四角 alpha=0、ICO 尺寸完整，并直接检查真实桌面截图：正式版和测试版均显示圆角图标，原来的外圈灰色方框已消失，启动目标未变。实际截图仍为 `outputs/experience-refinement-20260908/desktop-icon-cache-repair/actual-desktop.png`。

## 最新图标：带 AI获客 文字版本

已按用户最新提供的 `codex-clipboard-2fc67161-5a63-4e98-ba7d-760bbf0b8bf4.png` 替换图标。原始文件为 RGB，圆角外棋盘格并非透明；沿用用户已授权的本地精确裁切方式，只添加沿底板轮廓的抗锯齿透明蒙版，RGB 像素校验与原图完全一致。原图备份为 `desktop-icon-cache-repair/user-icon-with-label-original.png`，处理脚本为 `outputs/experience-refinement-20260908/replace-current-icon.py`。

当前打包资源为 `desktop/public/app-icon.png`、`app-icon.ico`；桌面快捷方式使用同内容的 `app-icon-labeled.ico`，不再引用上一版圆角图标。正式版和测试版启动目标未变。已验证四角 alpha=0、七种 ICO 尺寸完整，且直接检查桌面截图确认两个图标均已更新。构建目录图标资源已同步；本次未重新打包、安装或发布。
