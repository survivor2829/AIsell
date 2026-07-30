### §B.1 app.py 5400+ 行 God Object — 路由/业务/数据转换/AI 调用四层混杂
- **位置**: `app.py` 全文件 (5417 行, 82 个 `def`, 42 个 `@app.route`)
- **严重度**: 严重
- **根因诊断**: 项目从 MVP 单文件演进至今, 从未做模块拆分。`_map_parsed_to_form_fields` (605-873, 269 行纯数据转换)、`_build_category_prompt` (2296-2625, 330 行纯 prompt 模板)、`_call_deepseek_parse` (2628-2723, HTTP 调用)、`_assemble_all_blocks` (4141-4427, 287 行模板装配) 都不依赖 Flask request, 却嵌在路由层。batch 相关 21 个路由 (1112-2210) 和 AI 生图相关 8 个路由 (2825-3630) 完全可独立为 Blueprint。
- **修复建议**: 按职责拆 4 个 Blueprint + 2 个纯函数模块:
  1. `batch_routes.py` Blueprint (app.py:1112-2210)
  2. `ai_routes.py` Blueprint (app.py:2752-3630)
  3. `build_routes.py` Blueprint (app.py:4557-5290)
  4. `parse_utils.py` 纯函数 (app.py:252-880 的数据转换)
  5. `deepseek_client.py` (app.py:2296-2723 的 prompt + HTTP)
- **估时**: 2d (机械移动 + 修 import + 全量跑测)
- **依赖**: `batch_processor.py:54,107,114,160,280` 和 `refine_processor.py:102` 有 `from app import ...` 循环引用, 拆出后反而能消除
- **是否阻塞 P5/P6**: yes — 耗材/工具/配耗管线会各加 `_build_category_prompt` 分支, 再塞 app.py 将到 7000+ 行不可维护

### §B.2 循环 import: batch_processor / refine_processor → app
- **位置**: `batch_processor.py:54,107,114,160,280`, `refine_processor.py:102`
- **严重度**: 中
- **根因诊断**: worker 线程需要 Flask app context + DB session + 工具函数 (`_ensure_rembg`, `_call_deepseek_parse`, `BASE_DIR`), 只能延迟 `from app import ...`。这造成 app 模块不可在 worker 外独立测试, 且 `import app` 的 stop-hook 验证 (`.claude/hooks/stop_import_check.py`) 等于全量初始化。
- **修复建议**: 将 `_call_deepseek_parse` 拆到 `deepseek_client.py`; 将 `_ensure_rembg` / `REMBG_SESSION` 拆到 `rembg_service.py`; worker 通过参数注入 `app_context_fn` 而非 import app。
- **估时**: 1d
- **依赖**: 改变 batch_processor / refine_processor 的调用约定, 需同步改 batch_queue 的 submit 签名
- **是否阻塞 P5/P6**: no, 但每新增品类处理器都会加深耦合

### §B.3 进程内 ThreadPoolExecutor + dict 状态 — 多 worker 部署数据丢失
- **位置**: `batch_queue.py:62-81` (`_lock`, `_batches`, `_single_tasks`, `_refine_batches` 三个进程级 dict)
- **严重度**: 中 (当前 docker-compose 强制 POOL_SIZE=1 串行, 暂安全; 阶段七扩 worker 后必爆)
- **根因诊断**: 代码注释已承认 "重启丢, 真源数据在 DB" (batch_queue.py:7), 但 `get_batch_status` / `pool_stats` API 返回的是内存快照而非 DB 查询。gunicorn 多 worker 或 K8s 多 Pod 场景, 进程 A 提交的任务进程 B 看不到, WS 推送也跨不了 worker (pubsub memory 模式)。
- **修复建议**: 阶段七升级时必须: (1) `PUBSUB_BACKEND=redis`; (2) batch_queue 的状态查询改查 DB (已有 Batch/BatchItem 表); (3) `pool_stats` 端点聚合所有 worker 的计数 (通过 Redis INCR/DECR)。
- **估时**: 1d (状态查询改 DB) + 0.5d (Redis 计数器)
- **依赖**: 需要 Redis 在 full profile 部署, docker-compose.yml 已就绪
- **是否阻塞 P5/P6**: no (P5/P6 仍单机), 但阻塞阶段七水平扩展

