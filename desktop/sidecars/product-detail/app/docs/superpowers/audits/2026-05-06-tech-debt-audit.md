# 技术债中度审计报告 v1

> **日期**: 2026-05-06
> **触发**: master roadmap §7 (Q5=B 中度审计 audit-only)
> **范围**: 全仓库 .py / templates/ / static/ / scripts/ / migrations/ / docs/
> **输出方法**: 4 sub-agent 真并行扫描 (单条 message 4 tool call, 11 分钟完成)
> **承诺**: audit-only, 本报告产生 0 行业务代码改动

---

## 总览

| 维度 | 严重度高 | 严重度中 | 严重度低 | 小计 | NA |
|---|---|---|---|---|---|
| §A 安全债 (security-reviewer) | 1 | 4 | 3 | 8 | 4 |
| §B 架构债 (architect) | 2 | 6 | 2 | 10 | 0 |
| §C 代码风味债 (code-reviewer) | 4 | 4 | 3 | 11 | 0 |
| §D Dead code (explore) | 0 | 2 | 2 | 4 | 2 |
| **合计** | **7** | **16** | **10** | **33** | **6** |

(NA 项 = sub-agent 检查后判定无问题, 留作"已审已过"凭证)

---

## Top 10 严重度排名

按 ROI 排序 — 严重度 × (1/估时)。优先选"高严重度 + 短估时"的低悬果实, 再处理结构性大债。

| # | 债 | 类型 | 严重度 | 修复估时 | 阻塞 P5/P6 | spec stub | Scott 决策 |
|---|---|---|---|---|---|---|---|
| 1 | §C.5 `_get_user_api_key` 解密失败静默吞 except: pass | 风味 | 严重 | 10 min | no | `_stubs/C5-except-pass-decrypt-stub.md` | [ ] 修 [ ] 不修 [ ] 延后 |
| 2 | §A.1 SECRET_KEY 硬编码 "dev-change-me" 回退 — 生产 session 可伪造 | 安全 | 严重 | 0.5 h | no | `_stubs/A1-secret-key-fallback-stub.md` | [ ] 修 [ ] 不修 [ ] 延后 |
| 3 | §B.4 image_composer.py 硬编码 Windows 字体路径 — Linux 容器找不到 | 架构 | 严重 | 0.5-2 h | no | `_stubs/B4-windows-font-path-stub.md` | [ ] 修 [ ] 不修 [ ] 延后 |
| 4 | §C.10 `_clear_proxy` 多线程 race condition | 风味 | 严重 | 1 h | no | `_stubs/C10-clear-proxy-race-stub.md` | [ ] 修 [ ] 不修 [ ] 延后 |
| 5 | §A.6 v2 task_id IDOR — 越权访问其他用户精修任务 | 安全 | 中 | 1 h | no | `_stubs/A6-task-id-idor-stub.md` | [ ] 修 [ ] 不修 [ ] 延后 |
| 6 | §A.4 登录无 rate-limit — 5 客户上线前必修 | 安全 | 中 | 2 h | no | `_stubs/A4-login-no-ratelimit-stub.md` | [ ] 修 [ ] 不修 [ ] 延后 |
| 7 | §C.1 228 处 print() 无统一 logging | 风味 | 严重 | 1 d | no | `_stubs/C1-no-logging-stub.md` | [ ] 修 [ ] 不修 [ ] 延后 |
| 8 | §B.1 app.py 5417 行 god module — Blueprint 拆分 (= §C.3) | 架构 | 严重 | 2 d | **yes** | `_stubs/B1-app-py-god-module-stub.md` | [ ] 修 [ ] 不修 [ ] 延后 |
| 9 | §B.7 `_map_parsed_to_form_fields` 269 行意面 (= §C.8) | 架构 | 中 | 1 d | **yes** | `_stubs/B7-map-parsed-spaghetti-stub.md` | [ ] 修 [ ] 不修 [ ] 延后 |
| 10 | §B.5 prompt 模板 330 行硬编码 — P5/P6 多品类阻塞 | 架构 | 中 | 4 h | **yes** | `_stubs/B5-prompt-template-monolith-stub.md` | [ ] 修 [ ] 不修 [ ] 延后 |

