# T10a 搜索结果识别实施结果

## 二审返工（等待 T5 合并后变基）

本轮在原分支先完成二审实现；按任务顺序，尚未把 T10a 变基到未合并的 T5。

- resolver 的判定恢复为 `9d77c2d` 基线原逻辑；有下拉框时，先按“搜”字列位置重新分类长分界，再跑基线判定，最后对缺少联系人标题、候选上方最近标题、跨分区、可疑视觉行和读得出的更长微信号做只会拒绝点击的检查。无下拉框时沿用基线精确规则并检查更长微信号。没有提交包装 resolver。
- 二审参考原型中，几何列不合格但文字恰好是精确标签的行，仍可被基线再次当作分界；拆开的可疑词片也未被否决。定向攻击用例先复现这两处，修为“不可信长分界阻断”和“合并视觉行后否决”。这两处是参考实现与攻击用例间的实际差异，建议审查以安全用例复核。
- PowerShell 找下拉框时只接受唯一合格窗口，并输出合格候选数量。搜索证据记录 `capture_source`、下拉框矩形、DPI、候选数量及“搜”字列位置；新增字段只包含枚举或数字。测试用离线不可激活窗口运行生产的 `Find-SearchPopup` 函数，检查同进程、类名、可见、尺寸、位置、唯一性和 DPI；逐字词框运行生产 OCR 代码，检查坐标换算。
- 32 条样例继续回放，28 条好友选在预期行，4 条非好友均不点击且返回 r015。补上二审列出的群聊、聊天记录、缺少标题、双姓名行、昵称行、跨分区、网络查找、同视觉行及微信号多出字符攻击输入。UIA 用例改为本机观测的空候选输入；原基线 UIA 判定仍由原逻辑执行。
- 删除已不用的 9 月 20 日单条夹具。分支历史已压成从 `9d77c2d` 起的单个提交；该提交差异中没有真实备注，旧夹具不在提交树中。随后等待 T5 合并再按要求变基。

变异回归实测：逐项移除列位置、前缀长度、联系人标题、最近标题、跨分区、视觉行、多出字符检查、无下拉框精确回退，共 8 项；每项均使其对应攻击输入从拒绝变为 `selected`，现有自检会失败。窗口行为回放分别断言唯一窗口可用、双窗口回退，以及进程、类名、可见、尺寸、位置过滤后的候选数量；未对 PowerShell 源码做变异测试。

验证命令与实际输出：在 `desktop/` 执行 `node rpa/active_touch/self_check.cjs` 退出码 0，末行 `active-touch self-check passed`；`node rpa/active_touch/wechat_search_observation.self_check.cjs` 退出码 0，输出 `search observation PowerShell replay passed (spaced OCR; noisy sections ignored; no real input)`；`npm.cmd run check:self` 退出码 0，末行 `all source self-checks passed`，其中策略门禁输出 `WeChat failure policy review passed: every added literal reason is classified`；`npm.cmd run build:test` 退出码 0，输出 `test renderer build completed`；`git diff --check` 退出码 0（仅 LF/CRLF 提示）。

未验证：本轮没有再次操作真实微信；跨版本、异机的真实下拉框截图和 OCR 效果仍待后续实机验收。未做安装包或发布。

分支：`codex/fix-search-recognition`，基于 `codex/fix-apimart-gateway-transport` 的 `82f248d`。未合并、未推送、未发布。

## 改动

- F2：JS 与 PowerShell 共用同一份网络搜索标签表。行首最多忽略两个任意字符；只对“搜索网络结果”允许一次编辑误差，且要求与联系人分区标题左侧相差不超过 8px、行高相差不超过 30%。仍拒绝多个分界。
- F3：未读到分界时，先对同一截图做 3 倍灰度及对比度拉伸后补读，再隔 800ms 截图补读。补读结果仅在本地分区内各行的位置与首次观测相差不超过 2px 且没有新增好友行时使用；观测不一致则拒绝。结果与搜索证据记录 `recognitionRecoveryCount`。
- F4：无分界时，必须见到唯一联系人分区标题、其下相邻名字行和完全匹配查询词的微信号行，且全截图只有一条以微信号开头的行；后续出现额外好友或姓名冲突时拒绝。返回名字行中心。
- F5：排除含“查找”及非行首“微信号”的行和同一视觉行。无分界路径不凭单行 OCR 文本授权点击。
- 新增基于 9 月 20 日 11 行观测坐标的脱敏夹具：姓名、群名和微信号换为占位内容，保留各行字符长度、字符类别及判定所需标签；原始数据未进 Git。