### §B.4 image_composer.py 硬编码 Windows 字体路径
- **位置**: `image_composer.py:13-15`
- **严重度**: 严重 (生产 Docker 容器是 Linux, 路径 `C:/Windows/Fonts/msyh.ttc` 不存在)
- **根因诊断**: v1 Pillow 合成器在本地 Windows 开发时写死, 后来被 v2 HTML/Playwright 管线 (`ai_compose_pipeline.py`) 替代, 但 `/api/generate-ai-images` 路由 (app.py:2825) 仍可调用 `image_composer.compose_all`。如果有用户触发该旧路由, Linux 容器上会抛 `IOError: cannot open resource`。
- **修复建议**: (1) 如果 v1 Pillow 路径已废弃, 添加 `@app.route` 上的 deprecation 告警或直接 return 501; (2) 否则加 `_find_font()` 跨平台解析 (检查 `/usr/share/fonts/` 兜底)。
- **估时**: 0.5h (方案 1) / 2h (方案 2)
- **依赖**: 确认 `/api/generate-ai-images` 是否仍有前端调用
- **是否阻塞 P5/P6**: no (新管线走 ai_compose_pipeline), 但若客户误触发会 500

### §B.5 AI prompt 模板硬编码 330 行 Python 字符串 — 品类扩展成本 O(n)
- **位置**: `app.py:2296-2625` (`_build_category_prompt` 函数)
- **严重度**: 中
- **根因诊断**: 每种品类 (设备/耗材/工具/配耗) 各有 ~80 行 prompt 字符串拼接。P5/P6 要加新品类时, 必须复制粘贴整段 + 微调, 无法差分复用公共规则 (`_NO_FABRICATION_RULE`, `_EXTREME_WORDS_RULE`, JSON schema 骨架)。
- **修复建议**: 抽成 `prompts/<category>.json` 或 Jinja2 模板, 公共片段用 `{% include %}` 复用。函数改为 `_render_parse_prompt(product_type, raw_text)` 从注册表加载。
- **估时**: 4h
- **依赖**: 需同步改 `_call_deepseek_parse` 入参; 测试 `test_parse_text` 需更新
- **是否阻塞 P5/P6**: yes — 每加一品类要动 app.py + 330 行未 DRY 的字符串

### §B.6 测试覆盖严重不足 — 核心业务模块 0 test
- **位置**: `tests/` 仅有 1 个文件 (`test_autonomy_doc_invariants.py`, 仅验证文档); `ai_refine_v2/tests/` 有 9 个文件 (仅覆盖 v2 精修子系统)
- **严重度**: 中
- **根因诊断**: `app.py` (5417 行)、`batch_processor.py`、`batch_queue.py`、`image_composer.py`、`ai_image_router.py`、`ai_bg_cache.py` 等核心模块无单元测试。历史测试全在 `scripts/archive/legacy/` (已归档), 当前 pytest 只跑 `tests/` + `ai_refine_v2/tests/`。号称 "245 测绿" 大部分来自 ai_refine_v2 子包。
- **修复建议**: 优先补 (1) `_map_parsed_to_form_fields` 的回归测试 (输入变体多, 改动频繁); (2) `batch_queue.submit_batch` 的并发/重入测试; (3) `_call_deepseek_parse` 的 mock 测试 (验证 JSON 解析兜底)。
- **估时**: 2d (优先级 top-3 模块覆盖)
- **依赖**: 需先完成 §B.1 拆分, 否则无法 import 单函数测试
- **是否阻塞 P5/P6**: no, 但每次改动无回归保护, 概率引入 silent regression