**ROI 备注**: #1-#4 总成本 ~3 小时, 全是严重级 — 强烈建议作为 P4 第一阶段一次性扫掉。#7-#10 单项 1d+, 与 P5 耗品类管线扩展耦合, 建议合并到 P5 前的"地基化 sprint"。

---

## 分类细节

### §A. 安全债 (8 项 + 4 NA)

(原始片段见 `_raw/2026-05-06-security.md`)

#### §A.1 SECRET_KEY 硬编码回退值 — 生产 Session 可伪造
- **位置**: `app.py:68`
- **严重度**: 严重
- **根因诊断**: `_secret_key or "dev-change-me-in-production"` 在 SECRET_KEY 环境变量为空时静默回退到公开硬编码字符串。判断条件 `FLASK_ENV != "development"` 只打印警告但不阻断启动。生产 .env 一旦丢失 SECRET_KEY，攻击者可用此已知字符串伪造任意 Flask session cookie，账号接管路径打开。
- **修复建议**: `FLASK_ENV != "development"` 且 SECRET_KEY 为空时 `sys.exit(1)` 强制中止。
- **估时**: 0.5h

#### §A.2 `/api/ai-engines` 未加 `@login_required`
- **位置**: `app.py:2946-2951` · **严重度**: 低 · **估时**: 0.5h
- 唯一一个数据 GET 端点缺鉴权, 暴露引擎/cost 配置给未认证用户。

#### §A.3 CSRF 豁免端点 `/api/batch/*-mock` 暴露公网
- **位置**: `app.py:1410, 1888` · **严重度**: 中 · **估时**: 1h
- `@csrf.exempt` 仅靠 `FLASK_ENV == production` env 守门, 而 .env.example 没声明此变量 → 部署遗漏即开放跨站调用。

#### §A.4 登录无 rate-limit — 暴力破解
- **位置**: `auth.py:13-36` · **严重度**: 中 · **估时**: 2h
- 5 个 demo 客户即将试用, 公网无频率限制 + 6 字符弱密码 = 必修。

#### §A.5 Session Cookie 缺 Secure / SameSite 配置
- **位置**: `app.py` 全局 · **严重度**: 中 · **估时**: 0.5h
- 当前 HTTP 部署可被中间人嗅探, HTTPS 上线后也需要显式 SAMESITE=Lax / SECURE=True。

#### §A.6 v2 精修 task_id 无 owner 校验 — IDOR
- **位置**: `app.py:4543-4551, 5115-5121` · **严重度**: 中 · **估时**: 1h
- task_id 可预测 (时间戳+hex), 任何登录用户可枚举读其他用户精修结果。

#### §A.7 WebSocket legacy `user_id IS NULL` 批次绕过
- **位置**: `app.py:1134, 1352, 2234` · **严重度**: 低 · **估时**: 1h
- 阶段六遗留 OR 分支, backfill 后可统一删除。

#### §A.8 Fernet Key 无轮换机制
- **位置**: `crypto_utils.py:7-17` · **严重度**: 低 · **估时**: 1d
- 单点密钥, 引入 v2 versioning + migration。

#### §A.9-A.12 (NA — 已审无问题)
- §A.9 Zip 解压 zip-slip 防御已就位 (`batch_upload.py:69-89`)
- §A.10 SQL 注入: 全局走 SQLAlchemy ORM 参数化
- §A.11 XSS: Jinja autoescape, `|safe` 零命中
- §A.12 文件上传遍历: uuid 重命名 + 白名单 + safe_join

### §B. 架构债 (10 项)

(原始片段见 `_raw/2026-05-06-architect.md`)

#### §B.1 app.py 5417 行 God Object
- **位置**: `app.py` 全文件 (82 def, 42 route) · **严重度**: 严重 · **估时**: 2d · **阻塞 P5/P6**: yes
- **根因**: 从 MVP 单文件演进, 从未做 Blueprint 拆分。`_map_parsed_to_form_fields` (269 行) / `_build_category_prompt` (330 行) / `_assemble_all_blocks` (287 行) 都不依赖 request 但嵌在路由层。
- **修复**: 拆 4 Blueprint + 2 纯函数模块 (batch_routes / ai_routes / build_routes / parse_utils / deepseek_client)。

