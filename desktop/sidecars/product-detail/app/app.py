"""
小玺AI产品详情页生成器 - Web 后端（设备类专用）
启动: python app.py
访问: http://localhost:5000
"""
import os
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
import uuid
import secrets
import json
import re
import time
import zlib
import io
from functools import lru_cache
from pathlib import Path
from urllib.parse import unquote
from dotenv import load_dotenv

# Load local configuration before importing image providers.  The APIMart
# adapter snapshots the user's proxy route at import time so it remains
# available even when the DashScope provider later clears proxy variables for
# its own SDK.
load_dotenv(Path(__file__).parent / ".env")

import ai_bg_cache
import batch_upload as batch_upload_mod
import batch_queue as batch_queue_mod
import batch_processor as batch_processor_mod
import batch_pubsub as batch_pubsub_mod
from browser_runtime import launch_chromium

RESOURCE_DIR = Path(
    os.environ.get("XIAOXI_PRODUCT_DETAIL_RESOURCE_DIR", Path(__file__).parent)
).resolve()
_DESKTOP_MODE = os.environ.get("XIAOXI_PRODUCT_DETAIL_DESKTOP", "").strip() == "1"
if _DESKTOP_MODE:
    _desktop_data_value = os.environ.get("XIAOXI_PRODUCT_DETAIL_DATA_DIR", "").strip()
    if not _desktop_data_value:
        raise RuntimeError("desktop mode requires XIAOXI_PRODUCT_DETAIL_DATA_DIR")
    BASE_DIR = Path(_desktop_data_value).resolve()
else:
    BASE_DIR = RESOURCE_DIR

# ── P3 砍刀流: 启动校验 platform key 完整性 (per master roadmap §8) ──
# 用户登录后不再自配 API key, 所有调用走 env. 缺任一必填项立即 fail-fast,
# 避免运行时才发现 key 缺失导致用户看到 5xx.
# Note: 测试时由 conftest.py 注入 fake key; 生产环境必须在 .env 或系统环境变量中配齐.
_REQUIRED_PLATFORM_KEYS = [
    "DEEPSEEK_API_KEY",       # 文案 AI 解析
    "REFINE_API_KEY",         # gpt-image-2 精修
    "REFINE_API_BASE_URL",    # 精修 API endpoint (反硬编码: 不留 fallback default)
]
_in_test_or_dev_mode = (
    "pytest" in sys.modules
    or os.environ.get("FLASK_ENV") == "development"
    or _DESKTOP_MODE
)
_missing_platform_keys = [k for k in _REQUIRED_PLATFORM_KEYS if not os.environ.get(k, "").strip()]
if _missing_platform_keys and not _in_test_or_dev_mode:
    raise RuntimeError(
        f"\n[启动校验] 缺以下 platform key: {_missing_platform_keys}\n"
        f"  请在 .env 配齐后重启 (参考 .env.example).\n"
        f"  P3 砍刀流后用户不再自配 key, 必须 platform 全配."
    )

import threading
from flask import Flask, request, jsonify, send_file, send_from_directory, render_template, redirect, url_for, abort, flash
from flask_login import login_required, current_user
from flask_wtf.csrf import CSRFProtect

# 2026-04-22: 磁盘落点从 BASE_DIR/uploads 迁到 BASE_DIR/static/uploads, 与 Docker
# named volume (uploads -> /app/static/uploads) 对齐, 修复容器重启后文件蒸发的
# 持久化 bug (见 docs 铁律10). URL 仍用 /uploads/... 经 serve_batch_upload 代理,
# owner 鉴权保留; URL <-> 磁盘的映射集中在 batch_upload/batch_processor/refine_processor
# 三处 _to_url/_resolve_path 里统一做 'static/' 前缀增删.
UPLOAD_DIR = BASE_DIR / "static" / "uploads"
OUTPUT_DIR = BASE_DIR / "output"
TEMPLATES_DIR = RESOURCE_DIR / "templates"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
if _DESKTOP_MODE:
    ai_bg_cache.BASE_DIR = BASE_DIR
    ai_bg_cache.CACHE_DIR = BASE_DIR / "static" / "cache" / "ai_bg"
    ai_bg_cache.CACHE_DIR.mkdir(parents=True, exist_ok=True)

PRODUCT_TYPE = "设备类"
_EXTRA_BLOCK_KEYS = ["block_g", "block_h", "block_i", "block_j", "block_k",
                     "block_l", "block_m", "block_n", "block_o",
                     "block_p", "block_q", "block_r",
                     "block_s", "block_t", "block_u", "block_v",
                     "block_w", "block_x", "block_y"]

ALLOWED_IMG = {"jpg", "jpeg", "png", "webp"}

# ── DeepSeek API 配置 ─────────────────────────────────────────────────
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_API_URL = os.environ.get(
    "DEEPSEEK_API_URL", "https://api.deepseek.com/v1/chat/completions"
).strip() or "https://api.deepseek.com/v1/chat/completions"
DEEPSEEK_MODEL   = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash").strip() or "deepseek-v4-flash"
_proxy_url = os.environ.get("HTTP_PROXY", "").strip()
PROXY = {"http": _proxy_url, "https": _proxy_url} if _proxy_url else {}

_flask_kwargs = {
    "template_folder": str(TEMPLATES_DIR),
    "static_folder": str(BASE_DIR / "static"),
    "static_url_path": "/static",
}
if _DESKTOP_MODE:
    _instance_dir = BASE_DIR / "instance"
    _instance_dir.mkdir(parents=True, exist_ok=True)
    _flask_kwargs["instance_path"] = str(_instance_dir)
app = Flask(__name__, **_flask_kwargs)
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0


def _positive_int_env(name, default):
    """Read a positive integer limit without making a bad env value fatal."""
    try:
        value = int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


# 参数单图会把客户端当前编辑的 block_e 再次交给 Jinja 和 Chromium。集中限制
# 它的规模与字段范围，既避免单次导出耗尽渲染资源，也不让额外字段混入模板上下文。
app.config["PARAMETER_EXPORT_LIMITS"] = {
    "spec_count": _positive_int_env("PARAMETER_EXPORT_MAX_SPECS", 48),
    "spec_name_length": _positive_int_env("PARAMETER_EXPORT_MAX_SPEC_NAME_LENGTH", 80),
    "spec_value_length": _positive_int_env("PARAMETER_EXPORT_MAX_SPEC_VALUE_LENGTH", 240),
    "text_length": _positive_int_env("PARAMETER_EXPORT_MAX_TEXT_LENGTH", 200),
    "image_url_length": _positive_int_env("PARAMETER_EXPORT_MAX_IMAGE_URL_LENGTH", 2048),
}

# ── P4 §A.1 修复: SECRET_KEY 必填, 不再有公开默认值兜底 ──
# 原 bug: `_secret_key or "dev-change-me-in-production"` 在生产环境 SECRET_KEY
# 缺失时会静默用公开字符串, 攻击者可伪造 session cookie 接管账号.
# 修复 (per audit stub A1 方案 A): 非 development 直接 sys.exit(1) fail-fast.
_secret_key = os.environ.get("SECRET_KEY", "").strip()
_SECRET_KEY_PLACEHOLDERS = {
    "change-me-in-production",
    "dev-change-me-in-production",
}
if not _secret_key:
    if _DESKTOP_MODE:
        _secret_key = secrets.token_hex(32)
    elif os.environ.get("FLASK_ENV") == "development":
        _secret_key = "dev-change-me-in-production"
    else:
        sys.stderr.write(
            "[FATAL] SECRET_KEY 未设, 拒绝在非 development 环境启动.\n"
            "  生成: python -c \"import secrets; print(secrets.token_hex(32))\"\n"
            "  写入 .env: SECRET_KEY=<生成值>\n"
        )
        sys.exit(1)
elif os.environ.get("FLASK_ENV") != "development" and _secret_key in _SECRET_KEY_PLACEHOLDERS:
    sys.stderr.write(
        "[FATAL] SECRET_KEY 是占位符, 拒绝在非 development 环境启动.\n"
        "  生成: python -c \"import secrets; print(secrets.token_hex(32))\"\n"
        "  写入 .env: SECRET_KEY=<生成值>\n"
    )
    sys.exit(1)
app.config["SECRET_KEY"] = _secret_key
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get("DATABASE_URL", "sqlite:///wubaoyun.db")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

# ── SQLAlchemy 连接池参数 (Postgres 长连接生产必备) ─────────────────────────
# - pool_size/max_overflow: 并发上限. gthread worker × threads 是上限参考.
# - pool_recycle: 比云 LB 的 idle timeout 小一点 (腾讯云 TKE 默认 3600, 我们 1800 安全).
# - pool_pre_ping: 每次 checkout 先 ping, 躲开死连接重连期.
# - SQLite 不吃这些参数 (用 SingletonThreadPool), 传进去会 TypeError, 必须条件启用.
_db_url = app.config["SQLALCHEMY_DATABASE_URI"]
if not _db_url.startswith("sqlite"):
    app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
        "pool_size": int(os.environ.get("DB_POOL_SIZE", "5")),
        "max_overflow": int(os.environ.get("DB_MAX_OVERFLOW", "10")),
        "pool_recycle": int(os.environ.get("DB_POOL_RECYCLE", "1800")),
        "pool_pre_ping": os.environ.get("DB_POOL_PRE_PING", "true").lower() == "true",
    }

# ── 初始化扩展 ──
from extensions import db, login_manager, migrate, limiter
from models import User, GenerationLog, Batch, BatchItem
from workspace_results import load_latest_workspace_result, save_workspace_result
from sqlalchemy import func as _sa_func
import json as _json_mod

# CSRF token 寿命: flask-wtf 默认 3600s (1h) — 用户开 login 页放 1h+ 再
# POST 时 csrf 过期报 400. 改 86400s (24h) 给"开页面放着不管"行为留余量.
# 真实事故: 2026-05-07 用户 prod 浏览器登录报 400, 排查根因 = csrf 过期.
app.config.setdefault("WTF_CSRF_TIME_LIMIT", 86400)
csrf = CSRFProtect(app)

# 批次实时推送：flask-sock 与现有 ThreadPoolExecutor 共存,不替换 Werkzeug worker。
from flask_sock import Sock as _Sock  # noqa: E402
sock = _Sock(app)
db.init_app(app)
login_manager.init_app(app)
migrate.init_app(app, db)
limiter.init_app(app)  # P4 §A.4: 登录暴力破解限流, 装饰器在 auth.py

# ── SQLite 默认 PRAGMA foreign_keys=OFF, 必须每连接都打开,
#    否则 ON DELETE CASCADE 不生效 → 删 Batch 不会带走 BatchItem,
#    再加 SQLite 的 rowid reuse 行为, 会出现"幽灵子记录附给新父记录"的污染。
#    必须在 db.init_app() 之后, 但在任何 query 前注册。
from sqlalchemy import event as _sa_event
from sqlalchemy.engine import Engine as _SA_Engine
@_sa_event.listens_for(_SA_Engine, "connect")
def _enable_sqlite_fk(dbapi_conn, _conn_record):
    try:
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()
    except Exception:
        pass  # 非 SQLite (比如未来切 Postgres) 静默跳过

@login_manager.user_loader
def _load_user(user_id):
    return db.session.get(User, int(user_id))

# ── product_type 白名单校验（防止路径遍历）──
ALLOWED_PRODUCT_TYPES = {"设备类", "耗材类", "配件类", "工具类"}

def _validate_product_type(product_type):
    if product_type not in ALLOWED_PRODUCT_TYPES:
        abort(404, f"不支持的产品类型: {product_type}")

# ── 全局请求钩子：更新活跃时间 + 拦截未审核用户 ──
from datetime import datetime as _dt

@app.before_request
def _before_request():
    if current_user.is_authenticated:
        # 更新最后活跃时间（每次请求写一次太频繁，改为5分钟更新一次）
        now = _dt.utcnow()
        if not current_user.last_active or (now - current_user.last_active).total_seconds() > 300:
            current_user.last_active = now
            db.session.commit()
        # 未审核用户只能访问 auth 相关页面
        if not current_user.is_approved and request.endpoint and not request.endpoint.startswith("auth.") and request.endpoint != "static":
            from flask import render_template_string
            return render_template_string("""
<!DOCTYPE html><html><head><meta charset="UTF-8"><title>等待审核</title>
<style>body{font-family:"Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5;}
.card{background:#fff;padding:40px;border-radius:16px;text-align:center;max-width:400px;box-shadow:0 4px 20px rgba(0,0,0,0.1);}
h2{color:#333;margin-bottom:12px;} p{color:#666;font-size:14px;line-height:1.6;}
a{color:#E8231A;text-decoration:none;font-size:14px;display:inline-block;margin-top:16px;}</style></head>
<body><div class="card"><h2>&#x23F3; 账号审核中</h2><p>您的账号正在等待管理员审核<br>审核通过后即可正常使用所有功能</p>
<a href="{{ url_for('auth.logout') }}">退出登录</a></div></body></html>
            """), 200


@app.after_request
def _no_cache(response):
    """禁止浏览器缓存 HTML/JSON，静态资源允许缓存"""
    ct = response.content_type or ""
    if "text/html" in ct or "application/json" in ct:
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# ── rembg 可用性检测（懒加载，避免启动时占满内存） ──
REMBG_SESSION = None
REMBG_AVAILABLE = False
_rembg_loaded = False
_rembg_lock = threading.Lock()

def _ensure_rembg():
    """首次抠图时才加载模型，减少启动内存占用"""
    global REMBG_SESSION, REMBG_AVAILABLE, _rembg_loaded
    if _rembg_loaded:
        return REMBG_AVAILABLE
    with _rembg_lock:
        if _rembg_loaded:
            return REMBG_AVAILABLE
        _rembg_loaded = True
        try:
            from rembg import new_session
            REMBG_SESSION = new_session("isnet-general-use")
            REMBG_AVAILABLE = True
            print("[rembg] 模型加载成功，产品图将自动抠图")
        except Exception as e:
            REMBG_AVAILABLE = False
            print(f"[rembg] 模型加载失败（{e}），产品图将保留原背景")
    return REMBG_AVAILABLE

# 仅检测是否安装，不加载模型
if _DESKTOP_MODE:
    from offline_cutout import available as _offline_cutout_available
    REMBG_AVAILABLE = _offline_cutout_available()
else:
    try:
        import rembg as _rembg_check
        REMBG_AVAILABLE = True
        print("[启动] rembg 已安装，首次抠图时加载模型")
    except ImportError:
        print("[启动] rembg 未安装，产品图将保留原背景")


# ── 工具函数 ─────────────────────────────────────────────────────────

def allowed_img(fn): return "." in fn and fn.rsplit(".", 1)[1].lower() in ALLOWED_IMG


def _to_str(value):
    if value is None:
        return ""
    return str(value).strip()


def _validate_parameter_export_specs(raw_specs):
    """Normalize parameter rows and reject payloads that are unsafe to render."""
    if not isinstance(raw_specs, list):
        return None, "没有有效产品参数，请补充参数后重新生成"

    limits = app.config["PARAMETER_EXPORT_LIMITS"]
    if len(raw_specs) > limits["spec_count"]:
        return None, (
            f"产品参数最多支持 {limits['spec_count']} 条，"
            f"当前为 {len(raw_specs)} 条，请精简后重新导出"
        )

    normalized = []
    for index, spec in enumerate(raw_specs, start=1):
        if not isinstance(spec, dict):
            continue

        raw_name = spec.get("name")
        raw_value = spec.get("value")
        if isinstance(raw_name, (dict, list)) or isinstance(raw_value, (dict, list)):
            return None, f"第 {index} 条产品参数的名称和值必须是文本"

        name = _to_str(raw_name)
        value = _to_str(raw_value)
        if not name or not value:
            continue
        if len(name) > limits["spec_name_length"]:
            return None, (
                f"第 {index} 条产品参数名称超过 {limits['spec_name_length']} 个字符，"
                "请缩短后重新导出"
            )
        if len(value) > limits["spec_value_length"]:
            return None, (
                f"第 {index} 条产品参数值超过 {limits['spec_value_length']} 个字符，"
                "请缩短后重新导出"
            )
        normalized.append({"name": name, "value": value})

    if not normalized:
        return None, "没有有效产品参数，请补充参数后重新生成"
    return normalized, None


_PARAMETER_EXPORT_TEXT_FIELDS = (
    "title",
    "subtitle",
    "red_bar_text",
    "dim_height",
    "dim_width",
    "dim_length",
    "footnote",
)


def _sanitize_parameter_export_data(block_e):
    """Whitelist and bound the editable block_e fields used by the template."""
    specs, error = _validate_parameter_export_specs(block_e.get("specs"))
    if error:
        return None, error

    limits = app.config["PARAMETER_EXPORT_LIMITS"]
    parameter_data = {"specs": specs}
    for field in _PARAMETER_EXPORT_TEXT_FIELDS:
        raw_value = block_e.get(field)
        if isinstance(raw_value, (dict, list)):
            return None, f"产品参数图字段 {field} 必须是文本"
        value = _to_str(raw_value)
        if len(value) > limits["text_length"]:
            return None, (
                f"产品参数图字段 {field} 超过 {limits['text_length']} 个字符，"
                "请缩短后重新导出"
            )
        parameter_data[field] = value

    raw_image = block_e.get("product_image")
    if isinstance(raw_image, (dict, list)):
        return None, "产品图片来源无效，请重新上传产品图"
    image_url = _to_str(raw_image)
    if len(image_url) > limits["image_url_length"]:
        return None, "产品图片地址过长，请重新上传产品图"
    if image_url:
        image_path = unquote(image_url.split("?", 1)[0].split("#", 1)[0]).replace("\\", "/")
        if not image_path.startswith("/static/"):
            return None, "产品图片来源无效，请重新上传产品图"
        try:
            static_root = (BASE_DIR / "static").resolve()
            image_file = (static_root / image_path[len("/static/"):]).resolve()
            image_file.relative_to(static_root)
        except (OSError, ValueError):
            return None, "产品图片来源无效，请重新上传产品图"
    parameter_data["product_image"] = image_url
    return parameter_data, None


def _fallback_text(value, default=""):
    s = _to_str(value)
    return s if s else default


def _first_nonempty(*values):
    for value in values:
        s = _to_str(value)
        if s:
            return s
    return ""


def _safe_download_name(name: str, default: str = "product") -> str:
    """剥离文件系统非法字符 (\\ / : * ? " < > |) + 首尾空格/点,保留中文与字母数字"""
    cleaned = re.sub(r'[\\/:*?"<>|]', '', (name or '').strip()).strip('. ')
    return cleaned or default


# ── 极限词过滤（电商合规）────────────────────────────────────────────

_EXTREME_WORD_MAP = {
    "最强": "超强", "最大": "超大", "最小": "超小", "最好": "优质",
    "最高": "超高", "最低": "超低", "最快": "高速", "最优": "优质",
    "最先进": "先进", "最专业": "专业", "最安全": "安全",
    "最耐用": "耐用", "最便捷": "便捷", "最智能": "智能",
    "最环保": "环保", "最轻": "轻量", "最省": "节能",
    "第一": "领先", "唯一": "专属", "极致": "卓越",
    "顶级": "高级", "顶尖": "优质",
    "行业领先": "行业前列", "业界领先": "行业认可",
    "全球领先": "全球认可", "国内领先": "行业前列",
    "世界领先": "行业前列", "国际领先": "国际认可",
    "无与伦比": "卓越出色",
}


def _strip_extreme_words(text: str) -> str:
    """替换电商违禁极限词，避免平台合规风险"""
    if not isinstance(text, str):
        return text
    for word, repl in _EXTREME_WORD_MAP.items():
        text = text.replace(word, repl)
    return text


def _get_detail_value(detail_params: dict, keys: list) -> str:
    if not isinstance(detail_params, dict):
        return ""
    for key in keys:
        value = _to_str(detail_params.get(key, ""))
        if value:
            return value
    return ""


