# 生产环境变量清单

> 用这份清单生成真正的 `.env` 文件（`.env` 本身不进 git，也被 Claude Code hook 阻止直接编辑，必须手工复制）。
>
> 推荐流程：
> ```bash
> python scripts/generate_secrets.py > /tmp/secrets.txt
> # 人工编辑 /tmp/secrets.txt, 加非密钥字段后移到项目根 .env
> ```

## 必填（生产不设会直接起不来或不安全）

| 变量 | 用途 | 示例 | 备注 |
|------|------|------|------|
| `SECRET_KEY` | Flask session / CSRF 签名 | `32 字节 hex` | 换了所有用户下线 |
| `FERNET_KEY` | 用户 API Key 对称加密 | `base64url 44 字符` | ⚠ **换了所有已存密文 Key 永久不可解**，轮换前必须 re-encrypt 所有用户数据 |
| `DATABASE_URL` | SQLAlchemy 连接串 | `postgresql+psycopg2://xiaoxi:<pwd>@db:5432/xiaoxi` | 本地开发可用 `sqlite:///instance/wubaoyun.db` |
| `POSTGRES_PASSWORD` | Postgres 超级用户密码 | `generate_secrets.py` 给一个 | 仅 docker-compose 的 db 服务读 |
| `PUBSUB_BACKEND` | `memory` 或 `redis` | `redis` | 多 worker 生产必须 `redis`；单 worker 开发用 `memory` |
| `REDIS_URL` | 当 `PUBSUB_BACKEND=redis` 时必填 | `redis://:<pwd>@redis:6379/0` | 不走公网可以省略密码 |

## 可选（有默认值，按需覆盖）

| 变量 | 默认 | 说明 |
|------|------|------|
| `WEB_WORKERS` | `2` | gunicorn worker 进程数；云机 2C4G 建议 2，4C8G 建议 4 |
| `WEB_THREADS` | `25` | 每 worker 的线程数（gthread class）。WS 长连接 + 业务混用，公式：并发 WS 峰值 + 业务 RPS × 平均耗时 |
| `WEB_TIMEOUT` | `180` | 单请求超时秒数；Playwright 截图 + 大 zip 可能用到 60s+，180 安全 |
| `WEB_PORT` | `5000` | 容器内监听端口，腾讯云反代用 |
| `BATCH_POOL_SIZE` | `3` | HTML 批量池并发 worker；每个 Chromium ≈ 600MB，2C4G 别超 3 |
| `REFINE_POOL_SIZE` | `3` | AI 精修池并发；每个调用豆包 5–15s，超并发会被限速 |
| `SINGLE_POOL_SIZE` | `3` | 单产品池（老接口，基本不用） |
| `MAX_REFINE_COST_PER_RUN` | `50.0` | 单次精修请求费用硬上限（人民币），超过直接 400 拒 |
| `REQUIRE_USER_KEY` | `false` | `true` 时前端没传豆包 Key 直接 403；SaaS 模式必开 |
| `AI_BG_MODE` | `cache` | `cache` 走磁盘缓存 / `realtime` 每次重调 API |
| `PUBSUB_CHANNEL_PREFIX` | `xiaoxi:batch:` | Redis 频道前缀，多 app 共享 Redis 时改 |
| `DB_POOL_SIZE` | `5` | SQLAlchemy 连接池大小（workers × threads 之和的 1/N，不要太大） |
| `DB_MAX_OVERFLOW` | `10` | 超过 pool_size 时允许临时加的连接数 |
| `DB_POOL_RECYCLE` | `1800` | 连接最大寿命秒数，比云 LB 的 idle timeout 小一点 |
| `DB_POOL_PRE_PING` | `true` | 每次拿连接先 ping 一下，避免死连接进 checkout |

## 开发用（生产应该空或不设）

| 变量 | 说明 |
|------|------|
| `HTTP_PROXY` | 本地 Clash `http://127.0.0.1:7890`。**生产必须空**（DeepSeek / 豆包都是国内 API，已代码级禁代理，但其他 requests 会误用） |
| `FLASK_ENV` | `development` 时 `SECRET_KEY` 可留空 |
| `DEEPSEEK_API_KEY` | 已废弃：DeepSeek Key 走用户账号（`custom_api_key_enc` 加密存 DB） |
| `ARK_API_KEY` | 豆包 Seedream 兜底 Key；`REQUIRE_USER_KEY=true` 时忽略 |

## 生成生产 `.env` 的完整示例

```bash
# 1. 在项目根目录跑
python scripts/generate_secrets.py > /tmp/seeds.txt

# 2. 编辑得到最终 .env（手工操作，下面是内容示例）
cat > .env <<'EOF'
# —— 密钥（来自 generate_secrets.py）——
SECRET_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FERNET_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=
POSTGRES_PASSWORD=xxxxxxxxxxxxxxxxxxxxxxxxxx
REDIS_PASSWORD=xxxxxxxxxxxxxxxxxxxxxxxxxx

# —— 服务连接串 ——
DATABASE_URL=postgresql+psycopg2://xiaoxi:${POSTGRES_PASSWORD}@db:5432/xiaoxi
REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379/0
PUBSUB_BACKEND=redis

# —— 运行时调参 ——
WEB_WORKERS=2
WEB_THREADS=25
BATCH_POOL_SIZE=3
REFINE_POOL_SIZE=3
MAX_REFINE_COST_PER_RUN=50.0
REQUIRE_USER_KEY=true
AI_BG_MODE=cache
EOF
```

## 重要约束

- **`.env` 绝不进 git**（.gitignore 已覆盖）
- **`FERNET_KEY` 一旦启用就绝不能丢**，否则所有用户存的 DeepSeek / Ark Key 全部不可恢复
- **`SECRET_KEY` 轮换** 只会把所有用户踢下线一次，无数据损失，可以轮换
- **Postgres 密码轮换** 需要同步改 `.env` + 重启容器 + `ALTER USER`
