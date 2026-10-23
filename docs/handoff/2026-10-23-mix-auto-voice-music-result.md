# 三种视频功能的默认声音与混剪配乐修复

基线：`main` / `32514af`；分支：`codex/mix-auto-voice-music`。精准触达独立提交为 `a570732`，本分支不包含其改动。不发布、不安装。

## 修改

- 内置固定火山官方音色首次启动及升级自动获得产品批准，未试听也可用；自动选择优先数字人默认音色、其次自动选择优先级，同优先级保持目录顺序。默认小何 2.0。百炼设计音色及私有配置保留试听批准要求，显式选择和失效恢复保留。
- 数字人选择已经可用的官方声音不再重复批准。产品效果视频开始前读取共享声音目录，没有可用默认声音或读取失败时停在草稿，明确提示，避免付费执行到音频阶段才发现问题。
- 混剪第 2 步增加声音、配乐、字幕摘要，其他制作设置统一收进默认收起的“更多设置”；字幕样式默认主题常驻，严格核对默认关闭。声音可留空自动选择，无需先选试听候选。
- 新数据及升级自动注册 7 首内置 CC0 配乐，复用既有授权证据校验。相同音频指纹的客户记录及停用状态优先，普通导入仍走媒体实测。自动配乐缺少可用曲目会明确停止，避免悄悄变成无配乐；客户明确选“不加配乐”及旧批次既有无乐语义保留。

## 实际预装曲目

用户已将数量调整为“筛选这 12 首，合格多少预装多少”。以下 7 首来自原作者 OpenGameArt 上传，作者均为 Alex McCulloch (Pro Sensory)，许可证均为 CC0 1.0。每首 `assets/builtin-music/*.license.json` 保存原页面完整 HTML、原始下载 URL、作者、下载日期、完整许可及原始/包内音频 SHA256。

| 名称 | 来源 | 节拍估计 |
| --- | --- | --- |
| Happy | https://opengameart.org/content/happy | 120 BPM |
| Elevator Music | https://opengameart.org/content/elevator-music | 120 BPM |
| Inspiration | https://opengameart.org/content/inspiration-1 | 100 BPM |
| The love cycle (Guitar) | https://opengameart.org/content/the-love-cycle-guitar | 125 BPM |
| River | https://opengameart.org/content/river | 120 BPM |
| Forever (version 2) | https://opengameart.org/content/forever-version-2 | 100 BPM |
| Taken Lightly | https://opengameart.org/content/taken-lightly | 100 BPM |

其余 5 首因节拍歧义、弱节拍依据或混合 rock 风格标签排除，没有用同曲变奏凑数。筛选依据为原作者标签和波形节拍估计，**尚未完成人工听审**，上述 BPM 不等于原作者标注。包内录音约 96–175 秒，合计约 10 MB，约 −20 LUFS，实测峰值均低于 −4.8 dBTP；仅固定增益转码，保留原音频及完整证据。

## 验证

- 界面 `npm.cmd run build:test` 通过；既有 Vite CJS 与大于 500 kB 的 bundle 提示仍在。
- 源码验收所需开发 Remotion 运行时本地构建成功；初次制作因其尚未构建而被预检拦截，未请求配音。补齐运行时后复用同一批次继续，没有重新理解素材或生成文案。
- `content-engine-ipc`、`narrated-batch-ipc`、`product-video`、`digital-human-audio`、`batch-voice-recovery` 自检通过。
- Python：声音资源、混剪批次、混剪制作及音乐资源定向检查通过；新增覆盖全新数据无试听、默认官方音色、实际本地模拟音频准备、升级、私人音色不自动批准、客户选声、曲库注册、不覆盖停用记录及音频篡改。
- `test_auto_mix_v2` 初次 4 项补图回归因 Windows 深目录超过传统路径阈值失败；捕获到 `WinError 206` 后仅将该测试 fixture 改成系统临时短目录，补图 5 项全部通过，未改断言和产品逻辑。其余 67 项初次通过。
- 独立只读审查发现空曲库提示仍称自动保留配音，已改成明确提示曲库不可用；其余所审范围未发现明确阻断缺陷。
- `.gitattributes` 为 7 份授权证据固定原始字节，避免 Windows Git 自动换行改变校验值；从暂存区按 `core.autocrlf=true` 实际检出后，7 份证据 SHA256 全部匹配。

## 真实验收与费用

出片前已告知：1 条约 30–60 秒预计云端 0.2–2 元，按 5 元预留；实际账单以供应商为准，不自动重做结果未知的操作。数字人与产品效果视频本轮只验证共享声音链及本地模拟，不另外提交云端视频。

隔离源码运行时使用新的内容数据目录，只复用本机已保存的软件加密登录资料。测试素材从桌面“测试素材”只读导入，未改原素材、客户历史、已安装程序及桌面 main 工作区。

第 2 步实际运行截图：[默认自动声音、自动配乐与收起的更多设置](images/2026-10-23-mix-step2-settings.png)。实际保存的批次设置没有 `voice_persona_id`，`music_mode=auto`，没有试听记录。数字人真实 IPC 能力读取中小何等官方声音显示 `available=true`；产品效果视频能力读取为 `ready=true`，两者均未提交云端视频。

真实混剪已完成并自动导出 **1 条，35.167 秒，1080×1920 / H.264 + AAC 48 kHz 双声道**：

- 批次：`narrated_batch_3d9dc069aff64d98acced4e578016cd6`，`status=completed`、`export_ready=true`、`exported_count=1`。
- 用户没有指定声音，确认制作时后端自动将默认小何 `volc-xiaohe-2@1` 冻结到该批设置；没有试听记录。自动配乐选中预装 **River**。
- 最终媒体完整解码无错误，已检查 10 秒画面及字幕；音频质量记录为 −15.14 LUFS、−2.87 dBTP，人声/背景音乐最小差值 8.78 LU。未完成人工全片听审。
- 文件在本工作区 `desktop/.build/mix-fresh-profile/content-engine/batch-exports/narrated_batch_3d9dc069aff64d98acced4e578016cd6/01-先看操作再问场景-1a2aecab.mp4`。SHA256：`4824e99ec10dfd153b4b3f8e6c0c35813681204f9a47022f2e36026b6ad34fc4`，不纳入源码提交。
- 调用账本合计成功 TTS 输入 199 字、ASR 音频 144.778 秒；最终未完成请求数为 0。文案与画面理解也有调用，未取得供应商最终人民币账单，不能将估算写成实际扣费。

未发布、未打安装包、未在其他电脑验收；数字人与产品效果视频没有额外云端出片。曲目整体风格与全片听感仍建议用户人工试听确认，后续可按实际反馈缩小预装范围。
