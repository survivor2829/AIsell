# 任务2 技术方案 · 状态实时更新 (per-stage pubsub pill)

> **日期**: 2026-04-22
> **状态**: 待用户 review
> **前置**: 任务1 完成; design-tokens.md 已批准 (决策 A/B), 任务3 美化记阶段八 8.4
> **依赖**: 现有 `batch_pubsub_mod` (pubsub/memory backend) + 现有 `/ws/batch/<id>` 路由

---

## 1. 后端 Pub/Sub 事件协议

### 1.1 事件 Schema

所有事件是 JSON 对象,通过 `batch_pubsub_mod.publish(batch_id, event)` 广播。后端自动补 `ts` (unix ms) 和 `batch_id` 字段。

**通用必填字段**:
```json
{
  "type":     "stage",           // 事件类型, 新增的一类
  "item_id":  15,                // BatchItem.id
  "name":     "DZ70X新品1",       // 产品名 (冗余, 前端 find by name 用)
  "stage":    "parsing",         // 6 个值之一
  "ts":       1776832123456      // 后端补
}
```

**stage 枚举** (严格 6 个):
- `pending`    — 任务进队列但未开始 (PoolExecutor 未 take)
- `parsing`    — DeepSeek 解析进行中
- `cutting`    — rembg 抠图进行中
- `rendering`  — Jinja render_template + preview.html 落盘
- `capturing`  — Playwright 启动 Chromium + 截图
- `done` / `failed` — 终态 (继续沿用现有 `type='product'` 事件)

**stage 映射到 batch_processor.py 埋点**:

| stage | 触发点 (行号) | 现有 print |
|---|---|---|
| `parsing`   | L268 before DeepSeek 调用 | "DeepSeek 解析中…" |
| `cutting`   | L295 before rembg 调用 | "rembg 抠图中…" |
| `rendering` | L310 before `_render_product_preview` 调用 | "渲染长图中…" |
| `capturing` | `_render_product_preview` L185 preview.html 写完后 | "preview.html 已落盘" |

**done / failed 不动**: 沿用现有 `type='product'` 事件 (由 `_batch_db_sync_callback` 在 worker 完成时发),无需改。

### 1.2 可选字段

```json
{
  "elapsed_ms": 12340,   // 当前 stage 已耗时 (后端算 ts - stage_started_at)
  "progress":   null     // 暂不支持细粒度 % (不增加复杂度, 按需加)
}
```

后续演进可加 `attempt` (重试次数)、`sub_message` (更细 print 如 "parsed 15 个字段") —— 本次先不塞。

### 1.3 频率

**每个 stage 发 1 次** (进入阶段时发), 不发"阶段完成"事件 —— 下一阶段的 enter 事件隐式代表上一阶段 exit。

6 个产品批次最多 4 stage × 6 = 24 个 `type='stage'` 事件 + 6 个 `type='product'` 终态事件 = 30 个,两分钟内,远低于 WS 背压阈值。

### 1.4 PUBSUB_BACKEND=memory 下的多 worker 考量

**当前**: BATCH_POOL_SIZE=1, gunicorn workers=2 但只有一个 worker 跑批次。publish 和 subscribe 都在**同一个 Python 进程内存**, 天然一致。

**memory backend 局限**:
- 如果 WS 在 gunicorn worker A, 但 batch processor thread 在 worker B → publish 到 B 的 memory dict, WS 订阅方在 A 收不到
- 这是"多 worker + memory backend"的固有缺陷,`pubsub/memory.py` 不跨进程

**当前为何不爆**: BATCH_POOL_SIZE=1 + gunicorn sticky (WS 长连接 + `--worker-class gthread`) + 内存 pool 单实例独享,所以批次 worker 和订阅它的 WS 落在同一 worker 的概率高。但非 100%,存在静默丢失。

**未来 Redis 切换路径** (已在 pubsub/redis_backend.py 存):
```bash
# .env 改:
PUBSUB_BACKEND=redis
REDIS_URL=redis://:pwd@redis:6379/0

# docker-compose --profile full up -d (把 redis 起起来)
```
Redis pub/sub 跨 worker 广播, 天然一致。**本次任务2 不涉及 redis**,但在实现时必须用 `publish()` 接口 (而非直接操作 memory dict), 任何时候切 redis 零代码改动。

### 1.5 事件顺序保证

publish 是同步调用 (memory backend 在同一线程里完成 dict 写 + ws.send), 单产品的 4 个 stage 事件**严格有序到达**。多产品并行时不同产品的事件交错,但同一产品内严格单调。

