# 2026-09-08 人物、成片中心与视频样式诊断

> 后续：用户已授权修复，现已更新默认视频包并完成36.933秒本地重渲染与播放检查；见[修复记录](2026-09-08-video-render-repair.md)。下面保留修复前的诊断依据。

## 界面修改

- 人物所在英雄区取消独立背景面板和裁切边界。图片由放大铺满改为完整适配，恢复头部、手部及原图已有内容；边缘柔化，原图色彩与角色背景混合。原图片文件保持原样，原图自身的装饰仍保留，这不是透明底抠图。
- 成片中心直接展示可用作品，批次管理长列表改为右上角“制作记录”入口。取消“已删除”页签与不可用作品卡片；历史数据库和实际文件均未删除。
- 保留搜索、刷新、播放、下载和定位文件。紧凑窗口实际显示9条可用作品，无横向溢出；空搜索及制作记录导航通过，三位角色首页完整适配，无页面错误。
- `npm.cmd run build:test` 通过，1631个模块。实际 Electron 检查与截图见 `outputs/experience-refinement-20260908/ui-results.json`、`role-*-1180.png`、`finished-1180.png`。本轮未打包或部署。

## 视频为什么回到旧排版

对比9月5日、9月7日已认可成片及9月8日新片的批次设置、配方、manifest与实际渲染包：

1. 三批次均为工作流2，均启用 `narrated_reference_captions`，配方均指定 `caption_presentation: reference_narration`。不是用户选错模板，也不是设置丢失。
2. 当前源码 `video-template.tsx` 已包含 `ReferenceCaptionTrack`，渲染参数也保留对应模式。
3. 本机默认 `.build/remotion-runtime/development/remotion-bundle` 的16个JS文件不含 `reference_narration` 或 `captionPresentation`。主进程没有环境覆盖时默认选用此目录；`build:test` 只构建应用界面，不重建视频渲染包。
4. 对默认包及当前 worker 计算运行时摘要为 `d4fddac8c2d549443af85e3692a51fa519f85efa46b08f89dc7420996a6be388`，与9月8日新片 manifest 完全一致。9月5日、7日认可成片使用的摘要为 `8532d705309bf792fc5509199018d9179fb3b8036bc31357a4856099ccd3958a`。这证明新片实际用了缺少新版字幕逻辑的旧包。

对比数据见 `outputs/experience-refinement-20260908/video-style-comparison.json`；三条视频18秒位置截图分别为 `approved-0905-frame.png`、`approved-0907-frame.png` 和 `current-0908-frame.png`。

之前验证时长、正文和完整播放，遗漏了与认可样片的排版对照。36.829秒成片确实存在并能播放，但视觉质量未通过，之前的交付状态已更正。

本轮视频部分按用户要求完成诊断，没有新增付费调用或重渲染。修复方向是更新默认视频包并核对实际选中的运行时，复用已有配音、字幕时序和镜头，仅重做渲染；先对照开头、字幕与结尾，再检查完整视频。不能只重新构建界面或重新生成文案。
