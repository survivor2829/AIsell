# 精准触达：误跳联系人、称呼念备注、文案被改写（任务卡）

来源：吐槽中心 `3e624f5a-5282-43d7-866d-d894386d078e`（2026-10-22 16:20，status=pending）及同机导出诊断包 `AI短视频获客 V1.0版本-1.2.6-test-诊断日志-2026-10-22T13-08-55-800Z.zip`（用户桌面）。诊断由 Claude 完成，实施交给 Codex。风险等级：高（`desktop/rpa/**`、`touch-*`）。分支：从 `main` 拉 `codex/precise-touch-skip-copy`。

## 现场

- 客户端 1.2.6 / `20261022T0327Z` / 提交 `6185b52`，安装版，Windows `10.0.17763`（1809），微信 `4.1.15.13`，窗口 1400×950，DPI 120（125%）。
- 任务 `ed49bcc7…` 第 0–25 位中 9 位在点击发送前停止，`send_attempted=false`，无误发。用户称其中至少 6 位是有效联系人。

| 类型 | 序号（passport 目录后缀） | 结论 |
|---|---|---|
| `search-r014` | 6、9、16、18 | **全部误判，已定位**（见 A） |
| `search_result_not_opened` | 3、12 | 截图显示已打开正确会话，标题核验失败；原因待证据（见 B） |
| `search-r015` | 2、4、8 | 按名字回退搜索未命中；证据不足（见 C） |

## 根因

### A. r014：识别结果把头像噪声拼进文字行（已确认）

- 四张 `task-passports/active_touch/…-{6,9,16,18}/*-screen.png`：“联系人”下唯一一行，微信号与搜索词完全一致，本应选中。
- `raw-reading.json` 的 OCR 框：名字行/“微信号”行左端在弹窗列 36–57（96 DPI 归一），头像占列约 36–72，正文应从列约 80 开始。字数多 1：#16 “微信号”行 16 字 = 噪声 1 + `微信号:` 4 + 微信号 11；#18 13 = 1 + 4 + 8。
- 触发点：`wechat_search_result_resolver.cjs:652-654` 的 `isUnsafeVisualText`——文字含“微信号”但不在开头即判不安全（原意是拦“网络查找微信号”）。
- 本地模拟（按 #16 几何拼装 observation，`queryType=wechat_id`）：`微信号:<id>` → `selected / unique_local_wechat_id_visual`；`，微信号:<id>` 或 `·微信号:<id>` → `search-r014`。

### B. not_opened（#3、#12）：标题核验对象可能不一致（待证据）

非精确微信号路径用 `titles.find(t => t.includes(customerName))` 核验（`state_machine.cjs:795-818`），`customerName = selected_customer.name`（`:688`）。微信标题显示备注；若同步的 `name` 与备注不同（昵称、全/半角逗号等）即失败。诊断里没有标题与期望值的比对，无法确认。

### C. r015（#2、#4、#8）：名字回退精确匹配过严（待证据）

截图搜索框为备注/名字：#2 以 emoji 开头，#4 为长公司名，#8 含空格和编号。名字路径（`resolver:625-638`）要求某行与 `expectedName` 逐字相等且行左端列 > 60；emoji 无法识别、长名截断、头像噪声任一都会失败。但截图是在弹窗关闭后整窗截取，且回退那次的 OCR 观察未导出，不能确定。

### D. 称呼念整条备注（已复现）

- `ai-draft.cjs:6-7` 要求机构前缀与人之间有分隔符（T1c 刻意规定）。`湛江港濠酒店黄总` → generic；`湛江港濠酒店 黄总` → `黄总`。
- generic 时 `greetingForContact`（`ai-draft.cjs:44-52`，后续提交加入）把整条备注当称呼，产出“湛江港濠酒店黄总，下午好”。诊断截图另有“江门博雍汇灿总，下午好”。

### E. 文案被改写、格式丢失（已确认）

- 提示词 `deepseek-api.cjs:99-108` 明确要求“改写”、50–90 字、问句结尾、2–3 个 Emoji。截图中两位联系人收到的正文各不相同。
- `sanitizeAiMessage`（`ai-draft.cjs:73`）把所有空白压成单个空格，超过 260 字返回空；固定话术兜底同样丢换行。

## 修改要求

