# 审查报告：搜索联系人阶段"跳过"原因调查（2026-09-16）

调查人：审查方（只读，未改任何代码）
数据来源：本机 `xiaoxi-active-touch-test` 运行数据（10 个 workflow-task 账本 + 运行日志），代码路径 touch-workflow.cjs / wechat_search_result_resolver.cjs

## 一、结论（先说答案）

"搜索微信联系人被跳过"有**两类完全不同的原因**，用户观察到的"有的跳、有的不跳"两类都存在：

### 类型 A：任务创建时预排除（确定性，按联系人数据决定）

- reason_code = `wechat_id_missing`，文案"该联系人未公开微信号，无法安全精确搜索，已跳过"
- 触发条件：通讯录同步时该联系人没有公开微信号（如企业微信联系人、小程序账号）
- 证据：2026-08-27 任务（touch-9d58bc7f）预排除 2 人（"玺联惠创客合伙人城胜"、"小猫"），同一任务 4 人全部 sent_verified
- **这是设计行为，不是 bug**：没有微信号就无法做"精确搜索+身份核验"，宁可排除也不能搜错人

### 类型 B：运行时身份核验失败（偶发，同一联系人下一轮就能成功）

- reason_code = `search_result_identity_unverified`，文案"搜索结果识别波动…"→ 重试 2 次仍失败 →"已跳过当前联系人"（status = identity_skipped）
- 重试预算：首次 + 2 次自动恢复（IDENTITY_RECOVERY_ATTEMPTS = 2），共 3 次机会
- **实锤证据（本机 2026-09-15 13:50–14:34，任务 97716abc）**：
  - A测试客户：3 次尝试全部"搜索结果身份无法唯一确认" → 跳过
  - 森妮：3 次全部失败 → 跳过
  - 向锦涛：3 次全部失败 → 跳过
  - 炎燃：第 1 轮失败，等待约 15–20 秒后的重试**成功**（14:21:30 与 14:32:30 两次成功都发生在"输入状态变化延后"之后）
  - **12 分钟后的下一轮任务（a018f11c）同样 4 人全部 sent_verified** → 证明是瞬时观测质量问题，不是联系人数据问题

## 二、机制拆解（为什么会"无法唯一确认"）

点击搜索结果前，解析器必须**唯一确认**目标行，判定级联（wechat_search_result_resolver.cjs:249-350）：

1. UIA 路径：恰好 1 个本地候选且身份匹配（微信 4.1.13 UIA 树近空，基本走不到）
2. 视觉路径（主路径）：
   - OCR 必须成功（ocrOk），候选必须落在搜索下拉裁剪区内（r003–r006）
   - 期望找到"微信号: xxx"标注且与查询一致（exact_wechat_id_visual / unique_local_visual）
   - 无标注时需要"紧凑表面唯一 + 有伴随身份文本"（r013/r014 兜底拒绝）
   - 网络查找行必须能被配对解释，否则拒绝（1.1.43 加严后）
3. 任一步骤不满足 → `search_result_identity_unverified`（r001–r015）

**高频失败的模式**：失败轮里重试间隔仅约 5 秒，且 3 连败；而成功都发生在等待 15–20 秒之后。指向**搜索下拉渲染/OCR 未沉降就读取**的时序问题——读早了，下拉列表不完整或行文本不全，核验必然失败。

## 三、发现的可诊断性缺口（请 Codex 评估）

1. **跳过记录不含 rule_id**：identity_skipped 的 skipped_records 为空数组，`recordSkippedResult`（touch-workflow.cjs:408）只记了 reasonCode，没记解析器返回的 rule_id（r001–r015）和 candidate/OCR 诊断。用户问"为什么跳过"时无法回答到规则级。
2. **失败证据未随任务归档**：failure-evidence 的截图/JSON 没有落在对应 workflow-task 目录，事后无法复盘。
3. **恢复重试间隔偏短**：identity_recovery 重试延迟为 attempts × 2 秒（最多 4 秒），与本机观测到的"15–20 秒后才能通过"不符，3 次快速重试大概率连续撞同一时序问题。

## 四、给 Codex 的待回应问题（S 系列，先回应单再实施）

- **S1**：identity_skipped / pre_send_skipped 的 skipped_records 中补充 rule_id + candidate_count + visual_candidate_count + ocr_ok（数据已在 resolver diagnostics 中，只是没透传落盘）。纯诊断增强，不改行为。
- **S2**：评估把 identity_recovery 重试延迟改为沉降等待（如 5s → 10s → 20s 递增），并说明是否会拖慢整体节奏。
- **S3**：确认 1.1.45 之后搜索链路未受 TickCount64 波及（图片脚本专属，但请确认搜索脚本无同类 API——本机 09-15 失败轮发生在 1.1.43/1.1.44，不能排除旧版因素）。
- **S4**：失败证据（截图+JSON）落盘到对应 workflow-task 目录或建立可关联的归档路径。

## 五、与"提效"的关系（回应用户第一重担忧）

提效（第三档，常驻 PowerShell 等）**不会**触碰本报告的判定逻辑——分级表、身份核验、门禁都在，且每档独立版本 + 本机 3×sent_verified + 客户机同人同图验收 + 放量前小批量金丝雀。TickCount64 教训已固化为打包门禁（自检断言，self_check.cjs:37），同类错误会被构建拦截而不是带到现场。
