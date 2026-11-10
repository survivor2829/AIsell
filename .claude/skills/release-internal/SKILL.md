---
name: release-internal
description: 发布 AI获客 内部更新的固定流程。用户说“发版/更新一下/发内部测试/发布这个版本”，或一次改动做完要交付给用户时使用。
---

# 内部更新 SOP

每次更新都走这一条路，顺序不变、不换别的命令。细节和例外见 `docs/internal-release.md`。

1. **分支**：从最新 `main` 拉 `claude/<主题>` 短分支。
2. **改动**：只改本次范围；长耗时的新功能要接桌宠进度（`sprite-activity.cjs` 的 `SPRITE_FEATURES`，漏接自检不过）。
3. **版本三件套**
   - `desktop/package.json` 和 `package-lock.json`（两处）递增版本号。
   - `customer-release-notes.json` 写客户听得懂的话，第一条是最大亮点，未验证的写进 `limitations`。更新弹窗、公告页、等待页都由它自动生成，不用另外写。
   - `customer-release-dates.json` 写 `YYYY-MM-DD HH:mm`（北京时间），`docs/project-status-history.md` 顶部加一条本版记录；只有能力或验证状态变了才改 `PROJECT_STATUS.md`（当前状态）。
4. **本机验证**：相关自检 + `npm.cmd run build:test`；界面改动用临时实例看真实页面，不碰用户数据。微信相关先在开发机测试号实测。
5. **独立审查**：`code-review`，修掉确认的问题。
6. **CI**：推分支开 PR。只有 Electron 下载 504 这类网络失败才重跑失败项，别的失败先修。`gh pr checks` 全绿才往下走，同一分支不要同时挂两个重试循环。
7. **合并**：`gh pr merge <N> --merge --delete-branch`。
8. **打包发布**：在 `desktop/` 运行 `npm.cmd run release:sop`（需要关沙箱）。它把发布工作区切到 `origin/main`、设好环境、构建、发布并读回验签。失败就停下看原因，不换整包、不绕过。
9. **交付**：构建、自检、发布读回、真实使用分别报告，没验的写没验。

需要另外获得用户同意：正式客户频道、付费调用、服务器部署、新的真实微信操作。