#### §B.2 worker → app 循环 import
- **位置**: `batch_processor.py:54,107,114,160,280` · **严重度**: 中 · **估时**: 1d
- 修复 = 抽 deepseek_client.py + rembg_service.py。

#### §B.3 进程内 dict 状态 — 多 worker 必爆
- **位置**: `batch_queue.py:62-81` · **严重度**: 中 · **估时**: 1.5d
- 当前 POOL_SIZE=1 暂安全, 阶段七扩 worker 必须先做。

#### §B.4 image_composer.py 硬编码 Windows 字体路径
- **位置**: `image_composer.py:13-15` · **严重度**: 严重 · **估时**: 0.5-2h
- Linux Docker 容器 `/usr/share/fonts/` 路径不存在, 旧路由触发即 IOError。

#### §B.5 prompt 模板 330 行硬编码 — P5/P6 阻塞
- **位置**: `app.py:2296-2625` (`_build_category_prompt`) · **严重度**: 中 · **估时**: 4h · **阻塞 P5/P6**: yes
- 修复 = 抽 `prompts/<category>.json` 注册表 + Jinja2 公共片段。

#### §B.6 测试覆盖严重不足
- **位置**: `tests/` 1 文件 (仅文档守护) · **严重度**: 中 · **估时**: 2d
- 245 测中绝大部分在 ai_refine_v2 子包, app.py / batch / image_composer 0 单测。

#### §B.7 `_map_parsed_to_form_fields` 269 行意面 — P5/P6 阻塞
- **位置**: `app.py:605-873` · **严重度**: 中 · **估时**: 1d · **阻塞 P5/P6**: yes
- 修复 = 字段映射注册表 + CategoryMapper 子类。

#### §B.8 DEEPSEEK_API_URL 硬编码
- **位置**: `app.py:57` · **严重度**: 低 · **估时**: 0.5h
- 改 env 注入即可。

#### §B.9 Docker 内存限制 1400MB + Chromium 并发风险
- **位置**: `docker-compose.yml:75-76` · **严重度**: 中 · **估时**: 2h-1d
- 阶段七升 4C8G 时必须同步调 mem_limit 或重构共享 Chromium。

#### §B.10 多品类管线代码未解耦 — P5/P6 阻塞
- **位置**: `templates/{设备类,耗材类,配耗类,工具类}/` · **严重度**: 低 · **估时**: 2d · **阻塞 P5/P6**: yes
- 模板已就绪但路由层 `_build_category_prompt`/`_map_parsed`/`_assemble_all_blocks` 未走策略模式。

### §C. 代码风味债 (11 项)

(原始片段见 `_raw/2026-05-06-code-review.md`)

#### §C.1 全局零 logging — 228 处 print() 无结构化日志
- **位置**: `app.py / ai_image*.py / batch_processor.py / ai_refine_v2/` · **严重度**: 严重 · **估时**: 1d
- **根因**: demo 阶段 print 调试沿用至生产, 从未引入 logging。Docker gunicorn 下无级别/无时间戳/无 request_id, 出问题不可分级静默。

#### §C.2 `_clear_proxy` 跨文件复制粘贴
- **位置**: `ai_image.py:29-39` / `ai_image_volcengine.py:32-42` · **严重度**: 中 · **估时**: 0.5h
- 抽 `net_utils.py:proxy_bypass()` context manager。

#### §C.3 app.py god module (= §B.1)
- 已并入 §B.1, 不重复列。

#### §C.4 字体硬编码常量 (= §B.4)
- 已并入 §B.4, 不重复列。

#### §C.5 `_get_user_api_key` 解密 except: pass
- **位置**: `app.py:1091-1093` · **严重度**: 严重 · **估时**: 10 min
- **根因**: 静默吞解密失败, key 轮转/迁移导致永久解密失败时用户只看到"未配置 Key", 运维零信号。
- **修复**: `except Exception as e: logger.warning("[api-key] 解密失败: %s", e, exc_info=True)`。