def _split_slogan(slogan: str) -> tuple:
    text = _to_str(slogan)
    if not text:
        return "", ""
    for sep in ("，", ",", "。", "；", ";", "、"):
        if sep in text:
            parts = [p.strip() for p in text.split(sep) if p.strip()]
            if len(parts) >= 2:
                return parts[0] + (sep if sep in ("，", ",") else ""), parts[1]
    if len(text) <= 12:
        return text, ""
    mid = max(4, len(text) // 2)
    return text[:mid], text[mid:]


def _parse_dimensions_from_text(size_text: str) -> tuple:
    text = _to_str(size_text).lower().replace(" ", "")
    text = text.replace("长", "").replace("宽", "").replace("高", "")
    text = text.replace("l", "").replace("w", "").replace("h", "")
    if not text:
        return "", "", ""
    m = re.search(
        r"(\d+(?:\.\d+)?(?:mm|cm|m)?)\s*[x×*]\s*(\d+(?:\.\d+)?(?:mm|cm|m)?)\s*[x×*]\s*(\d+(?:\.\d+)?(?:mm|cm|m)?)",
        text,
    )
    if not m:
        return "", "", ""
    return m.group(1), m.group(2), m.group(3)


def _extract_json_object(raw_text: str):
    text = _to_str(raw_text)
    if not text:
        return None
    m = re.search(r"```(?:json)?\s*([\s\S]+?)```", text, flags=re.IGNORECASE)
    if m:
        text = m.group(1).strip()
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    decoder = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch != "{":
            continue
        try:
            obj, _ = decoder.raw_decode(text[i:])
            if isinstance(obj, dict):
                return obj
        except Exception:
            continue
    return None


def _parse_advantages_text(value: str) -> list:
    text = _to_str(value)
    if not text:
        return []
    parts = re.split(r"[，,；;、/|\n]+", text)
    return [p.strip(" -·.。;；,，") for p in parts if p.strip(" -·.。;；,，")]


def _parse_explicit_list_text(value: str) -> list[str]:
    """Split an explicit user-provided list without inventing new items."""
    text = _to_str(value)
    if not text:
        return []
    parts = re.split(r"[\uFF0C,\uFF1B;\u3001|\n]+", text)
    return [p.strip(" -\u00b7.\u3002;\uFF1B,\uFF0C") for p in parts if p.strip(" -\u00b7.\u3002;\uFF1B,\uFF0C")]

def _parse_text_by_template(raw_text: str) -> dict:
    """按固定字段模板快速解析（不调用AI）"""
    lines = [ln.strip() for ln in _to_str(raw_text).replace("\r\n", "\n").split("\n")]
    lines = [ln for ln in lines if ln]
    if not lines:
        return {}

    field_alias = {
        "品牌": "brand", "brand": "brand",
        "英文品牌": "brand_en", "brand_en": "brand_en", "品牌英文": "brand_en",
        "产品名称": "product_name", "名称": "product_name", "product_name": "product_name",
        "型号": "model", "机型": "model", "model": "model",
        "主标语": "slogan", "标语": "slogan", "slogan": "slogan",
        "副标语": "sub_slogan", "sub_slogan": "sub_slogan",
        "产品类型": "product_type", "类型": "product_type", "product_type": "product_type",
    }

    detail_key_alias = {
        "工作效率": "工作效率", "清洁效率": "工作效率",
        "最大清洁效率": "工作效率", "最大清洁效率m²/h": "工作效率",
        "清洗宽度": "清洗宽度", "清扫宽度": "清扫宽度", "吸水宽度": "吸水宽度",
        "清水容量": "清水容量", "污水容量": "污水容量",
        "清/污水箱容量": "污水容量", "水箱容量": "水箱容量",
        "尘箱容量": "尘箱容量", "工作时间": "工作时间",
        "续航": "工作时间", "续航时间": "工作时间",
        "刷盘电机": "刷盘电机", "吸水电机": "吸水电机",
        "刷盘压力": "刷盘压力", "工作噪音": "工作噪音",
        "电瓶容量": "电瓶容量", "锂电容量": "锂电容量",
        "整机重量": "整机重量", "设备尺寸": "产品尺寸",
        "产品尺寸": "产品尺寸", "尺寸": "产品尺寸",
        "边刷电机": "边刷电机", "电池规格": "电池规格",
        "垃圾箱容量": "垃圾箱容量", "清水箱容量": "清水箱容量",
        "驱动功率": "驱动功率", "驱动电机": "驱动电机",
        "刷盘功率": "刷盘功率", "吸水功率": "吸水功率",
        "充电时间": "充电时间", "电池容量": "电池容量",
        "产品净重": "产品净重",
    }

    result = {
        "brand": "", "brand_en": "", "product_name": "", "model": "",
        "slogan": "", "sub_slogan": "", "product_type": "",
        "core_params": {}, "detail_params": {},
        "advantages": [],
        "dimensions": {"length": "", "width": "", "height": ""},
        "scenes": [],
    }

    kv_pattern = re.compile(r"^([^:：]{1,40})\s*[:：]\s*(.+)$")
    for ln in lines:
        m = kv_pattern.match(ln)
        if not m:
            continue
        raw_key = m.group(1).strip()
        raw_val = m.group(2).strip()
        if not raw_val:
            continue

        key_low = raw_key.lower()
        normalized_field = field_alias.get(raw_key) or field_alias.get(key_low)
        if normalized_field:
            result[normalized_field] = raw_val
            continue

        if any(token in raw_key for token in ("优势", "卖点", "亮点")):
            result["advantages"].extend(_parse_advantages_text(raw_val))
            continue

        d_key = detail_key_alias.get(raw_key) or detail_key_alias.get(raw_key.replace("：", "").strip())
        if raw_key in {"\u9002\u7528\u573a\u666f", "\u5e94\u7528\u573a\u666f", "\u4f7f\u7528\u573a\u666f"}:
            result["scenes"] = [
                {"name": item, "desc": ""}
                for item in _parse_explicit_list_text(raw_val)[:8]
            ]
            continue
        if d_key:
            result["detail_params"][d_key] = raw_val
            continue

        if len(raw_key) <= 20:
            result["detail_params"][raw_key] = raw_val

    size_text = _first_nonempty(
        result["detail_params"].get("产品尺寸", ""),
        result["detail_params"].get("设备尺寸", ""),
    )
    l, w, h = _parse_dimensions_from_text(size_text)
    if l and w and h:
        result["dimensions"] = {"length": l, "width": w, "height": h}

    detail = result["detail_params"]
    core_map = [
        ("工作效率", _first_nonempty(detail.get("工作效率", ""))),
        ("清洗宽度", _first_nonempty(detail.get("清洗宽度", ""), detail.get("清扫宽度", ""))),
        ("污水容量", _first_nonempty(detail.get("污水容量", ""), detail.get("水箱容量", ""), detail.get("尘箱容量", ""))),
        ("工作时间", _first_nonempty(detail.get("工作时间", ""), detail.get("续航时间", ""))),
    ]
    for k, v in core_map:
        if _to_str(v):
            result["core_params"][k] = _to_str(v)

    dedup = []
    seen = set()
    for item in result["advantages"]:
        val = _to_str(item)
        if not val or val in seen:
            continue
        dedup.append(val)
        seen.add(val)
    result["advantages"] = dedup[:6]

    useful_count = sum(1 for key in ("brand", "model", "product_name", "slogan", "sub_slogan", "product_type") if _to_str(result.get(key, "")))
    useful_count += len(result["detail_params"])
    if useful_count < 2:
        return {}
    return result


_STAT_NUM_RE = re.compile(
    r'(\d+(?:\.\d+)?)\s*'
    # 长单位必须在前,避免 L/min 被 L 先吃掉 ;
    # 汉字单位 (名/人/倍/小时等) 没有 word boundary 问题
    r'(㎡/h|m²/h|㎡|m²|L/min|kWh|km/h|m/s|mm|kg|dB|Hz|%|°|分钟|小时|W|V|A|L|min|h|名|人|倍|年|项|台|层|重|m)'
)

# 整串末尾单位拆分(用于 specs):'90L' → ('90','L'),'≤68dB' → ('≤68','dB')
# 与 _STAT_NUM_RE 不同 — 这里匹配整串结尾的单位,不限定前面是纯数字(允许 ≤/~ 等前缀)
_VALUE_UNIT_TAIL_RE = re.compile(
    r'^(.*?)\s*'
    r'(㎡/h|m²/h|L/min|kWh|km/h|m/s|mm|㎡|m²|kg|dB|Hz|%|°|分钟|小时|W|V|A|L|min|h|m)$'
)


_PLACEHOLDER_TOKENS = frozenset({'--', '-', '无', 'N/A'})


def _is_valid_spec_value(val: str, max_len: int = 16) -> bool:
    """hero_params / kpi 的 value 是否可用:非空、非占位符、长度合规。"""
    v = (val or "").strip()
    return bool(v) and v not in _PLACEHOLDER_TOKENS and len(v) <= max_len


def _split_value_unit(val: str) -> tuple[str, str]:
    """把 '90L' / '3600㎡/h' / '≤68dB' 拆成 (数值部分, 单位)。

    用于 specs 表格的 value/unit 双列展示:
      .spec-value 大号白粗体 + .spec-unit 小号灰色,baseline 对齐。
    匹配不到单位 → 返回 (原串, "") — 模板 {% if s.unit %} 自动隐藏空单位。
    """
    v = _to_str(val or "").strip()
    if not v:
        return "", ""
    m = _VALUE_UNIT_TAIL_RE.match(v)
    if m:
        return m.group(1).strip(), m.group(2)
    return v, ""


def _extract_stat_from_desc(*texts: str) -> tuple[str, str]:
    """从一段描述里抓第一个 '<数字><单位>' 组合,用于 advantages 卡的红色大数字。

    找不到返回 ('', '') → 卡片自动隐藏 .card-stat 块,只显示 title+desc。
    例: '90L/100L 双箱设计' → ('90', 'L'); '相当于8名保洁' → ('8', '人')
    """
    for t in texts:
        t = _to_str(t or "")
        if not t:
            continue
        m = _STAT_NUM_RE.search(t)
        if m:
            return m.group(1), m.group(2)
    return "", ""


def _supplement_from_specs(out: list,
                           e_specs: list,
                           key_priority: list,
                           *,
                           min_count: int,
                           limit: int,
                           used_norm: set,
                           make_row) -> None:
    """就地补齐 out 到 min_count(不越过 limit)。按 key_priority → e_specs 原序补,
    通过 used_norm 去重。make_row(name, value) 决定附加字段结构(label/value vs icon/unit)。
    Why: _ensure_hero_params_min2 和 _build_kpi_list Stage 2 本来是同构代码,统一到此处。
    """
    if len(out) >= min_count or len(out) >= limit:
        return

    specs_by_name: dict[str, str] = {}
    for s in (e_specs or []):
        if not isinstance(s, dict):
            continue
        name = (s.get("name") or "").strip()
        value = (s.get("value") or "").strip()
        if not name or not _is_valid_spec_value(value):
            continue
        specs_by_name.setdefault(name, value)

    consumed: set[str] = set()
    for k in (key_priority or []):
        if len(out) >= min_count or len(out) >= limit:
            break
        if k in specs_by_name and k.strip().lower() not in used_norm:
            out.append(make_row(k, specs_by_name[k]))
            used_norm.add(k.strip().lower())
            consumed.add(k)

    for name, value in specs_by_name.items():
        if len(out) >= min_count or len(out) >= limit:
            break
        if name in consumed or name.strip().lower() in used_norm:
            continue
        out.append(make_row(name, value))
        used_norm.add(name.strip().lower())


def _ensure_hero_params_min2(hero_params: list,
                             e_specs: list,
                             key_priority: list,
                             min_count: int = 2,
                             max_count: int = 4) -> list:
    """若 hero_params 不足 min_count 项,从 e_specs 按优先级补齐,直到 min_count。
    specs 枯竭时保持原样,不硬编造(feedback_no_hardcoded_data)。
    """
    if len(hero_params) >= min_count:
        return hero_params[:max_count]

    out = list(hero_params)
    used = {(p.get("label") or "").strip().lower() for p in out if p.get("label")}
    _supplement_from_specs(
        out, e_specs, key_priority,
        min_count=min_count, limit=max_count, used_norm=used,
        make_row=lambda name, value: {"label": name, "value": value},
    )
    return out[:max_count]


def _build_spec_rows(detail_params: dict) -> list:
    """将 detail_params 转为参数行列表，优先列显示重要参数，其余全量追加。不限行数。"""
    if not isinstance(detail_params, dict):
        return []

    priority = [
        "洗地效率", "清扫效率", "吸尘效率", "清洗宽度", "清扫作业宽度",
        "清水容量", "污水容量", "水箱容量", "尘箱容量",
        "工作效率", "工作时间", "续航时间", "充电时间",
        "刷盘功率", "吸水功率", "驱动功率",
        "刷盘电机", "吸水电机", "刷盘压力", "工作噪音",
        "电瓶容量", "锂电容量", "电池容量",
        "整机重量", "产品净重", "产品尺寸", "设备尺寸",
    ]

    rows = []
    used = set()
    for key in priority:
        value = _to_str(detail_params.get(key, ""))
        if value:
            rows.append({"name": key, "value": value})
            used.add(key)

    for key, value in detail_params.items():
        k = _to_str(key)
        v = _to_str(value)
        if not k or not v or k in used:
            continue
        rows.append({"name": k, "value": v})

    return rows


def _append_unit(val: str, unit: str = "mm") -> str:
    """给纯数字维度值追加单位后缀"""
    if val and val.replace(".", "").isdigit():
        return val + unit
    return val


def _strip_extreme_in_list(items, fields):
    """批量过滤列表中每个 dict 指定字段的极限词"""
    for item in items:
        if isinstance(item, dict):
            for f in fields:
                if f in item:
                    item[f] = _strip_extreme_words(_to_str(item[f]))


# P5.1 (2026-05-07): 4 品类参数 label 映射
# 替代 line 754-757 硬编码 "工作效率/清洗宽度/清水箱/续航时间" 设备类专属.
# 设备类 label 保持原值 (向后兼容); 耗材/配件/工具按各自语义命名.
_PARAM_LABELS_BY_CATEGORY = {
    "设备类": ("工作效率", "清洗宽度", "清水箱", "续航时间"),
    "耗材类": ("稀释比", "覆盖面积", "净含量", "保质期"),
    "配件类": ("适配机型", "净含量", "材质", "保质期"),
    "工具类": ("适配宽度", "材质", "净重", "耐久性"),
}

# P5.1 (2026-05-07): 4 品类兜底字符串映射
# 替代 line 739 硬编码 "商用清洁设备" 设备类专属兜底.
_CAT_FALLBACK = {
    "设备类": "商用清洁设备",
    "耗材类": "清洁耗材",
    "配件类": "清洁配件",
    "工具类": "清洁工具",
}


def _map_parsed_to_form_fields(parsed: dict, product_category: str | None = None) -> dict:
    """将解析结果映射为表单字段（供前端 AI 填表使用）.

    Args:
        parsed: DeepSeek 解析后的字典
        product_category: 4 大品类之一 ("设备类"/"耗材类"/"配件类"/"工具类").
                          None 或未知值时走"设备类"老路径 (向后兼容).
    """
    parsed = parsed if isinstance(parsed, dict) else {}
    detail_params = parsed.get("detail_params", {})
    dimensions = parsed.get("dimensions", {})
    if not isinstance(dimensions, dict):
        dimensions = {}

    brand = _to_str(parsed.get("brand", ""))
    model = _first_nonempty(parsed.get("model"), parsed.get("product_name"))
    product_type_str = _to_str(parsed.get("product_type", ""))
    slogan = _to_str(parsed.get("slogan", ""))
    sub_slogan = _to_str(parsed.get("sub_slogan", ""))

    tagline_line1, tagline_line2 = _split_slogan(slogan)

    brand_text = ""
    if brand and product_type_str:
        brand_text = f"{brand}{product_type_str}"
    elif brand:
        brand_text = brand

    param_efficiency = _first_nonempty(
        parsed.get("param_efficiency"),
        _get_detail_value(detail_params, ["工作效率", "清洁效率", "最大清洁效率"]),
    )
    param_width = _first_nonempty(
        parsed.get("param_width"),
        _get_detail_value(detail_params, ["清洗宽度", "清扫宽度", "清扫作业宽度", "吸水宽度"]),
    )
    param_capacity = _first_nonempty(
        parsed.get("param_capacity"),
        _get_detail_value(detail_params, ["清水容量", "污水容量", "水箱容量", "尘箱容量"]),
    )
    param_runtime = _first_nonempty(
        parsed.get("param_runtime"),
        _get_detail_value(detail_params, ["工作时间", "续航时间", "续航"]),
    )

    specs = _build_spec_rows(detail_params)

    dim_length = _to_str(dimensions.get("length", ""))
    dim_width = _to_str(dimensions.get("width", ""))
    dim_height = _to_str(dimensions.get("height", ""))

    if not (dim_length and dim_width and dim_height):
        size_text = _first_nonempty(
            _get_detail_value(detail_params, ["产品尺寸", "设备尺寸", "尺寸"]),
        )
        l, w, h = _parse_dimensions_from_text(size_text)
        dim_length = dim_length or l
        dim_width = dim_width or w
        dim_height = dim_height or h

    _pn = _to_str(parsed.get("product_name", ""))
    # main_title(首图中间大字)必须是"提炼的卖点短语",不能退化成产品名/型号 —
    # 否则就和下方"产品名+型号"小字重复。兜底链顺序:
    #   AI main_title → slogan 首段(以 · 或 | 拆) → advantages[0].text → sub_slogan → 产品名/品牌
    # 前四条都来自产品文案,最后两条才是"实在没话可说"的保底。
    _slogan_head = ""
    _slogan_raw = _to_str(parsed.get("slogan", ""))
    if _slogan_raw:
        for _sep in ("·", "|", " - ", "—", " "):
            if _sep in _slogan_raw:
                _slogan_head = _slogan_raw.split(_sep)[0].strip()
                if _slogan_head:
                    break
        if not _slogan_head:
            _slogan_head = _slogan_raw.strip()
    _first_adv = ""
    _advs_raw = parsed.get("advantages") or []
    if _advs_raw and isinstance(_advs_raw[0], dict):
        _first_adv = _to_str(_advs_raw[0].get("text", "")) or _to_str(_advs_raw[0].get("title", ""))
    _main = _first_nonempty(
        _to_str(parsed.get("main_title", "")),
        _slogan_head,
        _first_adv,
        _to_str(parsed.get("sub_slogan", "")),
        _pn,
        f"{brand} {model}".strip() if (brand or model) else "",
    )
    # category_line 优先承载「产品名+型号」，让首屏第一行小字显示具体产品而非抽象品类词
    _model_str = _to_str(parsed.get("model", "")) or _to_str(parsed.get("model_name", ""))
    if _pn:
        _cat = _pn + ((" " + _model_str) if _model_str and _model_str not in _pn else "")
    else:
        _cat = _first_nonempty(
            _to_str(parsed.get("category_line", "")),
            _to_str(parsed.get("product_type", "")),
        )
    # slogan 兜底用「品类名词」而不是 _cat(现在已变成品牌+SKU),否则会拼出"高效德威莱克DZ50X"这种病句
    _cat_noun = _first_nonempty(
        _to_str(parsed.get("category_line", "")),
        _to_str(parsed.get("product_type", "")),
    )
    _hero_sub = _to_str(parsed.get("hero_subtitle", ""))
    # 如果 AI 没返回标语，尝试用品类名词补位(如"高效驾驶式洗地机")
    if not slogan and _cat_noun:
        slogan = f"高效{_cat_noun}"
        tagline_line1, tagline_line2 = _split_slogan(slogan)
    # 最终兜底：确保首屏至少有产品名
    # P5.1: 兜底字符串按品类映射 (替代硬编码 "商用清洁设备")
    _cat_fallback = _CAT_FALLBACK.get(product_category or "设备类", _CAT_FALLBACK["设备类"])
    if not _main and not _cat:
        _cat = product_type_str or _cat_fallback
    if not _main:
        _main = _cat

    # P5.1: param_label 按品类选择 (替代硬编码 4 个设备类参数名)
    _param_labels = _PARAM_LABELS_BY_CATEGORY.get(
        product_category or "设备类", _PARAM_LABELS_BY_CATEGORY["设备类"]
    )

    result = {
        "brand_text": brand_text,
        "model_name": model,
        "tagline_line1": tagline_line1,
        "tagline_line2": tagline_line2,
        "tagline_sub": sub_slogan,
        "category_line": _cat,
        "main_title": _main,
        "hero_subtitle_pre": _hero_sub,
        "hero_subtitle_em": "",
        "hero_subtitle_post": "",
        "param_1_label": _param_labels[0], "param_1_value": param_efficiency,
        "param_2_label": _param_labels[1], "param_2_value": param_width,
        "param_3_label": _param_labels[2], "param_3_value": param_capacity,
        "param_4_label": _param_labels[3], "param_4_value": param_runtime,
        "e_specs": specs,
        "e_dim_length": _append_unit(dim_length),
        "e_dim_width": _append_unit(dim_width),
        "e_dim_height": _append_unit(dim_height),
    }

    # ── 产品优势（仅用AI返回的，不兜底推导）──
    # 优先用 block_b2_items（工具/配件/耗材类专用，强制 2/4/6 项、4字以内具体能力）
    b2_items_raw = parsed.get("block_b2_items", [])
    if isinstance(b2_items_raw, list) and b2_items_raw:
        # 规范到 2/4/6 项: AI 违反 prompt 返回 {1,3,5} 时回退到 advantages 兜底分支,
        # 而不是硬截断 — 否则 N=1 会生成"1 大产品优势"病文案, N=3/5 会静默丢一条优势。
        _n = len(b2_items_raw)
        if _n >= 6:
            b2_items_raw = b2_items_raw[:6]
        elif _n >= 4:
            b2_items_raw = b2_items_raw[:4]
        elif _n == 2:
            b2_items_raw = b2_items_raw[:2]
        else:
            b2_items_raw = []  # 违规 → 走 else 分支(advantages 兜底)
    if isinstance(b2_items_raw, list) and b2_items_raw:
        for i, item in enumerate(b2_items_raw):
            if isinstance(item, dict):
                result[f"b2_icon_{i+1}"] = _to_str(item.get("icon_text", "")) or _to_str(item.get("emoji", "✅"))
                result[f"b2_label_{i+1}"] = _to_str(item.get("label", "")) or _to_str(item.get("text", ""))
                result[f"b2_desc_{i+1}"] = _to_str(item.get("desc", ""))
        result["b2_title_num"] = str(len(b2_items_raw))
        result["b2_title_text"] = "大产品优势"
        result["b2_subtitle"] = ""
    else:
        advantages = parsed.get("advantages", [])
        if advantages:
            for i, item in enumerate(advantages[:9]):
                if isinstance(item, dict):
                    result[f"b2_icon_{i+1}"] = _to_str(item.get("emoji", "✅"))
                    result[f"b2_label_{i+1}"] = _to_str(item.get("text", ""))
                    result[f"b2_desc_{i+1}"] = _to_str(item.get("desc", ""))
                elif isinstance(item, str):
                    result[f"b2_icon_{i+1}"] = "✅"
                    result[f"b2_label_{i+1}"] = item
                    result[f"b2_desc_{i+1}"] = ""
            n = len(advantages[:9])
            result["b2_title_num"] = str(n)
            result["b2_title_text"] = "大核心优势"
            result["b2_subtitle"] = ""
        # 如果AI没返回advantages，不设置b2字段，模块将不显示

    # ── 清洁故事文案（AI生成）──
    result["b3_header_line1"] = _to_str(parsed.get("story_title_1", ""))
    result["b3_header_line2"] = _to_str(parsed.get("story_title_2", ""))
    result["b3_caption_line1"] = _to_str(parsed.get("story_desc_1", ""))
    result["b3_caption_line2"] = _to_str(parsed.get("story_desc_2", ""))
    result["b3_footer_line1"] = _to_str(parsed.get("story_bottom_1", ""))
    result["b3_footer_line2"] = _to_str(parsed.get("story_bottom_2", ""))

    # ── VS对比文案（新 schema: product_*/labor_*）──
    # 注意: block_f 预览模板左列=人工 / 右列=本产品,与 ai_compose/vs.html 语义一致
    vs = parsed.get("vs_comparison", {})
    if isinstance(vs, dict) and vs:
        product_label = _to_str(vs.get("product_label", ""))
        labor_label = _to_str(vs.get("labor_label", ""))
        _tl1 = _to_str(vs.get("title_line1", ""))
        # 有两方标签任一 或 有主标 → 才填,避免空屏
        if product_label or labor_label or _tl1:
            _tl1_red = _to_str(vs.get("title_line1_red", ""))
            _tl1_end = _to_str(vs.get("title_line1_end", ""))
            _tl2 = _to_str(vs.get("title_line2", ""))
            _tl2_red = _to_str(vs.get("title_line2_red", ""))
            result["f_title_line1"] = _tl1
            result["f_title_line1_red"] = _tl1_red
            result["f_title_line1_end"] = _tl1_end
            result["f_title_line2"] = _tl2
            result["f_title_line2_red"] = _tl2_red
            # 左列=人工 / 右列=本产品(与 ai_compose/vs.html 一致)
            result["f_vs_left_title"] = labor_label
            result["f_vs_left_sub"] = _to_str(vs.get("labor_sublabel", ""))
            result["f_vs_right_title"] = product_label
            result["f_vs_right_sub"] = _to_str(vs.get("product_sublabel", ""))
            # 底部结论条: 新 schema 无 left_bottom/right_bottom,置空让模板兜底
            result["f_vs_left_bottom"] = ""
            result["f_vs_right_bottom"] = ""
            # block_f_showcase_vs.html 模板期望 {label, left, right} 格式,
            # 将新 schema 的 vs_rows ({label, product_value, labor_value, ...}) 转换:
            #   left  = 人工数据 + 说明
            #   right = 本产品数据 + 说明
            vs_rows_raw = vs.get("vs_rows", [])
            if isinstance(vs_rows_raw, list) and vs_rows_raw:
                _converted = []
                for _r in vs_rows_raw:
                    if not isinstance(_r, dict):
                        continue
                    _lbl = _to_str(_r.get("label", ""))
                    _pv = _to_str(_r.get("product_value", ""))
                    _lv = _to_str(_r.get("labor_value", ""))
                    if not (_lbl and _pv and _lv):
                        continue
                    _pd = _to_str(_r.get("product_desc", ""))
                    _ld = _to_str(_r.get("labor_desc", ""))
                    _converted.append({
                        "label": _lbl,
                        "left": (_lv + (" " + _ld if _ld else "")),   # 左列=人工
                        "right": (_pv + (" " + _pd if _pd else "")),  # 右列=本产品
                    })
                if _converted:
                    result["f_vs_rows_json"] = json.dumps(_converted, ensure_ascii=False)

    # ── 适用地面材质（AI生成）──
    floor_items = parsed.get("floor_items", [])
    if isinstance(floor_items, list) and floor_items:
        result["b3_floor_items_json"] = json.dumps(floor_items, ensure_ascii=False)

    # ── 品类扩展字段（列表类 → JSON）──
    _list_field_map = {
        "compat_models": "block_p_json",
        "package_items": "block_r_json",
        "kpis":          "block_i_json",
        "scenes":        "block_h_json",
        "before_after":  "block_q_json",
        "tech_items":    "block_j_json",
        "faqs":          "block_s_json",
        "cert_badges":   "block_k_json",
    }
    for src_key, dest_key in _list_field_map.items():
        val = parsed.get(src_key)
        if isinstance(val, list) and val:
            result[dest_key] = json.dumps(val, ensure_ascii=False)
    # install_steps / usage_steps 合并为 block_m_json
    steps = parsed.get("install_steps") or parsed.get("usage_steps")
    if isinstance(steps, list) and steps:
        result["block_m_json"] = json.dumps(steps, ensure_ascii=False)

    # ── 品牌数据（brand_stats / brand_story_lines → block_g）──
    _brand_stats = parsed.get("brand_stats", [])
    if isinstance(_brand_stats, list) and _brand_stats:
        result["block_g_stats_json"] = json.dumps(_brand_stats, ensure_ascii=False)
    _brand_lines = parsed.get("brand_story_lines", [])
    if isinstance(_brand_lines, list) and _brand_lines:
        result["block_g_lines_json"] = json.dumps(_brand_lines, ensure_ascii=False)

    # ── 服务对比（service_compare → block_l）──
    _svc = parsed.get("service_compare", {})
    if isinstance(_svc, dict) and _svc.get("compare_rows"):
        result["block_l_json"] = json.dumps(_svc["compare_rows"], ensure_ascii=False)

    print(f"[映射] b2_label_1={result.get('b2_label_1','(空)')}, b3_header_line1={result.get('b3_header_line1','(空)')}")

    return result


# ── 配置加载 ─────────────────────────────────────────────────────────

_build_config_cache = {}   # {product_type: (mtime, cfg)}


def _load_build_config(product_type: str) -> dict:
    cfg_path = TEMPLATES_DIR / product_type / "build_config.json"
    if not cfg_path.exists():
        return {}
    mtime = cfg_path.stat().st_mtime
    cached = _build_config_cache.get(product_type)
    if cached and cached[0] == mtime:
        return cached[1]
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    _build_config_cache[product_type] = (mtime, cfg)
    return cfg


# ── 图片上传工具 ──────────────────────────────────────────────────────

STATIC_UPLOADS = BASE_DIR / "static" / "uploads"
STATIC_UPLOADS.mkdir(parents=True, exist_ok=True)
STATIC_OUTPUTS = BASE_DIR / "static" / "outputs"
STATIC_OUTPUTS.mkdir(parents=True, exist_ok=True)


def _user_upload_dir():
    """返回当前用户的上传目录，按 user_id 隔离"""
    uid = current_user.id if current_user.is_authenticated else 0
    d = STATIC_UPLOADS / str(uid)
    d.mkdir(parents=True, exist_ok=True)
    return d

def _user_output_dir():
    """返回当前用户的输出目录，按 user_id 隔离"""
    uid = current_user.id if current_user.is_authenticated else 0
    d = OUTPUT_DIR / str(uid)
    d.mkdir(parents=True, exist_ok=True)
    return d

def _remove_bg_if_needed(save_path: Path, user_dir: Path, uid: str) -> str | None:
    """对已落盘的图片执行 AI 抠图。
    成功:返回去背景后的 `<uid>_nobg.png` 文件名。
    跳过/失败:返回 None(由调用方回退到原图文件名)。

    被 _save_upload(auto_rembg=True) 和 /api/upload?auto_rembg=1 共享。
    抽出是为了让 v2 workspace 上传路径也能走抠图,不再两处分叉。
    """
    if not _ensure_rembg():
        print(f"[抠图] rembg 不可用,跳过 {save_path.name}。"
              f"运行: pip install rembg onnxruntime", flush=True)
        return None
    try:
        from PIL import Image as _Img
        import numpy as np
        import rembg

        im = _Img.open(save_path)
        # 已有真实透明区域就别重抠
        if im.mode == "RGBA":
            alpha = np.array(im)[:, :, 3]
            if alpha.min() < 250:
                print(f"[抠图] {save_path.name} 已有透明底,跳过", flush=True)
                return None

        import io as _io
        print(f"[抠图] 开始处理 {save_path.name}(AI+色值混合)…", flush=True)

        orig = im.convert("RGB")
        arr = np.array(orig)

        # 1) AI 抠图
        with open(save_path, "rb") as inp:
            ai_bytes = rembg.remove(inp.read(), session=REMBG_SESSION)
        ai_img = _Img.open(_io.BytesIO(ai_bytes)).convert("RGBA")
        ai_alpha = np.array(ai_img)[:, :, 3]

        # 2) 色值清理纯白残留 — 取四角 15×15 采样,低于该亮度 & AI 半透明的视作背景
        corners = [arr[:15, :15], arr[:15, -15:], arr[-15:, :15], arr[-15:, -15:]]
        bg_min = np.concatenate([c.reshape(-1, 3) for c in corners]).min(axis=0)
        threshold = max(int(bg_min.min()) - 2, 248)
        pure_bg = np.all(arr >= threshold, axis=2)
        ai_alpha[pure_bg & (ai_alpha < 200)] = 0

        # 3) 合成 + 落盘
        result_arr = np.dstack([arr, ai_alpha])
        result_img = _Img.fromarray(result_arr.astype(np.uint8), "RGBA")
        nobg_filename = f"{uid}_nobg.png"
        nobg_path = user_dir / nobg_filename
        result_img.save(str(nobg_path))
        print(f"[抠图] 完成 → {nobg_filename}", flush=True)
        return nobg_filename
    except Exception as e:
        import traceback
        print(f"[抠图] 失败,使用原图: {e}", flush=True)
        traceback.print_exc()
        return None


def _persist_upload(file_storage, *, auto_rembg: bool = False) -> dict:
    """落盘一个 FileStorage + 可选 rembg,返回统一描述 dict。

    `/api/upload` 和 `_save_upload` 共享,避免 uid/filename/save 逻辑漂移。
    调用方保证 file_storage.filename 已校验非空且格式合法。
    """
    ext = file_storage.filename.rsplit(".", 1)[-1].lower() if "." in file_storage.filename else "png"
    uid = uuid.uuid4().hex
    filename = f"{uid}.{ext}"
    user_dir = _user_upload_dir()
    save_path = user_dir / filename
    file_storage.save(str(save_path))

    final_filename = filename
    cutout_status = "not_requested"
    cutout_code = ""
    if auto_rembg and _DESKTOP_MODE:
        from offline_cutout import remove_background
        try:
            cutout_filename = f"{uid}_nobg.png"
            cutout_status = remove_background(save_path, user_dir / cutout_filename)
            final_filename = cutout_filename
        except Exception as error:
            cutout_status = "failed"
            known_codes = {"CUTOUT_MODEL_UNAVAILABLE", "CUTOUT_MODEL_INVALID", "CUTOUT_MASK_INVALID"}
            cutout_code = str(error) if str(error) in known_codes else "CUTOUT_PROCESSING_FAILED"
            print(f"[cutout] {cutout_code}", flush=True)
        auto_rembg = False
    if auto_rembg:
        nobg = _remove_bg_if_needed(save_path, user_dir, uid)
        if nobg:
            final_filename = nobg

    result = {
        "filename": final_filename,
        "url":      f"/static/uploads/{current_user.id}/{final_filename}",
        "rembg":    final_filename != filename,
        "cutout_status": cutout_status,
        "cutout_code": cutout_code,
    }
    if not _DESKTOP_MODE:
        result["path"] = str(user_dir / final_filename)
    return result


def _save_upload(file_field_name, auto_rembg: bool = False) -> str:
    """保存上传图片到 static/uploads/{user_id}/,返回 URL。

    auto_rembg=True 时对产品图自动抠图。表单路径专用;
    v2 `/api/upload` 直接调 `_persist_upload` 拿完整 dict。
    """
    f = request.files.get(file_field_name)
    if not f or not f.filename:
        return ""
    return _persist_upload(f, auto_rembg=auto_rembg)["url"]


# ── 基础路由 ─────────────────────────────────────────────────────────

_CATEGORIES = [
    {"type": "设备类", "desc": "商用清洁机器人、洗地机、扫地车等大型设备", "color": "#E8231A", "icon": "🤖"},
    {"type": "配件类", "desc": "刷盘、滤芯、吸水胶条等设备配件", "color": "#1E6FBF", "icon": "🔧"},
    {"type": "耗材类", "desc": "清洁剂、除垢液、清洁垫等消耗品", "color": "#2E8B57", "icon": "🧪"},
    {"type": "工具类", "desc": "拖把、刮水器、清洁桶等手动工具", "color": "#E87C1A", "icon": "🧹"},
]

@app.route('/api/themes', methods=['GET'])
@login_required
def get_themes():
    """返回所有可用模板的配置（含CSS变量）"""
    themes_path = BASE_DIR / "static" / "themes" / "themes.json"
    with open(themes_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return jsonify(data)


@app.route("/")
@login_required
def index():
    return render_template("workspace.html", desktop_mode=_DESKTOP_MODE)


@app.route("/workspace/<product_type>")
@login_required
def build_redirect(product_type):
    _validate_product_type(product_type)
    return render_template(
        "workspace.html",
        initial_product_type=product_type,
        desktop_mode=_DESKTOP_MODE,
    )


# ── 用户设置页 (P3 砍刀流后仅展示账号信息, 不再有 API Key 配置) ──
@app.route("/settings", methods=["GET", "POST"])
@login_required
def user_settings():
    """PR C (2026-05-07): GET 渲染 settings 页, POST 接收非付费用户自配 key.

    Gating: 付费/admin 用户不应该 POST 自配 key (走 platform 不需要), 直接 403.
    """
    if request.method == "POST":
        # PR C: 仅非付费用户能自配 key (admin/付费用户走 platform)
        if current_user.is_paid or current_user.is_admin:
            flash("付费用户使用平台密钥，无需自配 API Key", "warning")
            return redirect(url_for("user_settings"))

        from crypto_utils import encrypt_api_key
        ds_key = (request.form.get("custom_deepseek_key") or "").strip()
        gpt_key = (request.form.get("custom_gpt_image_key") or "").strip()

        updated = []
        if ds_key:
            current_user.custom_deepseek_key_enc = encrypt_api_key(ds_key)
            updated.append("DeepSeek")
        if gpt_key:
            current_user.custom_gpt_image_key_enc = encrypt_api_key(gpt_key)
            updated.append("GPT-image-2")

        if updated:
            db.session.commit()
            flash(f"已保存: {' + '.join(updated)} API Key", "success")
        else:
            flash("未输入任何新 key (留空表示不修改)", "info")
        return redirect(url_for("user_settings"))

    return render_template("auth/settings.html")


def _get_user_api_key():
    """[向后兼容] 获取 platform 托管的 DeepSeek API Key, 返回 (key, source).

    P3 砍刀流原始版本. PR C (2026-05-07) 后, 推荐用 _get_deepseek_key(user) 二级模式.
    保留是为了不破坏老调用点 (parse-text endpoint 暂时用这个, 待迁移).
    """
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if key:
        return key, "platform"
    return None, None


# PR C 二级模式 key dispatcher 的配置表 — 加新 key 类型 (如 ark) 改这里即可,
# 无需复制整个函数. 跟 _get_user_api_key (legacy 单层) 解耦保留, 后者待 parse-text
# 迁移完毕再删.
_KEY_CONFIG = {
    "deepseek": {
        "env_var": "DEEPSEEK_API_KEY",
        "custom_attr": "custom_deepseek_key_enc",
        "display_name": "DeepSeek",
        "settings_hint": "请先在 /settings 配置自己的 DeepSeek API Key, 或联系管理员升级为付费用户",
    },
    "gpt_image": {
        "env_var": "REFINE_API_KEY",
        "fallback_env_vars": ("GPT_IMAGE_API_KEY",),
        "custom_attr": "custom_gpt_image_key_enc",
        "display_name": "GPT-image-2",
        "settings_hint": "请先在 /settings 配置自己的 GPT-image-2 API Key (APIMart), 或联系管理员升级为付费用户",
    },
}


def _platform_env_vars(cfg):
    env_vars = [cfg["env_var"]]
    env_vars.extend(cfg.get("fallback_env_vars", ()))
    return env_vars


def _resolve_platform_env_key(cfg):
    for env_var in _platform_env_vars(cfg):
        key = os.environ.get(env_var, "").strip()
        if key:
            return key, env_var
    return "", cfg["env_var"]


def _get_platform_key(user, key_type):
    """PR C 二级模式: 付费/admin 走 platform env key, 非付费走解密 custom_*_enc.

    替换早先 _get_deepseek_key / _get_gpt_image_key 的两份 90% 重复实现.
    保留两个原函数为薄 wrapper, 老调用点不动 (单独 PR 收尾).

    Args:
        user: current_user 对象
        key_type: _KEY_CONFIG 的 key (目前 "deepseek" / "gpt_image")

    Returns:
        (key, source) 元组. source ∈ {"platform", "custom"}.

    Raises:
        ValueError: 未知 key_type
        RuntimeError: 付费/admin 缺 platform key 或非付费缺 custom key
    """
    cfg = _KEY_CONFIG.get(key_type)
    if not cfg:
        raise ValueError(f"未知 key_type: {key_type!r}, 期望 {list(_KEY_CONFIG)}")

    # admin 永远当付费用户对待 (admin 测试时不该自配 key)
    if getattr(user, "is_admin", False) or getattr(user, "is_paid", False):
        key, _used_env_var = _resolve_platform_env_key(cfg)
        if not key:
            env_hint = " / ".join(_platform_env_vars(cfg))
            raise RuntimeError(
                f"付费用户的 {cfg['display_name']} key 缺失 "
                f"(admin 在 .env 配 {env_hint} 后重启)"
            )
        return key, "platform"

    # 非付费用户: 解密 custom_*_key_enc
    enc = getattr(user, cfg["custom_attr"], None)
    if not enc:
        raise RuntimeError(cfg["settings_hint"])
    from crypto_utils import decrypt_api_key
    key = (decrypt_api_key(enc) or "").strip()
    if not key:
        raise RuntimeError(
            f"{cfg['display_name']} key 解密失败, 请重新在 /settings 配置"
        )
    return key, "custom"


# 薄 wrapper, 保留老接口名以减小本 PR 的回归面.
# 下个 PR 再把所有调用点直接改 _get_platform_key + 删除这两个 wrapper.
def _get_deepseek_key(user):
    return _get_platform_key(user, "deepseek")


def _get_gpt_image_key(user):
    return _get_platform_key(user, "gpt_image")


@app.route("/api/upload", methods=["POST"])
@login_required
def upload():
    if "file" not in request.files:
        return jsonify({"error": "请求中没有文件字段"}), 400
    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "文件名为空"}), 400
    if not allowed_img(file.filename):
        return jsonify({"error": f"不支持的格式，请上传 {', '.join(ALLOWED_IMG)}"}), 400

    auto_rembg = str(request.form.get("auto_rembg", "")).lower() in ("1", "true", "yes")
    return jsonify(_persist_upload(file, auto_rembg=auto_rembg))


# ── 批量上传 UI 页面（PRD 阶段二·任务5）─────────────────────────────
@app.route("/batch/upload", methods=["GET"])
@login_required
def batch_upload_page():
    """批量生成入口页：浏览器选文件夹 → JS 用 JSZip 打包 → POST /api/batch/upload。"""
    return render_template("batch/upload.html")


# 任务6 (UX): 最简历史列表页 — 按 created_at 倒序列出当前用户全部批次,
# 点击跳回 upload.html#batch=<batch_id> 让前端恢复该批次视图.
# 扩展性备注:
#   - 现在用 SQL LIMIT 50 硬顶, 避免用户攒几千条时一次性传全量. 加分页只需把
#     50 改为 PAGE_SIZE + offset=(page-1)*PAGE_SIZE, 不需要改模板结构.
#   - 过滤 (按状态/日期) / 搜索 (按 raw_name) 留 v2, 当前版本故意不加,
#     避免 UX 复杂化和索引维护成本.
@app.route("/batch/history", methods=["GET"])
@login_required
def batch_history_page():
    """列出当前用户的批次, 创建时间倒序, 最多 50 条 (防 DoS)."""
    # 过滤策略与 /api/batches 保持一致: 当前用户 + legacy 无主批次
    # (user_id=NULL, 历史遗留). 任务7 决定是否把 legacy 一次性 backfill 后再锁死.
    batches = (
        Batch.query
        .filter((Batch.user_id == current_user.id) | (Batch.user_id.is_(None)))
        .order_by(Batch.created_at.desc())
        .limit(50)
        .all()
    )
    return render_template("batch/history.html", batches=batches)


@app.route("/batch/history/<batch_id>", methods=["GET"])
@login_required
def batch_history_detail_page(batch_id):
    """2026-04-22 历史批次详情页 (方向 B): 展示单批所有产品 + HTML/AI 预览缩略 +
    下载按钮. 复用任务1 lightbox + 任务2 stage-pill + A3 修好的下载端点.
    磁盘丢失时按钮置灰. 数据拉 /api/batches/<id> (自带 disk_available 字段).
    """
    batch = Batch.query.filter_by(batch_id=batch_id).first()
    if batch is None:
        abort(404)
    if batch.user_id is not None and batch.user_id != current_user.id:
        abort(403)
    return render_template("batch/history_detail.html", batch=batch)


# 任务9: /api/themes 复用已有端点 (app.py:990 get_themes), 返回 themes.json 全量。
# 前端只读 .themes 数组的 id/name/description 字段, 兼容。


# ── 批量上传（PRD: PRD_批量生成.md F1/F2/F3）──────────────────────────
@app.route("/api/batch/upload", methods=["POST"])
@login_required
def batch_upload():
    """接收一个 zip，解压后扫描产品文件夹结构，返回识别报告。

    multipart/form-data:
        file: <zip 文件，必填>
        batch_name: <批次显示名，可选；默认取 zip 文件名>
    """
    import shutil
    import zipfile as _zf

    if "file" not in request.files:
        return jsonify({"error": "请求中没有文件字段 file"}), 400
    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "文件名为空"}), 400
    if not file.filename.lower().endswith(".zip"):
        return jsonify({"error": "只支持 .zip 格式"}), 400

    batch_name = (request.form.get("batch_name", "") or "").strip() \
        or Path(file.filename).stem

    # 任务9 (PRD F11): 模板策略
    from theme_matcher import KNOWN_THEME_IDS as _THEMES_OK
    template_strategy = (request.form.get("template_strategy", "auto") or "auto").strip()
    if template_strategy not in ("auto", "fixed"):
        template_strategy = "auto"
    fixed_theme_id = (request.form.get("fixed_theme_id", "") or "").strip() or None
    if template_strategy == "fixed":
        if not fixed_theme_id or fixed_theme_id not in _THEMES_OK:
            return jsonify({
                "error": (f"template_strategy=fixed 但 fixed_theme_id 不在白名单内: "
                         f"{fixed_theme_id!r}; 可选: {sorted(_THEMES_OK)}"),
            }), 400
    else:
        fixed_theme_id = None  # auto 模式下强制清空,避免脏数据
    product_category = (request.form.get("product_category", "设备类") or "设备类").strip()
    if product_category not in ALLOWED_PRODUCT_TYPES:
        product_category = "设备类"

    batches_root = UPLOAD_DIR / "batches"
    batches_root.mkdir(parents=True, exist_ok=True)
    batch_id = batch_upload_mod.generate_batch_id(batches_root)
    batch_dir = batches_root / batch_id
    batch_dir.mkdir(parents=True, exist_ok=True)

    zip_path = batch_dir / "_upload.zip"
    file.save(str(zip_path))

    try:
        extracted = batch_upload_mod.extract_zip_safe(zip_path, batch_dir)
    except _zf.BadZipFile:
        shutil.rmtree(batch_dir, ignore_errors=True)
        return jsonify({"error": "无效的 zip 文件（损坏或不是 zip 格式）"}), 400
    except Exception as e:
        shutil.rmtree(batch_dir, ignore_errors=True)
        return jsonify({"error": f"解压失败：{type(e).__name__}: {e}"}), 500
    finally:
        try:
            zip_path.unlink()
        except OSError:
            pass

    report = batch_upload_mod.scan_batch(batch_dir, BASE_DIR)

    if report["total_folders"] > batch_upload_mod.MAX_PRODUCTS_PER_BATCH:
        shutil.rmtree(batch_dir, ignore_errors=True)
        return jsonify({
            "error": (f"单次最多 {batch_upload_mod.MAX_PRODUCTS_PER_BATCH} 个产品，"
                      f"当前 zip 包含 {report['total_folders']} 个文件夹"),
        }), 400

    # ── PRD F10：同名 (第N次) 后缀 + 持久化到 batches / batch_items ──
    display_name = _generate_unique_batch_name(batch_name)
    batch_dir_rel = str(batch_dir.relative_to(BASE_DIR)).replace("\\", "/")
    user_id_or_none = current_user.id if current_user.is_authenticated else None

    batch_row = Batch(
        batch_id=batch_id,
        name=display_name,
        raw_name=batch_name,
        user_id=user_id_or_none,
        status="uploaded",
        total_count=report["total_folders"],
        valid_count=report["valid_count"],
        skipped_count=report["skipped_count"],
        batch_dir=batch_dir_rel,
        template_strategy=template_strategy,
        fixed_theme_id=fixed_theme_id,
        product_category=product_category,
    )
    db.session.add(batch_row)
    db.session.flush()  # 拿 id

    for p in report["products"]:
        db.session.add(BatchItem(
            batch_pk=batch_row.id,
            name=p["name"],
            status="pending",
            main_image_path=p["main_image_path"],
            detail_image_paths=_json_mod.dumps(p["detail_image_paths"], ensure_ascii=False),
            desc_text=p.get("desc_text", ""),
            desc_chars=p["desc_chars"],
        ))
    for s in report["skipped"]:
        db.session.add(BatchItem(
            batch_pk=batch_row.id,
            name=s["name"],
            status="skipped",
            skip_reason=s["reason"],
        ))
    db.session.commit()

    # 响应里把 desc_text 全文剥掉(可能很长),只保留 preview
    products_response = [{k: v for k, v in p.items() if k != "desc_text"}
                         for p in report["products"]]

    return jsonify({
        "db_id": batch_row.id,
        "batch_id": batch_id,
        "batch_name": display_name,
        "raw_name": batch_name,
        "batch_dir": "/" + batch_dir_rel,
        "extracted_files": extracted,
        "scan_root": report["scan_root"],
        "total_folders": report["total_folders"],
        "valid_count": report["valid_count"],
        "skipped_count": report["skipped_count"],
        "products": products_response,
        "skipped": report["skipped"],
        # 任务9 (PRD F11): 让前端能在结果页显示当前批次的模板策略
        "template_strategy": template_strategy,
        "fixed_theme_id": fixed_theme_id,
        "product_category": product_category,
    })