---

## 2. 前端 WebSocket 状态机

### 2.1 State 枚举 (连接层)

```js
WS_STATE = {
  IDLE:         'idle',          // 还没建立过
  CONNECTING:   'connecting',    // new WebSocket() 到 onopen 之间
  CONNECTED:    'connected',     // onopen 触发后
  RECONNECTING: 'reconnecting',  // close 后 backoff 等待重连
  FAILED:       'failed',        // 达到 max 重连上限, 彻底降级到 polling
}
```

### 2.2 断线重连策略

**Exponential backoff**: `1s, 2s, 4s, 8s, 16s, 30s (cap), 30s, 30s...` 直到重连成功或手动关闭。

**实现伪代码**:
```js
let wsRetryDelay = 1000;
const wsMaxDelay = 30000;

function connectWS(batchId) {
  const ws = new WebSocket(url);
  ws.onopen = () => {
    setWSState('connected');
    wsRetryDelay = 1000;     // 重连成功清零
    fetchCatchupSnapshot();  // 补回断线期间状态 (见 2.4)
  };
  ws.onclose = () => {
    setWSState('reconnecting', `已断开, ${wsRetryDelay/1000}s 后重试`);
    setTimeout(() => connectWS(batchId), wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 2, wsMaxDelay);
  };
}
```

**关闭条件** (不再重连):
- 用户主动关闭页面 → `onbeforeunload` 里 `ws.close()` + 清 timer
- 批次 `batch_complete` 事件到达 → 正常完成, 主动 `ws.close()`
- 服务端返回 auth 错误 (batch 不存在或 403) → `setWSState('failed')`, 转 polling

### 2.3 断线期间的 fallback polling

**保留现有 polling 作 fallback**: 现在前端在 status 变化时轮询 `/api/batch/<id>/status`(查代码确认 session.pollInterval 存在情况), 不拆除这条路径。

**触发 polling 的条件**:
```js
if (ws.state === 'RECONNECTING' || ws.state === 'FAILED') {
  startPollingFallback(batchId);  // 5s 一次
} else {
  stopPollingFallback();
}
```

polling 拉全量快照 (pending/processing/done/failed 计数 + 每个 item 的 status/result), 不涉及 stage pill —— **stage pill 在断线期间停在最后收到的那个 stage, fade 过渡暂停**, 直到 WS 重连或 polling 推进到终态。

### 2.4 重连成功后的 catch-up

**不做历史事件重放** (memory backend 不存历史)。改成:

1. 重连成功 → 立即发 GET `/api/batch/<id>/status` 拉**当前 snapshot**
2. snapshot 里每个 item 的 `status` (pending/processing/done/failed) + `result` + 如果 processing 的话 `current_stage` (**后端需扩展 BatchItem 存当前 stage**)
3. 前端用 snapshot 覆盖所有 row 的 pill 状态 → 补上断线期间漏掉的阶段切换

**后端小改**: `BatchItem` 加一列 `current_stage VARCHAR(20) NULL`。publish 事件时同步 UPDATE。这样 snapshot 一查就有。

**权衡**: 加一个 DB 字段 vs 做内存事件队列。前者是 **持久化** + **简单** (一次 UPDATE 一条记录), 后者更精巧但 memory backend 重启丢失。选前者。

---

## 3. 前端 UI 状态机

### 3.1 Pill 状态转换

```
                    (WS event stage=X)
  pending  ──────────►  parsing  ──►  cutting  ──►  rendering  ──►  capturing
                                                                         │
                        (WS event type=product status=done)              ▼
  done  ◄──────────────────────────────────────────────────────────────  ✓
                                         │
                 (status=failed)         ▼
                                       failed
```

**state 数据结构** (每个 row 绑一个 pill):
```js
const rowPillState = {
  [itemName]: { stage: 'pending', lastUpdate: Date.now() }
};
```

### 3.2 Fade 过渡实现

**不用 setTimeout 硬切, 用 CSS transition + class swap**:

```css
.stage-pill { /* 见 design-tokens.md §8 */ transition: all var(--duration-normal); }
.stage-pending    { color: #5f5f5f; background: #f9fafb; ... }
.stage-parsing,
.stage-cutting,
.stage-rendering,
.stage-capturing  { color: var(--color-primary); background: var(--color-primary-light); animation: breathing 1800ms infinite; }
.stage-done       { color: var(--color-success); background: var(--color-success-bg); }
.stage-failed     { color: var(--color-error);   background: var(--color-error-bg);   }
```

