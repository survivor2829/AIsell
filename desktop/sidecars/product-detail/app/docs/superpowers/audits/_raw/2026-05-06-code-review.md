### §C.1 全局零 logging — 228 处 print() 无结构化日志
- **位置**: `app.py:86`, `ai_image.py:94`, `ai_image_volcengine.py:88`, `batch_processor.py` (11处), `ai_refine_v2/refine_planner.py` (20处)
- **严重度**: 严重
- **根因诊断**: 项目从 demo 快速演进到生产, 初期 print 调试直接沿用. 除 `migrations/env.py` 外无一处使用 `logging` 模块. 228 处 print 在 Docker gunicorn 环境下无级别 / 无时间戳 / 无 request_id, 出问题时无法 grep 也无法分级静默.
- **修复建议**: 根目录加 `log_config.py` 统一 `logging.config.dictConfig`, 全局 `logger = logging.getLogger(__name__)`. 用 sed/IDE 批量替换 `print(f"[xxx]` → `logger.info/error`. 估计 12 个文件 ~228 处.
- **估时**: 1d
- **影响范围**: 所有 .py 文件; 不改 public 接口

### §C.2 `_clear_proxy` / `_restore_proxy` 跨文件完整复制粘贴 (DRY)
- **位置**: `ai_image.py:29-39`, `ai_image_volcengine.py:32-42`
- **严重度**: 中
- **根因诊断**: 两个引擎模块独立开发, 各自实现了同样的 proxy 清除/恢复逻辑(12 行×2). `_PROXY_KEYS` 元组也完全相同. 如果将来加第三引擎会继续复制.
- **修复建议**: 提取为 `net_utils.py` 的 `proxy_bypass()` context manager (`with proxy_bypass(): ...`), 两文件改为 `from net_utils import proxy_bypass`. 一处改 = 全局生效.
- **估时**: 0.5h
- **影响范围**: 2 文件, 不改 public 接口

### §C.3 `app.py` 单文件 2000+ 行 God Module, 无业务分层
- **位置**: `app.py` (至少 112 个函数定义, 5000+ 行)
- **严重度**: 严重
- **根因诊断**: Flask 单文件起步, 多 agent 接力添加路由, 从未做 Blueprint 拆分. `_map_parsed_to_form_fields` 一个函数就 270 行, 混合数据映射 + 表单逻辑 + JSON 序列化.
- **修复建议**: 按职责拆 Blueprint: `routes/batch.py`, `routes/workspace.py`, `services/text_parser.py`, `services/form_mapper.py`. 第一步先把 `_map_parsed_to_form_fields` 和 `_parse_text_by_template` 抽到 `services/text_parser.py` (零路由依赖, 纯函数, 最安全).
- **估时**: 2d (分批, 每步跑测)
- **影响范围**: 仅 internal 重组, 不改 URL/接口

### §C.4 `image_composer.py` 硬编码 Windows 字体路径, 生产 Linux 靠运气
- **位置**: `image_composer.py:13-15` (`FONT_DIR = "C:/Windows/Fonts"`)
- **严重度**: 中
- **根因诊断**: 初版在 Windows 开发, 后来在 line 826-844 补了跨平台 `_FONT_CANDIDATES` fallback 列表, 但模块顶部 13-15 行的 `FONT_REGULAR / FONT_BOLD / FONT_EMOJI` 常量仍硬指 C:/Windows, 被早期函数 `_emoji_font` (line 39) 直接引用. Linux Docker 上 `_emoji_font` 会先尝试失败再 fallback, 多余 I/O + 吞异常.
- **修复建议**: 删除顶部 3 行硬编码常量, `_emoji_font` 也走 `_resolve_font_path` 统一查找链. 或单独加一个 emoji candidates 列表.
- **估时**: 0.5h
- **影响范围**: `image_composer.py` 1 文件

### §C.5 `app.py:1091` — `_get_user_api_key` 解密失败静默吞异常
- **位置**: `app.py:1091-1093`
- **严重度**: 严重
- **根因诊断**: `except Exception: pass` 把密钥解密失败彻底吞掉, 既不打日志也不告知用户. 如果 Fernet key 轮转或数据库迁移导致解密永久失败, 用户只会看到"未配置 Key"的误导信息, 运维无任何信号.
- **修复建议**: 改为 `except Exception as e: logger.warning("[api-key] 解密失败: %s", e, exc_info=True)` — 保留 pass 语义 (回退到 None) 但必须记录.
- **估时**: 10min
- **影响范围**: 1 处, 不改接口

### §C.6 `app.py:1714-1725` — 同一 `item.result` JSON 连续解析两次
- **位置**: `app.py:1714` 和 `app.py:1719` (batch_ai_refine_start 路由内)
- **严重度**: 低
- **根因诊断**: 复制粘贴取 `parsed_path` 和 `cutout_path` 时写了两个独立 try/except 块, 各自 `json.loads(it.result or "{}")`. 逻辑正确但冗余 + 可读性差.
- **修复建议**: 提到循环体顶部统一解析一次: `result = json.loads(it.result or "{}") if it.result else {}`, 后续直接 `.get()`.
- **估时**: 10min
- **影响范围**: 1 处