def _generate_unique_batch_name(raw_name: str) -> str:
    """PRD F10：同一天 raw_name 重复 → 第 2/3/N 次自动加 (第N次) 后缀。"""
    today = _dt.utcnow().date()
    count = Batch.query.filter(
        Batch.raw_name == raw_name,
        _sa_func.date(Batch.created_at) == today,
    ).count()
    if count == 0:
        return raw_name
    return f"{raw_name} (第{count + 1}次)"


# ── 历史批次查询（PRD F9 雏形）──────────────────────────────────────
@app.route("/api/batches", methods=["GET"])
@login_required
def batches_list():
    """列出批次，按创建时间倒序。?limit=50&offset=0"""
    try:
        limit = max(1, min(200, int(request.args.get("limit", "50"))))
        offset = max(0, int(request.args.get("offset", "0")))
    except ValueError:
        return jsonify({"error": "limit/offset 必须是整数"}), 400
    # 安全修复 (任务6 顺带): 之前没按 user_id 过滤, 会把全部用户的批次
    # 元数据 (raw_name / total_count / ...) 泄露给任意登录用户.
    # legacy 无主批次 (user_id=NULL) 依然开放读取, 与 batches_detail 的
    # "is not None 才校验" 策略保持一致, 避免把老数据锁死.
    q = (
        Batch.query
        .filter((Batch.user_id == current_user.id) | (Batch.user_id.is_(None)))
        .order_by(Batch.created_at.desc())
    )
    total = q.count()
    rows = q.offset(offset).limit(limit).all()
    return jsonify({
        "total": total,
        "limit": limit,
        "offset": offset,
        "batches": [b.to_dict() for b in rows],
    })


@app.route("/api/batches/<batch_id>", methods=["GET"])
@login_required
def batches_detail(batch_id):
    """单个批次详情，含全部 items。仅 owner 可读(legacy 无主批次仍开放)。

    2026-04-22 历史批次详情页: 附加 disk_available 字段 + 每个 item 的
    preview_png_exists / ai_refined_exists, 让前端能置灰"文件已丢失"按钮.
    """
    batch = Batch.query.filter_by(batch_id=batch_id).first()
    if not batch:
        return jsonify({"error": f"批次不存在: {batch_id}"}), 404
    if batch.user_id is not None and batch.user_id != current_user.id:
        return jsonify({"error": "没有权限查看该批次"}), 403
    data = batch.to_dict(with_items=True)
    # 磁盘存在性检查 (同批次 items 同目录, 共享 product_dir 查询)
    total_slots = missing_slots = 0
    item_by_id = {it.id: it for it in batch.items}
    for it_data in data.get("items", []):
        it_obj = item_by_id.get(it_data["id"])
        if it_obj is None:
            it_data["preview_png_exists"] = False
            it_data["ai_refined_exists"] = False
            total_slots += 2; missing_slots += 2
            continue
        prod_dir = _resolve_product_dir_from_result(it_obj, batch_id)
        png_ok = (prod_dir / "preview.png").is_file()
        ai_ok  = (prod_dir / "ai_refined.jpg").is_file()
        it_data["preview_png_exists"] = png_ok
        it_data["ai_refined_exists"]  = ai_ok
        total_slots += 2
        if not png_ok: missing_slots += 1
        if not ai_ok:  missing_slots += 1
    if total_slots == 0 or missing_slots == 0:
        data["disk_available"] = "full"
    elif missing_slots == total_slots:
        data["disk_available"] = "missing"
    else:
        data["disk_available"] = "partial"
    return jsonify(data)


@app.route("/api/batches/<batch_id>/items/<item_name>", methods=["PATCH"])
@login_required
def batches_item_update(batch_id, item_name):
    """更新单个 item，目前只支持 want_ai_refine。

    Body: {"want_ai_refine": true|false}
    """
    batch = Batch.query.filter_by(batch_id=batch_id).first()
    if not batch:
        return jsonify({"error": f"批次不存在: {batch_id}"}), 404
    if batch.user_id is not None and batch.user_id != current_user.id:
        return jsonify({"error": "没有权限修改该批次"}), 403
    item = BatchItem.query.filter_by(batch_pk=batch.id, name=item_name).first()
    if not item:
        return jsonify({"error": f"产品不存在: {item_name}"}), 404
    data = request.get_json(silent=True) or {}
    changed = False
    if "want_ai_refine" in data:
        item.want_ai_refine = bool(data["want_ai_refine"])
        changed = True
    if changed:
        db.session.commit()
    return jsonify(item.to_dict())