#### §C.6 `item.result` JSON 重复 parse
- **位置**: `app.py:1714, 1719` · **严重度**: 低 · **估时**: 10 min

#### §C.7 类型注解覆盖率 ~18%
- **位置**: 全局 (app.py 112 def, 仅 ~7 带注解) · **严重度**: 中 · **估时**: 1d
- 加 mypy CI 增量执行, 优先 service 层。

#### §C.8 `_map_parsed_to_form_fields` 270 行 (= §B.7)
- 已并入 §B.7。

#### §C.9 pricing_config 与实际链路矛盾
- **位置**: `pricing_config.py:19, 35` · **严重度**: 低 · **估时**: 0.5h
- v3.2 已是 12 屏 ¥0.7/屏 (~¥8.4), 但 config 仍写 6 屏 ¥0.20。计费可能少算。**值得立刻修, 哪怕只是更新数字**。

#### §C.10 `_clear_proxy` 多线程 race condition
- **位置**: `ai_image.py:29-39` · **严重度**: 严重 · **估时**: 1h
- **根因**: pop/put `os.environ` 全局字典在多线程下 race, 线程 A pop 后线程 B 看到空 saved。
- **修复**: ai_image_volcengine 已有 `_SESSION.trust_env = False` 双保险, `_clear_proxy` 对它冗余可删; ai_image (DashScope SDK) 改进程启动时一次性 unset。

#### §C.11 注释过度解释 "what"
- **位置**: 多文件 · **严重度**: 低 · **估时**: 0.5h

### §D. Dead code 债 (4 项 + 2 NA)

(原始片段见 `_raw/2026-05-06-explore.md`)

#### §D.1 未引用 prompt helper 对
- **位置**: `ai_image.py:178-198` / `ai_image_volcengine.py:225-245` (`prompt_comparison_bg` / `prompt_brand_bg`) · **严重度**: 低
- 建议归档到 `scripts/archive/unused_prompts.py`。

#### §D.2 重复实现 `_to_data_url`
- **位置**: `ai_bg_cache.py:38-70` vs `ai_refine_v2/refine_generator.py:239-285` · **严重度**: 中
- ai_refine_v2 版有 resize 防 413 (memory v3.2.2 33MB→480KB), ai_bg_cache 版无。统一到单工具模块。

#### §D.3 6 个未引用阶段一脚本
- **位置**: `scripts/{demo_refine_v2, smoke_pipeline_schema, smoke_test_refine_v2, stage1_planner_eval, test_deepseek_planner, refine_v1_with_gpt_image}.py` · **严重度**: 中
- 归档到 `scripts/archive/refine-v2-stage1/` (per `user_cleanup_taste.md` 偏好 archive > delete)。

#### §D.4 ai_compose 模板动态加载 (NA)
- registry 模式合理设计, 非 dead code。

#### §D.5 `.probe/` 探针目录
- **位置**: 4 个文件 · **严重度**: 低
- 归档到 `docs/archive/probe-experiment-v1/`。

#### §D.6 `_kill_old_flask` (NA)
- 启动兜底, 在用。

---

## 根因模式分析

把 33 个表象 N 映射到 5 个根因 K 的 N→K 压缩, 这是本 audit 最高价值产出 — Scott 决策时按"修根因 / 不修根因" 断,而非逐条勾。

### 根因 1：`app.py` 单文件累积 (1 根因 → 6 表象)
- §B.1 + §C.3 (god module 5417 行)
- §B.5 (prompt 330 行卡 P5/P6)
- §B.7 + §C.8 (`_map_parsed` 269 行卡 P5/P6)
- §C.5 (except: pass 在路由层难追溯)
- §C.6 (重复 JSON parse)
- §B.10 (多品类未解耦, 全靠 app.py 分支)

**修一处**: 拆 Blueprint + 抽纯函数模块 → 解决 6 处。建议作为 P4 第一个完整 sprint。

