# 小玺AI · 生产部署指南

> **适用范围**：腾讯云 / 阿里云等主流 Linux 云主机首次部署 + 日常滚动升级 + 回滚
> **不适用**：本地开发 — 本地走 `docker-compose.dev.yml` 或直接 `python app.py`
> **最后更新**：2026-04-21 (阶段六生产化收尾)

---

## 目录

1. [前置检查](#前置检查)
2. [首次部署（全新服务器）](#首次部署全新服务器)
3. [从本地 SQLite 迁移到线上 Postgres](#从本地-sqlite-迁移到线上-postgres)
4. [滚动升级](#滚动升级)
5. [回滚](#回滚)
6. [生产验收清单](#生产验收清单)
7. [故障排查速查](#故障排查速查)

---

## 前置检查

```bash
# 1. Docker + docker-compose v2 可用
docker --version         # 要 ≥ 20.10
docker compose version   # 要 ≥ 2.0 (注意无短横线)

# 2. 服务器资源建议
# - CPU: ≥ 2 core (Playwright + rembg 吃 CPU)
# - RAM: ≥ 4 GB (rembg ONNX 模型 + gunicorn threads)
# - 磁盘: ≥ 20 GB (批次图片 + Playwright Chromium)

# 3. 域名 + HTTPS
# 本指南假设反代 (nginx / 宝塔 / CDN) 已配好, web 容器暴露在 localhost:5000
# 不在本地处理 HTTPS, 由反代终结
```

---

## 首次部署（全新服务器）

### Step 1. 拉代码

```bash
cd /opt
git clone https://github.com/<your-org>/clean-industry-ai-assistant.git xiaoxi
cd xiaoxi
git checkout main
```

### Step 2. 生成 secrets

```bash
# 在本地或服务器上生成 4 个密钥
python scripts/generate_secrets.py --fmt env > .env.new
cat .env.new   # 人工检查一眼, 别让它印到日志
mv .env.new .env
chmod 600 .env
```

生成的 `.env` 包含：
- `SECRET_KEY` — Flask session 签名
- `FERNET_KEY` — 用户 API Key 加密 (丢了用户所有 Key 都要重填)
- `POSTGRES_PASSWORD` — PG 主密码
- `REDIS_PASSWORD` — Redis 密码 (docker 内网通信用)

再补几行业务配置：

```bash
cat >> .env <<'EOF'
# ── 业务配置 ────────────────────────────────────
FLASK_ENV=production
PUBSUB_BACKEND=redis          # 多 worker 必须 redis, 单 worker 可 memory
AI_BG_MODE=cache              # realtime=每次烧 Seedream API
WEB_WORKERS=2                 # gunicorn worker 数, 参考 (2*CPU)+1
WEB_THREADS=4                 # 每 worker 线程数
WEB_TIMEOUT=300               # Playwright 单次渲染 ~30s, 给足
DB_POOL_SIZE=5
DB_MAX_OVERFLOW=10
DB_POOL_RECYCLE=1800
DB_POOL_PRE_PING=true
MAX_REFINE_COST_PER_RUN=200   # 单次精修保护上限, 烧钱兜底
EOF
```

> **FERNET_KEY 备份**: 立刻把 `.env` 复制一份到离线存储 (1Password / Bitwarden)。
> Fernet Key 丢失 = 数据库里所有用户的加密 API Key 都成废数据, 必须每个用户重登重填。

### Step 3. 启动基础设施

```bash
# 先只起 db + redis, 让它们先健康
docker compose up -d db redis

# 等 ~10s 让 healthcheck 转绿, 然后验证
docker compose ps
# 期望: db 和 redis 的 STATUS 都是 "Up (healthy)"
```

如果 healthcheck 卡在 "starting"，看 `docker compose logs db` / `logs redis`：
- db 常见：密码特殊字符没转义；数据卷权限问题 — `docker compose down -v` 重来
- redis 常见：`--requirepass` 和客户端密码不一致

### Step 4. 建表 (Alembic)

```bash
# 第一次建所有表 — 必须跑, 不能靠 create_all
docker compose run --rm web flask db upgrade

# 验证结构
docker compose exec db psql -U xiaoxi -d xiaoxi \
  -c "SELECT version_num FROM alembic_version;"
# 期望输出: a73747e2b475 (baseline)
```

> 为什么不用 `db.create_all()`：生产环境统一走 Alembic，后续 schema 变更才能走 `flask db migrate`
> → `flask db upgrade` 流程。`create_all` 只保留为 SQLite 开发兜底。

### Step 5. 建管理员账号

```bash
docker compose run --rm web python -c "
from app import create_admin
create_admin('admin', 'CHANGE_ME_STRONG_PASSWORD_HERE')
"
```

### Step 6. 启动 web 容器

```bash
docker compose up -d web

# 观察启动日志, 确认三件事:
docker compose logs -f web | head -50
#   1. [startup-recovery] 出现 (空库的话打 "无中断记录, 干净启动")
#   2. [pubsub] backend=redis (不是 memory, 别搞错)
#   3. gunicorn workers ready on 0.0.0.0:5000
```

### Step 7. 反代前置

nginx 最小示例（自己挑反代工具）：

```nginx
server {
    listen 443 ssl http2;
    server_name ai.example.com;
    # ... ssl cert ...

    # WebSocket 支持 (/api/batch/<id>/progress 要用)
    location /api/batch/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;  # WS 长连
    }
    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        client_max_body_size 200M;  # 批量上传允许大文件
    }
}
```

---

## 从本地 SQLite 迁移到线上 Postgres

如果你是**从开发阶段的 `instance/wubaoyun.db` 迁数据过去**：

```bash
# 1. 先完成上面 Step 1-4 (建好空 PG + 跑完 alembic upgrade)

# 2. 本地跑 dry-run, 只打报告不改数据
python scripts/archive/one_shot/migrate_sqlite_to_pg.py \
    --sqlite instance/wubaoyun.db \
    --pg "postgresql+psycopg2://xiaoxi:<POSTGRES_PASSWORD>@<server>:5432/xiaoxi"

# 3. 确认报告 OK → 加 --commit 真跑
python scripts/archive/one_shot/migrate_sqlite_to_pg.py \
    --sqlite instance/wubaoyun.db \
    --pg "postgresql+psycopg2://xiaoxi:<POSTGRES_PASSWORD>@<server>:5432/xiaoxi" \
    --commit
```

脚本是幂等的 (`INSERT ... ON CONFLICT DO NOTHING`)，中断可重跑。
`setval` 序列重置会自动处理，不需要手工改 serial。

> **磁盘文件另外搬**: `static/uploads/` 和 `static/outputs/` 不进数据库。
> 用 `rsync -avz static/uploads/ user@server:/opt/xiaoxi/static/uploads/` 单独同步。

---

## 滚动升级

```bash
# 1. 先在本地 / CI 跑通 4 个 smoke, 有一个红就别推
python scripts/archive/one_shot/smoke_stage_a.py
python scripts/archive/one_shot/smoke_task6_history.py
python scripts/archive/one_shot/smoke_task7_csrf.py
python scripts/archive/one_shot/smoke_task8_concurrency.py

# 2. 推到远端
git push origin main

# 3. 服务器上
cd /opt/xiaoxi
git fetch origin
git log HEAD..origin/main --oneline   # 看看本次带了啥
git pull origin main

# 4. 如果有新 migration, 先升 schema (不停服也可以, Postgres DDL 多数不阻塞)
docker compose run --rm web flask db upgrade

# 5. 重建 + 重启 web (db / redis 不动, 不会掉连接)
docker compose build web
docker compose up -d --no-deps web

# 6. 观察 15 秒
docker compose logs -f web --tail=100
```

### 关键：不要这样升级

- ❌ 直接在服务器 `vim app.py` 改代码 — 代码会被下次 `git pull` 覆盖
- ❌ `docker compose down` 停全栈后再起 — 会断开正在跑的 WS 连接和未完成的批次
- ❌ 跳过 smoke 直接推 — 这些测试专门为生产安全设计的

---

## 回滚

```bash
# 1. 回到上个版本的 commit
cd /opt/xiaoxi
git log --oneline -20  # 找上一个 good commit
git reset --hard <good_sha>

# 2. 如果中间跑过 alembic migration, 要降级
docker compose run --rm web flask db downgrade -1   # 回退 1 步

# 3. 重建 + 重启
docker compose build web
docker compose up -d --no-deps web
```

> **回滚需谨慎**: 如果 downgrade 涉及删列, 之前写入的数据会丢。
> 关键数据的 schema 变更应走 "expand-and-contract":
> 先加列 (可回滚) → 双写 → 切读 → 再下一次发布删旧列。

---

## 生产验收清单

部署完成后，在生产环境跑一遍这些，**不出错才能放量**：

### 基础连通性
- [ ] `curl https://<domain>/` → 200
- [ ] 浏览器访问登录页能渲染、能登录 admin
- [ ] `/batch/upload` 页面 CSRF meta 有值（F12 看 `<meta name="csrf-token">`）

### 安全闭环
- [ ] `curl -X POST https://<domain>/api/batch/upload` (无 cookie + 无 csrf) → 400 或 401
- [ ] 用 admin cookie 但无 X-CSRFToken 发 POST → 400 with 'csrf' in error
- [ ] `/api/batch/*_mock-task` → 403 "生产环境已禁用"

### 跨用户隔离
- [ ] 注册 userB, 用 userB cookie 访问 `/api/batches/<userA_batch_id>` → 403
- [ ] userB 的 `/api/batches` 响应不含 userA 的批次

### 原子 claim（Postgres 特有）
- [ ] 用 `curl` 同时发 10 个 `/api/batch/<bid>/start` 请求（`&` 并发）→ 有且仅有 1 个返回 200，其余 9 个 409

  ```bash
  for i in {1..10}; do
    curl -s -o /dev/null -w "%{http_code}\n" \
      -X POST -b cookies.txt \
      -H "X-CSRFToken: $(grep csrf cookies.txt | head -1)" \
      https://<domain>/api/batch/$BID/start &
  done | sort | uniq -c
  # 期望输出: "  1 200" 和 "  9 409"
  ```

### WebSocket 跨 worker（生产特有）
- [ ] 开 2 个浏览器标签，都订阅同一个批次的 WS
- [ ] 触发批次启动 → 两个标签都能实时看到进度

  （如果只有一个标签收到，说明 `PUBSUB_BACKEND=memory` 没改成 `redis`）

### 启动恢复
- [ ] 跑一个批次到 running 中途 → `docker compose restart web` → 刷新页面，该批次应标记 `failed`（不是 running 或 queued），error 字段含 "服务重启中断"

---

## 故障排查速查

### web 容器起不来

```bash
docker compose logs web --tail=200
```

- `RuntimeError: 未设置 FERNET_KEY` → `.env` 里有没有这行，有没有 `chmod 600`
- `psycopg2.OperationalError: could not connect` → db 容器没健康，看 `docker compose ps`
- `ImportError` → `pip` 安装失败，要不要 rebuild 带 `--no-cache`

### 前端提示 "CSRF failed"

- `F12 → Network` 看请求头，有没有 `X-CSRFToken`
- meta tag 里的 token 是否和 session 对齐（可能反代缓存了老 HTML）
- 代码侧：`templates/batch/upload.html` 和 `templates/workspace.html` 都应有 `<meta name="csrf-token">`

### 批量池卡住不处理

```bash
curl -b cookies.txt https://<domain>/api/batch/_pools/stats
```

- `pending > 0 且 running = 0` 持续很久 → worker 线程挂了，`docker compose restart web`
- `running > WEB_THREADS` → 池满了，加 `THREADS` env 或减小单批次大小

### Playwright 渲染失败

```bash
docker compose exec web playwright install-deps chromium
# 或进容器手动跑
docker compose exec web python -c "from playwright.sync_api import sync_playwright; \
  p = sync_playwright().start(); b = p.chromium.launch(); b.close()"
```

- 缺 `libnss3` / `libatk1.0-0` 等 → `install-deps` 能补上
- OOM → 把并发降下来 (`MAIN_POOL_SIZE`)

---

## 本次部署新增说明（2026-04-21 起）

以下是阶段六的新行为，老版本服务器升级后要留意：

1. **CSRF 已全面启用**: 14 个 POST/PATCH 路由去掉了 `@csrf.exempt`。任何外部 curl / 爬虫调用必须先拿 session + CSRF token，详见 [阶段六审计表](PROJECT_STATUS_批量生成.md)。
2. **启动恢复 "不自动续跑"**: `pending` / `running` / `processing` 批次在启动时一律标 `failed`，用户需手动重新点启动。这是给付费 API 留的防护栏。
3. **跨用户数据隔离加强**: `/api/batches` 不再返回全库批次，已按 `user_id + legacy` 过滤。
4. **Mock 端点生产禁用**: `/api/batch/<id>/start-mock` 和 `/api/single/_mock-task` 在 `FLASK_ENV=production` 下返回 403。