## 验证命令与实际输出

- 新矩阵先在旧实现上运行 `node rpa/active_touch/self_check.cjs`：失败于 `missing boundary: the unique local two-line friend must be selected`，实际 `unverified`。
- 修改后同命令：通过，末行 `active-touch self-check passed`。覆盖 8 个分界读偏正例、8 个误点反例、JS/PowerShell 同表判定，以及补读时 2px/3px 位移和第二好友出现的拒绝边界。
- `node src/main/wechat-workflow.self_check.cjs`：通过，输出 `Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.`。
- `node rpa/active_touch/wechat_search_observation.self_check.cjs`：通过，输出 `search observation PowerShell replay passed (spaced OCR; noisy sections ignored; no real input)`。
- PowerShell Parser 对生成的 `SEARCH_SCRIPT` 解析：退出码 0、无语法错误。增强 OCR helper 用离线空白位图实际调用 WinRT：`enhanced_ocr_ok:0`，退出码 0。
- `node --check`（resolver、driver）：均退出码 0；`git diff --check`：退出码 0。
- `npm.cmd run check:self`：退出码 0，末行 `all source self-checks passed`。首次运行因测试夹具临时使用未登记的 `offline_replay` 失败，改用已登记的 `workflow_paused` 后完整通过。

## 未验证

- 未触碰真实微信、未执行点击前实机观察；100%/125% 缩放以及跨版本、异机的实际 OCR 救回率待用户指定测试对象并授权后验证。
- 离线空白位图确认增强 OCR API 可运行，不证明真实下拉框截图一定会被补读救回。

## 对任务卡的异议

- 卡片的“微信号本身永远不做模糊匹配”与“现有搜索用例保持原结论”需按证据层次理解：现有有分界的 `unique_local_wechat_id_visual` 允许灰色微信号 OCR 不可读时依靠唯一且有界的本地好友表面选中。无分界新增路径严格要求微信号完全匹配，未改动这条既有有界路径。

## 审查返工（以开发机空跑补充为准，基线 9d77c2d）

本节取代上文 F2、F3、F4 的实现和验证描述。已在原分支变基到 `9d77c2d`。

- 下拉框通过同进程、可见、位于主窗口搜索区下方且类名匹配 `Qt…QWindowToolSaveBits` 的顶层窗口定位；其矩形用于截图，DPI 由 `GetDpiForWindow` 取得。找不到下拉框时沿用公式截图与基线精确分界规则。搜索证据写入 `capture_source`。
- PowerShell 单次 OCR 输出每个词的 `text/left/right`。可信长分界须以“搜索网络结果”结尾、图标前缀不超过 4 个字符、“搜”字在下拉框左边第 62±8 列（96 dpi 换算）。短标签只接受基线精确匹配；JS 与 PowerShell 的精确匹配已在特殊 Unicode 字符表上对齐。
- 下拉框内选中好友前必须见到候选上方的短分区标题；本地结果仍须唯一，网络查找及其同一视觉行被屏蔽。只有读完整“微信号”且号码包含并长于查询词时拒绝，比较时折叠 `|/I/l/1` 与 `O/o/0`。无分界 F4 路径和 F3 二次 OCR 已删除。
- 将 32 条已脱敏的空跑样例从 `docs/handoff/` 移入 `desktop/rpa/active_touch/fixtures/`。旧 9 月 20 日夹具里与本机备注相同的姓名占位改为同形状的 `B春夏秋冬`。

新样例测试先在本轮旧实现上失败：`node rpa/active_touch/self_check.cjs` 于 `dpi100-friend0-formula_crop-7` 得到 `unverified`，预期 `selected`。用 `git show 9d77c2d` 的原 resolver 回放全部 32 条，实测恰有 7 条错误：`formula_crop-7/9/11/13/14/15` 六条为 r008，`popup-26` 非好友误选。返工后 28 条好友均选中 `expected.rowIndex` 的名字行，4 条非好友均不选中。

实际执行的六个临时变异结果：放宽“搜”字列位置、放宽图标前缀、绕过分区标题、移除多出字符检查、移除视觉行屏蔽、无下拉框时启用容错分界，各自使对应反例从拒绝变为 `selected`。变异脚本只在 `.build/` 临时运行，未纳入提交。

