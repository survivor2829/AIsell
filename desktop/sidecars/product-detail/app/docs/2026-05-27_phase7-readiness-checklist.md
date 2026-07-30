# 阶段七硬件 / PG / Redis / 自愈预备清单

> 日期：2026-05-27
> 状态：预备，不执行
> 目的：把阶段七的触发条件、操作边界、检查项和回滚点提前列清楚。本文档不代表已授权升配、部署、生产 DB 迁移或真实环境操作。

## 当前状态

阶段六生产形态仍按小机策略设计：

- 2C2G / SQLite / memory pubsub / `docker compose up -d` 只起 web。
- `docker-compose.yml` 已包含 `db` / `redis`，但挂在 `profiles: ["full"]` 下。
- `web` 当前资源保护为 `mem_limit: 1400m`、`memswap_limit: 3400m`。
- 并发池当前为 `BATCH_POOL_SIZE=1`、`SINGLE_POOL_SIZE=1`、`REFINE_POOL_SIZE=1`。
- `pubsub/` 已支持 `PUBSUB_BACKEND=memory|redis`。
- Postgres 迁移脚本已存在：`scripts/archive/one_shot/migrate_sqlite_to_pg.py`。

## 启动阶段七的触发条件

任一条件满足，再进入阶段七执行：

| 条件 | 触发说明 |
|---|---|
| 单批 >= 5 产品且耗时 > 10 分钟 | 2C2G 串行已经影响体验 |
| swap used > 500MB 持续 > 5 分钟 | 资源瓶颈明确 |
| 用户多次反馈“卡” | 体验压力高于成本压力 |
| 多用户并发 >= 3 且排队 > 5 分钟 | 需要 PG/Redis/多 worker |
| 计划向 5 个以上 demo 客户开放 | 轻量商用化地基需要补齐 |

未触发时建议：

- 不主动升配。
- 不急着上 PG/Redis。
- 可先做不花钱、不动生产的 UX 快赢。

## 授权边界

以下动作必须 stop-and-ask：

- 腾讯云机器升配 / 降配。
- 任何 SSH 到生产环境的操作。
- `docker compose up -d` / recreate 生产容器。
- 改生产 `.env`。
- SQLite -> Postgres 真实迁移 `--commit`。
- 修改生产 DB 数据。
- 真实多用户 / AI 真测导致费用的操作。

## 阶段七推荐顺序

### Step 0：只读盘点

- [ ] 记录当前 Git commit / branch。
- [ ] 记录当前生产容器状态。
- [ ] 记录当前 `.env` 关键非密值：`DATABASE_URL` 类型、`PUBSUB_BACKEND`、池大小。
- [ ] 记录磁盘、内存、CPU、swap 当前值。
- [ ] 记录最近一次真实批量耗时。

### Step 1：升配前备份

必须备份：

- [ ] `instance/`
- [ ] `static/uploads/batches/`
- [ ] `static/outputs/`
- [ ] `static/ai_refine_v2/`
- [ ] 当前 `.env` 的安全副本（只在密码管理器或服务器本地保管，不入仓库）

验收：

- [ ] 备份文件存在。
- [ ] 备份大小合理。
- [ ] 至少列出 tar 内容前几项确认路径正确。

### Step 2：硬件升配到 4C8G

目标：

- RAM 约 7.5GB。
- CPU = 4。
- IP 不变。

验收：

- [ ] `free -h` 确认内存。
- [ ] `nproc` 确认 CPU。
- [ ] SSH 新会话可登录。
- [ ] Web 首页/登录页可访问。

### Step 3：同步容器资源参数

当前小机参数：

```yaml
mem_limit: 1400m
memswap_limit: 3400m
BATCH_POOL_SIZE: "1"
SINGLE_POOL_SIZE: "1"
REFINE_POOL_SIZE: "1"
```

4C8G 建议参数：

```yaml
mem_limit: 6500m
memswap_limit: 9500m
BATCH_POOL_SIZE: "3"
SINGLE_POOL_SIZE: "2"
REFINE_POOL_SIZE: "2"
```

注意：

- 改 `mem_limit` / `memswap_limit` 必须 recreate，`restart` 不够。
- 调池大小前要确认 Chromium / rembg 峰值仍在安全线内。

验收：

- [ ] `docker stats --no-stream` MEM LIMIT 约 6.34GiB。
- [ ] 容器内 `printenv BATCH_POOL_SIZE` = 3。
- [ ] 日志无 traceback。
- [ ] 登录页 HTTP 200。

### Step 4：僵尸批次自愈

先做自愈，再上多 worker 更稳。

建议范围：

- [ ] `process_one_product` 顶层用 `try/finally` 保证状态回写。
- [ ] 新增 `POST /api/batch/<id>/reset-stuck-items`。
- [ ] 仅 batch owner / admin 可操作。
- [ ] 默认只重置超过 N 分钟未更新的 `processing` item。
- [ ] `batch/history.html` 或 detail 页提示“有卡住 item”并提供 reset 按钮。
- [ ] 添加守护测覆盖 owner check、阈值、状态转换。

非目标：

- 不自动重跑卡住 item，避免重复烧钱。
- 不对已完成 item 做任何修改。

### Step 5：Postgres 接入

前置：

- [ ] 4C8G 稳定。
- [ ] 备份完成。
- [ ] 迁移 dry-run 通过。

动作：

- [ ] `.env` 改 `DATABASE_URL=postgresql://...`
- [ ] `docker compose --profile full up -d`
- [ ] `flask db upgrade`
- [ ] `python scripts/archive/one_shot/migrate_sqlite_to_pg.py --commit`

验收：

- [ ] 登录、用户、批次历史可读。
- [ ] 新建批次能写入 PG。
- [ ] 旧 SQLite 数据数量与迁移后数量对得上。
- [ ] `with_for_update(skip_locked=True)` 路径可用。

### Step 6：Redis pub/sub 接入

前置：

- [ ] Redis 容器健康。
- [ ] `REDIS_URL` 配好。
- [ ] `PUBSUB_BACKEND=redis`。

验收：

- [ ] WebSocket 跨 worker 能收到 stage 事件。
- [ ] Redis 初始化失败会降级 memory，但生产必须观察日志确认没有降级。
- [ ] 多用户批量任务互不串线。

### Step 7：多用户并发 E2E

场景：

- [ ] 用户 A 跑 HTML 批次。
- [ ] 用户 B 同时跑 HTML 批次。
- [ ] 用户 A / B 各自只能看到自己的批次。
- [ ] WebSocket 只推送对应 batch。
- [ ] AI 精修不跨用户串 quota / 状态。

验收输出：

- 建议新增报告：`docs/superpowers/audits/<date>-phase7-multiuser-e2e.md`

## 回滚方案

### 只升配失败

- 腾讯云控制台降回原规格。
- 恢复旧 compose 参数。
- `docker compose up -d` recreate web。

### PG 迁移失败

- 停止 web 写入。
- `.env` 切回 SQLite `DATABASE_URL`。
- 使用升配前备份恢复。
- 保留失败日志，禁止半手工补 DB。

### Redis 失败

- `PUBSUB_BACKEND=memory` 临时回退。
- 保持单 worker / 低并发。
- 记录 Redis 初始化错误。

## 与当前规划的关系

- P5.6 真测通过前，不建议为了扩品类提前进入阶段七，除非性能触发条件已命中。
- 若暂时没有真测授权，可先实施 `docs/2026-05-27_upload-ux-quick-win-plan.md`。
- 阶段七一旦启动，优先做备份和自愈，再做 PG/Redis。