# ── 批量队列：mock 触发与状态查询（PRD F4/F7 验证用）────────────────
@app.route("/api/batch/<batch_id>/start-mock", methods=["POST"])
@login_required
@csrf.exempt  # dev-only: 保留豁免是为 curl 自测, 生产环境下面的 guard 会直接 403
def batch_start_mock(batch_id):
    """重新扫描已上传的批次目录，把识别到的产品扔进批量池跑 mock 处理器。

    任务4 会替换为真实的 DeepSeek+rembg+Playwright 流水线。
    """
    # 生产拒绝: 这个端点只服务本地开发 / curl 自测, 不应从公网可达
    if os.environ.get("FLASK_ENV", "").lower() == "production":
        return jsonify({"error": "mock 端点在生产环境已禁用"}), 403
    # 2026-04-22 纵深防御: owner 校验 (POST 严格风格, 同 L1710 real start, legacy 也拒).
    batch = Batch.query.filter_by(batch_id=batch_id).first()
    if batch is None:
        return jsonify({"error": f"批次不存在: {batch_id}"}), 404
    if batch.user_id is None or batch.user_id != current_user.id:
        return jsonify({"error": "无权访问该批次"}), 403
    batches_root = UPLOAD_DIR / "batches"
    batch_dir = batches_root / batch_id
    if not batch_dir.is_dir():
        return jsonify({"error": f"batch_id 不存在: {batch_id}"}), 404

    report = batch_upload_mod.scan_batch(batch_dir, BASE_DIR)
    if report["valid_count"] == 0:
        return jsonify({"error": "批次内没有合规产品",
                       "skipped": report["skipped"]}), 400

    batch_name = (request.form.get("batch_name", "") or "").strip() or batch_id
    try:
        batch_queue_mod.submit_batch(
            batch_id=batch_id, batch_name=batch_name,
            products=report["products"],
            processor_fn=batch_queue_mod.mock_processor,
            on_state_change=_batch_db_sync_callback,  # 任务6:让 mock 也走 WS 推送
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 409

    return jsonify({
        "ok": True,
        "batch_id": batch_id,
        "submitted": report["valid_count"],
        "skipped": report["skipped_count"],
        "message": "已扔进批量池；GET /api/batch/<batch_id>/status 查进度",
    })


@app.route("/api/batch/<batch_id>/status", methods=["GET"])
@login_required
def batch_status(batch_id):
    """查询批次进度。"""
    # 2026-04-22 纵深防御: owner 校验 (GET 宽松风格, 同 L1333/L1348).
    # legacy user_id=None 批次放过 (阶段六已归档技术债).
    batch = Batch.query.filter_by(batch_id=batch_id).first()
    if batch is None:
        return jsonify({"error": f"批次不存在: {batch_id}"}), 404
    if batch.user_id is not None and batch.user_id != current_user.id:
        return jsonify({"error": "无权访问该批次"}), 403
    state = batch_queue_mod.get_batch_status(batch_id)
    if state is None:
        return jsonify({"error": f"批次未在内存中: {batch_id}（可能未触发或服务重启过）"}), 404
    return jsonify(state)


# ── 批量真实处理流水线（PRD F4/F7/F8 任务4a 主干）───────────────────
def _batch_db_sync_callback(batch_id, name, status, result, error):
    """worker 状态变更 → 同步到 batch_items + 收尾 batches.status。

    必须套 app.app_context()，因为 worker 跑在线程池里，没有请求上下文。
    任何异常被 batch_queue 兜住，不会卡死 worker。
    """
    with app.app_context():
        batch = Batch.query.filter_by(batch_id=batch_id).first()
        if not batch:
            print(f"[db-sync] 找不到 batch_id={batch_id}，跳过", flush=True)
            return
        item = BatchItem.query.filter_by(batch_pk=batch.id, name=name).first()
        if not item:
            print(f"[db-sync] 找不到 batch.{batch.id} 的产品 {name}，跳过", flush=True)
            return

        now = _dt.utcnow()
        item.status = status
        if status == "processing":
            item.started_at = now
            if batch.status != "running":
                batch.status = "running"
        elif status in ("done", "failed"):
            item.finished_at = now
            # 任务2 (2026-04-22): 终态时清 current_stage = null, 让前端 pill
            # 从 "capturing" 这类进行中状态切到 done/failed 的终态 UI.
            item.current_stage = None
            if result is not None:
                item.result = _json_mod.dumps(result, ensure_ascii=False)
                # 任务9 (PRD F11): 把 processor 算出的主题落库,
                # 给后续 AI 精修阶段 (任务10/11) 直接用,不用再重算。
                if isinstance(result, dict):
                    if result.get("resolved_theme_id"):
                        item.resolved_theme_id = result["resolved_theme_id"]
                    if result.get("resolved_theme_matched_by"):
                        item.resolved_theme_matched_by = result["resolved_theme_matched_by"]
            if error is not None:
                item.error = error
        db.session.commit()

        # 收尾：所有 item 都终态了 → batches.status = completed
        batch_completed = False
        if status in ("done", "failed"):
            outstanding = BatchItem.query.filter(
                BatchItem.batch_pk == batch.id,
                BatchItem.status.in_(["pending", "processing"])
            ).count()
            if outstanding == 0:
                batch.status = "completed"
                db.session.commit()
                batch_completed = True
                print(f"[db-sync] batch {batch_id} 全部完成 → status=completed",
                      flush=True)

    # ── 推送到所有订阅了该批次的 WebSocket 前端 (PRD F5) ──────────────
    # 注意:必须在 app_context 之外做(避免 WS 写阻塞耽搁 DB session 释放),
    # 但仍在 worker 线程内同步调,因为 batch_pubsub 自带锁,线程安全。
    try:
        snap = batch_queue_mod.get_batch_status(batch_id)
        batch_pubsub_mod.publish(batch_id, {
            "type": "product",
            "name": name,
            "status": status,
            "result": result,
            "error": error,
            "snapshot": snap,
        })
        if batch_completed:
            batch_pubsub_mod.publish(batch_id, {
                "type": "batch_complete",
                "snapshot": snap,
            })
    except Exception:
        import traceback as _tb; _tb.print_exc()  # 推送失败绝不影响 worker


# ── 任务11 (PRD F6): 精修池 worker → DB 回写 ────────────────────────────
def _refine_db_sync_callback(batch_id, name, status, result, error):
    """精修 worker 状态变更 → 同步到 batch_items.ai_refine_status + result JSON。

    与 _batch_db_sync_callback 的区别:
      - 只动 ai_refine_status, 不碰 item.status (HTML 阶段的终态)
      - 把 result 里的 ai_refined_path / ai_refined_at 合并到 item.result JSON
        (不覆盖任务4 写的 parsed_path / preview_png 等字段)
      - 不改 batches.status (精修不会让整个 batch 变 completed/running)
    WS 推送 type='refine' 让前端能区分两个阶段。
    """
    with app.app_context():
        batch = Batch.query.filter_by(batch_id=batch_id).first()
        if not batch:
            print(f"[refine-db] 找不到 batch_id={batch_id},跳过", flush=True)
            return
        item = BatchItem.query.filter_by(batch_pk=batch.id, name=name).first()
        if not item:
            print(f"[refine-db] 找不到 batch.{batch.id} 产品 {name},跳过", flush=True)
            return

        now = _dt.utcnow()
        item.ai_refine_status = status
        if status == "processing":
            # 精修 started_at 复用 BatchItem.started_at? 不,那是 HTML 阶段的。
            # 精修时间戳塞进 result JSON,不加新列。
            pass
        elif status in ("done", "failed"):
            if result is not None and isinstance(result, dict):
                # 合并到现有 result (保留 HTML 阶段的 parsed_path 等)
                try:
                    existing = _json_mod.loads(item.result or "{}")
                    if not isinstance(existing, dict):
                        existing = {}
                except _json_mod.JSONDecodeError:
                    existing = {}
                existing.update(result)
                item.result = _json_mod.dumps(existing, ensure_ascii=False)
            if error is not None:
                # 精修错误塞到 result.ai_refine_error, 不覆盖 HTML 阶段的 item.error
                try:
                    existing = _json_mod.loads(item.result or "{}")
                    if not isinstance(existing, dict):
                        existing = {}
                except _json_mod.JSONDecodeError:
                    existing = {}
                existing["ai_refine_error"] = error
                item.result = _json_mod.dumps(existing, ensure_ascii=False)
        db.session.commit()

    # WS 推送: type='refine' (前端区别于 type='product')
    try:
        snap = batch_queue_mod.get_refine_status(batch_id)
        batch_pubsub_mod.publish(batch_id, {
            "type": "refine",
            "name": name,
            "status": status,
            "result": result,
            "error": error,
            "snapshot": snap,
        })
    except Exception:
        import traceback as _tb; _tb.print_exc()


@app.route("/api/batch/<batch_id>/ai-refine-start", methods=["POST"])
@login_required
def batch_ai_refine_start(batch_id):
    """任务11 (PRD F6 → v3.2): 把勾选的产品扔进精修池.

    v3.2 (2026-04-29): 切换到 v2 path (DeepSeek + APIMart gpt-image-2),
    不再依赖用户提供 ark_api_key. 服务端 .env 已配 DEEPSEEK_API_KEY +
    REFINE_API_KEY (兼容 GPT_IMAGE_API_KEY fallback), 用户在批量 UI 直接点启动即可.

    请求体 JSON (兼容历史调用方):
        { "ark_api_key": "sk-xxxxx" }   # v3.2 已不使用, 字段保留为兼容
    """
    import refine_processor

    batch = Batch.query.filter_by(batch_id=batch_id).first()
    if batch is None:
        return jsonify({"error": f"批次不存在: {batch_id}"}), 404
    if batch.user_id is None or batch.user_id != current_user.id:
        return jsonify({"error": "只有批次上传者可以启动精修"}), 403

    data = request.get_json(silent=True) or {}
    # v3.2: ark_api_key 不再必填. 透传给 refine_processor 兼容签名 (内部忽略).
    ark_api_key = (data.get("ark_api_key") or "").strip()
    # v3.2 改为校验服务端 env 是否配齐 v2 双 key
    deepseek_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    gpt_image_key, _ = _resolve_platform_env_key(_KEY_CONFIG["gpt_image"])
    if not (deepseek_key and gpt_image_key):
        return jsonify({
            "error": (
                "服务端 v3.2 v2 path key 未配齐. 联系管理员在 .env 加 "
                "DEEPSEEK_API_KEY + REFINE_API_KEY 后 docker compose "
                "up -d --force-recreate web."
            ),
            "action": "server_missing_v2_keys",
        }), 503

    candidates, skipped, already_done = _select_refine_candidates(batch)
    if not candidates:
        return jsonify({
            "error": "没有可精修的产品 (全部被白名单拦住)",
            "skipped": skipped,
        }), 400

    # ── 物理余额保护 (2026-04-20 事故后加) ─────────────────────────
    # 绝不让单次请求超过 MAX_REFINE_COST_PER_RUN. 这是最后一道防线,
    # 前端即使被绕过、按钮锁失效、用户手工 POST, 这里都能兜住.
    from pricing_config import compute_estimate, MAX_REFINE_COST_PER_RUN
    est = compute_estimate(len(candidates))
    if est["est_cost_yuan"] > MAX_REFINE_COST_PER_RUN:
        return jsonify({
            "error": (
                f"预估 ¥{est['est_cost_yuan']:.2f} 超过单次保护上限 "
                f"¥{MAX_REFINE_COST_PER_RUN:.2f} — 请减少勾选或调大 "
                f"环境变量 MAX_REFINE_COST_PER_RUN 后重试"
            ),
            "action": "cost_exceeds_cap",
            "estimated_cost_yuan": est["est_cost_yuan"],
            "cap_yuan": MAX_REFINE_COST_PER_RUN,
            "product_count": est["count"],
        }), 400

    # ── 原子 claim (多 worker 互斥入队) ─────────────────────────────
    # SELECT ... FOR UPDATE SKIP LOCKED: 跨 worker 场景下同一条 BatchItem 只会
    # 被一个 worker 锁住; 另一个 worker 直接跳过锁住行, 避免双扣费.
    # SQLite 不支持 FOR UPDATE, SQLAlchemy 会降级成普通 SELECT, 但 SQLite 本身
    # 就是单写, 所以也不会双扣. 生产 Postgres 必定走 skip_locked 分支.
    claimed_items = (
        db.session.query(BatchItem)
        .filter(
            BatchItem.id.in_([c.id for c in candidates]),
            BatchItem.ai_refine_status.in_(["not_requested", "failed"]),
        )
        .with_for_update(skip_locked=True)
        .all()
    )
    if not claimed_items:
        db.session.commit()
        return jsonify({
            "error": "所有条目已在精修队列中 / 已跑过, 无需重复提交",
            "skipped": skipped,
            "already_done_count": already_done,
        }), 409
    for _it in claimed_items:
        _it.ai_refine_status = "queued"
    db.session.commit()

    if len(claimed_items) < len(candidates):
        # 并发 claim 的边界情况: 一部分条目被另一个 worker 锁走了, 只处理自己拿到的
        print(
            f"[refine-claim] 并发: 请求 {len(candidates)} 条, "
            f"claim 成功 {len(claimed_items)} 条",
            flush=True,
        )
    candidates = claimed_items  # 下游 items 构造只基于 claim 成功的条目

    # 构造 payload: 只取精修需要的字段,避免池里传一大堆没用的东西
    items = []
    for it in candidates:
        # parsed.json 路径 — 从 result JSON 拿 (任务4 存的)
        parsed_path = ""
        try:
            r = _json_mod.loads(it.result or "{}")
            if isinstance(r, dict):
                parsed_path = r.get("parsed_path") or ""
        except _json_mod.JSONDecodeError:
            pass
        cutout_path = ""
        try:
            r = _json_mod.loads(it.result or "{}")
            if isinstance(r, dict):
                cutout_path = r.get("cutout_path") or ""
        except _json_mod.JSONDecodeError:
            pass
        items.append({
            "name": it.name,
            "main_image_path":   it.main_image_path,
            "cutout_path":       cutout_path,
            "parsed_json_path":  parsed_path,
            "resolved_theme_id": it.resolved_theme_id or "classic-red",
            "product_category":  batch.product_category or "设备类",
        })

    # (状态置 queued 已由上面的原子 claim 完成, 这里不再重复 UPDATE)

    # 用闭包绑定 ark_api_key → processor_fn 仍是 (scope_id, payload) 两参签名
    def _processor_with_ark(scope_id, payload, _key=ark_api_key):
        return refine_processor.refine_one_product(
            scope_id, payload, ark_api_key=_key
        )

    batch_queue_mod.submit_refine(
        batch_id=batch_id,
        items=items,
        processor_fn=_processor_with_ark,
        on_state_change=_refine_db_sync_callback,
    )

    return jsonify({
        "ok": True,
        "batch_id": batch_id,
        "submitted": len(items),
        "skipped": skipped,
        "already_done_count": already_done,
    })


# ── v3.3 单屏 reroll 锁字典 (per-process, gthread worker 共享) ──
_REGEN_LOCKS: dict[str, threading.Lock] = {}
_REGEN_LOCKS_GUARD = threading.Lock()


def _get_regen_lock(item_pk: int, block_index: int) -> threading.Lock:
    key = f"{item_pk}:{block_index}"
    with _REGEN_LOCKS_GUARD:
        lk = _REGEN_LOCKS.get(key)
        if lk is None:
            lk = threading.Lock()
            _REGEN_LOCKS[key] = lk
        return lk


@app.route(
    "/api/batch/<batch_id>/items/<int:item_pk>/regenerate-screen",
    methods=["POST"],
)
@limiter.limit("10 per minute; 30 per hour", methods=["POST"])
@login_required
def batch_item_regenerate_screen(batch_id, item_pk):
    """v3.3 单屏 reroll. spec: 2026-04-30-regenerate-screen-design.md"""
    batch = Batch.query.filter_by(batch_id=batch_id).first()
    if batch is None:
        return jsonify({"error": f"批次不存在: {batch_id}"}), 404
    # owner 校验严格度跟 /ai-refine-start 拉齐 (app.py:1631):
    # "user_id is None or != current_user.id" — 拒绝 NULL owner (legacy 数据安全).
    # 不能写成 "is not None and !=" — 那样 NULL owner 任何人都能 reroll → 跨用户扣费漏洞.
    if batch.user_id is None or batch.user_id != current_user.id:
        return jsonify({"error": "只有批次上传者可以重生"}), 403

    item = BatchItem.query.filter_by(id=item_pk, batch_pk=batch.id).first()
    if item is None:
        return jsonify({"error": f"产品不存在: {item_pk}"}), 404

    if item.ai_refine_status != "done":
        return jsonify({
            "error": "仅完成的产品可 reroll",
            "current_status": item.ai_refine_status,
        }), 409

    data = request.get_json(silent=True) or {}
    if "block_index" not in data:
        return jsonify({"error": "block_index 必填"}), 400
    try:
        block_index = int(data["block_index"])
    except (TypeError, ValueError):
        return jsonify({"error": "block_index 必须是整数"}), 400

    # Task 6: 锁 + 真实调用 + WS publish
    lock = _get_regen_lock(item_pk, block_index)
    if not lock.acquire(blocking=False):
        return jsonify({
            "error": "另一个 reroll 进行中, 请稍候",
        }), 423

    try:
        # 解析 result JSON 拿 task_id
        try:
            result_dict = json.loads(item.result or "{}")
        except json.JSONDecodeError:
            return jsonify({"error": "item.result 不是合法 JSON"}), 500
        task_id = (result_dict.get("task_id") or "").strip()
        if not task_id:
            return jsonify({
                "error": "item 缺 task_id, 无法 reroll. 重启精修.",
            }), 410

        task_dir = BASE_DIR / "static" / "ai_refine_v2" / task_id
        if not task_dir.is_dir():
            return jsonify({
                "error": "原始任务产物已清理, 无法 reroll. 重启精修.",
            }), 410

        # cutout: 从 main_image_path / parsed_json_path 推算 product_dir
        cutout_path = None
        try:
            main_url = (item.main_image_path or "").lstrip("/")
            if main_url.startswith("uploads/"):
                main_url = "static/" + main_url
            elif not main_url.startswith("static/"):
                main_url = ""
            if main_url:
                product_dir = (BASE_DIR / main_url).parent
                cand = product_dir / "product_cut.png"
                if cand.is_file():
                    cutout_path = cand
        except Exception:
            cutout_path = None

        deepseek_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
        gpt_image_key, _ = _resolve_platform_env_key(_KEY_CONFIG["gpt_image"])
        if not (deepseek_key and gpt_image_key):
            return jsonify({
                "error": "服务端 v2 key 未配齐",
            }), 503

        from ai_refine_v2.regen_single import regenerate_screen
        try:
            regen = regenerate_screen(
                task_dir=task_dir,
                block_index=block_index,
                cutout_path=cutout_path,
                deepseek_key=deepseek_key,
                gpt_image_key=gpt_image_key,
            )
        except IndexError as e:
            return jsonify({"error": str(e)}), 400
        except FileNotFoundError as e:
            return jsonify({"error": str(e)}), 410
        except Exception as e:
            return jsonify({
                "error": f"重生成失败: {type(e).__name__}: {e}",
            }), 500

        # 把 regen.new_assembled_path (PNG) 转 JPG 覆盖到产品目录的 ai_refined.jpg
        ai_refined_url = (result_dict.get("ai_refined_path") or "").strip()
        new_assembled_url = ai_refined_url  # default fallback
        if ai_refined_url:
            try:
                rel = ai_refined_url.lstrip("/")
                if rel.startswith("uploads/"):
                    rel = "static/" + rel
                ai_refined_fs = BASE_DIR / rel
                if ai_refined_fs.parent.is_dir():
                    from PIL import Image as _PIL_Image
                    img = _PIL_Image.open(regen.new_assembled_path).convert("RGB")
                    img.save(ai_refined_fs, format="JPEG", quality=90, optimize=True)
                    cache_bust = int(time.time())
                    new_assembled_url = f"{ai_refined_url}?v={cache_bust}"
            except Exception as _conv_e:
                print(f"[regen] 转 JPG 失败 (保留旧 assembled): {_conv_e}", flush=True)

        # WS publish (cache-bust query)
        cache_bust = int(time.time())
        new_block_url = (
            f"/static/ai_refine_v2/{task_id}/block_{block_index}.jpg?v={cache_bust}"
        )
        batch_pubsub_mod.publish(batch_id, {
            "type": "screen_regenerated",
            "batch_id": batch_id,
            "item_pk": item_pk,
            "block_index": block_index,
            "new_block_url": new_block_url,
            "new_assembled_url": new_assembled_url,
            "cost_rmb": regen.cost_rmb,
            "ts": cache_bust,
        })

        return jsonify({
            "ok": True,
            "block_index": block_index,
            "new_block_url": new_block_url,
            "new_assembled_url": new_assembled_url,
            "cost_rmb": regen.cost_rmb,
        }), 200
    finally:
        lock.release()


@app.route("/api/batch/<batch_id>/start", methods=["POST"])
@login_required
def batch_start_real(batch_id):
    """触发批次的真实处理流水线（DeepSeek + rembg；4b 接 Playwright）。

    从 DB 拉 status=pending 的产品，扔进批量池，进度回写 batch_items。
    DeepSeek Key 从批次发起者（batch.user_id）账号设置里解密后注入处理器。
    """
    batch = Batch.query.filter_by(batch_id=batch_id).first()
    if not batch:
        return jsonify({"error": f"批次不存在: {batch_id}"}), 404

    # ── 鉴权：必须由发起人触发（防止 A 用户用 B 的 Key 烧 quota）──
    if batch.user_id is None:
        return jsonify({
            "error": "该批次没有归属用户（可能是历史遗留数据），请重新上传",
        }), 400
    if batch.user_id != current_user.id:
        return jsonify({"error": "只有批次的上传者可以启动该批次"}), 403

    # ── 用 platform 托管的 DeepSeek Key (P3 砍刀流后所有用户共享 env key) ─────
    owner = db.session.get(User, batch.user_id)
    if owner is None:
        return jsonify({"error": "找不到批次上传者账号"}), 400
    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        return jsonify({
            "error": "服务暂不可用 (缺 DEEPSEEK_API_KEY 平台密钥, 请联系运维)",
        }), 500

    pending_items = BatchItem.query.filter_by(
        batch_pk=batch.id, status="pending"
    ).all()
    if not pending_items:
        return jsonify({
            "error": "没有待处理的产品（pending 队列为空）",
            "batch_status": batch.status,
        }), 400

    # 任务9 (PRD F11): 把批次的模板策略一起带给 processor
    products = []
    for it in pending_items:
        try:
            details = _json_mod.loads(it.detail_image_paths or "[]")
        except _json_mod.JSONDecodeError:
            details = []
        products.append({
            "name": it.name,
            "main_image_path": it.main_image_path,
            "detail_image_paths": details,
            "desc_text": it.desc_text or "",
            "desc_chars": it.desc_chars or 0,
            "template_strategy": batch.template_strategy or "auto",
            "fixed_theme_id": batch.fixed_theme_id,
            "product_category": batch.product_category or "设备类",
        })

    # 用闭包绑定 api_key，让 processor_fn 仍是 (scope_id, payload) 两参签名
    def _processor_with_key(scope_id, payload, _key=api_key):
        return batch_processor_mod.process_one_product(
            scope_id, payload, api_key=_key
        )

    # ── 原子 claim (跨 worker 互斥启动) ─────────────────────────────
    # 条件 UPDATE: 只能从 uploaded/failed 转到 queued; 其它状态 (queued/running/completed)
    # 都会让 UPDATE 返回 0 行, 我们据此判定"批次已在处理"直接 409.
    # 这一步天然互斥 (Postgres 行锁 / SQLite 单写), 替代原本在 submit_batch 之后
    # 再设 batch.status 的非原子做法. 多 worker 并发时, 后到者立即收到 409.
    claimed = (
        db.session.query(Batch)
        .filter(
            Batch.batch_id == batch_id,
            Batch.status.in_(["uploaded", "failed"]),
        )
        .update({"status": "queued"}, synchronize_session=False)
    )
    db.session.commit()
    if claimed == 0:
        current = Batch.query.filter_by(batch_id=batch_id).first()
        return jsonify({
            "error": "批次已在处理中或状态不允许启动",
            "current_status": current.status if current else None,
        }), 409

    try:
        batch_queue_mod.submit_batch(
            batch_id=batch_id,
            batch_name=batch.name,
            products=products,
            processor_fn=_processor_with_key,
            on_state_change=_batch_db_sync_callback,
        )
    except ValueError as e:
        # in-memory 冲突 (同 worker 内重入): DB claim 赢了但池里已有 → 回滚 claim
        (
            db.session.query(Batch)
            .filter(
                Batch.batch_id == batch_id,
                Batch.status == "queued",
            )
            .update({"status": "failed"}, synchronize_session=False)
        )
        db.session.commit()
        return jsonify({"error": str(e)}), 409

    # batch.status 已由原子 claim 设置为 queued, 不再需要重复 commit

    return jsonify({
        "ok": True,
        "batch_id": batch_id,
        "submitted": len(products),
        "batch_status": batch.status,
        "message": ("已提交真实处理流水线；GET /api/batch/<id>/status 看内存进度，"
                    "GET /api/batches/<id> 看 DB 持久化结果"),
    })


@app.route("/api/single/_mock-task", methods=["POST"])
@login_required
@csrf.exempt  # dev-only: 同 batch_start_mock, 生产 guard 已加
def single_mock_task():
    """喂 N 个 mock 任务到单品池（验证池隔离）。

    Query: count=<int>, default 1
    """
    if os.environ.get("FLASK_ENV", "").lower() == "production":
        return jsonify({"error": "mock 端点在生产环境已禁用"}), 403
    try:
        count = int(request.args.get("count", "1"))
    except ValueError:
        return jsonify({"error": "count 必须是整数"}), 400
    if count < 1 or count > 20:
        return jsonify({"error": "count 必须在 1-20 之间"}), 400

    task_ids = []
    for i in range(count):
        tid = f"single_{int(_dt.utcnow().timestamp() * 1000)}_{i}"
        batch_queue_mod.submit_single(
            task_id=tid,
            payload={"name": f"mock_single_{i}"},
            processor_fn=batch_queue_mod.mock_processor,
            user_id=current_user.id,  # P4 §A.6: owner 标记防 IDOR
        )
        task_ids.append(tid)
    return jsonify({"ok": True, "submitted": count, "task_ids": task_ids})


@app.route("/api/single/<task_id>/status", methods=["GET"])
@login_required
def single_task_status(task_id):
    """P4 §A.6 owner 校验防 IDOR: state.user_id 必须等于 current_user.id (或 admin)."""
    state = batch_queue_mod.get_single_status(task_id)
    if state is None:
        return jsonify({"error": f"任务未找到: {task_id}"}), 404
    owner_id = state.get("user_id")
    if owner_id != current_user.id and not current_user.is_admin:
        abort(403)
    return jsonify(state)


# ── 阶段四·Step A: 批次资源代理 (修图片 404) ───────────────────────────────
# DB 里 main_image_path 存的是 /uploads/batches/<batch_id>/... 但 Flask 默认
# 只服务 /static/*, 所以浏览器全 404. 用 send_from_directory 加一个代理端点,
# 必须 @login_required + owner 校验 (防止 A 拿 B 的批次).
def _check_batch_owner(batch_id: str) -> Batch:
    """显式传 batch_id 做 owner 校验,不隐式解析 URL.

    返回 Batch 实例; 不存在 → abort 404; 不是 owner → abort 403.
    调用方拿到 Batch 就可以放心继续, 校验不通过根本不会 return.
    """
    b = Batch.query.filter_by(batch_id=batch_id).first()
    if b is None:
        abort(404)
    if b.user_id is None or b.user_id != current_user.id:
        abort(403)
    return b


@app.route("/uploads/batches/<batch_id>/<path:subpath>", methods=["GET"])
@login_required
def serve_batch_upload(batch_id: str, subpath: str):
    """代理批次目录下的图片/JSON (主图 / preview.png / ai_refined.jpg / parsed.json).

    - batch_id 作为真 Flask 路由参数, owner 校验走 _check_batch_owner — 零隐式 parse.
    - send_from_directory 内置 safe_join, 自动防 ../ 路径穿越.
    - 大文件 (HTML/AI 长图) 走 send_from_directory 的默认 streaming — 不会一次性读内存.
    - 中文文件名: Flask 的 <path:> 已 unquote, pathlib 在 Windows 也 OK.
    """
    _check_batch_owner(batch_id)
    batch_root = UPLOAD_DIR / "batches" / batch_id
    if not batch_root.is_dir():
        abort(404)
    # conditional=True → 自动处理 If-Modified-Since/ETag,缩略图多次加载直接 304
    return send_from_directory(batch_root, subpath, conditional=True)


# ── 阶段四·Step B: 单文件下载端点 (HTML 版 / AI 精修版) ───────────────────
# 前端每行一个"下载"按钮 → GET /api/batch/<bid>/download?name=XXX&kind=html|ai
# 和 serve_batch_upload 不同点: 强制 as_attachment + 用"<产品名>_HTML版.png"
# 做下载文件名 (而不是裸 preview.png) — 用户一眼知道哪个产品哪个版本.
# kind=html → preview.png (任务4 落盘); kind=ai → ai_refined.jpg (任务11 落盘).
_KIND_TO_FILE = {
    "html": ("preview.png",    "HTML版.png"),  # (磁盘实际文件, 下载后缀)
    "ai":   ("ai_refined.jpg", "AI精修版.jpg"),
}


def _resolve_product_dir_from_result(item, batch_id: str):
    """Bug A3: 从 item.result JSON 里任意 URL 反推磁盘 product_dir.
    同一 item 所有产物同目录, 取首个非空 URL 的 parent 即可;
    全空时兜底硬拼 (调用方会再 is_dir/is_file 校验)."""
    try:
        result = _json_mod.loads(item.result or "{}")
    except _json_mod.JSONDecodeError:
        result = {}
    if not isinstance(result, dict):
        result = {}
    for key in ("preview_png", "ai_refined_path", "parsed_path", "cutout_path"):
        url = result.get(key)
        if not url:
            continue
        rel = str(url).lstrip("/")
        if rel.startswith("uploads/"):
            rel = "static/" + rel
        return (BASE_DIR / rel).parent
    return UPLOAD_DIR / "batches" / batch_id / item.name


@app.route("/api/batch/<batch_id>/download", methods=["GET"])
@login_required
def batch_download_one(batch_id: str):
    """下载单个产品的单个版本 (HTML 或 AI 精修).

    Query:
        name: 产品名 (= BatchItem.name, 也是磁盘目录名)
        kind: html | ai

    Response:
        200 + attachment (Content-Disposition: attachment)
        400: 参数不对 (kind 非法 / name 缺)
        403/404: owner 校验 (沿用 _check_batch_owner)
        404: BatchItem 不存在 / 文件还没生成 (HTML 没跑完 / AI 没精修过)

    为什么要 DB 校验 + 磁盘校验两层?
      - DB 校验防止"URL 猜产品名"拿到任意批次里不存在的产品 (降噪 404 的 trace)
      - 磁盘校验防止"DB 有但 worker 挂了"的半成品 → 明确 404 原因
    """
    b = _check_batch_owner(batch_id)

    name = (request.args.get("name") or "").strip()
    kind = (request.args.get("kind") or "").strip().lower()
    if not name:
        return jsonify({"error": "缺 name 参数"}), 400
    if kind not in _KIND_TO_FILE:
        return jsonify({"error": f"kind 必须是 html/ai, 实际 {kind!r}"}), 400

    # DB 二次校验: 该产品确实属于该批次 (不是用 URL 随便猜的名字)
    item = BatchItem.query.filter_by(batch_pk=b.id, name=name).first()
    if item is None:
        return jsonify({"error": f"产品 {name!r} 不在该批次"}), 404

    # AI 精修版要求 ai_refine_status == 'done' (防止下载半成品)
    if kind == "ai" and item.ai_refine_status != "done":
        return jsonify({
            "error": f"产品 {name!r} 的 AI 精修还未完成 "
                     f"(当前状态 {item.ai_refine_status!r})",
            "ai_refine_status": item.ai_refine_status,
        }), 404

    disk_name, pretty_suffix = _KIND_TO_FILE[kind]
    # 2026-04-22 Bug A3: 用 helper 从 item.result 读真实 product_dir (含 zip 子目录)
    product_dir = _resolve_product_dir_from_result(item, batch_id)
    file_abs = product_dir / disk_name
    if not file_abs.is_file():
        return jsonify({
            "error": f"{kind} 版本文件不存在: {disk_name}",
            "hint": "可能 worker 还没跑完 / 跑失败了",
        }), 404

    download_name = f"{name}_{pretty_suffix}"  # 中文名 Flask 会自动 RFC 5987 编码
    return send_from_directory(
        product_dir, disk_name,
        as_attachment=True,
        download_name=download_name,
        conditional=True,  # 大文件支持 Range / If-Modified-Since
    )


# ── 阶段四·Step D: 打包下载整批 zip ──────────────────────────────────────
# GET /api/batch/<bid>/download-all → ZIP 流
# 结构:
#   <batch_id>/
#     <产品名1>/
#       preview.png        (HTML 版, 如果 status=done)
#       ai_refined.jpg     (AI 精修版, 如果 ai_refine_status=done)
#     <产品名2>/
#       ...
# 设计要点:
#   1. 内存 BytesIO — 50 产品 × ~2MB = ~100MB, 单机内存 OK;
#      streaming zip 需 zipstream-ng (未装), 增加复杂度没必要
#   2. 只打包"真有价值"的文件 (preview.png + ai_refined.jpg),
#      不放 parsed.json / product.jpg / preview.html (原料, 用户不需要)
#   3. Chinese 文件名: Python 3 zipfile auto-sets UTF-8 flag 当 arcname 含非 ASCII
#   4. 如果整批连一张图都没落盘 → 404 (不返回空 zip, 避免用户下载空白文件困惑)
#   5. Range 请求不支持 (BytesIO zip 一次性生成, 没意义) — 够小的 zip 直接下载完事
@app.route("/api/batch/<batch_id>/download-all", methods=["GET"])
@login_required
def batch_download_all(batch_id: str):
    """打包下载整批 HTML 版 + AI 精修版产品图, 按 {bid}/{产品名}/ 结构组织."""
    import io, zipfile
    b = _check_batch_owner(batch_id)

    batch_root = UPLOAD_DIR / "batches" / batch_id
    if not batch_root.is_dir():
        return jsonify({"error": "批次目录不存在"}), 404

    items = BatchItem.query.filter_by(batch_pk=b.id).order_by(BatchItem.id.asc()).all()
    if not items:
        return jsonify({"error": "批次下没有产品"}), 404

    buf = io.BytesIO()
    included_count = 0
    skipped: list[str] = []

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for item in items:
            # 2026-04-22 Bug A3: 从 item.result 读真实路径 (含 zip 顶层子目录, 例"测试/")
            product_dir = _resolve_product_dir_from_result(item, batch_id)
            if not product_dir.is_dir():
                skipped.append(f"{item.name} (目录缺失)"); continue
            row_any = False
            # HTML 版 (preview.png) — status 必须 done
            if item.status == "done":
                png = product_dir / "preview.png"
                if png.is_file():
                    zf.write(str(png), arcname=f"{batch_id}/{item.name}/preview.png")
                    row_any = True
            # AI 精修版 (ai_refined.jpg) — ai_refine_status 必须 done
            if item.ai_refine_status == "done":
                jpg = product_dir / "ai_refined.jpg"
                if jpg.is_file():
                    zf.write(str(jpg), arcname=f"{batch_id}/{item.name}/ai_refined.jpg")
                    row_any = True
            if row_any:
                included_count += 1
            else:
                skipped.append(f"{item.name} (无可打包文件)")

    if included_count == 0:
        # 避免下空 zip — 给用户明确原因
        return jsonify({
            "error": "整批没有任何可打包的文件",
            "hint": "等产品生成完成 / AI 精修完成后再试",
            "total": len(items),
            "skipped": skipped[:20],  # 最多列 20 个, 防止 response 过大
        }), 404

    buf.seek(0)
    safe_bname = (b.name or b.batch_id).replace("/", "_").replace("\\", "_")
    download_name = f"{safe_bname}_{batch_id}.zip"
    print(f"[batch_download_all] {batch_id}: {included_count}/{len(items)} 产品打包, "
          f"zip size = {len(buf.getvalue())} bytes", flush=True)
    return send_file(
        buf, mimetype="application/zip",
        as_attachment=True, download_name=download_name,
    )


# ── 任务11 (PRD F6/F11): 精修候选白名单筛选 ────────────────────────────────
# 双保险:即使前端勾错/并发重复提交,这里也不让脏数据进池。
# 筛选条件 (全部满足才入队):
#   1. want_ai_refine = True        (用户勾选)
#   2. status = 'done'               (有 HTML 底图可精修)
#   3. main_image_path 非空          (精修流水线需要产品图)
#   4. ai_refine_status != 'processing'  (只拦并发重跑; done 允许重跑以支持换风格)
# 任务10 的 estimate 端点和 任务11 的 start 端点都消费同一个函数 — 一处真相。
def _select_refine_candidates(batch):
    """返回 (candidates, skipped, already_done_count):
        candidates: list[BatchItem] — 可精修 (含 ai_refine_status='done' 的重跑候选)
        skipped:    list[{name, reason}] — 勾选但不合格
        already_done_count: int — candidates 中之前已精修过 (ai_refine_status='done') 的个数
                            前端要据此展示"⚠ N 个会被覆盖重扣费"警告
    """
    candidates: list = []
    skipped: list[dict] = []
    already_done_count = 0
    items = BatchItem.query.filter_by(
        batch_pk=batch.id, want_ai_refine=True,
    ).order_by(BatchItem.id.asc()).all()
    for it in items:
        reason = None
        if it.status != "done":
            reason = f"状态={it.status},非 done 无底图"
        elif not (it.main_image_path or "").strip():
            reason = "缺主图路径"
        elif (it.ai_refine_status or "") == "processing":
            reason = "精修正在跑,防并发重复入队"
        if reason:
            skipped.append({"name": it.name, "reason": reason})
        else:
            candidates.append(it)
            if (it.ai_refine_status or "") == "done":
                already_done_count += 1
    return candidates, skipped, already_done_count


@app.route("/api/batch/<batch_id>/ai-refine-estimate", methods=["GET"])
@login_required
def batch_ai_refine_estimate(batch_id):
    """任务10 (PRD F6): 返回该批次"已勾选 AI 精修且合格"产品的费用估算。

    合格定义见 _select_refine_candidates — 同一套逻辑 任务11 入队时直接复用,
    所以用户在弹窗里看到的 count 就是真实会入队的数量, 费用不虚。
    单价/屏数/吞吐 全部从 pricing_config 拿, 运维改价不动这里。
    """
    from pricing_config import compute_estimate

    batch = Batch.query.filter_by(batch_id=batch_id).first()
    if batch is None:
        return jsonify({"error": f"批次未找到: {batch_id}"}), 404
    # 2026-04-22 纵深防御: owner 校验 (GET 宽松风格, 同 L1333/L1348).
    if batch.user_id is not None and batch.user_id != current_user.id:
        return jsonify({"error": "无权访问该批次"}), 403

    candidates, skipped, already_done_count = _select_refine_candidates(batch)
    payload = compute_estimate(len(candidates))
    payload["batch_id"] = batch_id
    payload["skipped"] = skipped                       # 前端: "⚠ N 个会被跳过"
    payload["already_done_count"] = already_done_count  # 前端: "⚠ N 个已精修过,重扣费"
    return jsonify(payload)


@app.route("/api/batch/_pools/stats", methods=["GET"])
@login_required
def batch_pools_stats():
    """返回两池实时占用，验证 PRD F4：互不阻塞。"""
    return jsonify(batch_queue_mod.get_pool_stats())


@app.route("/api/batch/_pubsub/stats", methods=["GET"])
@login_required
def batch_pubsub_stats():
    """看哪些批次当前有前端在监听 (debug)。"""
    return jsonify(batch_pubsub_mod.stats())


# ── 实时进度推送 WebSocket (PRD 阶段二·任务6 / F5)──────────────────
@sock.route("/ws/batch/<batch_id>")
def batch_progress_ws(ws, batch_id):
    """前端订阅某批次的实时进度。

    握手时校验:
      - 必须已登录 (cookie 同源)
      - 必须是批次的 owner (防 A 监听 B 的批次)

    通信:
      - 连上立刻 push 一个 snapshot 事件 (含当前 pending/processing/done/failed +
        每个产品的最新 status), 这样前端不需要先 GET status
      - 之后每次 _batch_db_sync_callback 触发就 push update 事件
      - 客户端可以发任意文本作为心跳, 服务端不管内容只要不断开就行
      - 断开 → 服务端 unsubscribe 并退出 (worker 不受影响, 继续在线程池里跑)
    """
    if not current_user.is_authenticated:
        ws.send(_json_mod.dumps({"type": "error", "code": "unauthorized"}))
        return
    batch = Batch.query.filter_by(batch_id=batch_id).first()
    if not batch:
        ws.send(_json_mod.dumps({"type": "error", "code": "not_found",
                                  "batch_id": batch_id}))
        return
    if batch.user_id is not None and batch.user_id != current_user.id:
        ws.send(_json_mod.dumps({"type": "error", "code": "forbidden"}))
        return

    batch_pubsub_mod.subscribe(batch_id, ws)
    print(f"[ws] subscribe batch_id={batch_id} user={current_user.id} "
          f"(now {batch_pubsub_mod.subscriber_count(batch_id)} listener[s])",
          flush=True)

    try:
        # 1) 立刻 push 当前状态快照 (内存里的 batch_queue 状态)
        snap = batch_queue_mod.get_batch_status(batch_id)
        ws.send(_json_mod.dumps({
            "type": "snapshot",
            "batch_id": batch_id,
            "snapshot": snap,  # None = 还没启动 (没在内存里),前端拿到就知道
        }, ensure_ascii=False))

        # 2) 阻塞读, 把 ws 喂活;客户端心跳消息我们都忽略内容
        while True:
            msg = ws.receive(timeout=None)
            if msg is None:  # 客户端关闭
                break
    except Exception as e:
        print(f"[ws] {batch_id} disconnect: {type(e).__name__}: {e}",
              flush=True)
    finally:
        batch_pubsub_mod.unsubscribe(batch_id, ws)
        print(f"[ws] unsubscribe batch_id={batch_id} "
              f"(now {batch_pubsub_mod.subscriber_count(batch_id)} listener[s])",
              flush=True)


# ── 文本解析（DeepSeek API）──────────────────────────────────────────
_NO_FABRICATION_RULE = (
    "【数据准确性要求】\n"
    "1. advantages 中的每一条必须能在用户提供的文案中找到依据，没有依据不要写。\n"
    "2. 如果文案中没有明确提到APP/云平台/智能导航等功能，不要在advantages中包含这些。\n"
    "3. 【最重要】detail_params 必须完整提取文案中的每一个参数，一个都不能遗漏！\n"
    "   包括但不限于：效率、宽度、容量、功率、电机、电池、重量、尺寸、噪音、转速、\n"
    "   吸力、压力、速度、材质、充电时间、续航时间等所有出现的技术数据。\n"
    "   用户给了多少参数就提取多少，不要截断、不要省略、不要合并。\n"
    "4. floor_items（适用地面）：只根据产品实际用途判断，如果无法确定就返回空数组。\n"
    "5. vs_comparison 中的数字（替代人数、节省金额）必须有文案依据，没有依据就留空。\n"
    "   vs_rows 数组 3-5 项。每项 left（本产品）必须引用文案里的具体数字/规格\n"
    "   （如 清洗宽度 620mm / 工作效率 3600㎡/h / 续航 8h / 清水箱 60L），\n"
    "   不允许写 高效/稳定/先进 等形容词。对应的 right（人工/传统）必须是合理的具体对照数据\n"
    "   （如 手工拖把宽 40cm / 人工 300㎡/h / 保洁员连续工作 4h 需休息 / 桶装 10L 每 30 分钟更换）。\n"
    "   每对 left/right 必须是同一维度、可直接量化比较的。label 是维度名（如 清洁效率/续航/覆盖面积），不超过 4 字。\n"
    "6. story_title/story_desc：必须用文案中的真实参数数据，不能编造数字。\n"
    "7. 售后承诺、质保年限等：只有文案中明确写了才能填，没写的一律不填。\n"
    "8. 不要编造用户文案中没有提到的服务承诺（如送货上门、上门培训等）。\n\n"
)

_EXTREME_WORDS_RULE = (
    "【合规要求】文案中严禁出现以下极限词（电商平台违禁词）：\n"
    "最强、最大、最好、最高、最低、最快、最优、最先进、最专业、最安全、最耐用、最便捷、最智能、\n"
    "第一、唯一、极致、顶级、顶尖、行业领先、业界领先、全球领先、世界领先、无与伦比。\n"
    "请用具体数据或中性词替代，如【超强】【高效】【优质】【行业前列】等。\n\n"
)


def _build_category_prompt(product_type: str, raw_text: str) -> str:
    """根据产品类型构建对应的 DeepSeek 解析提示词"""

    if product_type == "配件类":
        return (
            "你是一个清洁配件营销文案专家。请根据以下产品参数，完成两件事：\n\n"
            "第一，提取所有技术参数（型号、规格、材质等）填入对应字段。\n"
            "第二，根据这些参数生成营销文案（严格基于真实数据，不得编造产品没有的功能）。\n\n"
            + _NO_FABRICATION_RULE
            + _EXTREME_WORDS_RULE +
            "返回以下JSON格式（所有字段必须返回，不要遗漏）：\n"
            "```json\n"
            "{\n"
            '  "brand": "品牌中文名",\n'
            '  "product_name": "产品全称",\n'
            '  "model": "型号/规格",\n'
            '  "product_type": "配件类型（如刷盘、吸水胶条、滤芯）",\n'
            '  "detail_params": {"参数名":"参数值", ...},\n'
            '  "dimensions": {"length":"mm值","width":"mm值","height":"mm值"},\n'
            '  "category_line": "产品品类短语（不超过10字）",\n'
            '  "main_title": "一句话核心卖点（6-12字）。突出 原厂/适配/耐用 具体，如 原厂滚刷 3 倍寿命 / 适配 12 款主流机型。禁止 稳定/高效/可靠 等虚词，禁止写品牌名/口号",\n'
            '  "hero_subtitle": "副标题（适配XX系列，原厂品质，不超过15字）",\n'
            '  "slogan": "主标语（一句话概括产品最大卖点）",\n'
            '  "sub_slogan": "副标语（补充说明）",\n'
            '  "advantages": [\n'
            '    {"emoji":"🔧","text":"原厂适配"},\n'
            '    ...\n'
            '  ],\n'
            '  "compat_models": [\n'
            '    {"model":"DZ50X","series":"清洁机器人系列"},\n'
            '    ...\n'
            '  ],\n'
            '  "install_steps": [\n'
            '    {"title":"拆卸旧件","desc":"关闭电源，取下旧配件"},\n'
            '    ...\n'
            '  ],\n'
            '  "materials": [\n'
            '    {"name":"304 不锈钢","source_type":"mineral","source_story_hint":"国内特钢厂出料"},\n'
            '    ...\n'
            '  ],\n'
            '  "package_items": [\n'
            '    {"name":"主刷","qty":"1","note":""},\n'
            '    ...\n'
            '  ],\n'
            '  "block_b2_items": [\n'
            '    {"icon_text":"🔧","label":"适配12型"},\n'
            '    ...\n'
            '  ],\n'
            '  "listing_title": "电商标题（60字以内，含品牌+型号+核心卖点+品类词）",\n'
            '  "listing_keywords": "搜索关键词（10-15个，逗号分隔）",\n'
            '  "listing_selling_points": ["卖点1（15字以内）","卖点2","卖点3","卖点4","卖点5"],\n'
            '  "listing_description": "商品描述（200字以内，适合电商详情页顶部）",\n'
            '  "spec_callouts": [{"label":"参数名","value":"参数值"},...]\n'
            "}\n"
            "```\n\n"
            "【重要提示】\n"
            "- 识别文案中提到的所有兼容机型，填入 compat_models（多列出，不要遗漏）\n"
            "- install_steps 提供清晰的安装步骤（3-6步）\n"
            "- materials 提取产品材质 + 来源类型 (source_type 4 选 1):\n"
            "    natural=天然/植物/动物 (橡胶/木材/棉麻); chemical=化学合成 (尼龙/EVA/树脂);\n"
            "    mineral=矿物/金属 (304不锈钢/铝合金/玻璃); recycled=回收再生 (再生塑料/纤维)\n"
            "  source_story_hint 一句中文 (≤30 字), 描述材料来源/产地/工艺. 严禁编造文案中没有的产地或工艺.\n"
            "- package_items 列出包装内所有配件清单\n"
            "- advantages 6-9项，每项附带贴切的emoji，严禁编造\n"
            "- block_b2_items: 必须是 N 项（N 等于 2、4 或 6），每项 {icon_text: emoji, label: \"4 字以内的核心能力\"}。\n"
            "  label 必须是从文案里提炼的具体能力（如 原厂适配 / 3倍寿命 / 适配12型），不能是通用形容词（如 高效/专业）。\n"
            "  icon_text 选 1 个与能力语义匹配的 emoji（🔩🧹🪶♻️🛡⚡🧪🌿💧💰🔧⏱✅ 等）。\n"
            "- listing_title 要包含核心搜索词，便于电商平台搜索\n"
            "- spec_callouts 从参数中提取3-6个最吸引眼球的数据，用于主图标注\n\n"
            "只返回JSON，不要其他解释文字：\n\n" + raw_text
        )

    elif product_type == "耗材类":
        return (
            "你是一个清洁耗材营销文案专家。请根据以下产品参数，完成两件事：\n\n"
            "第一，提取所有技术参数（型号、规格、成分、稀释比等）填入对应字段。\n"
            "第二，根据这些参数生成营销文案（严格基于真实数据，不得编造产品没有的功能）。\n\n"
            + _NO_FABRICATION_RULE
            + _EXTREME_WORDS_RULE +
            "返回以下JSON格式（所有字段必须返回，不要遗漏）：\n"
            "```json\n"
            "{\n"
            '  "brand": "品牌中文名",\n'
            '  "product_name": "产品全称",\n'
            '  "model": "型号/规格",\n'
            '  "product_type": "耗材类型（如清洁剂、除垢液）",\n'
            '  "detail_params": {"参数名":"参数值", ...},\n'
            '  "dimensions": {"length":"mm值","width":"mm值","height":"mm值"},\n'
            '  "category_line": "产品品类短语（不超过10字）",\n'
            '  "main_title": "一句话核心卖点（6-12字）。突出 浓度/成本/环保 具体数字，如 1:50 稀释 每次 0.3元 / 食品级可降解无残留。禁止 稳定/高效/可靠 等虚词，禁止写品牌名/口号",\n'
            '  "hero_subtitle": "副标题（不超过15字）",\n'
            '  "slogan": "主标语（突出稀释比或覆盖面积）",\n'
            '  "sub_slogan": "副标语（补充说明）",\n'
            '  "advantages": [\n'
            '    {"emoji":"🧪","text":"专业配方"},\n'
            '    ...\n'
            '  ],\n'
            '  "usage_steps": [\n'
            '    {"title":"稀释","desc":"按1:200比例加水稀释"},\n'
            '    ...\n'
            '  ],\n'
            '  "kpis": [\n'
            '    {"label":"稀释比","value":"1:200","unit":"","note":""},\n'
            '    ...\n'
            '  ],\n'
            '  "before_after": [\n'
            '    {"before_label":"使用前","after_label":"使用后","desc":"顽固油污一喷即净"}\n'
            '  ],\n'
            '  "compat_models": ["XL-510", "DZ50X", "或不限品牌"],\n'
            '  "materials": [\n'
            '    {"name":"植物提取物","source_type":"natural","source_story_hint":"东南亚有机种植"},\n'
            '    ...\n'
            '  ],\n'
            '  "block_b2_items": [\n'
            '    {"icon_text":"🧪","label":"1:50稀释"},\n'
            '    ...\n'
            '  ],\n'
            '  "listing_title": "电商标题（60字以内，含品牌+型号+核心卖点+品类词）",\n'
            '  "listing_keywords": "搜索关键词（10-15个，逗号分隔）",\n'
            '  "listing_selling_points": ["卖点1（15字以内）","卖点2","卖点3","卖点4","卖点5"],\n'
            '  "listing_description": "商品描述（200字以内，适合电商详情页顶部）",\n'
            '  "spec_callouts": [{"label":"参数名","value":"参数值"},...]\n'
            "}\n"
            "```\n\n"
            "【重要提示】\n"
            "- 强调安全性（是否食品级、是否需要防护）\n"
            "- kpis 列出稀释比、覆盖面积、每升成本等关键指标\n"
            "- usage_steps 提供清晰的使用步骤（3-5步）\n"
            "- before_after 描述使用前后的清洁效果对比\n"
            "- compat_models 列出该耗材适配的机型/型号 (3-8 个); 如果是通用配方不限品牌, 填 [\"通用\", \"不限品牌\"]; 严禁编造未在文案出现的型号\n"
            "- materials 提取产品成分 + 来源类型 (source_type 4 选 1):\n"
            "    natural=天然 (植物提取/动物源/天然橡胶); chemical=化学合成 (酶/表面活性剂/醇);\n"
            "    mineral=矿物 (纯碱/盐酸/磷酸); recycled=回收再生\n"
            "  source_story_hint 一句中文 (≤30 字), 描述成分来源/产地/工艺. 严禁编造未在文案出现的产地或工艺.\n"
            "- advantages 6-9项，每项附带贴切的emoji，严禁编造\n"
            "- block_b2_items: 必须是 N 项（N 等于 2、4 或 6），每项 {icon_text: emoji, label: \"4 字以内的核心能力\"}。\n"
            "  label 必须是从文案里提炼的具体能力（如 0磷无害 / 1:50稀释 / 食品级），不能是通用形容词（如 高效/专业）。\n"
            "  icon_text 选 1 个与能力语义匹配的 emoji（🔩🧹🪶♻️🛡⚡🧪🌿💧💰🔧⏱✅ 等）。\n"
            "- listing_title 要包含核心搜索词，便于电商平台搜索\n"
            "- spec_callouts 从参数中提取3-6个最吸引眼球的数据，用于主图标注\n\n"
            "只返回JSON，不要其他解释文字：\n\n" + raw_text
        )

    elif product_type == "工具类":
        return (
            "你是一个清洁工具营销文案专家。请根据以下产品参数，完成两件事：\n\n"
            "第一，提取所有技术参数（型号、材质、规格等）填入对应字段。\n"
            "第二，根据这些参数生成营销文案（严格基于真实数据，不得编造产品没有的功能）。\n\n"
            + _NO_FABRICATION_RULE
            + _EXTREME_WORDS_RULE +
            "返回以下JSON格式（所有字段必须返回，不要遗漏）：\n"
            "```json\n"
            "{\n"
            '  "brand": "品牌中文名",\n'
            '  "product_name": "产品全称",\n'
            '  "model": "型号/规格",\n'
            '  "product_type": "工具类型（如拖把、刮水器）",\n'
            '  "detail_params": {"参数名":"参数值", ...},\n'
            '  "dimensions": {"length":"mm值","width":"mm值","height":"mm值"},\n'
            '  "category_line": "产品品类短语（不超过10字）",\n'
            '  "main_title": "一句话核心卖点（6-12字）。突出 耐用/轻便/高效/适配广 四选一具体特征，如 304 不锈钢 10年耐用 / 超轻 300g 不累手。禁止 稳定/高效/可靠 等虚词，禁止写品牌名/口号",\n'
            '  "hero_subtitle": "副标题（不超过15字）",\n'
            '  "slogan": "主标语（突出材质或耐用性）",\n'
            '  "sub_slogan": "副标语（补充说明）",\n'
            '  "advantages": [\n'
            '    {"emoji":"🔩","text":"坚固耐用"},\n'
            '    ...\n'
            '  ],\n'
            '  "scenes": [\n'
            '    {"name":"商场","desc":"大面积地面清洁"},\n'
            '    ...\n'
            '  ],\n'
            '  "package_items": [\n'
            '    {"name":"拖把杆","qty":"1","note":""},\n'
            '    ...\n'
            '  ],\n'
            '  "before_after": [\n'
            '    {"before_label":"使用前","after_label":"使用后","desc":"效果说明"}\n'
            '  ],\n'
            '  "block_b2_items": [\n'
            '    {"icon_text":"🔩","label":"10年耐用"},\n'
            '    ...\n'
            '  ],\n'
            '  "listing_title": "电商标题（60字以内，含品牌+型号+核心卖点+品类词）",\n'
            '  "listing_keywords": "搜索关键词（10-15个，逗号分隔）",\n'
            '  "listing_selling_points": ["卖点1（15字以内）","卖点2","卖点3","卖点4","卖点5"],\n'
            '  "listing_description": "商品描述（200字以内，适合电商详情页顶部）",\n'
            '  "spec_callouts": [{"label":"参数名","value":"参数值"},...]\n'
            "}\n"
            "```\n\n"
            "【重要提示】\n"
            "- 强调材质品质和耐用寿命\n"
            "- scenes 列出适用场景（3-6个），如商场、医院、学校、工厂等\n"
            "- package_items 列出包装内所有配件清单\n"
            "- before_after 描述使用前后的清洁效果对比\n"
            "- advantages 6-9项，每项附带贴切的emoji，严禁编造\n"
            "- block_b2_items: 必须是 N 项（N 等于 2、4 或 6），每项 {icon_text: emoji, label: \"4 字以内的核心能力\"}。\n"
            "  label 必须是从文案里提炼的具体能力（如 10年耐用 / 超轻300g / 适配广），不能是通用形容词（如 高效/专业）。\n"
            "  icon_text 选 1 个与能力语义匹配的 emoji（🔩🧹🪶♻️🛡⚡🧪🌿💧💰🔧⏱✅ 等）。\n"
            "- listing_title 要包含核心搜索词，便于电商平台搜索\n"
            "- spec_callouts 从参数中提取3-6个最吸引眼球的数据，用于主图标注\n\n"
            "只返回JSON，不要其他解释文字：\n\n" + raw_text
        )

    else:
        # 设备类（默认）
        return (
            "你是一个清洁设备营销文案专家。请根据以下产品参数，完成两件事：\n\n"
            "第一，提取所有技术参数（型号、尺寸、功率等）填入对应字段。\n"
            "第二，根据这些参数生成营销文案（严格基于真实数据，不得编造产品没有的功能）。\n\n"
            + _NO_FABRICATION_RULE
            + _EXTREME_WORDS_RULE +
            "返回以下JSON格式（所有字段必须返回，不要遗漏）：\n"
            "```json\n"
            "{\n"
            '  "brand": "品牌中文名",\n'
            '  "brand_en": "品牌英文名",\n'
            '  "product_name": "产品全称",\n'
            '  "model": "型号",\n'
            '  "product_type": "设备中文类型（如驾驶式扫地车）",\n'
            '  "detail_params": {"参数名":"参数值", ...},\n'
            '  // ⚠️ detail_params 必须提取文案中出现的【每一个】技术参数，不限数量，不能遗漏任何一个！\n'
            '  "dimensions": {"length":"mm值","width":"mm值","height":"mm值"},\n'
            '  "category_line": "产品品类短语（如 驾驶式洗地机 / 商用清洁机器人，不超过10字）",\n'
            '  "main_title": "一句话核心卖点（6-12字）。必须是量化能力或独特差异，如 3600㎡/h 高效清洁 / 8小时连续续航 / 自动回充充水。禁止写产品名/型号/品牌名（如禁止 DZ50X / 驾驶式洗地机 这种），禁止 稳定/高效/可靠 等虚词",\n'
            '  "hero_subtitle": "首屏副标题（描述适用场景+核心能力，如 大型商场高效清洁专家，不超过15字）",\n'
            '  "floor_items": [{"icon_text":"单字","label":"地面材质名"},...] （根据产品适用场景列出4-8种适用地面材质，如大理石、环氧地坪、瓷砖、水磨石、PVC地板等，没有相关信息则返回空数组）,\n'
            '  "slogan": "主标语（一句话概括产品最大卖点，用真实数据）",\n'
            '  "sub_slogan": "副标语（补充说明）",\n'
            '  "advantages": [\n'
            '    {"emoji":"🧹","text":"超宽清扫","desc":"660mm大直径主刷，单次覆盖更大面积"},\n'
            '    {"emoji":"⚡","text":"持久续航","desc":"90L大容量锂电池，连续工作4小时以上"},\n'
            '    ...\n'
            '  ],\n'
            '  "story_title_1": "清洁故事大标题1（突出核心清洁机构，如 660mm大直径主刷+4边刷设计）",\n'
            '  "story_title_2": "清洁故事大标题2（效果声明，如 高效清扫14600m²/h大面积场所。）",\n'
            '  "story_desc_1": "图片说明行1（关键参数短语，如 主刷660mm、4组边刷500mm、清扫宽度1800mm）",\n'
            '  "story_desc_2": "图片说明行2（总结短句，如 宽幅清扫，一步到位）",\n'
            '  "story_bottom_1": "底部卖点1（最亮眼的数字宣称，如 14600m²/h超大清扫效率，没有突出数据就留空字符串）",\n'
            '  "story_bottom_2": "底部卖点2（效果短句，如 大场所清扫首选）",\n'
            '  "vs_comparison": {\n'
            '    // ⚠️ 语义固定:「本产品 vs 人工」二分对比。product_* = 本产品(右侧红字/赢家),labor_* = 人工(左侧灰色)。\n'
            '    //    不要把产品类型词(如 "智能洗扫机器人") 和 "本产品" 这类词同时用,它们是同一方,会造成滑稽重复。\n'
            '    //    如果文案完全没有可量化对比数据,把整个 vs_comparison 留空 {} ,不要硬造。\n'
            '    "title_line1": "主标前缀短语,如 1台顶",\n'
            '    "title_line1_red": "主标数字突出(品牌红色),如 8-10(来自文案估算,无依据留空)",\n'
            '    "title_line1_end": "主标后缀,如 人(无则空串)",\n'
            '    "title_line2": "副标前半,如 机洗与人工",\n'
            '    "title_line2_red": "副标红字部分,如 的区别",\n'
            '    "product_label": "本产品短称,≤6字(如 智能机洗 / 驾驶机洗)。禁止写具体型号/品牌",\n'
            '    "product_sublabel": "本产品优势总结,6-10字(如 高效省心 / 一键智能)",\n'
            '    "product_icon": "单个 emoji,语义匹配产品(如 🤖 / ⚡ / 🧹)",\n'
            '    "labor_label": "对比方短称,固定用 人工 或 传统人力",\n'
            '    "labor_sublabel": "人工劣势总结,6-10字(如 疲劳效率低 / 人力成本高)",\n'
            '    "labor_icon": "单个 emoji,固定 👷 或 👤",\n'
            '    "vs_rows": [\n'
            '      {"label":"效率","product_value":"3600㎡/h","product_desc":"驾驶式机洗","labor_value":"300㎡/h","labor_desc":"人工手推"},\n'
            '      {"label":"续航","product_value":"8h 连续","product_desc":"锂电长续航","labor_value":"4h 需休息","labor_desc":"人工体力限制"},\n'
            '      {"label":"水箱","product_value":"60L","product_desc":"一箱作业 2h","labor_value":"10L","labor_desc":"30 分钟换水"}\n'
            '    ],\n'
            '    // ⚠️ vs_rows 3-5 项。每项 label 是维度名 ≤4 字(如 效率/续航/水箱)。\n'
            '    //    product_value 必须引用文案里的具体数字/规格(如 3600㎡/h、620mm、8h、60L);\n'
            '    //    labor_value 必须是同一维度下的人工对照数据(如 300㎡/h / 40cm / 4h / 10L)。\n'
            '    //    product_desc / labor_desc 是可选短说明 ≤8 字(如 "锂电长续航" / "30 分钟换水")。\n'
            '    //    禁止 高效/稳定/先进 等形容词,禁止单方填数字而另一方填虚词。\n'
            '    "summary_points": [\n'
            '      {"num":"12x","label":"效率倍数"},\n'
            '      {"num":"省 26W+","label":"年省成本"},\n'
            '      {"num":"1 顶 8","label":"人力替代"}\n'
            '    ]\n'
            '    // summary_points 2-3 项,VS 屏底部红色方块内容。num 是最亮眼的短数字/倍数(≤6字),label 是它的含义(≤5字)。\n'
            '    // 必须是文案里能推得出的结论,没有就返回 [](不要硬造"1顶多"这种)。\n'
            '  },\n'
            '  "tech_items": [\n'
            '    {"title":"技术/部件名称（如 感应电机）","desc":"一句话技术说明（如 高效稳定，适配长时间作业）"}\n'
            '  ],\n'
            '  // ⚠️ tech_items: 从文案提取4-8项核心技术特征/部件/卖点详解，每项必须有原文依据。没有则返回空数组\n'
            '  "brand_stats": [\n'
            '    {"value":"数值（如 200+）","label":"指标名（如 服务城市）"}\n'
            '  ],\n'
            '  // brand_stats: 提取品牌数字指标（如城市数、客户数、行业年限），没有则返回空数组\n'
            '  "brand_story_lines": [\n'
            '    {"year":"年份","text":"里程碑事件"}\n'
            '  ],\n'
            '  // brand_story_lines: 提取品牌历史里程碑，没有则返回空数组\n'
            '  "scenes": [{"name":"场景名","desc":"一句话描述"}],\n'
            '  // scenes: 从文案提取适用场景（如商场、医院、工厂），没有则返回空数组\n'
            '  "kpis": [\n'
            '    {"label":"清扫效率","value":"3600","unit":"㎡/h","note":""},\n'
            '    {"label":"清扫宽度","value":"1800","unit":"mm","note":""},\n'
            '    {"label":"续航时间","value":"3.5","unit":"小时","note":""},\n'
            '    {"label":"运行噪音","value":"≤65","unit":"dB","note":""},\n'
            '    {"label":"水箱容量","value":"90","unit":"L","note":""},\n'
            '    {"label":"爬坡能力","value":"8","unit":"°","note":""}\n'
            '  ],\n'
            '  // kpis: 尽量提取 4-6 项核心性能指标；每项必须有 label + value，缺 value 不要塞进来\n'
            '  // 常见指标：清扫效率/清扫宽度/续航时间/噪音/水箱容量/电池容量/充电时间/爬坡能力/转弯半径/自重/清扫覆盖率\n'
            '  // 数字与单位必须拆开：例 "1368㎡/h" 拆为 value=1368 unit=㎡/h；"3.5小时续航" 拆为 label=续航时间 value=3.5 unit=小时\n'
            '  // 文案里有几项可拆出来就提几项，不足 3 项说明提取不充分，请重新审视文案\n'
            '  "faqs": [\n'
            '    {"question":"买家常见问题","answer":"基于文案数据的简洁回答（30字以内）"}\n'
            '  ],\n'
            '  // faqs: 根据已提取参数生成3-5个常见问题，answer必须引用文案真实数据，不可编造。无依据则返回空数组\n'
            '  "service_compare": {\n'
            '    "compare_rows": [\n'
            '      {"label":"对比维度（如 质保时长）","left":"官方优势（如 整机2年）","right":"普通商家（如 无保障）"}\n'
            '    ]\n'
            '  },\n'
            '  // service_compare: 生成3-5行官方vs普通商家服务对比，没有售后信息则返回空对象{}\n'
            '  "cert_badges": [\n'
            '    {"title":"认证名称（如 CE认证）","desc":"简短说明"}\n'
            '  ],\n'
            '  // cert_badges: 从文案提取资质认证（如CE/FCC/IEC/ISO），没有则返回空数组\n'
            '  "listing_title": "电商标题（60字以内，含品牌+型号+核心卖点+品类词，如：XX品牌DZ50X商用驾驶式洗地机 大型商场工厂用全自动清洗机器人）",\n'
            '  "listing_keywords": "搜索关键词（10-15个，逗号分隔，如：洗地机,驾驶式洗地机,商用清洁机器人,...）",\n'
            '  "listing_selling_points": ["卖点1（15字以内）","卖点2","卖点3","卖点4","卖点5"],\n'
            '  "listing_description": "商品描述（200字以内，适合电商详情页顶部，突出核心参数和应用场景）",\n'
            '  "spec_callouts": [{"label":"清扫宽度","value":"1800mm"},{"label":"续航","value":"6小时"},...]  \n'
            "}\n"
            "```\n\n"
            "【advantages规则】\n"
            "- 严格从用户提供的产品文案中提取，每一条必须有原文依据\n"
            "- 如果文案只提到了3个卖点，就只返回3个，不要凑数\n"
            "- 绝对不要添加文案中没有的功能（如：文案没提APP就不能写智慧管理）\n"
            "- text: 2-6个字的卖点短语，附带一个贴切的emoji\n"
            "- desc: 10-20字的补充说明，必须引用文案中的真实参数/数据，让卖点有据可查\n"
            "- desc示例：text='超宽清扫'→desc='1800mm清扫宽度，大面积一次覆盖'\n\n"
            "【tech_items 与 advantages 的区别】\n"
            "- advantages 是用户感知的卖点短语（如\"超宽清扫\"），2-6字text+10-20字desc补充说明\n"
            "- tech_items 是技术实现细节（如\"感应电机\"），含标题+一句话技术说明\n"
            "- 两者可能描述同一特性的不同角度，这是正常的\n\n"
            "【扩展字段规则】\n"
            "- tech_items/scenes/kpis/cert_badges: 严格从文案提取，文案没提到就返回空数组\n"
            "- faqs: 可基于已提取的参数和卖点合理推导，但answer只能引用文案中的真实参数\n"
            "- brand_stats/brand_story_lines: 仅当文案包含品牌信息时提取，否则返回空数组\n"
            "- service_compare: 可基于产品特性合理推导官方优势，没有售后信息则返回空对象{}\n"
            "- 以上Tier 1字段（tech_items/brand_stats/brand_story_lines/scenes/kpis/cert_badges）必须返回，即使为空数组\n"
            "- Tier 2字段（faqs/service_compare）为补充字段，token不足时可省略\n\n"
            "【detail_params规则 — 最高优先级】\n"
            "- 用户文案中出现的每一个技术参数都必须提取到detail_params中\n"
            "- 不要截断、不要省略、不要合并，有多少写多少\n"
            "- 参数名使用文案中的原始名称，不要改写\n\n"
            "【电商文案规则】\n"
            "- listing_title 要包含核心搜索词，便于电商平台搜索\n"
            "- listing_selling_points 每条15字以内，突出差异化\n"
            "- spec_callouts 从参数中提取3-6个最吸引眼球的数据，用于主图标注\n\n"
            "只返回JSON，不要其他解释文字：\n\n" + raw_text
        )


def _call_deepseek_parse(raw_text: str, product_type: str = "设备类", api_key: str = "") -> dict:
    """调用 DeepSeek API，一次完成：解析产品参数 + 生成营销文案"""
    import requests as req
    use_key = api_key or DEEPSEEK_API_KEY
    if not use_key:
        raise ValueError("未配置 API Key，无法调用 AI 服务")
    prompt = _build_category_prompt(product_type, raw_text)
    print(f"[DeepSeek] 发送请求，文本长度={len(raw_text)}...")
    resp = req.post(
        DEEPSEEK_API_URL,
        headers={"Authorization": f"Bearer {use_key}"},
        json={
            "model": DEEPSEEK_MODEL,
            "messages": [
                {"role": "system", "content": "你是清洁设备营销文案专家。解析产品参数并生成营销文案。只返回JSON。"},
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.1,
            "max_tokens": 8192,
            "thinking": {"type": "disabled"},
            "response_format": {"type": "json_object"},
        },
        proxies={"http": None, "https": None},  # DeepSeek 国内API，不走代理
        timeout=180,
    )
    resp.raise_for_status()
    msg = resp.json()["choices"][0]["message"]
    raw = (msg.get("content") or "").strip()

    print(f"[DeepSeek] 原始响应长度={len(raw)}")

    if "```" in raw:
        m = re.search(r"```(?:json)?\s*([\s\S]+?)```", raw)
        if m:
            raw = m.group(1).strip()

    if not raw.startswith("{"):
        start = raw.find("{")
        if start != -1:
            raw = raw[start:]

    parsed = json.loads(raw.strip())
    print(f"[DeepSeek] 解析成功，字段数={len(parsed)}")
    adv = parsed.get("advantages", [])

    # ── 极限词过滤 ──
    for _field in ["slogan", "sub_slogan", "category_line", "hero_subtitle",
                   "story_title_1", "story_title_2",
                   "story_desc_1", "story_desc_2", "story_bottom_1", "story_bottom_2"]:
        if _field in parsed:
            parsed[_field] = _strip_extreme_words(_to_str(parsed[_field]))
    for _adv in parsed.get("advantages", []):
        if isinstance(_adv, dict):
            if "text" in _adv:
                _adv["text"] = _strip_extreme_words(_to_str(_adv["text"]))
            if "desc" in _adv:
                _adv["desc"] = _strip_extreme_words(_to_str(_adv["desc"]))
    # VS对比字段极限词过滤 — 新 schema 字段名(product_*/labor_*)
    vs = parsed.get("vs_comparison", {})
    if isinstance(vs, dict):
        _strip_extreme_in_list(vs.get("vs_rows", []),
                                ["product_value", "product_desc", "labor_value", "labor_desc"])
        for _vf in ["product_label", "product_sublabel",
                     "labor_label", "labor_sublabel",
                     "title_line1", "title_line1_red", "title_line1_end",
                     "title_line2", "title_line2_red"]:
            if _vf in vs:
                vs[_vf] = _strip_extreme_words(_to_str(vs[_vf]))

    # ── 新增字段极限词过滤 ──
    _strip_extreme_in_list(parsed.get("tech_items", []), ["title", "desc"])
    _strip_extreme_in_list(parsed.get("brand_stats", []), ["label"])
    _strip_extreme_in_list(parsed.get("brand_story_lines", []), ["text"])
    _strip_extreme_in_list(parsed.get("faqs", []), ["answer"])
    _svc = parsed.get("service_compare", {})
    if isinstance(_svc, dict):
        _strip_extreme_in_list(_svc.get("compare_rows", []), ["left", "right"])

    # ── 退化检测：Tier 1 must-extract 字段完整性 ──
    _dp = parsed.get("detail_params", {})
    _adv = parsed.get("advantages", [])
    _warnings = []
    if isinstance(_dp, dict) and len(_dp) < 3:
        _warnings.append(f"detail_params={len(_dp)}项（期望>=3）")
    if isinstance(_adv, list) and len(_adv) < 2:
        _warnings.append(f"advantages={len(_adv)}项（期望>=2）")
    if not parsed.get("slogan", "").strip():
        _warnings.append("slogan为空")
    if not parsed.get("story_title_1", "").strip():
        _warnings.append("story_title_1为空")
    if _warnings:
        print(f"[DeepSeek] ⚠️ Tier 1 退化警告: {'; '.join(_warnings)}")

    return parsed


def _derive_advantages_from_specs(detail_params: dict) -> list:
    """兜底：当 AI 不返回 advantages 时，从参数规格用中性词推导。
    注意：主流程已改为只用AI返回的advantages，此函数仅作极端降级。"""
    if not isinstance(detail_params, dict) or not detail_params:
        return []
    mapping = [
        (["清扫宽度", "清扫作业宽度"], "🧹", "清扫功能"),
        (["工作效率", "清洁效率", "最大清洁效率"], "⚡", "清洁效率"),
        (["垃圾箱容量"], "🗑️", "垃圾收集"),
        (["水箱容量", "清水容量"], "💧", "水箱配备"),
        (["爬坡能力"], "⛰️", "爬坡能力"),
        (["制动方式"], "🛑", "制动系统"),
        (["电池容量", "电瓶容量", "锂电容量"], "🔋", "电池续航"),
        (["连续工作时间", "工作时间", "续航时间"], "⏱️", "续航能力"),
        (["清洗宽度", "吸水宽度"], "🧽", "洗地功能"),
    ]
    items = []
    used = set()
    for keys, emoji, text in mapping:
        for k in keys:
            if detail_params.get(k) and k not in used:
                items.append({"emoji": emoji, "text": text})
                used.add(k)
                break
        if len(items) >= 6:
            break
    return items


def _parse_text_for_desktop(raw_text: str, product_type: str, product_title: str) -> dict:
    """Parse explicit product fields locally without network or paid model calls."""
    parsed = _extract_json_object(raw_text)
    if not isinstance(parsed, dict):
        parsed = _parse_text_by_template(raw_text)
    if not isinstance(parsed, dict) or not parsed:
        return {}
    if product_title:
        parsed.setdefault("product_name", product_title)
        parsed.setdefault("main_title", product_title)
    if not parsed.get("kpis"):
        detail_params = parsed.get("detail_params", {})
        if isinstance(detail_params, dict):
            kpis = []
            for label, value in detail_params.items():
                raw_value = _to_str(value)
                if not re.search(r"\d", raw_value):
                    continue
                if not _is_valid_spec_value(raw_value, max_len=24):
                    continue
                number, unit = _split_value_unit(raw_value)
                kpis.append({
                    "label": _to_str(label),
                    "value": number or raw_value,
                    "unit": unit,
                    "note": "",
                })
            if kpis:
                parsed["kpis"] = kpis[:6]
    mapped = _map_parsed_to_form_fields(parsed, product_category=product_type)
    mapped["_raw_parsed"] = parsed
    return mapped


@app.route("/api/build/<product_type>/parse-text", methods=["POST"])
@login_required
def parse_text_for_build(product_type):
    _validate_product_type(product_type)
    data = request.get_json(silent=True)
    if not data or not data.get("text"):
        return jsonify({"error": "缺少 text 字段"}), 400

    raw_text = _to_str(data.get("text"))
    if not raw_text:
        return jsonify({"error": "文本内容为空"}), 400

    # 如果用户提供了产品标题，拼入文案顶部增强 AI 识别
    product_title = _to_str(data.get("product_title", ""))
    if product_title:
        raw_text = f"【产品标题】{product_title}\n\n{raw_text}"

    if _DESKTOP_MODE and not os.environ.get("DEEPSEEK_API_KEY", "").strip():
        mapped = _parse_text_for_desktop(raw_text, product_type, product_title)
        if not mapped:
            return jsonify({
                "error": "本地解析未识别到足够字段，请按“字段：内容”格式补充品牌、型号和参数。",
                "code": "DESKTOP_LOCAL_PARSE_INSUFFICIENT",
            }), 400
        log = GenerationLog(
            user_id=current_user.id,
            product_type=product_type,
            model_name=mapped.get("model_name", ""),
            api_key_source="desktop_local",
            action="local_parse",
        )
        db.session.add(log)
        db.session.commit()
        return jsonify(mapped)

    # PR C (2026-05-07): 二级 key 模式 — paid/admin 用 platform, else 用 user 自配
    try:
        api_key, key_source = _get_deepseek_key(current_user)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503

    # 直接调 DeepSeek —— 必须用 AI 才能生成 advantage_labels 和 clean_story
    try:
        parsed = _call_deepseek_parse(raw_text, product_type, api_key=api_key)
    except Exception as e:
        print(f"[DeepSeek] ❌ API调用失败: {e}")
        # DeepSeek 失败时降级到模板解析（不含卖点生成）
        parsed = _extract_json_object(raw_text)
        if not isinstance(parsed, dict):
            parsed = _parse_text_by_template(raw_text)
        if not isinstance(parsed, dict) or not parsed:
            return jsonify({"error": f"AI 解析失败: {e}"}), 500
        print(f"[DeepSeek] ⚠️ 降级到模板解析，字段数={len(parsed)}")

    # 记录生成日志
    log = GenerationLog(
        user_id=current_user.id,
        product_type=product_type,
        model_name=parsed.get("model", ""),
        api_key_source=key_source,
        action="ai_parse",
    )
    db.session.add(log)
    db.session.commit()

    _detail_params = parsed.get("detail_params", {})
    _detail_count = len(_detail_params) if isinstance(_detail_params, dict) else 0
    print(f"[DeepSeek] 映射准备完成，字段数={len(parsed)}，参数数={_detail_count}")

    # 如果 AI 没返回 brand/model/product_name，用产品标题兜底
    if product_title:
        if not parsed.get("product_name"):
            parsed["product_name"] = product_title
        if not parsed.get("main_title"):
            parsed["main_title"] = product_title
    # P5.1: 传入 URL 里的 product_type, 让 param_label 按品类匹配
    mapped = _map_parsed_to_form_fields(parsed, product_category=product_type)
    # AI 精修(HTML v2)读嵌套语义,扁平表单消费者忽略本键
    mapped["_raw_parsed"] = parsed
    return jsonify(mapped)


# ── AI 生图（通义万相）─────────────────────────────────────────────

@app.route("/api/generate-ai-images", methods=["POST"])
@login_required
def generate_ai_images():
    """
    AI 生图 API：根据产品数据生成完整详情图集
    输入：parsed_data（DeepSeek解析结果）、product_image（产品图URL）
    输出：生成的图片URL列表
    """
    import ai_image
    import image_composer

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "缺少请求数据"}), 400

    parsed_data = data.get("parsed_data", {})
    product_image_url = data.get("product_image", "")

    # 阿里云百炼 API Key（优先用户配置，否则用环境变量）
    dashscope_key = data.get("dashscope_api_key", "")
    if not dashscope_key:
        dashscope_key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not dashscope_key and hasattr(current_user, 'dashscope_api_key_enc') and current_user.dashscope_api_key_enc:
        from crypto_utils import decrypt_api_key
        dashscope_key = decrypt_api_key(current_user.dashscope_api_key_enc)
    if not dashscope_key:
        return jsonify({"error": "请提供阿里云百炼 API Key（DASHSCOPE_API_KEY）"}), 403

    # 准备输出目录
    user_out = _user_output_dir()
    ai_dir = user_out / "ai_images"
    ai_dir.mkdir(parents=True, exist_ok=True)

    # 解析产品图本地路径
    product_image_local = ""
    if product_image_url:
        # /static/uploads/1/xxx.png → static/uploads/1/xxx.png
        rel = product_image_url.lstrip("/")
        local_path = BASE_DIR / rel
        if local_path.exists():
            product_image_local = str(local_path)

    # 构建合成所需的产品数据
    product_data = {}
    if parsed_data:
        mapped = _map_parsed_to_form_fields(parsed_data)
        product_data = {
            "brand": _to_str(parsed_data.get("brand", "")),
            "brand_text": mapped.get("brand_text", ""),
            "model_name": mapped.get("model_name", ""),
            "model": _to_str(parsed_data.get("model", "")),
            "product_name": _to_str(parsed_data.get("product_name", "")),
            "product_type": _to_str(parsed_data.get("product_type", "")),
            "category_line": mapped.get("category_line", ""),
            "tagline_line1": mapped.get("tagline_line1", ""),
            "tagline_line2": mapped.get("tagline_line2", ""),
            "sub_slogan": mapped.get("tagline_sub", ""),
            "slogan": _to_str(parsed_data.get("slogan", "")),
            "param_1_label": mapped.get("param_1_label", ""),
            "param_1_value": mapped.get("param_1_value", ""),
            "param_2_label": mapped.get("param_2_label", ""),
            "param_2_value": mapped.get("param_2_value", ""),
            "param_3_label": mapped.get("param_3_label", ""),
            "param_3_value": mapped.get("param_3_value", ""),
            "param_4_label": mapped.get("param_4_label", ""),
            "param_4_value": mapped.get("param_4_value", ""),
            "detail_params": parsed_data.get("detail_params", {}),
            "dimensions": parsed_data.get("dimensions", {}),
            "specs": mapped.get("e_specs", []),
            "advantages": parsed_data.get("advantages", []),
            # VS对比数据
            "vs_comparison": parsed_data.get("vs_comparison", {}),
            # 清洁故事数据
            "story_title_1": _to_str(parsed_data.get("story_title_1", "")),
            "story_title_2": _to_str(parsed_data.get("story_title_2", "")),
            "story_desc_1": _to_str(parsed_data.get("story_desc_1", "")),
            "story_desc_2": _to_str(parsed_data.get("story_desc_2", "")),
            "story_bottom_1": _to_str(parsed_data.get("story_bottom_1", "")),
            "story_bottom_2": _to_str(parsed_data.get("story_bottom_2", "")),
            "footer_note": "*产品参数以实物为准，图片仅供参考",
        }

    print(f"[AI生图] 开始为 {product_data.get('model_name', '未知')} 生成详情图...")

    # Step 1: 生成AI背景图
    try:
        backgrounds = ai_image.generate_detail_backgrounds(
            product_data, dashscope_key, ai_dir
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[AI生图] 背景生成失败: {e}，使用纯色背景继续")
        backgrounds = {}

    # Step 2: Pillow 合成最终图片
    try:
        output_dir = ai_dir / "final"
        result_paths = image_composer.compose_all(
            product_data, product_image_local, backgrounds, output_dir
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"图片合成失败: {e}"}), 500

    # 转换为URL
    result_urls = []
    for p in result_paths:
        rel_path = Path(p).relative_to(BASE_DIR)
        result_urls.append(f"/{rel_path.as_posix()}")

    print(f"[AI生图] 完成！共 {len(result_urls)} 张图")
    return jsonify({
        "images": result_urls,
        "count": len(result_urls),
    })


