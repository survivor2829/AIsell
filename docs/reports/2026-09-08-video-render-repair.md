# 2026-09-08 视频渲染包及原成片修复

原36.829秒视频实际加载旧development包，忽略新版干净字幕样式。用户授权修复后，已更新默认运行时，并复用原底片和音轨重渲染同一条成片。当前状态为本地修复检查通过，待用户视觉复核；没有将其写成新的用户认可样片。

## 实施

- 在独立目录构建当前Remotion模板并通过Chromium合成选择检查。首次画面复查发现结尾通用黄色卡片和一处120ms单字字幕，因此完成这两处源码修正后再次构建最终包。
- `video-template.tsx` 中，干净口播模式的结尾引导使用居中描边文字，保留完整引导正文及原事件时间，不再使用通用实心卡片。其他视频模式保留原渲染方式。
- `narration_alignment.py` 中，宽度分页造成的短小尾片段，在同一句、观测时间连续且两行宽度允许时合回前页；独立短句及标点边界保留。实际“问清／楚”恢复为完整“问清楚”，没有重新识别或伪造时间。
- 只重渲染已有 `mezzanine-base.mp4` 的视觉层，再直接复制原成片音轨。原确认稿、镜头序列、素材、配音、配乐及业务批次不变。
- 原成片ID为 `generated_video_3f01a727351141ec8ba2dc766ed1e9ae`。替换该目录中的视频、视觉轨、封面和manifest；数据库只更新对应成片文件大小。原视频、封面、视觉轨、manifest和原数据库行已备份。旧默认运行时保留在 `.build/remotion-runtime/development-before-repair-20260908`。

## 核对结果

- 最终默认运行时摘要：`fdf20998d6e9a565ddf790d8b214f613dcb561463e3a4ca10e8c2cfe741d3ef9`。构建源校验、完整包校验、Chromium合成检查均通过，安装后再验证与成片manifest一致。
- 最终视频：1080×1920、30fps、36.933333秒。音轨36.829秒保持原样，音频包SHA256在修复前后均为 `a9fe5e325d61226bed8701ab3588ef119b69199cb2a4c23aefaafa6adabe7c7d`。
- 视频SHA256：`5a61e07ff1a7bb23e169fc0edece0fcb97394c23ed98bbff41f2ce306a96ff8f`。
- 对照9月5日、7日样片的白字黑描边、一至两行字幕和干净背景；检查开头、各段、末尾单字原位置及结尾，实心引导卡片已去除。
- 4项相关字幕回归通过；整片FFmpeg解码无错误。当前Electron通过原生成视频媒体接口，在临时复核播放器中1倍速、有声播放至 `ended`，媒体错误为空；临时播放器已移除，应用留在成片中心。此检查不等于用户已认可。
- 当前内容引擎在无活动制作时经现有IPC重启以加载新代码，应用窗口和角色设置保持。没有触发真实微信动作。
- 本次新增LLM、TTS、ASR请求均为0；没有云端发布、打包或提交推送。

## 文件与回滚依据

本次证据在 `outputs/experience-refinement-20260908/video-repair/`：

- `original-row.json`、`original-files-backup/`：原记录与旧成片，保持独立可回查。
- `final/video.mp4`、`final/render-result.json`、`final/candidate-manifest.json`：交付副本、实际音轨摘要、媒体参数和运行时记录。
- `final/frame-*.png`：分段检查截图。
- `installed.json`：原成片及默认运行时安装位置和摘要。
- `playback-result.json`、`installed-playback.png`：实际播放结束和复核画面。
- `installed-finished-center.png`：成片中心刷新后的显示。

修复前工作区已经有其他未提交改动，基线HEAD为 `f00767c6c25f92b26aab5806c93244a02a7249f0`。本轮源码只修改上述两个渲染相关文件及现有字幕测试文件，另更新状态与验收文档；既有工作均保留。
