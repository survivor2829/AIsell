# 图片发送 180 秒挂起真因：`TickCount64` 在 PowerShell 5.1 上求值为 $null

- 日期：2026-09-16 15:55
- 性质：外部交叉审查（审查方本机实测诊断，未改仓库代码）
- 结论置信度：**实锤**（变量级证据，可复现实验）

---

## 1. 一句话结论

**图片脚本的 11 处 `[Environment]::TickCount64` 在 Windows PowerShell 5.1（.NET Framework 4.8，即驱动实际使用的运行时）上不存在，求值结果为 `$null`。** 后果：`read_back` 轮询环的 `$waitUntil` 变成光秃秃的 `200`，while 条件 `[空→0] -lt 200` **永远为真 → 无限自旋 → 187 秒被驱动超时杀掉**；同时**所有阶段预算（含 20 秒 read_back 预算）从未生效过**——这就是 X4 验收失败的真因，也大概率是客户机 1.1.44"185 秒挂起"的真因。

X1（租约沉降）和 X2（租约移出轮询环）方向完全正确、实现无误——**X2 拆掉了租约竞态这根"意外保险丝"，暴露了被它掩盖的更深的地雷。**

## 2. 决定性证据（本机复现 + 变量级转储）

### 2.1 现象复现

- 审查方 harness（Temp/ab-test/ab-run.cjs，未改动）：窗口绑定 OK、会话核验 OK、sentinel_write **正常完成**，进入 read_back 后 183 秒零标记 → 超时。与 Codex 报告的 X4 失败完全一致。
- 同机同窗口同图，**旧版脚本（6a8f1cb）此刻 7.5 秒 sent_verified 全链路成功**——环境无罪。

### 2.2 变量级转储（Temp/ab-test/instrumented-run.cjs，插桩复跑）

在轮询环每圈末尾转储变量值（444 圈，每圈 ~48ms，被 25 秒看门狗击杀）：

```
DIAG:after432 seq=582 before=582 now= waitUntil=200 stage=read_back startedAt=
```

- `seq=582 before=582`：剪贴板序列号未变（作曲框为空，^c 无产物——正常）
- **`now=`（空）**：`[Environment]::TickCount64` 求值为 `$null`
- **`waitUntil=200`**：本应为 `当前时钟 + 200ms` 的巨大 tick 值，实际 = `0 + (120+80×1) = 200`
- while 条件 `$copySequence -eq $beforeCopySequence -and [Environment]::TickCount64 -lt $waitUntil` → `true -and (0 -lt 200)` → **恒真**
- **`startedAt=`（空）**：`$script:imageStageStartedAt` 也是空 → 429 行 `Assert-ImageStageBudget` 的 `TickCount64 - startedAt -gt budget` 恒为 `0 - 0 = 0 > 20000` = false → **预算检查永远不会抛超时**。这回答了 Codex 报告中最关键的未解疑问："进入 read_back 后 20 秒阶段预算为什么不生效"——不是没生效，是它出生起就没活过。

### 2.3 机制：为什么 TickCount64 是 $null

- `Environment.TickCount64` 是 **.NET Core 3.0+** 新增 API；.NET Framework 4.8（Windows PowerShell 5.1）上不存在。
- 驱动 `runPowerShellAsync` 拉起的是 `powershell.exe`（5.1），非 `pwsh`。
- PowerShell 非严格模式下，访问不存在的静态属性**不报错，返回 $null** → 后续所有算术把它当 0，静默错误，构建/语法检查/自检全部无法发现。

## 3. 全部 11 处使用点及后果（文件：wechat_image_send.dev.cjs）

| 文件行 | 用途 | 后果 |
|---|---|---|
| 11/15/30 | preload 计时 | `elapsed_ms` 恒为 0——**今天所有诊断日志里的 `elapsed_ms=0` 都是假象**，不是真实耗时 |
| 44/78 | `$script:imageStageStartedAt` | 空 → 所有阶段计时基准丢失 |
| 54/61 | `Complete-ImageStage` elapsed | 恒 0，超时判断失效 |
| **69** | `Assert-ImageStageBudget` | **所有阶段预算永不触发**（20s read_back 预算形同虚设） |
| 90/92 | 剪贴板写 5 秒超时 | **死代码**——X3 新加的写超时兜底从未可能生效 |
| 118/126 | 租约沉降 | 上限失效；实际靠"连续 2 次稳定采样"碰巧退出（运气好的有界） |
| **210/216** | **read_back 轮询 waitUntil/while** | **无限自旋——本次 X4 失败主凶** |