# ── AI 生图：双引擎元数据 + 无缝长图 ─────────────────────────────────

@app.route("/api/ai-engines", methods=["GET"])
def list_ai_engines():
    """前端引擎下拉框数据源：返回可用引擎列表（id/label/vendor/model/cost_hint）"""
    import ai_image_router
    return jsonify({"engines": ai_image_router.list_engines(),
                    "default": ai_image_router.DEFAULT_ENGINE})


@app.route("/api/generate-ai-detail", methods=["POST"])
@login_required
def generate_ai_detail():
    """
    无缝长图 AI 精修：双引擎 + 色调流分段 + 渐变融合 + 中文字体合成。

    请求体：
    {
      "parsed_data": { ... DeepSeek 解析结果 ... },
      "product_image": "/static/uploads/...",
      "theme_id": "classic-red",
      "engine": "wanxiang" | "seedream",
      "zones": ["hero","advantages","story","specs","vs","scene","brand"],   # 可选
      "dashscope_api_key": "...",  # 可选，否则用环境变量/用户配置
      "ark_api_key": "..."         # 可选
    }

    返回：
    {
      "image_url": "/output/<uid>/ai_detail/seamless_<engine>.png",
      "engine": "wanxiang",
      "segments": 7,
      "elapsed_sec": 42.3
    }
    """
    import time as _t
    import traceback
    import ai_image_router
    import theme_color_flows
    import image_composer

    data = request.get_json(silent=True) or {}
    engine = (data.get("engine") or ai_image_router.DEFAULT_ENGINE).strip()
    if engine not in ai_image_router.ENGINES:
        return jsonify({"error": f"未知引擎: {engine}"}), 400

    parsed_data = data.get("parsed_data") or {}
    if not parsed_data:
        return jsonify({"error": "缺少 parsed_data"}), 400

    theme_id = (data.get("theme_id") or "classic-red").strip()
    zones = data.get("zones") or theme_color_flows.ZONE_ORDER_DEFAULT

    # 收集双引擎 key（优先请求体，再环境变量，再用户加密配置）
    api_keys = {
        "dashscope_api_key": data.get("dashscope_api_key", "") or os.environ.get("DASHSCOPE_API_KEY", ""),
        "ark_api_key": data.get("ark_api_key", "") or os.environ.get("ARK_API_KEY", ""),
    }
    # fallback: 用户配置加密的 dashscope_api_key（旧逻辑）
    if not api_keys["dashscope_api_key"] and hasattr(current_user, "dashscope_api_key_enc") and current_user.dashscope_api_key_enc:
        from crypto_utils import decrypt_api_key
        api_keys["dashscope_api_key"] = decrypt_api_key(current_user.dashscope_api_key_enc) or ""

    meta = ai_image_router.ENGINES[engine]
    if engine == "wanxiang" and not api_keys["dashscope_api_key"]:
        return jsonify({"error": f"请提供 {meta['label']} 的 API Key（DASHSCOPE_API_KEY）"}), 403
    if engine == "seedream" and not api_keys["ark_api_key"]:
        return jsonify({"error": f"请提供 {meta['label']} 的 API Key（ARK_API_KEY）"}), 403

    # 准备产品数据（复用现有映射）
    mapped = _map_parsed_to_form_fields(parsed_data)
    product_data = {
        "brand": _to_str(parsed_data.get("brand", "")),
        "brand_text": mapped.get("brand_text", ""),
        "model_name": mapped.get("model_name", ""),
        "model": _to_str(parsed_data.get("model", "")),
        "product_name": _to_str(parsed_data.get("product_name", "")),
        "product_type": _to_str(parsed_data.get("product_type", "")),
        "category_line": mapped.get("category_line", ""),
        "main_title": mapped.get("main_title", "") or _to_str(parsed_data.get("main_title", "")),
        "tagline_line1": mapped.get("tagline_line1", ""),
        "tagline_line2": mapped.get("tagline_line2", ""),
        "sub_slogan": mapped.get("tagline_sub", ""),
        "slogan": _to_str(parsed_data.get("slogan", "")),
        "advantages": parsed_data.get("advantages") or [],
        "specs": mapped.get("e_specs", []),
        "detail_params": parsed_data.get("detail_params", {}),
        "vs_comparison": parsed_data.get("vs_comparison", {}),
        "story_title_1": _to_str(parsed_data.get("story_title_1", "")),
        "story_title_2": _to_str(parsed_data.get("story_title_2", "")),
        "story_desc_1": _to_str(parsed_data.get("story_desc_1", "")),
        "story_desc_2": _to_str(parsed_data.get("story_desc_2", "")),
        "scenes": parsed_data.get("scenes") or [],
        "footer_note": "*产品参数以实物为准，图片仅供参考",
    }
    # 主参数条（4 项）
    for i in (1, 2, 3, 4):
        product_data[f"param_{i}_label"] = mapped.get(f"param_{i}_label", "")
        product_data[f"param_{i}_value"] = mapped.get(f"param_{i}_value", "")

    # 解析产品图本地路径
    product_image_local = ""
    pimg_url = data.get("product_image", "")
    if pimg_url:
        local = BASE_DIR / pimg_url.lstrip("/")
        if local.exists():
            product_image_local = str(local)

    # 准备输出目录
    user_out = _user_output_dir()
    detail_dir = user_out / "ai_detail"
    seg_dir = detail_dir / f"segments_{engine}"
    seg_dir.mkdir(parents=True, exist_ok=True)

    # Step 1: 规划 prompt 序列（使用 prompt_templates 六维专业模板）
    product_hint = product_data.get("product_type") or product_data.get("product_name") or ""
    plan = ai_image_router.plan_page(theme_id, zones=zones, product_hint=product_hint)
    print(f"[AI精修] 引擎={engine} 主题={theme_id} 段数={len(plan)} (prompt_templates)")

    # Step 2: 逐段生成背景（失败的段降级为空，由合成器忽略）
    # v3.3 颜色保真: 把产品图作为 reference_image_url 传给引擎走 i2i, 让 AI 看见产品真实色。
    # 豆包 Seedream 原生支持, 通义万相 wan2.6-t2i 不支持(会忽略并打 warning)。
    from ai_bg_cache import _to_data_url as _img_to_data_url
    ref_data_url = _img_to_data_url(product_image_local) if product_image_local else ""
    if ref_data_url:
        print(f"[AI精修] 参考图已转 data URL (len={len(ref_data_url)}) → i2i 颜色保真")
    elif product_image_local:
        print(f"[AI精修] ⚠️ 参考图转 data URL 失败, 降级纯文生图: {product_image_local}")

    t0 = _t.time()
    segment_paths = []
    for seg in plan:
        zone = seg["zone"]
        try:
            local = ai_image_router.generate_segment_to_local(
                engine, zone, seg["prompt"], api_keys, seg_dir,
                width=750, height=seg["height"],
                filename=f"{zone}.png",
                reference_image_url=ref_data_url,
            )
        except Exception as e:
            traceback.print_exc()
            print(f"[AI精修] 段 {zone} 生成异常: {e}")
            local = ""
        segment_paths.append(local)
        print(f"[AI精修]   ✓ {zone} → {local or '失败'}")

    valid_paths = [p for p in segment_paths if p]
    if not valid_paths:
        return jsonify({"error": "所有段背景生成失败，请检查 API Key 与额度"}), 502

    # Step 3: 融合 + 叠加内容
    out_path = detail_dir / f"seamless_{engine}.png"
    try:
        # 把段路径中失败的占位（空串）保留位置，让合成器跳过
        # compose_full_page 会跳过不存在的路径，只融合有效段
        # 但 plan 与段路径要对齐，所以传一个过滤后的子计划
        plan_filtered = [p for p, s in zip(plan, segment_paths) if s]
        theme_primary = theme_color_flows.get_flow(theme_id).get("primary", "#E8231A")
        image_composer.compose_seamless_detail_page(
            product_data=product_data,
            plan=plan_filtered,
            segment_paths=valid_paths,
            product_image=product_image_local,
            output_path=str(out_path),
            theme_primary=theme_primary,
        )
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": f"长图合成失败: {e}"}), 500

    elapsed = round(_t.time() - t0, 1)
    rel = out_path.relative_to(BASE_DIR).as_posix()
    print(f"[AI精修] 完成 → /{rel}（{elapsed}s）")
    return jsonify({
        "image_url": "/" + rel,
        "engine": engine,
        "segments": len(valid_paths),
        "elapsed_sec": elapsed,
    })


# ── AI 合成 v2:HTML/CSS + Playwright 截图长图 ────────────────────────
# 同一条管线也在 CLI `build_long_image.py` 里用,共享 `ai_compose_pipeline`。

_HTML_V2_THEME_ACCENT = "#FFD166"  # 金色点缀(品牌无关 — 所有主题共用)

# 这些 ctx 键如果存在,值里的 /static/... 路径会被转成 file:// 绝对 URI
# (Playwright 走 file:// 协议加载临时 HTML,无法解析相对 HTTP 路径)
_ASSET_KEYS_IN_CTX = (
    "bg_url", "product_url", "brand_logo_url", "qr_url",
    "effect_image_url",  # effect 屏的实拍图,Playwright 同样走 file:// 加载
)

# 每屏左上小字标签(英文 uppercased 装饰字),与 title_main 配对出现
_SECTION_LABELS = {
    "hero":       "",                        # hero 无 section_label
    "advantages": "CORE ADVANTAGES",
    "specs":      "TECHNICAL SPECS",
    "vs":         "COMPARISON",
    "scene":      "APPLICATION SCENARIOS",
    "effect":     "PRODUCT IN ACTION",
    "brand":      "ABOUT US",
}


@lru_cache(maxsize=1)
def _ai_kpi_priority() -> tuple:
    """返回 build_config.json 里 ai_detail_key_priority 的只读副本(tuple)。
    v2 ai_compose 管线与 legacy preview 共用同一份优先级,单一真相源。
    """
    cfg = _load_build_config("设备类") or {}
    return tuple(cfg.get("ai_detail_key_priority") or ())


def _build_kpi_list(mapped: dict, *, limit: int = 4,
                    split_unit: bool = False,
                    e_specs: list | None = None,
                    key_priority: list | None = None,
                    min_count: int = 0,
                    exclude_labels: set | None = None) -> list[dict]:
    """遍历 param_1..param_4,返回 [{value[, unit], label}, ...]。
    Why: hero(4 项 无单位)和 effect(3 项 拆单位)两处曾各自手写同一循环,抽出统一。
    split_unit=True 时把 value 里内嵌的 "90L"/"3600㎡/h" 等单位拆到独立字段,供模板右上角小字展示。

    新增 kwargs(均向后兼容,不传时行为不变):
    - e_specs / key_priority: param_1..4 不足时从规格表按优先级补齐
    - min_count: 期望最少项数;达到 min_count 就停补(不补到 limit,避免"1→4"视觉突变)
    - exclude_labels: 已被其它屏用过的 label 集合,跳过以避免跨屏重复
    """
    def _norm(s: str) -> str:
        return (s or "").strip().lower()
    exclude_norm = {_norm(l) for l in (exclude_labels or []) if _norm(l)}

    out: list[dict] = []
    used_norm: set[str] = set()
    for i in (1, 2, 3, 4):
        v = (mapped.get(f"param_{i}_value") or "").strip()
        l = (mapped.get(f"param_{i}_label") or "").strip()
        if not (v and l):
            continue
        if _norm(l) in exclude_norm:
            continue
        if split_unit:
            num_part, unit = _split_value_unit(v)
            out.append({"icon": "", "value": num_part or v,
                        "unit": unit, "label": l})
        else:
            out.append({"value": v, "label": l})
        used_norm.add(_norm(l))
        if len(out) >= limit:
            break

    # Stage 2: 从 e_specs 按优先级补齐到 min_count(上限仍然是 limit)
    if min_count and len(out) < min_count:
        def _make_kpi_row(name: str, value: str) -> dict:
            if split_unit:
                num_part, unit = _split_value_unit(value)
                return {"icon": "", "value": num_part or value,
                        "unit": unit, "label": name}
            return {"value": value, "label": name}

        used_norm |= exclude_norm
        _supplement_from_specs(
            out, e_specs, key_priority,
            min_count=min_count, limit=limit,
            used_norm=used_norm, make_row=_make_kpi_row,
        )

    return out[:limit]


def _pick_canvas_height(n: int, breakpoints: list[tuple[int, int]]) -> int:
    """按阈值表挑 canvas 高度。breakpoints = [(<=n, height), ...] 按升序。
    Why: advantages/vs 都要"按数据项数动态撑屏,避免留白",之前各写了 if/elif 阶梯,统一成查表。
    """
    for threshold, h in breakpoints:
        if n <= threshold:
            return h
    return breakpoints[-1][1]