JS 切换 class (保留 `.stage-pill` 基础不动, 只换 stage variant):
```js
function setRowStage(name, newStage) {
  const pill = findRow(name).querySelector('.stage-pill');
  if (!pill) return;
  const prev = Array.from(pill.classList).find(c => c.startsWith('stage-') && c !== 'stage-pill');
  if (prev) pill.classList.remove(prev);
  pill.classList.add(`stage-${newStage}`);
  pill.textContent = STAGE_LABELS[newStage];  // "🧠 AI 解析中..." 等
}
```

**CSS transition 自动 fade color/background**。`transform` 和 `animation` 也受同一 transition 范围 → 无需 setTimeout。

### 3.3 整批完成 Toast

**组件结构** (docs/design-tokens.md §7 `--z-toast: 300`):
```html
<div class="toast toast-success" role="status" aria-live="polite">
  <span class="toast-icon">✅</span>
  <span class="toast-title">批次完成</span>
  <span class="toast-msg">3 个产品已全部生成 · 耗时 1 分 42 秒</span>
</div>
```

```css
.toast {
  position: fixed; top: 24px; right: 24px; z-index: var(--z-toast, 300);
  display: flex; align-items: center; gap: var(--space-3);
  padding: 12px 20px;
  background: white; border: 1px solid var(--color-border); border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  animation: toastIn var(--duration-normal) var(--ease-spring);
  max-width: 360px;
}
.toast-success .toast-icon { color: var(--color-success); }
@keyframes toastIn {
  from { opacity: 0; transform: translateY(-8px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
```

**触发条件**: WS 收到 `type=batch_complete` 事件 (后端已有)。显示 4 秒后自动 fade out 移除。

**失败批次 toast**: 如果 `snapshot.failed > 0`, toast 用 `.toast-warning` variant + 文案 "完成 X 个, Y 个失败", 不自动消失 (用户要看清), 右侧加关闭按钮。

### 3.4 失败态 UI

**stage=failed 时**: pill 变 `.stage-failed` (红 bg + 红 text), hover 有 tooltip 显示 `error_message` 前 80 字。**不自动消失**, 用户必须主动点重试按钮或关闭。

---

## 4. 技术风险 + 降级

| 风险 | 触发条件 | 降级策略 |
|---|---|---|
| WS 被企业网络阻断 | proxy/firewall 不放行 `Upgrade: websocket` | 3s 内 connecting→failed → 全量走 polling (现有 5s 一次) |
| memory pub/sub 重启丢事件 | gunicorn reload / OOM restart | 重连后拉 `/api/batch/<id>/status` snapshot (§2.4), current_stage 从 DB 读回 |
| 大批次 100 产品并发事件风暴 | 假设 100 × 4 stage = 400 events 在 2 分钟内 | 事件频率可控 (每 stage 1 次, 不是 tick). 但前端加节流: 同一 item 100ms 内连续 stage 切换合并最后一个 |
| 事件乱序 (未来 Redis) | Redis pub/sub 跨 worker 可能乱序 | 每事件带 `seq` 递增, 前端只应用 seq 单调递增事件. **本次先不做** (memory backend 不乱序), 注释里标 TODO |
| 浏览器 tab 切后台 throttle | Chrome 把 WS 消息 defer, 前端状态停滞 | tab 切回时 (visibilitychange 事件) 主动重连 + 拉 snapshot |

---

## 5. 不动既有功能清单

### 5.1 保留

- **现有 polling** 完全保留, 只在 WS 断线时启动
- **现有 `type='product'` / `type='refine'` / `type='batch_complete'` 事件**不改 schema, 不动前端 handleEvent 里对应分支
- **status=done 后的渲染逻辑** (preview_png 缩略图 / AI 精修缩略) 不动
- **旧批次** (没发过 stage 事件的) UI 正常: 没 current_stage = null → pill 渲染为 "pending" 或按 status 字段推导

### 5.2 新增 (不替换)

- `BatchItem.current_stage VARCHAR(20)` 列 (Alembic migration)
- `type='stage'` WS 事件分支 (前端 handleEvent 加 `case 'stage':`)
- `.stage-pill` CSS class 组 (独立于现有 `.badge`)
- WS 重连逻辑 (替换 `ws.onclose = () => setWSState('disconnected', ...)` 为带 backoff 的版本)
- `.toast` 组件 (新增, 不替换现有 alert/confirm)

### 5.3 不动