其他 RPA 脚本（窗口驱动、朋友圈等）经 grep 确认干净，毒面仅此一个文件。

## 4. 修正与贯通：之前所有"诡异现象"现在全部对上

1. **为什么 1.1.44 在本机 A/B 是"快速失败"而不是挂起**：1.1.44 的轮询环里有租约检查（含竞态），每圈 40ms 就抛 `wechat_external_input_detected`——**租约竞态客观上当了这颗自旋地雷的保险丝**。保险丝先炸，自旋从未暴露。
2. **为什么 1.1.45 X4 验收必挂**：X2 按 X2 指令移除轮询内租约检查（正确且必要的修复），保险丝没了，自旋立刻暴露——本机 187s、Codex 的 ~180s，同一颗雷。
3. **客户机 1.1.44 的 185 秒挂起（修正审查方此前的判断）**：此前判断"零标记=卡死在预加载段"，现在更可能的解释是**同一个自旋**——客户机上租约检查恰好每圈通过（时序/机器差异），脚本在 read_back 自旋到驱动超时。原判断依据之一 `image_progress_lost=true` 已被证明不可靠（本机 1.1.45 诊断里 progress 数组有 7 条、lost 却仍为 true）。此修正请在回应单中核验。
4. **1.1.42 WIP 引入 TickCount64 的那天，就是图片功能"改着改着不可行"的起点**——它与租约竞态（b774489/e7d4671 一并引入）两个雷叠加，制造了三轮客户机失败的全部表象。

## 5. 修复指令（Y 系列；先出回应单，确认后再动代码）

### Y1（根修，一处模式、11 个替换点）

新增时钟助手（.NET Framework 兼容）并全量替换：

```powershell
function Get-UptimeMs { [long]([DateTime]::UtcNow.Ticks / 10000) }
```

- 全文件 11 处 `[Environment]::TickCount64` 全部替换为 `Get-UptimeMs`；
- 禁止再引入 TickCount64 或任何 .NET Core-only API（见 Y2）；
- 若希望更严格单调，可用 `[System.Diagnostics.Stopwatch]::GetTimestamp()` 换算，二选一，说明选型理由。

### Y2（门禁，防复发）

把"PowerShell 脚本字符串中出现 `TickCount64`"加入源码自检门禁（与失败码归类门禁同层）：构建时静态扫描所有脚本模板，命中即失败。可选加固：维护一份 .NET Core-only API 黑名单清单。

### Y3（回归用例）

- 合成用例：mock/替换时钟源，断言 read_back 空作曲框轮询在 ≤1 秒内正常退出（而不是 200ms 预算被空时钟击穿）；
- 断言 `Assert-ImageStageBudget` 在人工推进时钟后能真实抛 `image_stage_timeout`（证明预算复活）；
- 断言 Settle-ImageInputLease ≤ 300ms。

### Y4（验收协议，不变）

修完跑审查方 harness（`node %TEMP%\ab-test\ab-run.cjs new`）：预期 existing_draft_check 秒过、全链路真实发送，**连续 3 次 sent_verified** → 1.1.45 打包 → 客户机同人同图实测。X1/X2/X3 已实现部分保留，不回退。

### Y5（复盘修正）

1.1.45 本机验收通过后，用新时钟重读客户机 1.1.44 的 185 秒诊断包原始 stderr（如已归档），确认是否为同一自旋，并在版本公告中修正该轮归因。

## 6. 流程备注（给 Codex 的一句话）

Codex 的观察"进入 read_back 后未产生阶段完成标记；最终约 180 秒总预算超时"完全正确——但下一步应该问的正是"**为什么 20 秒阶段预算没有抛超时**"。预算检查失效本身是本轮最大的线索：一个"永不触发的安全网"比"没有安全网"更危险，因为它让所有 downstream 判断都建立在假象上。

## 7. 审查方测试工具（Temp/ab-test/，仓库零改动）

新增：ab-diag.cjs（spawn 层 stderr 落盘 + 超时压缩）、instrumented-run.cjs（抓取驱动真实 env 后插桩复跑）、extract-script.cjs / dump-region.cjs（脚本提取与区间打印）、wx-thread-state.cjs（微信线程状态检查）、stderr-diag-*.log / instrumented-stderr-*.log（原始 stderr 存档）。
