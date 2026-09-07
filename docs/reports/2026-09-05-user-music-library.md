# 用户提供音乐已接入本机曲库

当前测试版已导入并默认勾选两首用户提供的 MP3：Summer 154.067 秒，My Soul 140.066 秒。以用户指定文件为制作标准，保留原文件。受管副本位于当前 Windows 用户的 xiaoxi-active-touch-test/content-engine/music-catalog，非 30 秒试听缓存，也没有随安装包分发。

导入服务完成文件摘要校验、时长和响度分析，两首 analysisStatus 均为 ready。真实 Electron 重启后，通过 IPC 读回两首条目，界面复选框均可选且已勾选；新批次本地默认配乐 ID 已保存。原批次存储未修改。

| 原门禁 | 保护的风险 | 替代证据 | 剩余盲区 | 失败策略 | 回归测试 |
| --- | --- | --- | --- | --- | --- |
| 批次勾选及选曲必须允许商用 | 未经许可的自动商用选曲 | 明确批次 ID 池、本机使用指令记录、有效本地使用状态和文件证据 | 用户提供文件的购买凭证与发行版本未独立核实 | 非商用曲目仅在明确选定池中可用；过期、缺证据、文件异常仍不进入选曲 | 实际曲库 45 秒明确选曲通过；相同两首不指定池时不被自动选中 |

- Outcome：本机曲库导入与选择已跑通；本轮未渲染新视频。
- Safety proof：commercialUseAllowed 保持 false，本地指令记录不称作第三方商用许可。未触碰微信、付款、发布、密钥或旧成片。
- Verification：npm.cmd run build:test 通过；音频分析及实际选择器检查通过；真实 Electron 页面两项 checked/enabled 均为 true。
- Residuals：当前测试版用户曲库与默认设置已生效；不等同于发布安装包内置资源。
- Rollback：仅撤回 BatchSoundSettings.tsx 的可选条件和 auto_mix_v2.py 明确选曲条件即可恢复原限制；无需删除用户文件或旧素材。

详细运行记录：outputs/video-optimization-20260905/user-music-import.json、user-music-ui.json、user-music-library.png。