def _build_ctxs_from_parsed(parsed: dict,
                            product_image_url: str,
                            theme_id: str,
                            backgrounds: dict | None = None,
                            scene_image_url: str = "",
                            effect_image_url: str = "",
                            qr_image_url: str = "") -> dict:
    """
    将 AI 解析的 parsed_data 映射成 HTML 合成管线的 7 屏 ctxs。

    ───── 字段映射表(这是这个函数的单一真相) ─────────────────
    parsed 字段            → 哪些屏用它
    ─────────────────────────────────────────────────────
    main_title             → hero.main_title / cta.cta_main
    sub_slogan             → 所有屏 subtitle 的主来源
    category_line          → hero/advantages/specs/scene 的 subtitle 兜底
    hero_subtitle          → hero.subtitle 拼接串
    slogan                 → hero.taglines
    detail_params(字典)    → specs.specs[] + hero.kpi_list[]
    advantages[]           → advantages.advantages[]
    vs_comparison          → vs.{left_label/right_label/compare_items/summary_points}
    scenes[]               → scene.scene_items[]
    brand                  → brand.brand_name
    brand_story            → brand.brand_story
    brand_stats[]          → brand.credentials[]
    model / product_name   → brand.brand_name_sub + cta.contacts 兜底值
    contacts[](可选)       → cta.contacts[]
    cta_sub(可选)          → cta.cta_sub;没有时用 sub_slogan 兜底

    product_image_url      → hero/specs/cta 的 product_url(上传失败时走占位,见模板)
    backgrounds[screen]    → 对应屏的 bg_url(Seedream 缓存层产物)

    ───── 原则(feedback_no_hardcoded_data) ─────────────
    - 不编造产品数据(规格/优势文字都来自 parsed)
    - 但排版性字段(subtitle/副标签/iconemoji)可以做"基于 parsed 的派生兜底"
    - 每屏必填字段缺则跳过该屏,不生成空屏
    """
    import theme_color_flows

    parsed = parsed if isinstance(parsed, dict) else {}
    mapped = _map_parsed_to_form_fields(parsed)
    backgrounds = backgrounds or {}

    primary = theme_color_flows.get_flow(theme_id).get("primary", "#E8231A")
    theme = {
        "theme_primary":      primary,
        "theme_primary_dark": primary,
        "theme_accent":       _HTML_V2_THEME_ACCENT,
    }
    product_url = product_image_url or ""
    ctxs: dict = {}

    # ── 公共派生值(跨屏复用)────────────────────────────
    main_title     = mapped.get("main_title") or _to_str(parsed.get("main_title", ""))
    brand_name     = _to_str(parsed.get("brand", ""))
    model          = _to_str(parsed.get("model", "")) or _to_str(parsed.get("product_name", ""))
    # category_line 优先用 mapped 里 _map_parsed_to_form_fields 组装的「产品名+型号」格式,
    # raw parsed.category_line 只作兜底 —— 否则首图小字会退化成光秃秃的品类词(如 "驾驶式洗地机")
    category_line  = (mapped.get("category_line")
                      or _to_str(parsed.get("category_line", ""))
                      or _to_str(parsed.get("product_type", "")))
    sub_slogan     = _to_str(parsed.get("sub_slogan", ""))
    hero_subtitle  = _to_str(parsed.get("hero_subtitle", ""))

    # 跨屏 subtitle 通用兜底:sub_slogan > category_line
    common_subtitle = sub_slogan or category_line

    def _inject_bg(ctx: dict, screen: str) -> dict:
        """背景图存在时注入 bg_url;缺失时由模板走 CSS 兜底"""
        bg = (backgrounds.get(screen) or "").strip()
        if bg:
            ctx["bg_url"] = bg
        return ctx

    # ══════════════════════════════════════════════════════
    # HERO
    # ══════════════════════════════════════════════════════
    if main_title:
        hero: dict = {**theme, "main_title": main_title}
        # product_url 缺失时模板会显示占位(下面改 hero.html 加 else 分支)
        hero["product_url"] = product_url  # 空串也显式传,让模板走 else 分支
        # 小字只放"产品名 + 型号"(category_line 已在 _map_parsed_to_form_fields 组装),
        # 不再拼 hero_subtitle —— 避免和大字 main_title(卖点)形成双重副标、也避免与 taglines 重复。
        if category_line:
            hero["subtitle"] = category_line
        taglines = [p for p in (mapped.get("tagline_line1"),
                                mapped.get("tagline_line2")) if p]
        if taglines:
            hero["taglines"] = taglines
        kpi_list = _build_kpi_list(
            mapped,
            limit=4,
            split_unit=False,
            e_specs=mapped.get("e_specs") or [],
            key_priority=list(_ai_kpi_priority()),
            min_count=2,
        )
        if kpi_list:
            hero["kpi_list"] = kpi_list
        ctxs["hero"] = _inject_bg(hero, "hero")

    # ══════════════════════════════════════════════════════
    # ADVANTAGES
    # ══════════════════════════════════════════════════════
    advs_raw = parsed.get("advantages") or []
    advs = []
    for it in advs_raw[:6]:
        if isinstance(it, dict):
            title = _to_str(it.get("text", "")) or _to_str(it.get("title", ""))
            if not title:
                continue
            stat_num = _to_str(it.get("stat_num", ""))
            stat_unit = _to_str(it.get("stat_unit", ""))
            if not stat_num:
                stat_num, stat_unit = _extract_stat_from_desc(
                    it.get("desc", ""), it.get("desc_main", ""), it.get("text", ""))
            advs.append({
                "icon":      _to_str(it.get("emoji", "")) or "✅",
                "title":     title,
                "stat_num":  stat_num,
                "stat_unit": stat_unit,
                "desc_main": _to_str(it.get("desc_main", "")) or _to_str(it.get("desc", "")),
                "desc_sub":  _to_str(it.get("desc_sub", "")),
            })
        elif isinstance(it, str) and it.strip():
            advs.append({"icon": "✅", "title": it.strip(),
                         "stat_num": "", "stat_unit": "",
                         "desc_main": "", "desc_sub": ""})
    if advs:
        # Why: registry 默认 canvas=900(2×3),AI 常只返 3-4 项 → 底部留白;按项数撑版
        n_adv = len(advs)
        adv_h = _pick_canvas_height(n_adv, [(3, 480), (4, 640), (6, 780)])
        grid_cols = "1fr 1fr" if n_adv == 4 else "1fr 1fr 1fr"
        adv_ctx: dict = {
            **theme,
            "section_label": _SECTION_LABELS["advantages"],
            "title_main":    "核心优势",
            "advantages":    advs,
            "grid_cols":     grid_cols,
            "canvas_height": adv_h,
        }
        if common_subtitle:
            adv_ctx["subtitle"] = common_subtitle
        ctxs["advantages"] = _inject_bg(adv_ctx, "advantages")

    # ══════════════════════════════════════════════════════
    # SPECS — value/unit 拆分,让 .spec-value 和 .spec-unit 各归各位
    # ══════════════════════════════════════════════════════
    e_specs = mapped.get("e_specs") or []
    spec_rows = []
    for s in e_specs:
        if not isinstance(s, dict):
            continue
        label = _to_str(s.get("label", "")) or _to_str(s.get("name", ""))
        val = _to_str(s.get("value", ""))
        if not (label and val):
            continue
        # value 里若内嵌单位(如 "90L"/"3600㎡/h")则拆开,空单位模板自动隐藏
        unit = _to_str(s.get("unit", ""))
        if not unit:
            num_part, extracted_unit = _split_value_unit(val)
            if extracted_unit:
                val = num_part
                unit = extracted_unit
        spec_rows.append({"label": label, "value": val, "unit": unit})

    if spec_rows:
        n = len(spec_rows)
        if n <= 10:
            row_pad, val_size, lbl_size = "11px", "20px", "13px"
        elif n <= 15:
            row_pad, val_size, lbl_size = "7px", "17px", "12px"
        elif n <= 20:
            row_pad, val_size, lbl_size = "5px", "15px", "12px"
        else:
            row_pad, val_size, lbl_size = "3px", "13px", "11px"

        specs_ctx: dict = {
            **theme,
            "section_label":    _SECTION_LABELS["specs"],
            "title_main":       "专业参数",
            "specs":            spec_rows,  # 全量,不再 [:10] 截断
            "spec_row_pad":     row_pad,
            "spec_value_size":  val_size,
            "spec_label_size":  lbl_size,
        }
        if common_subtitle:
            specs_ctx["subtitle"] = common_subtitle
        specs_ctx["product_url"] = product_url  # 空串也传,让 specs.html 走 else 占位
        if model:
            specs_ctx["product_badge"] = model
        ctxs["specs"] = _inject_bg(specs_ctx, "specs")

    # ══════════════════════════════════════════════════════
    # VS — 补 icon/summary_points,对比屏从"三行表格"变成"视觉收束单元"
    # ══════════════════════════════════════════════════════
    # 新 schema: product_* = 本产品(映射到模板右侧/红色赢家位)
    #           labor_*   = 人工(映射到模板左侧/灰色对比位)
    # AI 无可量化对比数据 → 整屏跳过(不再硬编造 "传统人工"/"智能机器人")
    vs_raw = parsed.get("vs_comparison") or {}
    if isinstance(vs_raw, dict) and vs_raw:
        product_label    = _to_str(vs_raw.get("product_label", ""))
        labor_label      = _to_str(vs_raw.get("labor_label", ""))
        vs_rows_raw      = vs_raw.get("vs_rows") or []
        summary_raw      = vs_raw.get("summary_points") or []

        cmp_rows = []
        for c in vs_rows_raw:
            if not isinstance(c, dict):
                continue
            lbl = _to_str(c.get("label", ""))
            pv  = _to_str(c.get("product_value", ""))
            lv  = _to_str(c.get("labor_value", ""))
            # 每行都必须"三有":维度+产品值+人工值,缺一个就丢弃该行
            if not (lbl and pv and lv):
                continue
            cmp_rows.append({
                "label":       lbl,
                "left_value":  lv,                                     # 左=人工
                "left_desc":   _to_str(c.get("labor_desc", "")),
                "right_value": pv,                                     # 右=本产品
                "right_desc":  _to_str(c.get("product_desc", "")),
            })

        summary_points = []
        for s in summary_raw:
            if not isinstance(s, dict):
                continue
            n = _to_str(s.get("num", ""))
            lb = _to_str(s.get("label", ""))
            if n and lb:
                summary_points.append({"num": n, "label": lb})

        # 最小生成门槛:只要"至少一行可量化对比"即可;labels 缺失时兜底到通用分组名
        # Why: product_label/labor_label 是"对阵分组名",不是产品数据 —— 用 "本产品"/"人工"
        #   兜底不算硬编造(不违反 feedback_no_hardcoded_data),真正不可编造的是 vs_rows 的数字。
        if cmp_rows:
            if not product_label:
                product_label = "本产品"
            if not labor_label:
                labor_label = "人工"
            vs_h = _pick_canvas_height(
                len(cmp_rows), [(2, 620), (3, 720), (4, 820), (99, 900)])
            vs_ctx: dict = {
                **theme,
                "section_label":  _SECTION_LABELS["vs"],
                "title_main":     "对比优势",
                "left_label":     labor_label,                         # 模板左列 = 人工
                "right_label":    product_label,                       # 模板右列 = 本产品
                "left_icon":      _to_str(vs_raw.get("labor_icon", "")),
                "right_icon":     _to_str(vs_raw.get("product_icon", "")),
                "left_sublabel":  _to_str(vs_raw.get("labor_sublabel", "")),
                "right_sublabel": _to_str(vs_raw.get("product_sublabel", "")),
                "compare_items":  cmp_rows,
                "canvas_height":  vs_h,
            }
            if common_subtitle:
                vs_ctx["subtitle"] = common_subtitle
            if summary_points:
                vs_ctx["summary_points"] = summary_points[:3]
            ctxs["vs"] = _inject_bg(vs_ctx, "vs")

    # ══════════════════════════════════════════════════════
    # SCENE
    # ══════════════════════════════════════════════════════
    scenes_raw = parsed.get("scenes") or []
    scene_items = []
    for s in scenes_raw[:6]:
        if not isinstance(s, dict):
            continue
        name = _to_str(s.get("name", "")) or _to_str(s.get("title", ""))
        if not name:
            continue
        # 有图就用图,没匹配到也**不跳过** — 模板会走首字渐变占位卡(对齐 v1 block_h 行为)
        # Why: 用户给 5 个场景(背街小巷/广场/小区/人行道/...)硬套图反而违和,
        #      CSS 渐变 + 场景首字占位视觉上更干净,场景数与 parsed.scenes 一致
        img = _to_str(s.get("image", "")) or _match_scene_image(name)
        item = {"name": name, "image_url": img,
                "desc": _to_str(s.get("desc", "")) or _to_str(s.get("description", ""))}
        scene_items.append(item)
    if scene_items:
        scene_ctx: dict = {
            **theme,
            "section_label": _SECTION_LABELS["scene"],
            "title_main":    "适用场景",
            "scene_items":   scene_items,
        }
        if common_subtitle:
            scene_ctx["subtitle"] = common_subtitle
        scene_ctx = _inject_bg(scene_ctx, "scene")
        # effect_image_url 不再污染 scene 背景 — 改由独立 effect 屏承载(下方 EFFECT 段)
        ctxs["scene"] = scene_ctx

    # ══════════════════════════════════════════════════════
    # EFFECT — 用户上传效果图的独立展示屏(只在 effect_image_url 存在时构建)
    # Why: 效果图是带产品的实拍,当全屏模糊背景后面再叠场景卡视觉违和;
    #      给它一个"大图 + 底部 3-4 卖点条"的独立屏,对齐 v1 block_e 的处理方式
    # ══════════════════════════════════════════════════════
    if effect_image_url:
        # 跨屏去重:effect 的 kpi 不得与 hero 的 kpi_list 重复 label。
        # _build_ctxs_from_parsed 里 hero 段(上方)先于 effect 段执行,ctxs["hero"] 已就位。
        hero_labels = {
            (k.get("label") or "").strip()
            for k in (ctxs.get("hero", {}).get("kpi_list") or [])
            if k.get("label")
        }
        effect_kpis = _build_kpi_list(
            mapped,
            limit=3,
            split_unit=True,
            e_specs=mapped.get("e_specs") or [],
            key_priority=list(_ai_kpi_priority()),
            min_count=2,
            exclude_labels=hero_labels,
        )
        effect_ctx: dict = {
            **theme,
            "section_label":    _SECTION_LABELS["effect"],
            "title_main":       "实景效果",
            "effect_image_url": effect_image_url,
            "tag_text":         "实景演示",
        }
        if common_subtitle:
            effect_ctx["subtitle"] = common_subtitle
        if effect_kpis:
            effect_ctx["kpi_items"] = effect_kpis
            effect_ctx["kpi_cols"] = len(effect_kpis)
        ctxs["effect"] = effect_ctx

    # ══════════════════════════════════════════════════════
    # BRAND — 补 brand_name_sub (用 model 作英文副名)
    # ══════════════════════════════════════════════════════
    story_parts = [_to_str(parsed.get(k, ""))
                   for k in ("brand_story", "story_desc_1", "story_desc_2")]
    brand_story = " ".join(p for p in story_parts if p).strip()
    if brand_name and brand_story:
        creds = []
        for s in (parsed.get("brand_stats") or []):
            if not isinstance(s, dict):
                continue
            main = _to_str(s.get("value", "")) or _to_str(s.get("main", ""))
            lbl = _to_str(s.get("label", ""))
            if main and lbl:
                creds.append({"icon": _to_str(s.get("icon", "")) or "🏆",
                              "main": main, "label": lbl})
        brand_ctx: dict = {
            **theme,
            "section_label": _SECTION_LABELS["brand"],
            "brand_name":    brand_name,
            "brand_story":   brand_story,
        }
        # brand_name_sub:AI 显式给 > model 派生(英文型号作副名)
        brand_name_sub = _to_str(parsed.get("brand_name_sub", ""))
        if not brand_name_sub and model:
            brand_name_sub = model
        if brand_name_sub:
            brand_ctx["brand_name_sub"] = brand_name_sub
        if creds:
            brand_ctx["credentials"] = creds[:4]
            brand_ctx["credentials_cols"] = min(len(creds), 4)
        ctxs["brand"] = _inject_bg(brand_ctx, "brand")

    # ══════════════════════════════════════════════════════
    # CTA — 补 cta_sub / contacts;product_url 作为副图
    # ══════════════════════════════════════════════════════
    cta_main = _to_str(parsed.get("cta_main", ""))
    if not cta_main and main_title:
        cta_main = f"立即咨询 · {main_title}"
    if cta_main:
        cta: dict = {
            **theme,
            "section_label": "CONTACT US",
            "cta_main":      cta_main,
        }
        # cta_sub: AI 显式给 > sub_slogan > category_line
        cta_sub = _to_str(parsed.get("cta_sub", "")) or common_subtitle
        if cta_sub:
            cta["cta_sub"] = cta_sub

        # contacts: AI 显式给 > 基于 brand/model 派生的"品牌名片"占位
        # 不编假电话号 — 只把 parsed 已有的标识信息重组成"联系卡"形式
        contacts_raw = parsed.get("contacts") or []
        contacts = []
        for c in contacts_raw:
            if isinstance(c, dict):
                val = _to_str(c.get("value", ""))
                if val:
                    contacts.append({"icon": _to_str(c.get("icon", "")) or "",
                                     "label": _to_str(c.get("label", "")),
                                     "value": val})
        if not contacts:
            # 占位兜底:用 brand + model,不瞎编号码
            if brand_name:
                contacts.append({"icon": "🏢", "label": "BRAND",
                                 "value": brand_name})
            if model:
                contacts.append({"icon": "📦", "label": "MODEL",
                                 "value": model})
            if category_line:
                contacts.append({"icon": "🛠", "label": "CATEGORY",
                                 "value": category_line})
        if contacts:
            cta["contacts"] = contacts

        if product_url:
            cta["product_url"] = product_url
        if qr_image_url:
            cta["qr_url"] = qr_image_url

        ctxs["cta"] = cta

    return ctxs


def _to_file_uri_if_local(url: str) -> str:
    """把 /static/... 或 /output/... 的 HTTP 路径转成 file:// 绝对 URI,
    已经是 file:// / http(s):// / data: 的保持原样;空串/None 原样返回。

    必须 unquote: url_for 输出的中文路径是 percent-encoded(如 %E5%95%86),
    不解码会让 Path 找不到 "商场.jpg" 这种文件,导致图加载失败 → 浏览器显示黑底。
    """
    if not url or not isinstance(url, str):
        return url
    if url.startswith(("file://", "http://", "https://", "data:")):
        return url
    if url.startswith("/"):
        local = BASE_DIR / unquote(url.lstrip("/"))
        if local.exists():
            return local.as_uri()
    return url


def _resolve_asset_urls_in_ctx(ctx: dict) -> dict:
    """深拷贝 ctx 并把已知资源字段的相对路径转成 file:// URI。
    只处理已知的 asset 键和 scene_items[].image_url — 不误伤其他字符串。"""
    out = dict(ctx)
    for k in _ASSET_KEYS_IN_CTX:
        if k in out:
            out[k] = _to_file_uri_if_local(out[k])
    # scene 屏的场景卡片图
    if isinstance(out.get("scene_items"), list):
        out["scene_items"] = [
            {**it, "image_url": _to_file_uri_if_local(it.get("image_url", ""))}
            if isinstance(it, dict) else it
            for it in out["scene_items"]
        ]
    return out


@app.route("/api/generate-ai-detail-html", methods=["POST"])
@login_required
def generate_ai_detail_html():
    """
    AI 合成管线 v2:HTML/CSS 排版 + Playwright 截图(7 屏长图)。

    与 /api/generate-ai-detail 的区别:
      - v1:AI 背景 + Pillow 绘字(字体/排版依赖 PIL)
      - v2:AI 背景 + HTML/CSS 排版 + Chromium 截图(排版由浏览器负责,更精准)

    请求体:
    {
      "ctxs":  { "hero": {...}, "advantages": {...}, ... },  # 必填
      "order": ["hero","advantages","vs","scene","brand","specs","cta"],  # 可选(specs 放倒数第二,符合"故事→参数→下单"心智)
      "out_jpg_name": "long.jpg",  # 可选
      "jpg_quality":  90,          # 可选
      "save_png":     false        # 可选(true 额外 +20s 生成档案 PNG)
    }

    返回:
    {
      "image_url": "/static/outputs/<uid>/ai_compose/<jpg_name>",
      "segments":  [{type, w, h, elapsed}, ...],
      "render_elapsed": 12.7, "stitch_elapsed": 0.8, "total_elapsed": 13.5,
      "width": 1500, "height": 11200,
      "jpg_bytes": 1583204,
      "png_url"?: "...", "png_bytes"?: ...
    }
    """
    import traceback
    import ai_compose_pipeline

    data = request.get_json(silent=True) or {}

    # 输入两路:显式 ctxs(测试/CLI)或 parsed_data(前端 AI 解析结果)
    ctxs = data.get("ctxs") or {}
    if not ctxs or not isinstance(ctxs, dict):
        parsed_data = data.get("parsed_data") or {}
        if not parsed_data:
            return jsonify({"error": "缺少 ctxs 或 parsed_data"}), 400
        product_image = data.get("product_image", "")
        scene_image   = (data.get("scene_image") or "").strip()    # 配景 → Seedream 图生图参考
        effect_image  = (data.get("effect_image") or "").strip()   # 效果图 → scene 屏 bg 覆盖
        qr_image      = (data.get("qr_image") or "").strip()       # 二维码 → cta 屏右栏
        theme_id = (data.get("theme_id") or "classic-red").strip()

        # 先并发生成 6 屏 AI 背景(hero/advantages/specs/vs/scene/brand)
        # AI_BG_MODE 控制模式: cache(默认 24h 复用) / realtime(每次都新)
        # API 失败 / 无 key → 该屏 bg_url="" → 模板走 CSS 兜底
        # scene_image 存在时 → 作为 Doubao 图生图参考,生成的 6 屏背景会向其色调/风格靠拢
        # 优先用前端传的 ark_api_key(用户自己 key),REQUIRE_USER_KEY=true 时禁用 ENV 兜底
        # 这样生产部署即使 ENV 有 key 也不会替用户付账单(防被薅羊毛)
        user_ark_key = (data.get("ark_api_key") or "").strip()
        require_user_key = os.environ.get("REQUIRE_USER_KEY", "false").lower() == "true"
        if user_ark_key:
            ark_key = user_ark_key
        elif require_user_key:
            return jsonify({
                "error": "需要豆包 API Key 才能生成 AI 精修。请在「AI 精修(专业版)」按钮"
                         "下方点「设置」填入你的 sk-xxx(火山方舟控制台申请)"
            }), 403
        else:
            ark_key = os.environ.get("ARK_API_KEY", "").strip()

        try:
            import ai_bg_cache
            category = (parsed_data.get("product_type")
                        or parsed_data.get("category_line") or "").strip()
            brand = (parsed_data.get("brand") or "").strip()
            # product_name 进缓存 key → 不同型号不共享背景图
            product_name = (parsed_data.get("product_name")
                            or parsed_data.get("model")
                            or parsed_data.get("main_title") or "").strip()
            backgrounds = ai_bg_cache.generate_backgrounds(
                theme_id=theme_id, product_category=category,
                brand=brand, api_key=ark_key,
                product_name=product_name,
                reference_image_url=scene_image,
            )
        except Exception as e:
            print(f"[ai-detail-html] 背景生成全局失败,全部走 CSS 兜底: {e}")
            traceback.print_exc()
            backgrounds = {}

        ctxs = _build_ctxs_from_parsed(parsed_data, product_image, theme_id,
                                       backgrounds=backgrounds,
                                       scene_image_url=scene_image,
                                       effect_image_url=effect_image,
                                       qr_image_url=qr_image)

        # ── 诊断日志:审计数据流(由 AI_DETAIL_DEBUG=1 开启)────────
        # 开启方式: 环境变量 AI_DETAIL_DEBUG=1 python app.py
        # 目的: 把 parsed_data 关键字段 / ctxs 各屏字段 dump 到 stdout
        #       便于对比"模板要什么 vs ctxs 有什么 vs 哪些为空"
        if os.environ.get("AI_DETAIL_DEBUG", "").strip() in ("1", "true", "yes"):
            import json as _json
            print("\n" + "═" * 72)
            print("[AUDIT] /api/generate-ai-detail-html 数据流诊断")
            print("═" * 72)
            print(f"[AUDIT] parsed_data.keys() = {sorted(parsed_data.keys())}")
            for k, v in parsed_data.items():
                if isinstance(v, (list, dict)):
                    snippet = _json.dumps(v, ensure_ascii=False)[:120]
                    print(f"[AUDIT]   {k:20s} = {type(v).__name__}[len={len(v)}]  {snippet}")
                else:
                    print(f"[AUDIT]   {k:20s} = {_to_str(v)[:80]!r}")
            print("─" * 72)
            print(f"[AUDIT] ctxs.keys() = {list(ctxs.keys())}")
            for screen, ctx in ctxs.items():
                keys = list(ctx.keys())
                empties = [k for k, v in ctx.items()
                           if v in ("", None, [], {}) or
                           (isinstance(v, str) and not v.strip())]
                print(f"[AUDIT]   {screen:12s} keys={keys}")
                print(f"[AUDIT]   {screen:12s} 空字段={empties}")
                # 列表字段详细展开(advantages/specs/compare_items/scene_items/credentials)
                for lk in ("advantages", "specs", "compare_items",
                           "scene_items", "credentials", "kpi_list", "taglines", "contacts"):
                    lv = ctx.get(lk)
                    if isinstance(lv, list):
                        print(f"[AUDIT]   {screen:12s} {lk}[{len(lv)}] = "
                              f"{_json.dumps(lv, ensure_ascii=False)[:200]}")
            print("═" * 72 + "\n")

        if not ctxs:
            return jsonify({"error": "parsed_data 里没有可渲染的屏(至少需要 main_title)"}), 400

    order = data.get("order") or ai_compose_pipeline.DEFAULT_ORDER
    if not isinstance(order, list) or not order:
        return jsonify({"error": "order 必须是非空数组"}), 400

    out_jpg_name = (data.get("out_jpg_name") or "long.jpg").strip()
    if not out_jpg_name.endswith(".jpg"):
        out_jpg_name += ".jpg"
    jpg_quality = int(data.get("jpg_quality") or 90)
    save_png = bool(data.get("save_png"))

    # 把每屏 ctx 里的 /static/... 路径转成 file:// URI
    resolved_ctxs = {k: _resolve_asset_urls_in_ctx(v) for k, v in ctxs.items()
                     if isinstance(v, dict)}

    # 输出目录:static/outputs/<uid>/ai_compose/ — 走 Flask 默认 static 服务
    uid = current_user.id if current_user.is_authenticated else 0
    out_dir = STATIC_OUTPUTS / str(uid) / "ai_compose"
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        result = ai_compose_pipeline.compose_detail_page(
            ctxs=resolved_ctxs,
            order=order,
            out_dir=out_dir,
            out_jpg_name=out_jpg_name,
            out_png_name="long.png" if save_png else None,
            jpg_quality=jpg_quality,
            verbose=True,
        )
    except ValueError as e:
        # 必填字段缺失 / segments 空 — 用户可修复
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": f"合成失败: {e}"}), 500

    # 把绝对路径转成可访问 URL
    jpg_rel = Path(result["jpg"]).relative_to(BASE_DIR).as_posix()
    resp = {
        "image_url":      "/" + jpg_rel,
        "segments":       [{k: s[k] for k in ("type", "w", "h", "elapsed")}
                           for s in result["segments"]],
        "render_elapsed": result["render_elapsed"],
        "stitch_elapsed": result["stitch_elapsed"],
        "total_elapsed":  result["total_elapsed"],
        "width":          result["width"],
        "height":         result["height"],
        "jpg_bytes":      result["jpg_bytes"],
    }
    if "png" in result:
        resp["png_url"] = "/" + Path(result["png"]).relative_to(BASE_DIR).as_posix()
        resp["png_bytes"] = result["png_bytes"]

    print(f"[AI合成v2] 完成 → {resp['image_url']} "
          f"({resp['total_elapsed']}s, {resp['jpg_bytes']/1024/1024:.2f} MB)")
    return jsonify(resp)


# ══════════════════════════════════════════════════════════════════════
# ── 构建系统（设备类，blocks 引擎）──────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

# 场景图库：文件名 → 别名关键词（中英文+近义词，模糊匹配）
# 图文件位于 static/scene_bank/{name}.jpg，来自 Unsplash CC0 授权
_SCENE_IMG_ALIASES = {
    # 按"大类 + 穷举变体"组织，每张图代表一个场景类型，子串匹配
    # 字典顺序决定命中优先级:越具体越靠前(如"地下车库"要先于"车库",避免"停车场"撞 地下)

    # —— 停车/地下空间 ——(放最前,避免"停车"被地面停车等长条件干扰)
    "地下车库.jpg": [
        "地下车库", "地下停车", "地下通道", "车库", "garage",
    ],
    "停车场.jpg": [
        "停车场", "停车库", "露天停车", "地面停车", "停车区", "parking",
    ],

    # —— 交通/小节点 ——(在"火车站/机场"之前:避免"公交站"被枢纽类 吃掉)
    "公交站.jpg": [
        "公交站", "公交总站", "公交枢纽", "公交站台", "候车亭", "bus stop", "公交",
    ],
    "地铁站.jpg": [
        "地铁", "轻轨", "subway", "metro", "站台",
    ],

    # —— 交通/大枢纽 ——
    "火车站.jpg": [
        "火车站", "高铁站", "动车", "train station",
        "汽车站", "客运站", "长途客运", "长途汽车",
        "交通枢纽", "枢纽", "候车厅", "候车",
    ],
    "机场.jpg": [
        "机场", "航站楼", "候机", "airport", "terminal", "航空",
    ],
    "码头.jpg": [
        "码头", "港口", "渡口", "客运码头", "客运港",
        "wharf", "pier", "dock", "harbor",
    ],

    # —— 道路 ——(在"广场/公园"前:避免"步行街"被广场吃掉;"人行道"要先于"街道")
    "人行道.jpg": [
        "人行道", "便道", "步行道", "走道", "sidewalk",
    ],
    "小巷.jpg": [
        "小巷", "胡同", "里弄", "窄巷", "背街", "背街小巷", "巷子", "alley", "laneway",
    ],
    "街道.jpg": [
        "街道", "马路", "街面", "市政道路", "城市道路", "路面", "街区", "街巷",
    ],
    "高速.jpg": [
        "高速", "高速公路", "公路", "快速路", "国道", "省道",
        "隧道", "立交", "立交桥", "高架", "highway",
    ],
    "加油站.jpg": [
        "加油站", "充电站", "换电站", "服务区", "gas station", "filling station",
    ],

    # —— 户外公共 ——
    "广场.jpg": [
        "广场", "步行街", "商业街", "美食街", "夜市",
        "中央广场", "文化广场", "市民广场", "中心广场", "town square",
    ],
    "公园.jpg": [
        "公园", "绿地", "园林", "街心公园", "花园", "湿地公园", "森林公园", "park",
    ],
    "景区.jpg": [
        "景区", "景点", "旅游区", "风景区", "游览", "scenic", "attraction",
    ],

    # —— 商业零售 ——
    "商场.jpg": [
        "商场", "购物中心", "购物广场", "百货", "商业综合体", "商圈",
        "mall", "shopping", "plaza", "专卖店", "连锁店",
    ],
    "超市.jpg": [
        "超市", "supermarket", "卖场", "便利店", "生鲜", "菜市场", "商超",
    ],

    # —— 住宿/住宅/会所 ——
    "酒店大堂.jpg": [
        "酒店", "宾馆", "民宿", "会所", "会馆", "度假村", "招待所",
        "hotel", "lobby", "前台", "接待区", "前厅",
    ],  # 不含"大堂"，避免"写字楼大堂"误匹配
    "小区.jpg": [
        "小区", "社区", "住宅小区", "住宅区", "居民区", "物业",
        "residential", "neighborhood",
    ],
    "公寓.jpg": [
        "公寓", "住宅", "楼盘", "楼房", "高层", "apartment",
    ],

    # —— 办公/公务 ——
    "写字楼.jpg": [
        "写字楼", "办公楼", "办公", "office", "楼宇", "商务楼",
        "政务大厅", "政务", "政府", "行政", "机关",
        "银行", "营业厅", "网点", "会议室",
        "律所", "咨询",
    ],

    # —— 工业制造/仓储 ——
    "工厂车间.jpg": [
        "工厂", "车间", "factory", "工业", "生产线", "流水线",
        "manufacturing", "加工", "厂房", "工业园",
    ],
    "仓库.jpg": [
        "仓库", "仓储", "warehouse", "物流", "储运",
        "冷库", "分拣", "配送中心",
    ],

    # —— 医疗健康 ——
    "医院.jpg": [
        "医院", "诊所", "hospital", "clinic", "医疗", "卫生院",
        "卫生服务中心", "体检", "康复", "养老", "敬老院", "药房", "药店",
    ],

    # —— 教育培训 ——
    "学校.jpg": [
        "学校", "校园", "教学楼", "school", "university",
        "大学", "教学", "学府", "培训机构", "培训", "幼儿园",
        "教室", "图书馆", "科技馆",
    ],

    # —— 餐饮 ——
    "餐厅.jpg": [
        "餐厅", "餐饮", "食堂", "restaurant", "cafeteria",
        "饭店", "快餐", "咖啡", "cafe", "茶楼", "茶馆", "小吃", "coffeehouse", "咖啡馆",
    ],

    # —— 运动健身 ——
    "健身房.jpg": [
        "健身", "gym", "fitness", "瑜伽", "私教", "训练馆",
    ],
    "体育馆.jpg": [
        "体育馆", "体育", "场馆", "stadium", "gymnasium", "运动",
        "球场", "游泳馆", "羽毛球", "篮球", "会议中心", "礼堂",
    ],

    # —— 展览文化 ——(博物馆 先于 展厅:博物馆命中"博物馆"才不会掉到展厅)
    "博物馆.jpg": [
        "博物馆", "美术馆", "画廊", "艺术馆", "艺术中心", "文化馆", "纪念馆", "museum",
    ],
    "展厅.jpg": [
        "展厅", "展馆", "展会", "exhibition", "会展", "展览",
    ],
}


# 未命中时的兜底池 — 跨"室外/公共/商业/枢纽"多生态挑最泛用又耐看的 8 张,
# 按 name 的 crc32 分桶。同一场景名稳定选同图(不会每次重启跳变),
# 不同场景名大概率分到不同图(不会再出现"所有未命中全是商场"的重复)。
_SCENE_IMG_FALLBACK_POOL = [
    "商场.jpg", "街道.jpg", "广场.jpg", "写字楼.jpg",
    "酒店大堂.jpg", "超市.jpg", "地铁站.jpg", "机场.jpg",
]


def _fallback_scene_image(name: str) -> str:
    """按 name 的 crc32 哈希从兜底池里挑一张,确保未命中场景互不重复。
    Why: 之前单值兜底("商场.jpg")会让页面上多个未识别场景全部是同一张图,
         视觉重复感很强。crc32 跨进程稳定,同名 → 同图,不同名 → 大概率异图。
    """
    if not name:
        return _SCENE_IMG_FALLBACK_POOL[0]
    idx = zlib.crc32(name.encode("utf-8")) % len(_SCENE_IMG_FALLBACK_POOL)
    return _SCENE_IMG_FALLBACK_POOL[idx]


def _match_scene_image(name):
    """场景名 → 本地图 URL。匹配策略:
    1. 精确子串命中 _SCENE_IMG_ALIASES → 对应图
    2. 完全匹不上 → crc32 从 _SCENE_IMG_FALLBACK_POOL 分桶挑图
    Why: v1 一键生成版是"纯模板 + 本地图库"管线,必须保证每屏场景都有图,
    否则首字占位卡视觉违和。哈希分桶保证多个未识别场景不会收敛到同一张。
    """
    if not name:
        return url_for('static', filename=f'scene_bank/{_fallback_scene_image("")}')
    key = str(name).strip().lower()
    if not key:
        return url_for('static', filename=f'scene_bank/{_fallback_scene_image("")}')
    for fname, aliases in _SCENE_IMG_ALIASES.items():
        for a in aliases:
            if a.lower() in key:
                return url_for('static', filename=f'scene_bank/{fname}')
    return url_for('static', filename=f'scene_bank/{_fallback_scene_image(key)}')


