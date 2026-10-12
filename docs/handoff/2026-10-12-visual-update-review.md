# 人物界面、教程与旧版更新审查记录

工作分支：`codex/visual-guidance-update-recovery`；源码审查执行号 `20261012-shipping-a15e`。审查完成，结论为 Ready with fixes；九个本地审查方向完成。未调用不可用的外部审查 CLI，不将本地审查写成外部独立结果。

| 发现 | 修复 | 定向证据 |
| --- | --- | --- |
| P1：旧版桥接服务校验的 ZIP 内路径与真实生成器不同 | 统一为 `files/resources/app/src/main/legacy-update-target.json`；缺失、重复、损坏目标返回稳定错误 | 使用真实 builder ZIP 运行 `test_legacy_releases` 与 `test_components`，5项通过 |
| P1：发布门禁和读回无能力头，启用旧版路由后会取到固定旧清单 | latest 请求附带协议3及目标版本；不伪造底座信息，制品下载不附带路由头 | `release-upgrade-path.self_check.cjs`、`release-readback.self_check.cjs` 通过，包含移除头后的失败检查 |
| P2：教程取消后立即重试可能复用已中断请求 | 等待原请求清理后重新获取共享任务；并发重试仍合并 | `tutorials.self_check.cjs` 通过，包含立即重试、截断/超长/摘要错误响应与临时文件检查 |

修复后未重复运行整套审查。全源码检查已通过，修改对应定向检查通过；打包按发布流程另行验证。隔离Electron界面、真实MP4播放及草稿保存结果见 `desktop/.build/visual-b-acceptance/`。未新增付费生成和微信发送。

精简复核后保留现有教程目录查找方式：当前目录规模有限，额外建索引与模式迁移没有本轮性能证据，不为此扩展实现。只读旧程序采集工具另经源码边界复核，未发现必须修复问题；不采业务目录或凭据，不删除原文件。

原1.1.64制品、普通客户权限下的正式安装器连续升级、真实NSIS失败恢复和服务部署仍分别待验收。不能把夹具或源码通过写成客户更新完成。
