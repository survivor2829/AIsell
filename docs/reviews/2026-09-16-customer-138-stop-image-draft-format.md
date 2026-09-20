# 审查报告：客户机 1.1.45 跑量 138/185 停机分析（2026-09-16 19:00）

数据来源：客户机诊断包 2026-09-16T11-02-10Z（summary + diagnostics.jsonl 6901 条 + 13 份 failure-evidence）
审查人：审查方（只读）

## 一、结论（三句话）

1. **1.1.45 在客户机量产环境完全站住了**：82 分钟连续跑 127 个联系人，114 次图片发送全链路成功（中位耗时 2.9 秒/次），TickCount64 修复经受住了实战检验。
2. 第 138 个联系人发图时，粘贴后回读输入框草稿**没检测到图片**，抛出新错误码 `image_draft_format_unavailable`（image-r010）——该联系人**未发送任何内容**（side_effect=none，安全）。
3. 停机不是崩溃，是**设计行为**：这个错误码不在 1.1.45 的失败分级表里，按"未知即暂停等人工"的 fail-closed 规则全局停下。分类表缺了这一个码，是实施方的遗漏，不是架构问题。

## 二、这轮跑量的完整画像（09:26:53–10:49:32 UTC）

| 指标 | 数值 |
|---|---|
| 任务总量 | 185（UI 显示 183，另有 2 人预排除） |
| 推进到 | 138（完成率 74.6% 后暂停） |
| 图片发送成功 | 114 次，min 2.87s / 中位 2.96s / max 4.05s |
| 搜索身份核验跳过 | 4 人（search-r014，各试 3 次后按设计跳过，12 次失败记录齐全） |
| 发图阶段失败 | 1 次（第 138 人，即停机点） |
| 全局停机 | 1 次（image_draft_format_unavailable 未分类 → unknown_reason_paused） |

搜索引擎核验跳过的诊断数据本次齐全（candidate_count=0、visual 9~15、ocr_ok=true），与昨日 S 报告的判断一致，S1 落盘诉求本次已由 image 链示范（rule_id+完整 image_progress 都在）。

## 三、停机点机制（image-r010 / image_draft_format_unavailable）

发生位置：wechat_image_send 脚本 read_back 段（runtime error_line 686），紧跟 paste 之后：

- 流程：sentinel_write ✓ → read_back ✓ → image_load ✓ → clipboard_bitmap ✓ → paste ✓ → **read_back ✗（2877ms 内重试 5 次剪贴板/草稿读取）**
- 判定代码（wechat_image_send.dev.cjs:349-351）：回读草稿时 `$draft.image` 为 false → 抛 `image_draft_format_unavailable`
- 语义：**粘贴动作后，微信输入框里没有检测到图片草稿**。要么 ^v 没进输入框（焦点/竞态），要么图片缩略图渲染慢于读取（脚本仅等 350ms 就读），要么检测误报
- 安全性：抛出点在 click_send 之前，`send_attempted=false`、`side_effect=none`、payload 自带 `retryability=safe_retry` —— 该联系人明确未发送，可安全重试

137 连发成功后第 138 人单发失败，且失败前 read_back 重试了 5 次——指向**瞬时状态**（渲染/焦点/剪贴板时序），非数据或资源性问题。机器 8GB 内存、余 2.6GB，长时间运行后有轻度资源压力但未见异常指标。

## 四、给 Codex 的修复指令（C 系列，先回应单再实施）

- **C1（主修复）**：把 `image_draft_format_unavailable` 收进失败分级表，归为**可恢复类**。依据：payload 已证明 send_attempted=false + side_effect=none + safe_retry；处置=有界重试（建议 2 次）→ 仍失败则跳过该联系人继续任务，不得全局停机。
- **C2（脚本内自愈）**：paste 后 read_back 增加沉降重试——首次读取失败后等 800~1200ms 再读，最多 3 轮（覆盖缩略图渲染慢），全部失败才抛错。与 C1 的重试预算分开，避免双重重试叠加超时。
- **C3（分类表完整性自检）**：新增门禁——扫描图片脚本所有 `throw "image_*"` 字面量，逐一核对都在失败分级表中有归类，防止再出现"新错误码=全局暂停"。
- **C4（恢复路径确认）**：剩余 47 人的续跑方式需要明确答复：直接"启动任务"是只跑剩余还是重头？138 号联系人应可安全重试（未发送）。另请解释 UI 红条"会话与其他处理联系人重复"文案对应的检测逻辑，与本次停机是否有关（日志未见 duplicate 事件，疑似另一路提示）。
- **C5（延续 S 系列）**：search-r014 跳过的 4 人本次仍未把 rule_id 写进任务账本 skipped_records（failure-evidence 里有，账本里没有），S1 诉求维持。

## 五、给用户的操作建议

- 不用慌：114 人已成功送达，未发送的 138 号联系人没有副作用，剩余 47 人原地未动。
- 等 Codex 出 1.1.46（C1+C2 是小改动），装上后续跑即可；不要在 1.1.45 上反复整批重跑剩余名单来"试"。
