# 精准触达误跳过与文案修复结果

基线：已从 `04f21ea` 同步到最新 `main` / `32514afbb89e3642a3f0ab49e166e6661a4bf8b4`。分支：`codex/precise-touch-skip-copy`。位置：`D:\OpenAI\CodexHome\worktrees\9c3f\xiaoxi-active-touch`。

任务卡来源：桌面主工作区中同名 `-task.md`，现按用户明确要求原样纳入本分支；桌面原文件及其他未提交改动保留。诊断包：用户指定的桌面 `…13-08-55-800Z(1)(1).zip`，只在临时目录解包；没有把客户原图或原文加入仓库。

用户已在本人微信测试确认无问题，并授权本分支走 CI、合并 main、删除分支和内部 test 发布。现已完成 PR #66、主线 CI、1.2.8 内部 test 发布及本机 1.2.7→1.2.8 升级/健康 ACK，精准分支已删除。客户公告只包含精准触达，不包含独立混剪分支；截图隐私策略继续保持未改。详见[发布记录](../reports/2026-10-22-1.2.8-precise-touch-release.md)。

## 修改

- resolver 按弹窗 DPI 把头像列归一到 96 DPI，优先按词框剔除头像噪声；缺少词框时保留原行，记录 `avatar_unsegmented_line_count`，不猜测删除正文。结构标题和网络查找行仍保留为拒绝依据。名字、emoji、长备注匹配条件不放宽。
- 四个失败样例的相关几何（#6、#9、#16、#18）用匿名文字和标点/数字噪声回放；保持网络查找、多候选、超长微信号拒绝。
- 连写机构后缀允许接一个常见姓与职务，例如“湛江港濠酒店黄总”称“黄总”；机构方等歧义仍否决。删除整条备注称呼兜底；无法确认时仅时间问候。
- 默认原文发送，不调用 AI；保留正文换行、空格和 `[加油]` 等表情码，清理开头已知称呼、占位符和旧问候；正文中间的 `{称呼}` 替换为已确认短称呼，无短称呼时才删除。任务可主动开启 AI 润色，保存/编辑/列表显示模式；提示词保留全部业务信息和分行，不强加问句或表情。自动回复的 260 字约束不变。
- 模式写入冻结绑定。历史任务中已有生成文案时先要求编辑确认，不把历史 AI 草稿标成原文直接发送；结果不明、部分已发送和禁止补发保护保留。
- `r014` 七处拒绝拆为保留 `r014` 加新增 `r019`–`r024`，登记规则目录并更新搜索规则行号。首次/名字回退分别保留规则和脱敏 OCR；标题不匹配从底层实际右侧标题生成摘要；`r015` 保存同次 OCR 弹窗图，缺图明确记录不可用。
- 模式需经过任务控制器保存/编辑/读取，所以同时修改 `wechat-workflow.cjs` 的相关字段传递；没有扩展其他功能。

## 验证

通过的定向检查：

- `node rpa/active_touch/self_check.cjs`
- `node rpa/active_touch/wechat_search_observation.self_check.cjs`（含 PowerShell OCR、真实标题摘要代码回放、截图临时文件交接）
- `node src/main/ai-draft.self_check.cjs`
- `node src/main/deepseek-api.self_check.cjs`
- `node src/main/wechat-workflow.self_check.cjs`（模式保存/修改、原文不调用 AI、历史草稿阻断、证据脱敏）
- `node src/main/touch-task-ipc.self_check.cjs`
- `node src/main/active-touch-ipc.self_check.cjs`
- `node src/main/touch-message-sequence.self_check.cjs`
- `node src/main/task-passport.self_check.cjs`（包含故意注入写盘失败，输出的 `task_passport_write_failed` 属于预期）
- `node src/main/failure-evidence.self_check.cjs`
- `npm.cmd run build:test`、`npm.cmd run build:delivery`
- `git diff --check`；Impeccable 检查无发现。

界面使用实际 `WechatWorkflowPage` 和隔离模拟 API，检查原文默认关闭润色、切换提示、保存模式和重新编辑回填。未连接应用真实数据或微信。模拟截图在本工作区 `desktop/.build/precise-touch-ui/`，不提交。

高风险独立只读审查已执行；修正了历史草稿恢复、实际标题摘要、跨行旧问候三处发现，并对白名单外原文进入新增失败记录的路径补安全摘要。

## 未验证与待决定

- 初次实现时未发布或安装；后续 1.2.8 发布与本机升级已完成，详见上方发布记录。用户明确授权当前已登录微信中的“A测试客户”：在当前微信 **4.1.13.65** 上通过源码真实发送入口发送 1 条 4 行测试消息（46 字符，含双空格、换行、`[加油]`），输入回读及发前检查通过，状态依次 `prepared → clicked → sent_verified`。错误名字搜索和缺少账号绑定的前置尝试均在发送前阻断，`send_attempted=false`；没有绕过保护或重复发送。脱敏回执在本工作区 `desktop/.build/precise-touch-real-acceptance/result.json`。发布验收未新增发送。
- 本机版本不同于故障电脑的 4.1.15.13；当前真实通过不替代原故障电脑和版本的验收。
- 微信 4.1.15.13 的单条实际上限没有可靠证据；当前 **2000 字符只是本地保守保护值**，超限明确提示，不声称已验证微信边界。
- 没有取得吐槽正文中的完整原话术；文案回归使用等价多行文字、连续空格、空行与表情码。用户原话术逐字设备复验仍待补。
- #3、#12 以及名字回退 #2、#4、#8 的具体原因仍待新版本现场证据，不据猜测放宽身份核验。
- 截图隐私策略（任务卡第 6 条）未改，按用户要求在其余工作完成后询问。

以后经用户另行授权才做的手动验收：在原 1809 / 125% / 微信 4.1.15.13 电脑，仅用指定测试账号与联系人检查四类头像噪声联系人；核对正文逐字、换行和表情；检查原文/润色保存与编辑；失败后导出新搜索链及标题摘要，再判断五位原因未定的联系人。结果不明不得补发。

## 后续审查收尾

已处理 `2026-10-23-mix-auto-voice-music-task.md` 附录：同步最新 main；补 #16 无词框保留回放；补中间占位符回归；完成当前机器真实多行与表情码检查；2000 字提示仍明确为本地保护上限。截图隐私策略未纳入本次修改。混剪将从最新 main 另建分支，不混入本提交。