返工验证：`node rpa/active_touch/self_check.cjs` 退出码 0，末行 `active-touch self-check passed`；`node src/main/wechat-workflow.self_check.cjs` 退出码 0，输出 `Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.`；生成的 `SEARCH_SCRIPT` 经 PowerShell Parser 检查为 0 个语法错误，Win32 C# 桥接代码 `Add-Type` 编译通过；`git diff --check` 退出码 0（仅 LF/CRLF 提示）。

`npm.cmd run check:self` 退出码 0，末行 `all source self-checks passed`；其中 `WeChat failure policy review passed: every added literal reason is classified`，以及本次 active-touch 和 workflow 自检均通过。

最后复核时，一次 `node rpa/active_touch/self_check.cjs` 在进入搜索测试前的剪贴板 PowerShell 自检偶发 `powershell_failed`；立即单独复跑退出码 0，末行 `active-touch self-check passed`。此前完整 `check:self` 也通过。未据此修改无关剪贴板代码。

未验证：本轮未再次操作真实微信；真实顶层下拉框定位、实际 OCR `words` 和异机不同微信版本仍需只观察空跑。已有 30 次开发机空跑属于审查文件里的用户授权观测，不算本轮新实现的实机验收。未做安装包或发布。

## 三审返工（变基至 cdb01ed）

- `codex/fix-search-recognition` 已变基到收尾基线 `cdb01ed`。弹窗路径出现不可信网络分界时，不论按微信号还是按名字搜索，均在基线判定前返回 r011。
- 可疑视觉行同时检查原始行与合并行；合并时排除弹窗第 60 列以内的头像碎片，保留原始可疑行的否决能力。
- `search_columns` 汇集视觉候选和 PowerShell 已分类的网络候选；无弹窗的生产观测也输出 `capture_source`、`popup_candidate_count`。将纯数字 `popup_candidate_count` 提到 `searchEvidence` 顶层，供 T5 的白名单证据链读取。证据继续只收枚举及有限数字，不写联系人文本。
- PowerShell 离线回放覆盖生产脚本从 `Find-SearchPopup` 到 JSON 输出的路径：假弹窗原点 (300, 200)、DPI 120 时词框原点为 350；无弹窗时为 308，且 `captureSource=formula_crop`、`popupBounds=null`。另检查候选窗口类名、隐藏、宽高、六个位置边界和 DPI。样例与测试矩阵先按生产匹配器分流，再送入 resolver。

验证命令与实际输出（均在本分支工作区；源码检查在 `desktop/`）：

- `node rpa/active_touch/self_check.cjs`：退出码 0，`active-touch self-check passed`。`node rpa/active_touch/wechat_search_observation.self_check.cjs`：退出码 0，`search observation PowerShell replay passed (spaced OCR; noisy sections ignored; no real input)`。
- 审查脚本 `t10a-safety/attacks.cjs`：G1–G7 共 20 个攻击场景，0 次点击；`attacks_r3.cjs`、`attacks_name.cjs`：A1/A1b/A1c 为 r011，A2 为 r014，A4 为 r011，G8 为 r007；A3 两个头像碎片正例仍选中好友。
- `t10a-safety/replay_fixture.cjs`：JS/PS 精确匹配分歧 0；弹窗几何路径好友 `ok=28 missed=0 wrong=0`，非好友 `ok=4 wrongClick=0`。原始公式截图的 6 条仍按无弹窗基线回退返回 r008；该脚本将它们单独列出，不计入弹窗几何的 28/4 结果。
- `t10a-safety/fuzz_wrongrow.cjs`：`looserWrong=0`、`selWrong=0`（`sel=6487`）。`t10a-r3-safety/fuzz_diff.cjs`：四种模式各 60000 例，`tOnlySel=0`、`diffPoint=0`；弹窗路径 `pOnlySel` 分别为微信号 3155、名字 3530。
- 定向变异：R3a、R3b 均使对应新断言失败；R9d（漏合并 `webSearchCandidates`）在 `dpi125-friend0-formula_crop-0` 失败。变异只在忽略的临时目录执行，原源码已恢复。
- `npm.cmd run check:self`：退出码 0，末行 `all source self-checks passed`。`npm.cmd run build:test`：退出码 0，`test renderer build completed`。`git diff --check`：退出码 0（仅工作树 LF/CRLF 提示）。

未验证：本轮没有操作真实微信、实际联系人或执行点击；跨设备和不同微信版本的弹窗识别、OCR 与 DPI 仍待获授权的实机空跑。未做安装包、发布或合并。

对任务卡的异议：无。审查脚本把无弹窗公式截图的 6 条 r008 与有弹窗几何路径的 28/4 分开统计；前者保留基线精确回退规则，与三审要求一致。