- `BATCH_POOL_SIZE` 继续串行
- `PUBSUB_BACKEND=memory` 继续
- gunicorn workers 配置
- 现有 `/api/batch/<id>/status` 返回格式 (追加 `current_stage` 字段到每个 item)

---

## 6. 验收标准 (任务2 闭环必过)

### 6.1 功能

- [ ] 新批次上传后,用户**不刷新**就能看到 pill 切换 (pending → parsing → cutting → rendering → capturing → done)
- [ ] 手动 `ws.close()` 后 5s 内自动重连成功 (Chrome DevTools Network → WS → Close connection)
- [ ] 重连后 pill 状态与服务端 current_stage 一致 (不会回到"pending")
- [ ] 整批完成后 toast 弹出, 显示产品数 + 总耗时, 4s 后 fade out
- [ ] 有产品 failed 时 toast 用 warning variant, 不自动消失
- [ ] WS 彻底 failed 时前端自动走 polling fallback, 状态仍能刷出 (5s 一次)

### 6.2 兼容

- [ ] 旧批次 (当前生产 id<20 所有没 current_stage 字段的) 打开 UI 不崩, pill 按 status 推导 (done/failed)
- [ ] 现有 AI 精修列 / 下载按钮 / lightbox 全部不回归

### 6.3 证据 (Playwright 5 屏, 任务1 同标准)

- [ ] `docker exec python3 playwright` 拉 5 viewport (1920/1600/1440/1366/375) 的 `/batch/upload` 页面,assertions:
  1. 每屏打开带一个 mock batch (2 个产品), 100ms 后注入 stage=parsing 事件, 截图显示 pill = "🧠 AI 解析中..."
  2. 继续注入 stage=capturing, 截图显示 pill = "📸 生成图片..."
  3. 注入 type=batch_complete, 截图显示 toast 在右上角
  4. 模拟 WS close, 1.2s 后截图显示 "reconnecting" 状态 + polling 降级提示
  5. mobile-375 屏下所有上述显示不变形

- [ ] Computed style 断言:
  - `.stage-processing` 的 `background-color` 等于 design-tokens 定义的 `rgba(20,110,245,0.08)`
  - `.stage-processing` 的 animation-name 等于 `breathing`
  - `.toast` 的 `z-index` 等于 `300`

- [ ] 硬证据 5/5 PASS 才叫"修好了", 任何一个不对 = 诊断有漏洞, 停下告诉用户

### 6.4 其他

- [ ] `git log` 本任务 commit 数 ≤ 3 (后端 + 前端 + migration)
- [ ] `batch_processor.py` 改动行数 < 30 (只在 4 个 print 点后加 publish)
- [ ] `upload.html` 改动 < 200 行 (新增 pill / toast / 重连, 不动老代码)

---

## 7. 执行步骤 (用户批准后)

1. **Alembic migration**: 加 `BatchItem.current_stage` 列 (nullable default NULL)
2. **batch_processor.py**: 4 个 stage 点后加 `batch_pubsub_mod.publish(scope_id, {type:'stage', ...})` + 同步 UPDATE `item.current_stage`
3. **app.py**: WS 路由不动; `/api/batch/<id>/status` 响应追加 `current_stage`; `_batch_db_sync_callback` 在 done/failed 时 null 掉 current_stage
4. **static/css/design-system.css**: 新增 `--duration-pulse`, `--z-toast: 300`, `@keyframes breathing/pulse-dot/fade-in/toastIn`, `.stage-pill` + 6 个 variant, `.toast` 家族
5. **templates/batch/upload.html**:
   - 新增 `.stage-cell` (table 新列 or 进 .status-cell) 渲染 pill
   - 新增 toast 挂载点 + `showToast(kind, title, msg)` 函数
   - 重写 `openWS()` 带 exponential backoff 重连
   - 新增 `startPollingFallback()` 在 failed/reconnecting 态启动
   - `handleEvent()` 加 `case 'stage':` + `case 'batch_complete':` 里触发 toast
   - tab visibilitychange 主动重连
6. **本地 smoke**: 跑现有 URL 映射单元测试 + 手动点一个批次全流程
7. **Playwright 5 屏证据脚本**: 写 `scripts/verify_task2_realtime.py` 跑 mock 事件注入截图
8. **deploy**: rebuild (COPY .) + up -d + 自动验证
9. **交付**: commit hash / Playwright 5/5 PASS 截图路径 / 用户浏览器验收

---

**签收**: 此文档即任务2 技术契约。用户 review 后按 §7 执行, 实现中偏离任何一条设计要回文档解释/修。