1. **A 修复**：在 resolver 内按 `popupDpi` 换算列坐标，先剔除左端落在头像列内的 OCR 词（用 `line.words`，无词级数据时按行左端），再做 `isUnsafeVisualText`、`labelledWechatId`、`hasNameConflict` 判断。阈值用 DPI 归一列，不写死像素。“网络查找微信号”行、多候选、超长微信号（superstring veto）等现有拒绝必须保持。
2. **名字路径**：同样先剔除头像列噪声；是否接受 emoji/截断名，等第 5 条证据回来再定，本轮不放宽。
3. **称呼（D）**：用户本次明确要求称“黄总”，取代 T1c“必须有分隔符”的限制：机构前缀以 `ORG_END_RE` 机构词结尾时，可直接接“1 个常见姓 + 职务”。关系词否决、常见姓表、整条锚定、64 字上限不变。仍识别不出时只用时间问候，**删除把备注当称呼的回退**。
4. **文案（E）**：默认“原文发送”——正文逐字保留用户话术（含换行、`[加油]` 等微信表情码），只在开头加称呼+问候，并去掉话术里已有的 `{称呼}`/旧问候。AI 润色改为任务级可选开关，默认关闭；开启时提示词须要求保留全部业务信息和分行，不得新增问句。兜底话术不压缩换行；长度上限按微信单条实际限制，不足时提示而非静默丢弃。界面需能看到当前任务是原文还是润色。
5. **诊断架构**：
   - `search-r014` 当前在 resolver 中 7 处共用（约 495、555、578、637、644、647、654 行），拆成独立编号并登记 `src/shared/wechat-rule-catalog.json`；同时修正目录中已过时的 r014/r015 行号。编号不重排、不复用。
   - 任务 passport 的 `raw-reading.json` 必须保留 `search_query_type`、`fallback_reason`，以及首次和回退两次搜索各自的 `rule_id` 与 `ocr_observation`（现回退前的观察被 `discardSearchCapture` 丢弃，r015/not_opened 的 raw-reading 不含 OCR）。
   - not_opened 记录标题与期望名的比对摘要：长度、`sha256_16`、是否仅标点/空白/全半角差异，不记原文。
   - r015 截图在弹窗关闭前截取弹窗区域。
6. **需用户决定，未决前不改**：`task-passports/**/*-screen.png` 当前未打码（含聊天内容、客户名、微信号），与 `docs/failure-evidence.md`“截图全部打码”不一致；`failure-evidence/*.png` 确为全灰。本次定位依赖这些原图。实施前向用户确认保留策略，并同步文档。

## 允许改动

`desktop/rpa/active_touch/wechat_search_result_resolver.cjs`、`state_machine.cjs`、`wechat_window_driver.cjs`（仅证据字段）、`desktop/src/main/ai-draft.cjs`、`deepseek-api.cjs`（提示词）、`touch-workflow.cjs`/`touch-task-ipc.cjs`（文案模式）、`task-passport.cjs`（字段白名单）、`src/shared/wechat-rule-catalog.json`、触达任务相关界面，以及对应 `*.self_check.cjs`、`docs/failure-evidence.md`。

## 禁止

- 不放宽身份核验来“多发几个”：无唯一本地联系人、多候选、网络查找行仍必须拒绝。
- 结果不明保持 `outcome_unknown`，不自动补发。
- 不把客户正文、微信号、联系人名写入上传到吐槽中心的诊断。

## 验收

- 回归样例：用 #6、#9、#16、#18 的 OCR 几何（`raw-reading.json` 中的框，文本按截图与字数还原，噪声首字分别用标点和数字）建样例，旧实现失败、新实现选中；另加“网络查找微信号”、双候选、超长微信号三个反例保持拒绝。
- 称呼表驱动：`湛江港濠酒店黄总`→`黄总`；`江门博雍汇灿总`、`深圳客户追发票的`→仅时间问候；T1c 原有样例全部不变。
- 文案：用户这段多行话术（见吐槽正文）原文模式下逐字保留、换行保留，仅加“黄总，下午好”。
- 自检：resolver、active-touch、ai-draft、deepseek-api 定向自检通过；按 README 要求做构建检查。
- 真机：回到同一台 1809 / 125% / 微信 4.1.15.13 电脑，只对用户指定的测试联系人复测；#6、#9、#16、#18 类联系人应通过身份确认；#3、#12、#2、#4、#8 用新证据复核并回报原因。构建、自检、真机结果分开报告。