### 根因 2：缺统一 logging 体系 (1 根因 → 3 表象)
- §C.1 (228 print)
- §C.5 (except: pass 静默 — 无 logger 可记)
- 间接: §A.5 (cookie 配置无 audit log)

**修一处**: `log_config.py` + 全局 `logger = getLogger(__name__)` → 解决 3 处 + 未来所有 except 都有处去。

### 根因 3：缺统一 config / env 体系 (1 根因 → 5 表象)
- §B.4 + §C.4 (字体路径硬编码)
- §B.8 (DEEPSEEK_API_URL 硬编码)
- §C.9 (pricing 与链路矛盾, 因为没人查改)
- §A.3 (FLASK_ENV 没在 .env.example, 部署易遗漏)
- §A.1 (SECRET_KEY 兜底值实质是"代码默认 config")

**修一处**: 引入 `config.py` 集中所有 env 读取 + 启动时 fail-fast 校验 → 解决 5 处 + 防未来再硬编码。配合 master roadmap §3.1 反硬编码原则。

### 根因 4：多线程 / 多 worker 状态管理简陋 (1 根因 → 2 表象)
- §B.3 (进程内 dict)
- §C.10 (`_clear_proxy` race)

**修一处**: 引入 Redis 共享状态 (阶段七必做) + 改 `_clear_proxy` 为进程级一次性 unset → 解决 2 处 + 解锁阶段七水平扩展。

### 根因 5：测试基础设施薄弱 (1 根因 → 2 表象)
- §B.6 (核心模块 0 单测)
- §C.7 (无类型注解 + 无 mypy CI)

**修一处**: 引入 pytest fixture + mypy CI → 解决 2 处 + 防未来 silent regression。配合 master roadmap §3.6 fixture 必清理。

### 总结：5 个根因 K → 18 个表象 N
- 剩 15 个独立表象 (§A 6 项 + §B 1 项 + §C 1 项 + §D 4 项 等) 是真零散问题, 单条修。
- 5 个根因合计预算: ~6 个工作日 (Blueprint 拆分 2d + logging 1d + config 1d + Redis/proxy 1d + mypy 1d)。
- 完成 5 个根因后 Top 10 中的 #1/#7/#8/#9/#10 自动消解, 仅剩 #2-#6 五项独立修。

---

## Scott 决策栏

每条 Top 10 旁勾选, 约 5 分钟决策完毕。

**转化路径**:
- 修 → 该 stub 转正式 spec, 进入 P4 队列
- 不修 → stub 标 deferred, 备注理由
- 延后 → stub 标 backlog, 季度复盘

**建议批量决策模式**:
- 「全勾根因 1-5」= 6 个工作日预算解决 18/33 表象, ROI 最高
- 「只勾 #1-#4」= 3 小时低悬果实 (4 个严重级低成本债)
- 「全延后」= 进入下一阶段 P3 / P5, 这份报告作为 backlog 备查

---

## 风险与限制

1. **判断准确度**: 4 sub-agent 独立扫, 但严重度评级有主观成分。Scott review 时关注是否同意"严重 / 中 / 低" 划分。
2. **ROI 估时**: 估时是 best-effort, 实际可能 ±50%。Scott 决定后实施时按 writing-plans skill 「plan + iter」 原则修订。
3. **NA 项**: §A.9-12 + §D.4 + §D.6 已审无问题, 但若部署环境变化 (e.g. 上 nginx, 改用 PostgreSQL) 需重审。
4. **Dynamic loading 排除**: §D.4 ai_compose registry 是动态加载好例子, 静态 dead-code 扫描会误报。审 §D 时已人工二审。

---

**起草人**: Claude Opus 4.7 (4 sub-agent: security-reviewer / architect / code-reviewer / explore)
**对应 Plan**: docs/superpowers/plans/2026-05-06-P2-tech-debt-audit-implementation.md
**对应 Spec**: docs/superpowers/specs/2026-05-06-master-roadmap-design.md §7
**总耗时**: ~11 分钟 (4 sub-agent 真并行) + 主线聚合
