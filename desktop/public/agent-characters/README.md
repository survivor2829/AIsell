# 数字员工形象资源

三位数字员工各有 3 种可选外观，共 9 种。角色、外观名称、图片前缀、裁切位置、主题色、背景图案和装饰元素统一配置在 [role-appearance.json](../../src/shared/role-appearance.json)。切换外观时，人物图片与对应的界面背景、色彩及装饰元素一起切换；用户修改角色名字不改变外观资源的标识。

| 默认角色 | 外观 ID / 名称 | 人物图片 | 背景图案 |
| --- | --- | --- | --- |
| 小玺 | `original` / 经典小玺 | `xiaoxi-integrated-idle.png` | `agent-original.svg` |
| 小玺 | `welcome` / 热情相迎 | `xiaoxi-welcome-idle.png` | `agent-welcome.svg` |
| 小玺 | `connect` / 随时在线 | `xiaoxi-connect-idle.png` | `agent-connect.svg` |
| 小惠 | `original` / 经典小惠 | `xiaohui-integrated-idle.png` | `production-original.svg` |
| 小惠 | `studio` / 灵感手记 | `xiaohui-studio-idle.png` | `production-studio.svg` |
| 小惠 | `create` / 创作时刻 | `xiaohui-create-idle.png` | `production-create.svg` |
| 小联 | `original` / 经典小联 | `xiaolian-integrated-idle.png` | `operations-original.svg` |
| 小联 | `growth` / 增长伙伴 | `xiaolian-growth-idle.png` | `operations-growth.svg` |
| 小联 | `channels` / 连接更多 | `xiaolian-channels-idle.png` | `operations-channels.svg` |

`xiaoxi-idle.png`、`xiaohui-idle.png`、`xiaolian-idle.png` 保留为早期原稿，不计入以上 9 种可选外观；经典外观使用已有的 `*-integrated-idle.png` 融合版本。

## 用户提供的 6 张原图

新增 PNG 从用户 Downloads 目录中的以下文件原样复制，未重绘、抠图或改写图片内容。2026-09-08 已逐一核对来源文件与本目录副本的 SHA-256，两者一致。背景 SVG 为界面配套装饰资源，不替换原图内自带的背景元素。

| 本目录文件 | Downloads 来源文件 | SHA-256（来源与副本一致） |
| --- | --- | --- |
| `xiaoxi-connect-idle.png` | `ChatGPT Image 2026年9月7日 14_36_43.png` | `5671A5F0953091392C0DA4E914CBBB515540C1021FB3168F104C8C0B5F1E0E86` |
| `xiaoxi-welcome-idle.png` | `ChatGPT Image 2026年9月7日 14_36_39.png` | `BA3A79580640056DE4D6CA6B257DD5BB44E098B3F48677E7E5DDE805D107EA27` |
| `xiaohui-create-idle.png` | `ChatGPT Image 2026年9月7日 14_36_33.png` | `A5BCC38F1D1D6AD6152C7E0BB2E54B3FE667633E4A6E9A5A88821C1CF471FF57` |
| `xiaohui-studio-idle.png` | `ChatGPT Image 2026年9月7日 14_36_26.png` | `37AB3236F757DC9C0781D8A219672185A7C28EC64B1FBB7621FB58B03C0BDB09` |
| `xiaolian-growth-idle.png` | `ChatGPT Image 2026年9月7日 14_36_17.png` | `10829E2A00A64A96F905CCF4E68ABB97E491B7A72C7B4F1465134FCD127F3A7A` |
| `xiaolian-channels-idle.png` | `ChatGPT Image 2026年9月7日 14_36_22.png` | `8C704910D4AC98D7199D39B91989E91E1D249CF590C017854BB0A7738904EB02` |

## 当前动效方式

2026-09-08 底色融合修正：九套外观的 `surface` 已依据各自原图上方与两侧背景取样校准，角色首页使用同一底色，人物叠加由 `multiply` 改为 `darken`，避免浅色背景重复染深形成矩形色块。PNG 保持原样，当前实现属于底色融合，不是真透明抠图。Electron 已检查九套外观在 1800×950、1180×950 下的显示；截图及结果见 `outputs/experience-refinement-20260908/portrait-blend/`。透明图工具的试稿没有 alpha 通道，未接入应用。

当前只加载静态 `idle` 图片，配合 CSS 轻微呼吸等动效；没有眨眼或挥手动作帧。仅新增同前缀的 `-blink.png`、`-wave.png` 不会自动启用动作，后续需要动作帧时应同时调整加载与播放实现，并另行验收。