### §B.7 _map_parsed_to_form_fields 269 行过程式意面 — 品类路径难复用
- **位置**: `app.py:605-873`
- **严重度**: 中
- **根因诊断**: 一个函数承担 "AI JSON → 表单字段" 全部映射, 含 6 种兜底链、3 种品类特有分支 (b2_items / vs / kpis) 和 12 种 list→JSON 序列化。每新增品类要在同一函数内加 if/else, 圈复杂度已 > 30。
- **修复建议**: 提取 "字段映射注册表" 模式: 每品类一个 `CategoryMapper` 子类或 dict 配置, 公共映射逻辑走基类。
- **估时**: 1d
- **依赖**: 被 7+ 路由调用 (generate_ai_images, generate_ai_detail, build_submit, regenerate_block 等)
- **是否阻塞 P5/P6**: yes — 当前设备类逻辑无法直接被耗材类复用

### §B.8 DEEPSEEK_API_URL 硬编码 + 无超时配置化
- **位置**: `app.py:57` (`DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions"`)
- **严重度**: 低
- **根因诊断**: API endpoint 写死在代码里, 切换 provider (如 DeepSeek 更换域名、或用兼容 API 如 OpenRouter) 需改代码重部署。`_call_deepseek_parse` 超时也写死 `timeout=60` (app.py:2646 附近), 生产环境网络不稳定时不够灵活。
- **修复建议**: 改为 `os.environ.get("DEEPSEEK_API_URL", "https://api.deepseek.com/v1/chat/completions")`; 超时同理走 env。
- **估时**: 0.5h
- **依赖**: 无
- **是否阻塞 P5/P6**: no

### §B.9 Docker 内存限制 1400MB + Playwright Chromium 并发 = OOM 风险
- **位置**: `docker-compose.yml:75-76` (`mem_limit: 1400m`), `batch_processor.py:33-34` (每 worker 启动独立 Chromium ~600MB)
- **严重度**: 中 (当前 POOL_SIZE=1 串行安全, 阶段七调回 3 必爆)
- **根因诊断**: batch_processor 设计文档明确 "3 worker 并发 约 1.8GB Chromium 峰值" (batch_processor.py:33), 但容器只给 1400MB RAM + 2000MB swap。阶段七若调 BATCH_POOL_SIZE=3, 峰值 1.8GB + Flask/Python 基础 ~400MB = 2.2GB > 1.4GB RAM, 必触发 swap thrashing 或 OOM kill。
- **修复建议**: 阶段七升 4C8G 后 mem_limit 调到 4000m; 或采用 batch_processor 文档中提到的 "共享单 Chromium + per-thread context" 方案 (节省 ~1.2GB)。
- **估时**: 2h (调参) / 1d (共享 Chromium 重构)
- **依赖**: 需同步升服务器 + 改 docker-compose.yml
- **是否阻塞 P5/P6**: no (P5/P6 仍单机单 worker)

### §B.10 品类模板扩展路径 — assembled.html 已就绪但管线代码未解耦
- **位置**: `templates/耗材类/assembled.html`, `templates/配耗类/assembled.html`, `templates/工具类/assembled.html` (已存在); `app.py:121` (`ALLOWED_PRODUCT_TYPES = {"设备类", "耗材类", "配耗类", "工具类"}`)
- **严重度**: 低 (当前只是空壳, 不影响运行)
- **根因诊断**: 模板层已为多品类做好 4 套 `assembled.html`, 路由层也有 `_validate_product_type` 白名单。但真正的品类差异逻辑 (prompt 模板 §B.5 + 字段映射 §B.7 + block 装配 §B.1 中的 `_assemble_all_blocks`) 全部硬编码在 app.py 一个函数里, 没有注册表/策略模式。P5/P6 扩展时预估移植成本: prompt (~80行/品类) + 映射 (~60行/品类) + 装配 (~100行/品类) = 每品类 ~240 行纯手工。
- **修复建议**: 建立 `categories/` 包, 每品类一个模块 (`categories/consumable.py` 等), 实现统一接口 `build_prompt / map_fields / assemble_blocks`; `app.py` 路由通过 `product_type` 分发到对应模块。
- **估时**: 2d (含迁移设备类作为参考实现 + 测试)
- **依赖**: 依赖 §B.1 拆分完成后再做, 否则在巨型 app.py 里加抽象等于雪上加霜
- **是否阻塞 P5/P6**: yes — 这是多品类管线复用的核心架构缺口