# Bug A1 (2026-04-22): manifest-driven scene matching.
# 老 _match_scene_image 保留作 manifest 缺失时的兜底 (决定性但语义错, 见 A1 commit).

_SCENE_MANIFEST_PATH = Path(__file__).parent / "static" / "scene_bank" / "manifest.json"


@lru_cache(maxsize=1)
def _load_scene_manifest() -> tuple[dict, ...]:
    """载入 manifest.json (lru_cache 单例, 线程安全). 失败返回空元组让调用方走兜底."""
    try:
        import json as _json
        data = _json.loads(_SCENE_MANIFEST_PATH.read_text(encoding="utf-8"))
        return tuple(data) if isinstance(data, list) else ()
    except Exception as e:
        print(f"[scene-manifest] 加载失败, 退回旧 _match_scene_image: {e}", flush=True)
        return ()


def _category_for_product(product_type: str) -> str:
    pt = (product_type or "").lower()
    if any(k in pt for k in ("水面", "水上", "水质", "无人船", "水下")):
        return "water"
    if any(k in pt for k in ("管道", "管网", "箱涵", "下水", "排水")):
        return "pipeline"
    if any(k in pt for k in ("工业", "仓储", "车间", "厂房", "工厂")):
        return "industrial"
    if any(k in pt for k in ("商用", "办公", "商业", "商超", "酒店", "机场")):
        return "commercial"
    return "public"


def _match_scene_smart(scene_name: str, product_type: str = "") -> str:
    """scene → 图 URL: manifest 双向子串打分 → 零分按 category 兜底."""
    manifest = _load_scene_manifest()
    if not manifest:
        return _match_scene_image(scene_name)
    key = (scene_name or "").strip()
    best_score, best_entry = 0, None
    if key:
        for entry in manifest:
            score = sum(1 for kw in (entry.get("keywords") or [])
                        if kw and (kw in key or key in kw))
            if score > best_score:
                best_score, best_entry = score, entry
    if best_score == 0:
        # 零分 → 按 product_type 推导 category 兜底 (不走老 crc32 随机)
        cat = _category_for_product(product_type)
        best_entry = next((e for e in manifest if e.get("category") == cat), manifest[0])
    return url_for('static', filename=f'scene_bank/{best_entry["file"]}')


def _enrich_scenes_with_images(scenes, product_type: str = ""):
    """为 scenes[] 里没 image 的项填补图 URL. product_type 用于零分兜底选 category.
    2026-04-22 改用 _match_scene_smart (老 _match_scene_image 作最终兜底)."""
    if not isinstance(scenes, list):
        return
    for s in scenes:
        if not isinstance(s, dict):
            continue
        if (s.get("image") or "").strip():
            continue
        scene_name = s.get("name") or s.get("title") or ""
        img = _match_scene_smart(scene_name, product_type=product_type)
        if img:
            s["image"] = img


def _clean_kpis(kpis):
    """清洗 block_i KPI：number→value 兼容、剔除无数字项、拆分"3600㎡/h"这种混写。"""
    if not isinstance(kpis, list):
        return
    cleaned = []
    for k in kpis:
        if not isinstance(k, dict):
            continue
        if "number" in k and "value" not in k:
            k["value"] = k.pop("number")
        val = str(k.get("value", "")).strip()
        if not val:
            continue
        if not (k.get("unit") or "").strip():
            m = re.match(r'^\s*([\+\-]?[\d\.,]+)\s*(.*)$', val)
            if m and m.group(2).strip():
                k["value"] = m.group(1)
                k["unit"] = m.group(2).strip()
        cleaned.append(k)
    kpis.clear()
    kpis.extend(cleaned)


def _postprocess_extra_blocks(extra_blocks, product_type: str = ""):
    """对 extra_blocks 中的场景图/KPI 做一次后处理，两处提交路径复用。
    product_type 下传给 _enrich_scenes_with_images, 用于零分兜底选 category (Bug A1)."""
    _enrich_scenes_with_images(extra_blocks.get("block_h", {}).get("scenes", []),
                               product_type=product_type)
    _clean_kpis(extra_blocks.get("block_i", {}).get("kpis", []))


def _get_labor_reference_image():
    """Never call the paid image provider from the desktop offline workspace."""
    if _DESKTOP_MODE:
        return ""
    return ai_bg_cache.get_labor_reference_image(
        api_key=os.environ.get("ARK_API_KEY", "")
    )


def _assemble_all_blocks(product_type, mapped_fields, images, cfg):
    """
    Assemble all block data from mapped fields and images.
    Returns dict with all block data ready for template rendering.

    mapped_fields: dict from _map_parsed_to_form_fields()
    images: {"product_image": "...", "scene_image": "...", "logo_image": "...", "qr_image": "...", "product_side_image": "", "effect_image": ""}
    cfg: build_config.json contents
    """
    def field(name, default=""):
        v = mapped_fields.get(name, "")
        return v.strip() if v else default

    product_image = images.get("product_image", "")
    scene_image = images.get("scene_image", "")
    logo_image = images.get("logo_image", "")
    qr_image = images.get("qr_image", "")
    product_side_image = images.get("product_side_image", "")
    effect_image = images.get("effect_image", "")

    # Hero params (不足 2 项 → 从 e_specs 按优先级补齐,不硬编造)
    hero_params = []
    for i in range(1, 5):
        v = field(f'param_{i}_value', '').strip()
        l = field(f'param_{i}_label', '').strip()
        if _is_valid_spec_value(v):
            hero_params.append({"value": v, "label": l})
    hero_params = _ensure_hero_params_min2(
        hero_params,
        mapped_fields.get("e_specs", []) or [],
        cfg.get("ai_detail_key_priority", []) or [],
    )

    _hcov = cfg.get("hero_cover_defaults") or {}
    _def = cfg.get("defaults") or {}

    block_a = {
        "brand_text": field('brand_text', _def.get("brand_text", "")),
        "model_name": field('model_name', _def.get("model_name", "")),
        "tagline_line1": field('tagline_line1', _def.get("tagline_line1", "")),
        "tagline_line2": field('tagline_line2', _def.get("tagline_line2", "")),
        "tagline_sub": field('tagline_sub', _def.get("tagline_sub", "")),
        "bg_image": scene_image,
        "product_image": product_image,
        "logo_image": logo_image,
        "category_line": field('category_line', _hcov.get("category_line", "")),
        "main_title": field('main_title', _hcov.get("main_title", "")),
        "hero_subtitle_pre": field('hero_subtitle_pre', _hcov.get("hero_subtitle_pre", "")),
        "hero_subtitle_em": field('hero_subtitle_em', _hcov.get("hero_subtitle_em", "")),
        "hero_subtitle_post": field('hero_subtitle_post', _hcov.get("hero_subtitle_post", "")),
        "footer_note": field('footer_note', _hcov.get("footer_note", "")),
        "cover_image": "",
        "floor_bg_image": scene_image,
        "bg_focal": field('bg_focal', _hcov.get("bg_focal", "center bottom")) or "center bottom",
        "show_hero_params": True,
        "params": hero_params,
    }
    print(f"[block_a调试] brand_text={block_a['brand_text']!r}, model_name={block_a['model_name']!r}, "
          f"main_title={block_a['main_title']!r}, category_line={block_a['category_line']!r}, "
          f"hero_subtitle_pre={block_a['hero_subtitle_pre']!r}, tagline_sub={block_a['tagline_sub']!r}, "
          f"params={len(hero_params)}个")
    print(f"[block_a调试] mapped_fields keys sample: {list(mapped_fields.keys())[:15]}")

    # Block E
    e_specs = []
    # From mapped e_specs list
    raw_specs = mapped_fields.get("e_specs", [])
    if isinstance(raw_specs, list):
        e_specs = [s for s in raw_specs if s.get("name") and s.get("value")]
    # 兜底：AI 未返回参数时，使用配置中的 default_specs
    if not e_specs:
        default_specs = cfg.get("default_specs", [])
        if isinstance(default_specs, list):
            e_specs = [{"name": s.get("name", ""), "value": s.get("value", "")}
                       for s in default_specs if s.get("name") and s.get("value")]

    model_name = field('model_name', _def.get("model_name", ""))
    _e_red = field("e_red_bar_text", "").strip()
    _dims = cfg.get("default_dims", {})
    block_e = {
        "title": "产品参数",
        "subtitle": field("e_table_subtitle", "规格一览"),
        "red_bar_text": _e_red or f"{model_name}创新升级",
        "product_image": product_side_image or product_image,
        "dim_height": field('e_dim_height', _dims.get("height", "")),
        "dim_width": field('e_dim_width', _dims.get("width", "")),
        "dim_length": field('e_dim_length', _dims.get("length", "")),
        "specs": e_specs,
        "footnote": "*人工测量有误差",
    }

    blocks_hc = cfg.get("blocks_hardcoded", {})

    # Block B2
    block_b2_cfg = blocks_hc.get("block_b2", {})
    b2_items = []
    for i in range(1, 10):
        label = field(f"b2_label_{i}", "")
        icon = field(f"b2_icon_{i}", "")
        desc = field(f"b2_desc_{i}", "")
        if label:
            b2_items.append({"icon_image": "", "icon_text": icon or "✅", "label": label, "desc": desc})
    if not b2_items:
        b2_items = block_b2_cfg.get("items", [])
    block_b2 = {
        "title_num": field("b2_title_num", "") or block_b2_cfg.get("title_num", str(len(b2_items))),
        "title_text": field("b2_title_text", "") or block_b2_cfg.get("title_text", "大核心优势"),
        "subtitle": field("b2_subtitle", "") or block_b2_cfg.get("subtitle", ""),
        "grid_columns": block_b2_cfg.get("grid_columns", 3),
        "items": b2_items,
    }

    # Block B3
    block_b3 = dict(blocks_hc.get("block_b3", {}))
    for _f in ["header_line1", "header_line2", "caption_line1", "caption_line2", "footer_line1", "footer_line2"]:
        _v = field(f"b3_{_f}", "")
        if _v:
            block_b3[_f] = _v
    if not (block_b3.get("hero_image") or "").strip():
        block_b3["hero_image"] = product_image
    block_b3["effect_image"] = effect_image  # 有效果图时整张顶替"背景+产品图"组合区
    _floor_json = field("b3_floor_items_json", "")
    if _floor_json:
        try:
            _floor_list = json.loads(_floor_json)
            if isinstance(_floor_list, list) and _floor_list:
                block_b3["floor_items"] = _floor_list
        except (json.JSONDecodeError, ValueError):
            pass

    # Block F
    block_f = dict(blocks_hc.get("block_f", {}))
    for _f in ["title_line1", "title_line1_red", "title_line1_end",
                "title_line2", "title_line2_red",
                "vs_left_title", "vs_left_sub", "vs_right_title", "vs_right_sub",
                "vs_left_bottom", "vs_right_bottom"]:
        _v = field(f"f_{_f}", "")
        if _v:
            block_f[_f] = _v
    block_f["product_image"] = product_image
    block_f["labor_image"] = _get_labor_reference_image()
    _vs_rows_json = field("f_vs_rows_json", "")
    if _vs_rows_json:
        try:
            _vs_rows = json.loads(_vs_rows_json)
            if isinstance(_vs_rows, list) and _vs_rows:
                block_f["vs_rows"] = _vs_rows
        except (json.JSONDecodeError, ValueError):
            pass

    fixed_selling_images = [
        f"/static/{product_type}/{fname}"
        for fname in cfg.get("fixed_selling_images", [])
    ]

    extra_blocks = {k: dict(cfg.get(k, {})) for k in _EXTRA_BLOCK_KEYS}

    _g_title = field("g_brand_title", "")
    _g_sub = field("g_brand_subtitle", "")
    if _g_title:
        extra_blocks["block_g"]["brand_title"] = _g_title
    if _g_sub:
        extra_blocks["block_g"]["brand_subtitle"] = _g_sub

    if qr_image:
        extra_blocks["block_n"]["qr_image"] = qr_image

    # ── brand_stats / brand_story_lines → block_g ──
    _g_stats_raw = field("block_g_stats_json", "")
    if _g_stats_raw:
        try:
            _g_stats = json.loads(_g_stats_raw)
            if isinstance(_g_stats, list) and _g_stats:
                extra_blocks["block_g"]["brand_stats"] = _g_stats
        except (json.JSONDecodeError, ValueError):
            pass
    _g_lines_raw = field("block_g_lines_json", "")
    if _g_lines_raw:
        try:
            _g_lines = json.loads(_g_lines_raw)
            if isinstance(_g_lines, list) and _g_lines:
                extra_blocks["block_g"]["brand_story_lines"] = _g_lines
        except (json.JSONDecodeError, ValueError):
            pass

    _json_field_map = {
        "block_h_json": ("block_h", "scenes"),
        "block_i_json": ("block_i", "kpis"),
        "block_m_json": ("block_m", "steps"),
        "block_p_json": ("block_p", "compat_models"),
        "block_q_json": ("block_q", "comparisons"),
        "block_r_json": ("block_r", "package_items"),
        "block_j_json": ("block_j", "tech_items"),
        "block_s_json": ("block_s", "faqs"),
        "block_k_json": ("block_k", "badge_items"),
        "block_l_json": ("block_l", "compare_rows"),
    }
    for form_field, (block_key, data_key) in _json_field_map.items():
        _raw = field(form_field, "")
        if _raw:
            try:
                _parsed_val = json.loads(_raw)
                if isinstance(_parsed_val, list) and _parsed_val:
                    extra_blocks[block_key][data_key] = _parsed_val
            except (json.JSONDecodeError, ValueError):
                pass

    _postprocess_extra_blocks(extra_blocks, product_type=product_type)

    return {
        "product_type": product_type,
        "block_a": block_a,
        "block_b2": block_b2,
        "block_b3": block_b3,
        "block_f": block_f,
        "block_e": block_e,
        **extra_blocks,
        "fixed_selling_images": fixed_selling_images,
        "effect_image": effect_image,
        "hero_block_template": cfg.get("hero_block_template", "blocks/block_a_hero_robot_cover.html"),
        "spec_block_template": cfg.get("spec_block_template", "blocks/block_e_glass_dimension.html"),
    }


# Block rendering metadata: block_id → (template_path, display_name)
_BLOCK_REGISTRY = {
    "block_a": ("blocks/block_a_hero_robot_cover.html", "英雄首屏"),
    "block_b2": ("blocks/block_b2_icon_grid.html", "产品优势"),
    "block_b3": ("blocks/block_b3_clean_story.html", "清洁故事"),
    "block_e": ("blocks/block_e_glass_dimension.html", "产品参数"),
    "block_f": ("blocks/block_f_showcase_vs.html", "VS对比"),
    "block_g": ("blocks/block_g_brand_story.html", "品牌背书"),
    "block_h": ("blocks/block_h_scene_grid.html", "适用场景"),
    "block_i": ("blocks/block_i_kpi_strip.html", "效率数据"),
    "block_j": ("blocks/block_j_core_tech.html", "核心技术"),
    "block_k": ("blocks/block_k_cert_badges.html", "资质认证"),
    "block_l": ("blocks/block_l_service_compare.html", "服务对比"),
    "block_m": ("blocks/block_m_steps.html", "使用流程"),
    "block_n": ("blocks/block_n_quote_cta.html", "询价CTA"),
    "block_o": ("blocks/block_o_disclaimer.html", "免责声明"),
    "block_p": ("blocks/block_p_compatibility.html", "适配型号"),
    "block_q": ("blocks/block_q_before_after.html", "效果对比"),
    "block_r": ("blocks/block_r_package_list.html", "包装清单"),
    "block_s": ("blocks/block_s_faq.html", "常见问题"),
    "block_t": ("blocks/block_t_customer_cases.html", "客户案例"),
    "block_u": ("blocks/block_u_after_sales.html", "售后服务"),
    "block_v": ("blocks/block_v_model_compare.html", "型号对比"),
    "block_w": ("blocks/block_w_video_cover.html", "视频封面"),
    "block_x": ("blocks/block_x_durability.html", "实测数据"),
    "block_y": ("blocks/block_y_value_calc.html", "性价比"),
}

# Main image template registry: tpl_id → (template_path, display_name)
_MAIN_IMG_REGISTRY = {
    "main_img_1": ("blocks/main_img_1_white_bg.html", "纯白底"),
    "main_img_2": ("blocks/main_img_2_gradient_hero.html", "渐变标语"),
    "main_img_3": ("blocks/main_img_3_specs_callout.html", "参数标注"),
    "main_img_4": ("blocks/main_img_4_scene_blend.html", "场景融合"),
    "main_img_5": ("blocks/main_img_5_selling_points.html", "卖点矩阵"),
}


# 智能模块匹配：常量表
_BLOCK_ALWAYS_SHOW = {"block_a", "block_e", "block_n", "block_o"}
_BLOCK_LIST_KEYS = {
    "block_b2": "items",
    "block_h": "scenes",
    "block_i": "kpis",
    "block_j": "tech_items",
    "block_k": "badge_items",
    "block_l": "compare_rows",
    "block_m": "steps",
    "block_p": "compat_models",
    "block_q": "comparisons",
    "block_r": "package_items",
    "block_s": "faqs",
    "block_u": "promises",
    "block_v": "models",
    "block_x": "metrics",
}

_BLOCK_CONTENT_KEYS = {
    "block_b3": ("header_line1", "header_line2"),
    "block_f": (
        "title_line1",
        "title_line1_red",
        "title_line2",
        "title_line2_red",
        "vs_left_title",
        "vs_right_title",
        "vs_rows",
    ),
    "block_g": ("brand_stats", "brand_story_lines"),
    "block_t": ("cases", "client_logos", "client_count"),
    "block_w": ("video_title", "cover_image", "qr_image"),
    "block_y": ("calc_items", "cost_per_use", "coverage_text", "dilution_ratio"),
}


def _has_visible_block_value(value):
    """Return whether a template value contains something users can actually see."""
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, dict):
        return any(_has_visible_block_value(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return any(_has_visible_block_value(item) for item in value)
    return value is not None and value is not False


def _is_block_empty(block_id, block_data):
    """判断模块是否缺少有效数据——没有数据的模块不渲染。"""
    if not block_data or not isinstance(block_data, dict):
        return True
    if block_id in _BLOCK_ALWAYS_SHOW:
        return False
    if block_id in _BLOCK_LIST_KEYS:
        return not _has_visible_block_value(block_data.get(_BLOCK_LIST_KEYS[block_id]))

    if block_id in _BLOCK_CONTENT_KEYS:
        return not any(
            _has_visible_block_value(block_data.get(key))
            for key in _BLOCK_CONTENT_KEYS[block_id]
        )

    # 默认：任何非空字符串或非空列表即视为有数据
    return not any(
        (isinstance(v, str) and v.strip()) or (isinstance(v, list) and v)
        for v in block_data.values()
    )


def _render_single_block(block_id, block_data):
    """Render a single block template with its data, return HTML string."""
    reg = _BLOCK_REGISTRY.get(block_id)
    if not reg:
        return ""
    tpl_path, _ = reg
    # block_h: AI 可能返回 title 而非 name，做兼容映射
    if block_id == "block_h" and "scenes" in block_data:
        for s in block_data["scenes"]:
            if "title" in s and "name" not in s:
                s["name"] = s.pop("title")
    try:
        return render_template(tpl_path, **block_data)
    except Exception as e:
        print(f"[渲染] {block_id} 失败: {e}")
        return f'<div style="padding:20px;color:red;">模块 {block_id} 渲染失败: {e}</div>'


def _get_block_display_name(block_id):
    """Get display name for a block."""
    reg = _BLOCK_REGISTRY.get(block_id)
    return reg[1] if reg else block_id


# ── AI 精修 v2 端点 (DeepSeek planner + APIMart gpt-image-2 + Playwright 拼装) ──
# 无 key 时自动降级 mock (用 4/23 demo 的 6 张图做占位), 让 UI 能完整走通.
# 配齐 DEEPSEEK_API_KEY + REFINE_API_KEY 后自动切真实 API.
@app.route("/api/ai-refine-v2/execute", methods=["POST"])
@login_required
def ai_refine_v2_execute():
    """启动 v2 精修管线 (后台线程跑 3-5 分钟), 立即返回 task_id 供前端轮询."""
    from ai_refine_v2.refine_planner import ProductInputError, validate_product_inputs

    def _input_error(code, message):
        return jsonify({"ok": False, "code": code, "error": message}), 400

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return _input_error("AI_REFINE_REQUEST_INVALID", "请求体必须是 JSON 对象")

    try:
        product_text, product_title = validate_product_inputs(
            data.get("product_text"), data.get("product_title", ""),
        )
    except ProductInputError as exc:
        return _input_error(exc.code, str(exc))

    raw_product_image_url = data.get("product_image_url")
    if not isinstance(raw_product_image_url, str):
        return _input_error(
            "AI_REFINE_PRODUCT_IMAGE_REQUIRED",
            "缺少 product_image_url (产品主图)",
        )
    product_image_url = raw_product_image_url.strip()

    if not product_image_url:
        return _input_error(
            "AI_REFINE_PRODUCT_IMAGE_REQUIRED",
            "缺少 product_image_url (产品主图)",
        )

    # v3.2 fix (2026-04-29): 前端传的是 Web URL path (/static/uploads/xxx.png),
    # 但 _to_data_url 当 filesystem path 读 — docker 容器内真实路径是 /app/static/...
    # 不转换会导致 cutout 转换静默失败 → 12 屏全降级纯文生 → 产品形态 100% 脑补.
    # 这才是 v3.2 上生产后用户报"产品形态跟参考图不一样"的根因.
    if product_image_url.startswith("/static/"):
        rel = product_image_url[len("/static/"):]
        static_root = Path(app.static_folder).resolve()
        fs_path = (static_root / rel).resolve()
        try:
            fs_path.relative_to(static_root)
        except ValueError:
            return _input_error(
                "AI_REFINE_PRODUCT_IMAGE_INVALID",
                "产品主图路径无效，请重新上传",
            )
        if fs_path.is_file():
            product_image_url = str(fs_path)
        else:
            return _input_error(
                "AI_REFINE_PRODUCT_IMAGE_NOT_FOUND",
                "产品主图文件不存在，请重新上传",
            )

    # PRD §阶段二·任务 2.2: 前端可显式传 schema_mode='v2' 走新路径; 默认 'v1' 兼容.
    raw_schema_mode = data.get("schema_mode", "v1")
    if not isinstance(raw_schema_mode, str):
        return _input_error(
            "AI_REFINE_SCHEMA_MODE_INVALID",
            "schema_mode 必须是 'v1' 或 'v2'",
        )
    schema_mode = raw_schema_mode.strip().lower()
    if schema_mode not in ("v1", "v2"):
        return _input_error(
            "AI_REFINE_SCHEMA_MODE_INVALID",
            f"schema_mode 必须 'v1' 或 'v2', 实际 {schema_mode!r}",
        )

    # PR A (2026-05-07): 透传 product_category 给 v2 worker 用于 post-planning reorder
    # (耗材/配件类 lifestyle_demo 屏强制提到 idx=2). 缺则 None=不重排.
    raw_product_category = data.get("product_category", "")
    product_category = (
        raw_product_category.strip() or None
        if isinstance(raw_product_category, str)
        else None
    )
    if product_category and product_category not in ALLOWED_PRODUCT_TYPES:
        product_category = None  # 不合法的品类 → 静默降级不重排

    from ai_refine_v2 import pipeline_runner
    # PR C (2026-05-07): 二级 key 模式 — paid/admin 用 platform, else 用 user 自配
    try:
        deepseek_key, _ = _get_deepseek_key(current_user)
        gpt_image_key, _ = _get_gpt_image_key(current_user)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503

    task_id = pipeline_runner.start_task(
        product_text=product_text,
        product_image_url=product_image_url,
        product_title=product_title,
        deepseek_key=deepseek_key,
        gpt_image_key=gpt_image_key,
        mode=schema_mode,
        user_id=current_user.id,  # P4 §A.6: owner 标记防 IDOR
        product_category=product_category,
    )
    actual_deepseek_key, actual_gpt_image_key = pipeline_runner._apply_safety_valve(
        deepseek_key, gpt_image_key
    )
    mode = pipeline_runner._detect_mode(actual_deepseek_key, actual_gpt_image_key)
    return jsonify({
        "ok": True,
        "task_id": task_id,
        "mode": mode,
        "poll_url": f"/api/ai-refine-v2/status/{task_id}",
        "notes": (
            [] if mode == "real"
            else ["当前为 mock/partial-mock 模式: 部分或全部使用占位图. "
                  "配置 DEEPSEEK_API_KEY + REFINE_API_KEY 后自动切真实生成."]
        ),
    })


@app.route("/api/ai-refine-v2/status/<task_id>", methods=["GET"])
@login_required
def ai_refine_v2_status(task_id: str):
    """轮询 v2 精修任务进度. 返回 status / progress_pct / progress_msg / 结果字段.

    P4 §A.6 owner 校验防 IDOR: state.user_id 必须等于 current_user.id (或 admin).
    历史任务 (无 user_id) 仅 admin 可读.
    """
    from ai_refine_v2 import pipeline_runner
    state = pipeline_runner.get_task_status(task_id)
    if state is None:
        return jsonify({"error": f"任务不存在或已过期: {task_id}"}), 404
    owner_id = state.get("user_id")
    if owner_id != current_user.id and not current_user.is_admin:
        abort(403)
    return jsonify(state)


@app.route("/api/ai-refine-v2/recover/<task_id>", methods=["POST"])
@login_required
def ai_refine_v2_recover(task_id: str):
    """Continue the original provider tasks/URLs without creating a new order."""
    from ai_refine_v2 import pipeline_runner

    state = pipeline_runner.get_task_status(task_id)
    if state is None:
        return jsonify({"error": f"任务不存在或已过期: {task_id}"}), 404
    owner_id = state.get("user_id")
    if owner_id != current_user.id and not current_user.is_admin:
        abort(403)
    if state.get("status") in {"success", "partial_success"}:
        return jsonify({"ok": True, **state})
    try:
        gpt_image_key, _ = _get_gpt_image_key(current_user)
        recovered = pipeline_runner.start_task_recovery(task_id, gpt_image_key)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 409
    except RuntimeError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 503
    return jsonify({"ok": True, **recovered}), 202


@app.route("/api/workspace-results/ai-refine-v2/<task_id>", methods=["POST"])
@login_required
def workspace_result_save_ai_refine_v2(task_id: str):
    """Persist a completed homepage AI refine result so refresh can restore it."""
    from ai_refine_v2 import pipeline_runner

    state = pipeline_runner.get_task_status(task_id)
    if state is None:
        return jsonify({"error": f"任务不存在或已过期: {task_id}"}), 404
    owner_id = state.get("user_id")
    if owner_id != current_user.id and not current_user.is_admin:
        abort(403)
    terminal_status = str(state.get("status") or "").strip()
    if terminal_status not in {"success", "partial_success"}:
        return jsonify({"error": "任务尚未成功完成，不能保存到首页历史"}), 400

    image_url = (state.get("assembled_url") or "").strip()
    if not image_url:
        return jsonify({"error": "任务缺少 assembled_url，不能保存"}), 400

    data = request.get_json(silent=True) or {}
    product_category = (data.get("product_category") or "").strip()
    if product_category not in ALLOWED_PRODUCT_TYPES:
        product_category = ""
    blocks = state.get("blocks") or []
    blocks_count = len(blocks) if isinstance(blocks, list) else 0
    planned_count = int(state.get("planned_count") or blocks_count)
    success_count = int(
        state.get("success_count")
        if state.get("success_count") is not None
        else sum(
            1
            for block in blocks
            if isinstance(block, dict) and block.get("success")
        )
    )
    failed_count = int(
        state.get("failed_count")
        if state.get("failed_count") is not None
        else max(planned_count - success_count, 0)
    )
    record = {
        "kind": "ai_refine_v2",
        "task_id": task_id,
        "image_url": image_url,
        "assembled_url": image_url,
        "mode": state.get("mode") or "",
        "product_title": "",
        "product_category": product_category,
        "blocks_count": blocks_count,
        "planned_count": planned_count,
        "success_count": success_count,
        "failed_count": failed_count,
        "elapsed_s": state.get("elapsed_s") or 0,
        "cost_rmb": state.get("cost_rmb") or 0,
    }
    try:
        saved = save_workspace_result(STATIC_OUTPUTS, current_user.id, record)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True, "result": saved})


@app.route("/api/workspace-results/latest", methods=["GET"])
@login_required
def workspace_result_latest():
    """Return the latest restorable homepage generation result for this user."""
    kind = (request.args.get("kind") or "ai_refine_v2").strip()
    result = load_latest_workspace_result(
        STATIC_OUTPUTS,
        current_user.id,
        kind=kind,
        repo_root=BASE_DIR,
    )
    return jsonify({"ok": True, "result": result})



@app.route('/build/<product_type>', methods=['GET'])
@login_required
def build_form_generic(product_type):
    """Legacy route — redirect to new workspace."""
    _validate_product_type(product_type)
    return redirect(url_for('index', _external=False))


@app.route('/build/<product_type>', methods=['POST'])
@login_required
def build_submit_generic(product_type):
    _validate_product_type(product_type)
    cfg = _load_build_config(product_type)
    if not cfg:
        return f"未找到产品类型 [{product_type}] 的配置", 404

    F = request.form

    def form_text(name, default=""):
        return _fallback_text(F.get(name, ""), default)

    # ── 图片上传 ──
    product_image      = _save_upload('product_image',      auto_rembg=True)  # 产品主图自动抠白底
    scene_image        = _save_upload('scene_image')                          # 场景底图保留背景
    product_side_image = _save_upload('product_side_image', auto_rembg=True)  # 侧面图自动抠白底
    effect_image       = _save_upload('effect_image')                         # 效果图保留背景
    logo_image         = _save_upload('logo_image')
    qr_image           = _save_upload('qr_image')                            # 微信二维码

    # ── 先解析 specs（原本在下方 Block E 构建时解析，提前到这里供 hero_params 补齐用）──
    e_specs = []
    for i in range(1, 21):
        name = form_text(f'e_spec_name_{i}', '')
        value = form_text(f'e_spec_value_{i}', '')
        if name and value:
            e_specs.append({"name": name, "value": value})
    # 兜底：表单未填参数时，使用配置中的 default_specs
    if not e_specs:
        default_specs = cfg.get("default_specs", [])
        if isinstance(default_specs, list):
            e_specs = [{"name": s.get("name", ""), "value": s.get("value", "")}
                       for s in default_specs if s.get("name") and s.get("value")]

    # ── 英雄屏参数条（跳过空值、占位符、过长值；不足 2 项从 specs 补齐）──
    hero_params = []
    for i in range(1, 5):
        v = form_text(f'param_{i}_value', '').strip()
        l = form_text(f'param_{i}_label', '').strip()
        if _is_valid_spec_value(v):
            hero_params.append({"value": v, "label": l})
    hero_params = _ensure_hero_params_min2(
        hero_params,
        e_specs,
        cfg.get("ai_detail_key_priority", []) or [],
    )

    # ── Block A（英雄屏）──
    _hcov = cfg.get("hero_cover_defaults") or {}
    _def = cfg.get("defaults") or {}
    block_a = {
        "brand_text": form_text('brand_text', _def.get("brand_text", "")),
        "model_name": form_text('model_name', _def.get("model_name", "")),
        "tagline_line1": form_text('tagline_line1', _def.get("tagline_line1", "")),
        "tagline_line2": form_text('tagline_line2', _def.get("tagline_line2", "")),
        "tagline_sub": form_text('tagline_sub', _def.get("tagline_sub", "")),
        "bg_image": scene_image,
        "product_image": product_image,
        "logo_image": logo_image,
        "category_line": form_text('category_line', _hcov.get("category_line", "")),
        "main_title": form_text('main_title', _hcov.get("main_title", "")),
        "hero_subtitle_pre": form_text('hero_subtitle_pre', _hcov.get("hero_subtitle_pre", "")),
        "hero_subtitle_em": form_text('hero_subtitle_em', _hcov.get("hero_subtitle_em", "")),
        "hero_subtitle_post": form_text('hero_subtitle_post', _hcov.get("hero_subtitle_post", "")),
        "footer_note": form_text('footer_note', _hcov.get("footer_note", "")),
        "cover_image": "",
        "floor_bg_image": scene_image,
        "bg_focal": form_text('bg_focal', _hcov.get("bg_focal", "center bottom")) or "center bottom",
        "show_hero_params": True,
        "params": hero_params,
    }

    # ── Block E（参数表）──
    # e_specs 已在上方 hero_params 构建前解析,这里直接复用
    model_name = form_text('model_name', _def.get("model_name", ""))
    _e_red = form_text("e_red_bar_text", "").strip()
    _dims = cfg.get("default_dims", {})
    block_e = {
        "title": "产品参数",
        "subtitle": form_text("e_table_subtitle", "规格一览"),
        "red_bar_text": _e_red or f"{model_name}创新升级",
        "product_image": product_side_image or product_image,
        "dim_height": form_text('e_dim_height', _dims.get("height", "")),
        "dim_width":  form_text('e_dim_width',  _dims.get("width", "")),
        "dim_length": form_text('e_dim_length', _dims.get("length", "")),
        "specs": e_specs,
        "footnote": "*人工测量有误差",
    }

    # ── blocks_hardcoded（从配置读，表单值可覆盖）──
    blocks_hc = cfg.get("blocks_hardcoded", {})

    # ── Block B2（优势网格）— 完全从表单构建 ──
    block_b2_cfg = blocks_hc.get("block_b2", {})
    b2_items = []
    for i in range(1, 10):
        label = form_text(f"b2_label_{i}", "")
        icon = form_text(f"b2_icon_{i}", "")
        desc = form_text(f"b2_desc_{i}", "")
        if label:
            b2_items.append({"icon_image": "", "icon_text": icon or "✅", "label": label, "desc": desc})
    # 兜底：没有表单数据时用配置默认
    if not b2_items:
        b2_items = block_b2_cfg.get("items", [])
    block_b2 = {
        "title_num": form_text("b2_title_num", "") or block_b2_cfg.get("title_num", str(len(b2_items))),
        "title_text": form_text("b2_title_text", "") or block_b2_cfg.get("title_text", "大核心优势"),
        "subtitle": form_text("b2_subtitle", "") or block_b2_cfg.get("subtitle", ""),
        "grid_columns": block_b2_cfg.get("grid_columns", 3),
        "items": b2_items,
    }

    # ── Block B3（清洁故事）— 表单文案覆盖 ──
    block_b3 = dict(blocks_hc.get("block_b3", {}))
    for _field in ["header_line1", "header_line2", "caption_line1", "caption_line2", "footer_line1", "footer_line2"]:
        _v = form_text(f"b3_{_field}", "")
        if _v:
            block_b3[_field] = _v
    if not (block_b3.get("hero_image") or "").strip():
        block_b3["hero_image"] = product_image
    block_b3["effect_image"] = effect_image  # 有效果图时整张顶替"背景+产品图"组合区
    # AI 生成的地面材质覆盖硬编码
    _floor_json = form_text("b3_floor_items_json", "")
    if _floor_json:
        try:
            _floor_list = json.loads(_floor_json)
            if isinstance(_floor_list, list) and _floor_list:
                block_b3["floor_items"] = _floor_list
        except (json.JSONDecodeError, ValueError):
            pass

    # ── Block F（VS对比）— 表单文案覆盖 + 图片注入 ──
    block_f = dict(blocks_hc.get("block_f", {}))
    for _field in ["title_line1", "title_line1_red", "title_line1_end",
                    "title_line2", "title_line2_red",
                    "vs_left_title", "vs_left_sub", "vs_right_title", "vs_right_sub",
                    "vs_left_bottom", "vs_right_bottom"]:
        _v = form_text(f"f_{_field}", "")
        if _v:
            block_f[_field] = _v
    block_f["product_image"] = product_image
    block_f["labor_image"] = _get_labor_reference_image()
    _vs_rows_json = form_text("f_vs_rows_json", "")
    if _vs_rows_json:
        try:
            _vs_rows = json.loads(_vs_rows_json)
            if isinstance(_vs_rows, list) and _vs_rows:
                block_f["vs_rows"] = _vs_rows
        except (json.JSONDecodeError, ValueError):
            pass

    # ── 固定卖点图 ──
    fixed_selling_images = [
        f"/static/{product_type}/{fname}"
        for fname in cfg.get("fixed_selling_images", [])
    ]

    # ── 扩展积木（从配置读取默认值 + 表单覆盖）──
    extra_blocks = {k: dict(cfg.get(k, {})) for k in _EXTRA_BLOCK_KEYS}

    # 品牌背书 (block_g) — 表单文本覆盖
    _g_title = form_text("g_brand_title", "")
    _g_sub = form_text("g_brand_subtitle", "")
    if _g_title:
        extra_blocks["block_g"]["brand_title"] = _g_title
    if _g_sub:
        extra_blocks["block_g"]["brand_subtitle"] = _g_sub

    # 二维码图片覆盖 block_n
    if qr_image:
        extra_blocks["block_n"]["qr_image"] = qr_image

    # ── brand_stats / brand_story_lines → block_g ──
    _g_stats_raw = form_text("block_g_stats_json", "")
    if _g_stats_raw:
        try:
            _g_stats = json.loads(_g_stats_raw)
            if isinstance(_g_stats, list) and _g_stats:
                extra_blocks["block_g"]["brand_stats"] = _g_stats
        except (json.JSONDecodeError, ValueError):
            pass
    _g_lines_raw = form_text("block_g_lines_json", "")
    if _g_lines_raw:
        try:
            _g_lines = json.loads(_g_lines_raw)
            if isinstance(_g_lines, list) and _g_lines:
                extra_blocks["block_g"]["brand_story_lines"] = _g_lines
        except (json.JSONDecodeError, ValueError):
            pass

    # 表单 JSON 字段覆盖（AI 识别填入 → 用户可编辑 → 提交覆盖配置默认）
    _json_field_map = {
        "block_h_json": ("block_h", "scenes"),
        "block_i_json": ("block_i", "kpis"),
        "block_m_json": ("block_m", "steps"),
        "block_p_json": ("block_p", "compat_models"),
        "block_q_json": ("block_q", "comparisons"),
        "block_r_json": ("block_r", "package_items"),
        "block_j_json": ("block_j", "tech_items"),
        "block_s_json": ("block_s", "faqs"),
        "block_k_json": ("block_k", "badge_items"),
        "block_l_json": ("block_l", "compare_rows"),
    }
    for form_field, (block_key, data_key) in _json_field_map.items():
        _raw = form_text(form_field, "")
        if _raw:
            try:
                _parsed = json.loads(_raw)
                if isinstance(_parsed, list) and _parsed:
                    extra_blocks[block_key][data_key] = _parsed
            except (json.JSONDecodeError, ValueError):
                pass

    _postprocess_extra_blocks(extra_blocks, product_type=product_type)

    data = {
        "product_type": product_type,
        "block_a": block_a,
        "block_b2": block_b2,
        "block_b3": block_b3,
        "block_f": block_f,
        "block_e": block_e,
        **extra_blocks,
        "fixed_selling_images": fixed_selling_images,
        "effect_image": effect_image,
        "hero_block_template": cfg.get("hero_block_template", "blocks/block_a_hero_robot_cover.html"),
        "spec_block_template": cfg.get("spec_block_template", "blocks/block_e_glass_dimension.html"),
    }

    # 保存预览数据供导出使用（按用户隔离）
    _save_data = dict(data)
    _user_out = _user_output_dir()
    _last_preview = _user_out / f"_last_{product_type}_preview.json"
    with open(_last_preview, "w", encoding="utf-8") as fp:
        json.dump(_save_data, fp, ensure_ascii=False)

    return render_template(f"{product_type}/assembled.html", **data)