### §C.7 类型注解覆盖率极低 (~18%)
- **位置**: 全局; 代表: `app.py` 112 个函数中仅 ~7 个有返回值注解; `batch_processor.py` 6 个函数 5 个带注解; `ai_bg_cache.py` 10 个函数 6 个带注解
- **严重度**: 中
- **根因诊断**: 多 agent 接力, 无 CI 类型检查 (无 mypy/pyright 配置), 后期模块 (`ai_refine_v2`) 自觉写了注解, 早期 `app.py` / `image_composer.py` 几乎没有.
- **修复建议**: 加 `pyproject.toml` 配 mypy `--warn-no-return`, 先给 public API 函数和 service 层加注解 (优先: `_map_parsed_to_form_fields`, `refine_one_product`, `process_one_product`). CI 跑 `mypy --ignore-missing-imports`.
- **估时**: 1d (增量, 不需一次全覆盖)
- **影响范围**: 不改运行时行为

### §C.8 `_map_parsed_to_form_fields` 超长函数 (270 行) + 嵌套 4 层
- **位置**: `app.py:605-873`
- **严重度**: 中
- **根因诊断**: 每次新增品类字段 (block_b2 / block_f / block_g / block_l...) 都往这个函数里追加, 无人拆分. 圈复杂度预估 > 25. 新人接手需通读 270 行才能改一个字段映射.
- **修复建议**: 拆为 `_map_hero_fields(parsed)`, `_map_advantages_fields(parsed)`, `_map_vs_fields(parsed)`, `_map_brand_fields(parsed)` 等 6-8 个子函数, 主函数只做 `result.update(each_sub(...))` 串联.
- **估时**: 2h
- **影响范围**: `app.py` 内部重构, 被 4 处调用方透明

### §C.9 `pricing_config.py` 单价 / 屏数硬编码为 Python 常量
- **位置**: `pricing_config.py:19` (`SEEDREAM_UNIT_PRICE_YUAN = 0.20`), line 35 (`ZONES_PER_PRODUCT = 6`)
- **严重度**: 低
- **根因诊断**: 当前设计是"运维改文件重启", 但 v3.2 已切换到 12 屏 gpt-image-2 路径 (见 `refine_processor.py:18` 注释 "~¥8.4/产品 12 屏"), 而 pricing_config 仍写 6 屏 × ¥0.20 = ¥1.2/产品. **计费公式与真实链路不一致**.
- **修复建议**: 将 `ZONES_PER_PRODUCT` 和单价更新为 v3.2 的 12 屏 + ¥0.70/屏 (或按 APIMart 实际计费), 或改为从配置文件/env 读取, 避免代码与文档矛盾.
- **估时**: 0.5h
- **影响范围**: 前端费用弹窗显示; 后端 `MAX_REFINE_COST_PER_RUN` 保护阈值

### §C.10 `_clear_proxy` 在多线程环境下不安全
- **位置**: `ai_image.py:29-39`, `ai_image_volcengine.py:32-42`
- **严重度**: 严重
- **根因诊断**: `_clear_proxy()` 直接 pop `os.environ` 全局字典, `_restore_proxy()` 再塞回去. 在 `batch_queue` 3-worker 并发场景下, 线程 A pop 了代理 → 线程 B 进入同一函数发现已经没代理 → B 的 `saved` 为空 → A restore 时 B 的请求可能已经带上了代理. 实际影响取决于 GIL 调度时序, 但理论上是 race condition.
- **修复建议**: (a) `ai_image_volcengine.py` 已用 `_SESSION.trust_env = False` + `proxies={}` 双保险, 那么 `_clear_proxy/_restore_proxy` 对它而言是冗余的, 可删; (b) `ai_image.py` (DashScope SDK) 无法控制 session, 需改为进程启动时一次性 unset 代理 (worker 级), 而非每次请求清/还.
- **估时**: 1h
- **影响范围**: 2 文件; 并发烧图场景

### §C.11 docstring 覆盖较好但注释过度解释 "what"
- **位置**: `app.py:35-39` (5 行注释解释 UPLOAD_DIR 迁移), `batch_queue.py:1-25` (26 行模块 docstring 含设计理由)
- **严重度**: 低
- **根因诊断**: 多 agent 协作产物 — 每轮 agent 都留大段"为什么这样做"注释给下一个 agent, 导致注释密度高. 正面: 关键决策都有 trace. 负面: 噪音大, 部分注释已过时 (如 `pricing_config` 仍说 6 屏).
- **修复建议**: 保留 "why" 注释, 删除描述变量名/类型等显而易见 "what" 的注释. 过时数字统一更新. 非阻塞.
- **估时**: 0.5h
- **影响范围**: 可读性
