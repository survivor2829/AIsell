# U1 结果：更新助手不再等待复用了上级 PID 的无关进程

分支 `claude/update-pid-reuse`，提交依次为：
- `31c5d73`：首版修复；
- `e37656f`：时钟宽限，按 PID + 启动时间识别进程；
- `48eecd5`：补测试；
- `168ff53`：F-OWN。

## 改动

`desktop/src/main/update-helper.cjs`：

- `createdAt()`：解析 `/Date(ms)/` 和 ISO 两种 CreationDate，解析不了返回 null。
- `startedUnder()`：上级关系在两种情况下断开，宽限都是 60 秒，启动时间未知时一律保留关系：
  - 子进程比上级早启动超过 60 秒；
  - 该 PID 已换了新主人，且子进程比新主人晚启动超过 60 秒。
- `descendants()`：
  - 按 PID + 启动时间识别进程，复用了同一 PID 的新进程是另一个进程；
  - 已跟踪的根进程不会被 PID 复用者替换。
- `waitForExit()`：任务里记录的、早于助手启动的应用进程，不算助手自己的进程。

`desktop/scripts/update-helper.electron.self_check.cjs` 新增 `checkProcessTreeIgnoresReusedPids`：

- 回放 10-01 事故；
- 覆盖：
  - ISO 时间；
  - 未知时间（子进程、上级、PID 新主人三处）；
  - 时钟回拨 1.5 秒；
  - 同一毫秒启动；
  - 已退出 worker 的遗留子进程；
  - 根和 worker 的 PID 被陌生进程复用；
  - 我方 worker 接管 PID；
  - 助手拿到已退出应用进程的 PID；
- `waitForExit` 两个方向各回放一次：只剩陌生进程时放行，真实进程仍在时等到超时失败。

## 验证（在 `C:/Users/Scott/xiaoxi-review/update-pid/desktop`）

```
node scripts/update-helper.electron.self_check.cjs   → update-helper Electron 32.3.3 backup self-check passed
node scripts/update-helper.e2e.cjs                   → Update helper process fixture passed.（observedPhase complete）
node scripts/component-update-selftest.cjs           → pass 4, fail 0
```

旧代码上运行新测试：
- 88ba683：失败，`a process older than its recorded parent is not that parent's child`；
- 48eecd5：失败，`Missing expected rejection`（F-OWN 用例）。

变异测试脚本是 `C:/Users/Scott/xiaoxi-review/update-pid-review/mutate-e37656f.cjs`，13 个变异全部被抓住：
- 去掉宽限；
- 去掉"早于上级"判断；
- 去掉 PID 新主人判断；
- 新主人判断不加宽限；
- 子进程、上级、新主人的时间未知时丢弃关系（三个变异）；
- 只按 PID 识别进程；
- 根进程被覆盖；
- 只用 Date.parse；
- 只看第一个候选上级；
- 去掉助手自身进程的记录过滤；
- 整体还原为 88ba683 版本（单独替换文件验证）。

本机实时快照（只读）：
- 416–422 行，CreationDate 全部是 `/Date(ms)/`；
- 有 17 个进程的记录上级已退出或已被更新的进程占用，涉及 14 个已失效的上级 PID。

## 开发机实况

- 10:35、11:01 两次从 1.1.54 应用内更新都报 `update_workers_still_running`。被误等的进程是：
  - 第一次：`clouddrive_desktop_widget.exe`，08:46 启动；
  - 第二次：`FyTool.exe`、`ChatterflyCloud.exe`，08:47 启动。
- 用户数据先备份到 `C:/Users/Scott/xiaoxi-review/backup-pre-1.1.55/userdata`：8,813 个文件，10.4 GB，0 失败。
- 之后用户用 1.1.55 完整安装包覆盖安装，安装成功，创作工作台的模型调用正常。