def _render_preview_modules(all_data: dict) -> list[dict]:
    """Render persisted preview data into the public workspace module DTO."""
    render_order = [
        "block_a", "block_b2", "block_b3", "block_g", "block_h", "block_i",
        "block_j", "block_f", "block_x", "block_y", "block_w", "block_v",
        "block_e", "block_k", "block_l", "block_m", "block_t", "block_u",
        "block_s", "block_p", "block_q", "block_r", "block_n", "block_o",
    ]
    modules = []
    for block_id in render_order:
        block_data = all_data.get(block_id, {})
        if _is_block_empty(block_id, block_data):
            continue
        html = _render_single_block(block_id, block_data)
        if not html or not html.strip():
            continue
        modules.append({
            "id": block_id,
            "name": _get_block_display_name(block_id),
            "html": html,
            "data": block_data,
        })
    return modules


@app.route('/api/build/<product_type>/render-preview', methods=['POST'])
@login_required
def render_preview(product_type):
    """Render all modules as HTML fragments for the workspace preview."""
    _validate_product_type(product_type)
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "缺少请求数据"}), 400

    parsed = data.get("parsed_data", {})
    # parsed_data is already mapped form-field keys (output of _map_parsed_to_form_fields
    # from the parse-text endpoint). Do NOT re-map it or all AI data is discarded.
    mapped = parsed if parsed else {}
    cfg = _load_build_config(product_type)

    images = {
        "product_image": data.get("product_image", ""),
        "scene_image": data.get("scene_image", ""),
        "logo_image": data.get("logo_image", ""),
        "qr_image": data.get("qr_image", ""),
        "product_side_image": data.get("product_side_image", ""),
        "effect_image": data.get("effect_image", ""),
    }

    all_data = _assemble_all_blocks(product_type, mapped, images, cfg)
    all_data["_workspace_meta"] = {
        "theme_id": data.get("theme_id", "classic-red"),
    }

    # Save preview data for export and restart recovery.
    _user_out = _user_output_dir()
    _last_preview = _user_out / f"_last_{product_type}_preview.json"
    with open(_last_preview, "w", encoding="utf-8") as fp:
        json.dump(all_data, fp, ensure_ascii=False)

    return jsonify({"modules": _render_preview_modules(all_data)})


@app.route('/api/build/<product_type>/latest-preview', methods=['GET'])
@login_required
def latest_preview(product_type):
    """Restore the latest local preview after an application restart."""
    _validate_product_type(product_type)
    preview_json = _user_output_dir() / f"_last_{product_type}_preview.json"
    if not preview_json.is_file():
        return jsonify({"available": False, "modules": []})
    try:
        with open(preview_json, "r", encoding="utf-8") as handle:
            all_data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return jsonify({"available": False, "modules": []})
    if not isinstance(all_data, dict):
        return jsonify({"available": False, "modules": []})
    meta = all_data.get("_workspace_meta", {})
    theme_id = meta.get("theme_id", "classic-red") if isinstance(meta, dict) else "classic-red"
    return jsonify({
        "available": True,
        "modules": _render_preview_modules(all_data),
        "theme_id": theme_id,
    })


@app.route('/api/build/<product_type>/render-block', methods=['POST'])
@login_required
def render_single_block_api(product_type):
    """Re-render a single block's HTML (for edit-and-refresh)."""
    _validate_product_type(product_type)
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "缺少请求数据"}), 400

    block_id = data.get("block_id", "")
    block_data = data.get("block_data", {})

    if not block_id or block_id not in _BLOCK_REGISTRY:
        return jsonify({"error": f"未知模块: {block_id}"}), 400

    html = _render_single_block(block_id, block_data)
    return jsonify({"html": html})


@app.route('/api/build/<product_type>/regenerate-block', methods=['POST'])
@login_required
def regenerate_block_api(product_type):
    """AI-regenerate a single block's content without affecting others."""
    _validate_product_type(product_type)
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "缺少请求数据"}), 400

    block_id = data.get("block_id", "")
    if not block_id or block_id not in _BLOCK_REGISTRY:
        return jsonify({"error": f"未知模块: {block_id}"}), 400

    parsed_data = data.get("parsed_data", {})
    images = {
        "product_image": data.get("product_image", ""),
        "scene_image": data.get("scene_image", ""),
        "logo_image": data.get("logo_image", ""),
        "qr_image": data.get("qr_image", ""),
        "product_side_image": data.get("product_side_image", ""),
        "effect_image": data.get("effect_image", ""),
    }

    # Get API key
    api_key = ""
    if hasattr(current_user, 'deepseek_api_key') and current_user.deepseek_api_key:
        api_key = current_user.deepseek_api_key

    # Build a focused prompt for regenerating just this block
    block_name = _get_block_display_name(block_id)
    raw_context = json.dumps(parsed_data, ensure_ascii=False, indent=2)

    regen_prompt = (
        f"你是清洁设备营销文案专家。请根据以下已有产品信息，重新生成「{block_name}」模块的文案。\n\n"
        f"{_EXTREME_WORDS_RULE}"
        f"已有产品信息：\n{raw_context}\n\n"
        f"请用不同的角度和表达方式重新创作该模块的文案，保持信息准确但措辞新颖。\n"
        f"返回JSON格式，只包含该模块需要的字段。\n"
    )

    import requests as req
    use_key = api_key or DEEPSEEK_API_KEY
    if not use_key:
        return jsonify({"error": "未配置 API Key"}), 400

    try:
        resp = req.post(
            DEEPSEEK_API_URL,
            headers={"Authorization": f"Bearer {use_key}"},
            json={
                "model": DEEPSEEK_MODEL,
                "messages": [
                    {"role": "system", "content": "你是清洁设备营销文案专家。只返回JSON。"},
                    {"role": "user", "content": regen_prompt}
                ],
                "temperature": 0.7,
                "max_tokens": 2000,
            },
            timeout=30,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        regen_data = _extract_json_object(content)
        if not isinstance(regen_data, dict):
            return jsonify({"error": "AI返回数据解析失败"}), 500
    except Exception as e:
        return jsonify({"error": f"AI重新生成失败: {e}"}), 500

    # Merge regenerated fields into existing block data, then re-assemble
    mapped = _map_parsed_to_form_fields(parsed_data)
    cfg = _load_build_config(product_type)
    all_data = _assemble_all_blocks(product_type, mapped, images, cfg)

    existing_block = all_data.get(block_id, {})
    # Merge regen_data into existing block data (regen takes priority for string values)
    for k, v in regen_data.items():
        if v and isinstance(v, str):
            existing_block[k] = v
        elif v and isinstance(v, list) and len(v) > 0:
            existing_block[k] = v

    html = _render_single_block(block_id, existing_block)
    return jsonify({"html": html, "data": existing_block})


# ── 主图渲染 API ───────────────────────────────────────────────────

@app.route('/api/build/<product_type>/render-main-images', methods=['POST'])
@login_required
def render_main_images(product_type):
    """Render all 5 main image templates as HTML fragments."""
    _validate_product_type(product_type)
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "缺少请求数据"}), 400

    parsed = data.get("parsed_data", {})
    tpl_data = {
        "product_image": data.get("product_image", ""),
        "scene_image": data.get("scene_image", ""),
        "logo_image": data.get("logo_image", ""),
        "model_name": parsed.get("model", ""),
        "brand_text": parsed.get("brand", ""),
        "slogan": parsed.get("slogan", ""),
        "sub_slogan": parsed.get("sub_slogan", ""),
        "hero_subtitle": parsed.get("hero_subtitle", ""),
        "category_line": parsed.get("category_line", ""),
        "advantages": parsed.get("advantages", []),
        "spec_callouts": parsed.get("spec_callouts", []),
    }

    results = []
    for tpl_id, (tpl_path, display_name) in _MAIN_IMG_REGISTRY.items():
        try:
            html = render_template(tpl_path, **tpl_data)
        except Exception as e:
            print(f"[主图渲染] {tpl_id} 失败: {e}")
            html = f'<div style="width:800px;height:800px;display:flex;align-items:center;justify-content:center;background:#f5f5f5;color:red;">渲染失败: {e}</div>'
        results.append({
            "id": tpl_id,
            "name": display_name,
            "html": html,
        })

    return jsonify({"main_images": results})


# 模块主图候选（按品类分发）
# 配件/耗材/工具：b3 清洁故事 / f 1台顶8人 依赖大段文案叙事 → 替换为 e 参数表 + b2 核心优势 icon 网格
# AI 解析端 (app.py:802) 已对配件/耗材/工具类专门生成 block_b2_items, 此处直接复用
_MAIN_BLOCK_CANDIDATES = {
    "设备类": [("block_a", "英雄封面"), ("block_b3", "清洁故事"), ("block_f",  "VS对比"),
              ("block_h", "场景网格"), ("block_c1", "数据对比")],
    "配件类": [("block_a", "英雄封面"), ("block_e",  "产品参数"), ("block_b2", "核心优势"),
              ("block_h", "场景网格"), ("block_c1", "数据对比")],
    "耗材类": [("block_a", "英雄封面"), ("block_e",  "产品参数"), ("block_b2", "核心优势"),
              ("block_b3", "清洁故事"), ("block_h",  "场景网格")],
    "工具类": [("block_a", "英雄封面"), ("block_e",  "产品参数"), ("block_b2", "核心优势"),
              ("block_h", "场景网格"), ("block_c1", "数据对比")],
}
_DEFAULT_MAIN_BLOCKS = _MAIN_BLOCK_CANDIDATES["设备类"]


def _trim_bottom_whitespace(png_bytes: bytes, bg_rgb=(255, 255, 255), tolerance: int = 8) -> bytes:
    """Crop the trailing same-color band off the bottom of a PNG.

    Why: block_a 模板 min-height:720px + flex:1 + Playwright full_page=True 在短文案
    时会在 PNG 下方留 200px+ 白带；不动模板用截后处理保通用性。
    How: 与背景色 diff → getbbox 找非背景包围盒 → 仅裁底（保留 left/top/right 不动，
    避免英雄屏深色场景被误判）。block_a 整图非白 → bbox 等于全图 → 不裁，无副作用。
    """
    from PIL import Image, ImageChops
    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    bg = Image.new("RGB", img.size, bg_rgb)
    diff = ImageChops.difference(img, bg)
    if tolerance > 0:
        diff = diff.point(lambda p: 0 if p < tolerance else p)
    bbox = diff.getbbox()
    if not bbox:
        return png_bytes
    cropped = img.crop((0, 0, img.size[0], bbox[3]))
    out = io.BytesIO()
    cropped.save(out, format="PNG", optimize=True)
    return out.getvalue()


@app.route('/export/<product_type>/main-images', methods=['POST'])
@login_required
def export_main_images_zip(product_type):
    """Export module-main-images as 750-wide PNGs.

    单图直接发 PNG (image/png),多图打 ZIP (application/zip)。候选 block 按品类分发,
    配件/耗材/工具类用 b2/e 替代长文案叙事屏 (b3/f) 保证 ≥3 张兜底产出。
    """
    _validate_product_type(product_type)
    req_data = request.get_json(silent=True) or {}
    theme_id = req_data.get("theme_id", "classic-red")

    # 读取详情预览缓存（包含所有 block 已组装好的数据）
    _user_out = _user_output_dir()
    preview_json = _user_out / f"_last_{product_type}_preview.json"
    if not preview_json.exists():
        return jsonify({"error": "请先生成详情图预览，再导出模块主图"}), 400

    with open(preview_json, "r", encoding="utf-8") as fp:
        preview_data = json.load(fp)

    # 主题 CSS 变量
    theme_vars = {}
    themes_path = BASE_DIR / "static" / "themes" / "themes.json"
    if themes_path.exists():
        with open(themes_path, "r", encoding="utf-8") as f:
            themes_data = json.load(f)
        for t in themes_data.get("themes", []):
            if t["id"] == theme_id:
                theme_vars = t.get("vars", {})
                break
    css_vars = "; ".join(f"{k}:{v}" for k, v in theme_vars.items()) if theme_vars else ""

    import zipfile
    base_url_str = str(BASE_DIR).replace("\\", "/")
    candidates = _MAIN_BLOCK_CANDIDATES.get(product_type, _DEFAULT_MAIN_BLOCKS)

    # ── Stage 1: 渲染收集所有有效图片（带 trim） ─────────────────────────
    rendered = []  # [(display_name, block_id, png_bytes), ...]
    try:
        from PIL import Image
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser = launch_chromium(
                pw,
                args=["--allow-file-access-from-files"]
            )
            ctx = browser.new_context(
                viewport={"width": 750, "height": 1200},  # 宽固定，高度由 full_page 自适应
                device_scale_factor=2,
            )

            for block_id, display_name in candidates:
                # 放宽：不再硬跳 if not block_data，让模板用 {% if %} 自己兜底
                block_data = preview_data.get(block_id) or {}
                try:
                    html = _render_single_block(block_id, block_data)
                except Exception as render_err:
                    print(f"[主图导出] {block_id} 渲染异常,跳过: {render_err}")
                    continue
                if not html or not html.strip():
                    continue

                full_html = f'''<!DOCTYPE html><html><head><meta charset="UTF-8">
                <style>*{{margin:0;padding:0;box-sizing:border-box;}} body{{width:750px;background:#fff;}}</style>
                </head><body style="{css_vars}">{html}</body></html>'''
                full_html = full_html.replace('src="/static/', f'src="file:///{base_url_str}/static/')
                full_html = full_html.replace("src='/static/", f"src='file:///{base_url_str}/static/")

                temp_html = _user_out / f"_mainimg_{block_id}_{uuid.uuid4().hex[:6]}.html"
                with open(temp_html, "w", encoding="utf-8") as f:
                    f.write(full_html)

                page = ctx.new_page()
                try:
                    page.goto(temp_html.as_uri(), wait_until="networkidle", timeout=15000)
                    page.wait_for_timeout(500)
                    png_bytes = page.screenshot(full_page=True)
                except Exception as shot_err:
                    print(f"[主图导出] {block_id} 截图异常,跳过: {shot_err}")
                    page.close()
                    try: temp_html.unlink()
                    except Exception: pass
                    continue
                page.close()
                try: temp_html.unlink()
                except Exception: pass

                # Trim 底部留白(对 block_a 深色背景无副作用; 对 b2/e/c1/h 白底关键)
                png_bytes = _trim_bottom_whitespace(png_bytes)

                # 内容过少(渲染兜底但实际为空)→ 跳过避免输出无意义图
                try:
                    h = Image.open(io.BytesIO(png_bytes)).size[1]
                except Exception:
                    h = 0
                if h < 200:
                    continue

                rendered.append((display_name, block_id, png_bytes))

            browser.close()
    except Exception as exc:
        import traceback; traceback.print_exc()
        return jsonify({"error": f"模块主图导出失败: {exc}"}), 500

    # ── Stage 2: 张数分支 ─────────────────────────────────────────────
    if len(rendered) == 0:
        return jsonify({"error": "未生成任何主图，请检查文案完整性"}), 400

    model_name = preview_data.get("block_a", {}).get("model_name", product_type)
    safe_name = _safe_download_name(model_name, product_type)

    # 单图：直发 PNG（不再强制打 ZIP 让用户多解压一步）
    if len(rendered) == 1:
        display_name, block_id, png_bytes = rendered[0]
        return send_file(
            io.BytesIO(png_bytes),
            mimetype="image/png",
            as_attachment=True,
            download_name=f"{safe_name}_{display_name}.png",
        )

    # 多图：打 ZIP
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        for display_name, block_id, png_bytes in rendered:
            zf.writestr(f"{display_name}_{block_id}.png", png_bytes)
    zip_buffer.seek(0)
    return send_file(
        zip_buffer, mimetype="application/zip",
        as_attachment=True,
        download_name=f"{safe_name}.zip"
    )


# ── 导出PNG（Playwright截图）────────────────────────────────────────

@app.route('/export/<product_type>', methods=['POST'])
@login_required
def export_generic(product_type):
    _validate_product_type(product_type)
    _user_out = _user_output_dir()
    preview_json = _user_out / f"_last_{product_type}_preview.json"
    if not preview_json.exists():
        return jsonify({"error": "没有预览数据，请先生成预览"}), 400

    with open(preview_json, "r", encoding="utf-8") as fp:
        data = json.load(fp)

    # Get module order and hidden modules from request
    req_data = request.get_json(silent=True) or {}
    module_order = req_data.get("module_order", [])
    hidden_modules = set(req_data.get("hidden_modules", []))
    parameter_only = req_data.get("scope") == "parameter"
    theme_id = req_data.get("theme_id", "classic-red")
    # 导出格式: png (无损,默认,~5MB) | jpg (quality 90,~1.5-2MB,适合电商上传)
    export_format = (req_data.get("format") or "png").lower()
    if export_format not in ("png", "jpg"):
        export_format = "png"
    is_jpg = export_format == "jpg"

    # Load theme CSS vars
    theme_vars = {}
    themes_path = BASE_DIR / "static" / "themes" / "themes.json"
    if themes_path.exists():
        with open(themes_path, "r", encoding="utf-8") as f:
            themes_data = json.load(f)
        for t in themes_data.get("themes", []):
            if t["id"] == theme_id:
                theme_vars = t.get("vars", {})
                break
    css_vars_str = "; ".join(f"{k}:{v}" for k, v in theme_vars.items()) if theme_vars else ""

    if parameter_only:
        requested_parameter_data = req_data.get("parameter_data")
        block_e = requested_parameter_data if isinstance(requested_parameter_data, dict) else data.get("block_e")
        block_e = block_e if isinstance(block_e, dict) else {}
        parameter_data, validation_error = _sanitize_parameter_export_data(block_e)
        if validation_error:
            return jsonify({"error": validation_error}), 400

        data = dict(data)
        data["block_e"] = parameter_data
        module_order = ["block_e"]
        hidden_modules = set()

    if module_order:
        # Render blocks individually in user-specified order, skipping hidden
        block_htmls = []
        for bid in module_order:
            if bid in hidden_modules:
                continue
            block_data = data.get(bid, {})
            html = _render_single_block(bid, block_data)
            if html and html.strip():
                block_htmls.append(html)
        if parameter_only and not block_htmls:
            return jsonify({"error": "产品参数图渲染失败，请重新生成"}), 500

        # 参数图必须保持单图；普通详情导出继续附带固定销售图。
        fixed_imgs_html = ""
        fixed_selling_images = [] if parameter_only else data.get("fixed_selling_images", [])
        for img_url in fixed_selling_images:
            if img_url:
                fixed_imgs_html += f'<div class="screen"><img style="width:750px;display:block;" src="{img_url}" alt=""></div>'

        rendered_blocks_html = "".join(block_htmls)
        if parameter_only:
            rendered_blocks_html = (
                '<div id="parameter-export-root" style="width:750px;overflow:hidden;">'
                f'{rendered_blocks_html}</div>'
            )

        html_content = f'''<!DOCTYPE html><html><head><meta charset="UTF-8">
        <style>*{{margin:0;padding:0;box-sizing:border-box;}} body{{width:750px;background:#fff;}}</style>
        </head><body style="{css_vars_str}">
        {rendered_blocks_html}
        {fixed_imgs_html}
        </body></html>'''
    else:
        # Fallback: use assembled template (legacy)
        data["export_mode"] = True
        tpl = f"{product_type}/assembled.html"
        html_content = render_template(tpl, **data)

    base_url_str = str(BASE_DIR).replace("\\", "/")
    html_content = html_content.replace('src="/static/', f'src="file:///{base_url_str}/static/')
    html_content = html_content.replace("src='/static/", f"src='file:///{base_url_str}/static/")

    temp_html = OUTPUT_DIR / f"_export_{product_type}_{current_user.id}_{uuid.uuid4().hex[:8]}.html"
    with open(temp_html, "w", encoding="utf-8") as f:
        f.write(html_content)

    from datetime import datetime
    model_name = data.get("block_a", {}).get("model_name", product_type)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    # 服务端文件名含时间戳避免同型号重复导出覆盖;下载文件名只给用户看产品名
    ext = "jpg" if is_jpg else "png"
    scope_suffix = "_产品参数" if parameter_only else ""
    server_filename = f"{product_type}_{model_name}{scope_suffix}_{timestamp}.{ext}"
    download_filename = f"{_safe_download_name(model_name, product_type)}{scope_suffix}.{ext}"
    _user_outputs = STATIC_OUTPUTS / str(current_user.id)
    _user_outputs.mkdir(parents=True, exist_ok=True)
    out_path = _user_outputs / server_filename

    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser = launch_chromium(
                pw,
                args=["--allow-file-access-from-files"]
            )
            ctx = browser.new_context(
                viewport={"width": 750, "height": 900},
                device_scale_factor=2,
            )
            page = ctx.new_page()
            page.goto(temp_html.as_uri(), wait_until="networkidle", timeout=30000)
            page.wait_for_timeout(2000)
            screenshot_options = {"path": str(out_path)}
            if is_jpg:
                # quality 90: 肉眼几乎无损,750x3000 长图约 1.5-2MB,适合电商上传
                screenshot_options.update({"type": "jpeg", "quality": 90})
            if parameter_only:
                parameter_root = page.locator("#parameter-export-root")
                parameter_root.wait_for(state="visible")
                parameter_root.screenshot(**screenshot_options)
            else:
                page.screenshot(full_page=True, **screenshot_options)
            browser.close()
    except Exception as exc:
        import traceback; traceback.print_exc()
        return jsonify({"error": f"Playwright截图失败: {exc}"}), 500

    # 记录导出日志
    log = GenerationLog(
        user_id=current_user.id,
        product_type=product_type,
        model_name=data.get("block_a", {}).get("model_name", ""),
        api_key_source="",
        action="export",
    )
    db.session.add(log)
    db.session.commit()

    return send_file(str(out_path),
                     mimetype="image/jpeg" if is_jpg else "image/png",
                     as_attachment=True, download_name=download_filename)


# ── 设备类静态预览（调试用）──────────────────────────────────────────

@app.route("/preview/设备类")
@login_required
def preview_equipment():
    cfg = _load_build_config(PRODUCT_TYPE) or {}
    _bhc = cfg.get("blocks_hardcoded") or {}
    _defs = cfg.get("defaults") or {}
    _hcov = cfg.get("hero_cover_defaults") or {}
    _dims = cfg.get("default_dims") or {}

    fixed_selling_images = [
        f"/static/{PRODUCT_TYPE}/{fname}"
        for fname in cfg.get("fixed_selling_images", [])
    ]

    data = {
        "product_type": PRODUCT_TYPE,
        "hero_block_template": cfg.get("hero_block_template", "blocks/block_a_hero_robot_cover.html"),
        "spec_block_template": cfg.get("spec_block_template", "blocks/block_e_glass_dimension.html"),
        "fixed_selling_images": fixed_selling_images,
        "block_a": {
            "brand_text": _defs.get("brand_text", ""),
            "model_name": _defs.get("model_name", ""),
            "bg_image": "",
            "product_image": "",
            "tagline_line1": _defs.get("tagline_line1", ""),
            "tagline_line2": _defs.get("tagline_line2", ""),
            "tagline_sub": _defs.get("tagline_sub", ""),
            "logo_image": "",
            "category_line": _hcov.get("category_line", ""),
            "main_title": _hcov.get("main_title", ""),
            "hero_subtitle_pre": _hcov.get("hero_subtitle_pre", ""),
            "hero_subtitle_em": _hcov.get("hero_subtitle_em", ""),
            "hero_subtitle_post": _hcov.get("hero_subtitle_post", ""),
            "footer_note": _hcov.get("footer_note", ""),
            "cover_image": f"/static/{PRODUCT_TYPE}/{cfg.get('default_cover_image', '')}",
            "floor_bg_image": "",
            "bg_focal": _hcov.get("bg_focal", "center bottom"),
            "show_hero_params": False,
            "params": [
                {"value": hp.get("default_value", ""), "label": hp.get("label", "")}
                for hp in cfg.get("hero_params", [])
            ],
        },
        "block_b2": _bhc.get("block_b2", {}),
        "block_b3": dict(_bhc.get("block_b3", {})),
        "block_f": dict(_bhc.get("block_f", {})),
        "block_e": {
            "title": "产品参数",
            "subtitle": "规格一览",
            "red_bar_text": f"{_defs.get('model_name', '')}创新升级",
            "product_image": "",
            "dim_height": _dims.get("height", ""),
            "dim_width": _dims.get("width", ""),
            "dim_length": _dims.get("length", ""),
            "specs": [
                {"name": x.get("name", ""), "value": x.get("value", "")}
                for x in cfg.get("default_specs", [])
            ],
            "footnote": "*人工测量有误差",
        },
        **{k: cfg.get(k, {}) for k in _EXTRA_BLOCK_KEYS},
    }
    return render_template(f"{PRODUCT_TYPE}/assembled.html", **data)


# ────────────────────────────────────────────────────────────────────

def _kill_old_flask(port=5000):
    """启动前自动清理占用端口的旧 Flask 进程（Windows）"""
    import subprocess
    try:
        result = subprocess.run(
            ["netstat", "-ano"], capture_output=True, text=True, timeout=5
        )
        pids = set()
        for line in result.stdout.splitlines():
            if f":{port}" in line and "LISTENING" in line:
                parts = line.split()
                if parts:
                    pids.add(parts[-1])
        my_pid = str(os.getpid())
        pids.discard(my_pid)
        pids.discard("0")
        for pid in pids:
            print(f"[启动] 杀掉旧进程 PID={pid} (占用端口 {port})")
            subprocess.run(["taskkill", "/F", "/PID", pid],
                           capture_output=True, timeout=5)
    except Exception as e:
        print(f"[启动] 清理旧进程时出错(可忽略): {e}")


# ── 注册蓝图 ──
from auth import auth_bp
from admin import admin_bp
app.register_blueprint(auth_bp)
app.register_blueprint(admin_bp)

# ── CLI 命令：创建管理员 ──
import click

@app.cli.command("create-admin")
@click.option("--username", prompt=True, help="管理员用户名")
@click.option("--password", prompt=True, hide_input=True, confirmation_prompt=True, help="管理员密码")
def create_admin(username, password):
    """创建管理员账号"""
    existing = User.query.filter_by(username=username).first()
    if existing:
        click.echo(f"用户 {username} 已存在")
        return
    admin = User(username=username, is_admin=True, is_approved=True, is_paid=True)
    admin.set_password(password)
    db.session.add(admin)
    db.session.commit()
    click.echo(f"管理员 {username} 创建成功")

# ── 启动时自动建表 ──
# 本地 SQLite / 首次部署的兜底. 生产强烈建议走 alembic (flask db upgrade), 不靠 create_all.
# create_all 的缺点: 不会对已有表做结构变更 (加字段/改约束), 也不会产生可审计 migration 记录.
# 跳过 create_all 的两种情况:
#   1. ALEMBIC_AUTOGEN=1   — 正在跑 flask db migrate/revision 生成基线, 必须对空库比 diff
#   2. 运维显式走 flask db upgrade — 让 alembic 来建表 (不需要 create_all 兜底)
_skip_create_all = os.environ.get("ALEMBIC_AUTOGEN", "").strip() == "1"
with app.app_context():
    if not _skip_create_all:
        db.create_all()

    # ── 启动恢复: gunicorn 重启 / 容器重建后, DB 里仍有 processing/pending 状态的记录 ──
    # worker 线程已经没了, 不会有人把它们跑完; 统一标记成 failed + 写明原因,
    # 让用户在前端看见后手动重跑. 故意不做 auto-resubmit, 因为:
    #   1. 精修条目 (want_ai_refine=true) 调豆包要花钱, 不能"静默重跑" (¥10.8 事故教训)
    #   2. HTML 渲染虽然不花钱, 但用户可能只想看当前状态再决定, 不该抢手
    # 该逻辑幂等: 首次启动表里没记录就是 no-op; 每次重启各扫一轮.
    if _skip_create_all:
        # alembic autogen 环境下表可能还不存在, 跳过恢复扫描 (无业务意义)
        print("[startup-recovery] ALEMBIC_AUTOGEN=1, 跳过状态恢复扫描", flush=True)
    else:
        try:
            from datetime import datetime as _dt_sr

            _restart_ts = _dt_sr.utcnow()
            _RESTART_MSG = "服务重启中断, 请手动重新提交"

            _stuck_items = BatchItem.query.filter(
                BatchItem.status.in_(["pending", "processing"])
            ).all()
            for _it in _stuck_items:
                _it.status = "failed"
                _it.error = _RESTART_MSG
                _it.finished_at = _restart_ts

            _stuck_refine = BatchItem.query.filter(
                BatchItem.ai_refine_status.in_(["pending", "processing"])
            ).all()
            for _it in _stuck_refine:
                _it.ai_refine_status = "failed"
                if not _it.error:
                    _it.error = _RESTART_MSG

            _stuck_batches = Batch.query.filter(
                Batch.status.in_(["queued", "running"])
            ).all()
            for _b in _stuck_batches:
                _b.status = "failed"

            if _stuck_items or _stuck_refine or _stuck_batches:
                db.session.commit()
                print(
                    f"[startup-recovery] 标记中断: batches={len(_stuck_batches)}, "
                    f"items={len(_stuck_items)}, refine_items={len(_stuck_refine)}",
                    flush=True,
                )
            else:
                print("[startup-recovery] 无中断记录, 干净启动", flush=True)
        except Exception as _e:
            import traceback as _tb_sr
            _tb_sr.print_exc()
            print(f"[startup-recovery] 扫描中断状态失败: {_e} (跳过, 不阻塞启动)",
                  flush=True)
            db.session.rollback()


if __name__ == "__main__":
    _kill_old_flask(5000)
    print("=" * 50)
    print("  小玺AI产品详情页生成器 - Web UI")
    print("=" * 50)
    print(f"  入口: http://localhost:5000/build/{PRODUCT_TYPE}")
    print(f"  预览: http://localhost:5000/preview/{PRODUCT_TYPE}")
    print("=" * 50)
    app.run(debug=True, port=5000, use_reloader=False)
