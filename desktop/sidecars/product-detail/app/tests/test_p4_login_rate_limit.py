"""P4 §A.4 登录无 rate-limit 修复 — 守护测试.

per `docs/superpowers/specs/_stubs/A4-login-no-ratelimit-stub.md` 方案 A.

漏洞: /auth/login POST 端点无频率限制. 5 个 demo 客户即将试用,
密码最低 6 字符 → 公网暴力破解秒破.

修复:
  - 加 flask-limiter 依赖
  - extensions.py 实例化 limiter (key_func=get_remote_address)
  - app.py limiter.init_app(app)
  - auth.py login route 加 @limiter.limit("5 per minute; 20 per hour")

本测试组防止未来 PR 删除 rate-limit 装饰器或换成 no-op.
"""
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
AUTH_PY = REPO_ROOT / "auth.py"
EXTENSIONS_PY = REPO_ROOT / "extensions.py"
APP_PY = REPO_ROOT / "app.py"
REQUIREMENTS = REPO_ROOT / "requirements.txt"


class TestRequirementsListsLimiter:
    """守护: requirements.txt 必须列出 flask-limiter."""

    def test_flask_limiter_in_requirements(self):
        content = REQUIREMENTS.read_text(encoding="utf-8")
        # 接受 'flask-limiter' / 'Flask-Limiter' / 'flask_limiter' 任意写法
        has_limiter = re.search(r'flask[-_]limiter', content, re.I)
        assert has_limiter, (
            "requirements.txt 必须列出 flask-limiter; "
            "安装命令: pip install \"flask-limiter>=3.5\""
        )


class TestExtensionsHasLimiter:
    """守护: extensions.py 必须实例化 Limiter."""

    def test_limiter_instance_exists(self):
        content = EXTENSIONS_PY.read_text(encoding="utf-8")
        # 必须 import + 实例化 limiter
        has_import = "from flask_limiter import" in content or "import flask_limiter" in content
        has_instance = re.search(r'^limiter\s*=\s*Limiter\s*\(', content, re.M)
        assert has_import, "extensions.py 必须 import flask_limiter"
        assert has_instance, (
            "extensions.py 必须有 module-level `limiter = Limiter(...)` 实例; "
            "供 app.py init_app + auth.py 引用 装饰器."
        )

    def test_limiter_uses_remote_address_key(self):
        """限流 key_func 必须基于 IP (get_remote_address)."""
        content = EXTENSIONS_PY.read_text(encoding="utf-8")
        has_remote_addr = "get_remote_address" in content
        assert has_remote_addr, (
            "Limiter key_func 必须用 get_remote_address (按客户端 IP 限流). "
            "from flask_limiter.util import get_remote_address"
        )


class TestAppPyInitsLimiter:
    """守护: app.py 必须调 limiter.init_app(app)."""

    def test_app_py_inits_limiter(self):
        content = APP_PY.read_text(encoding="utf-8")
        has_init = re.search(r'limiter\.init_app\s*\(\s*app\s*\)', content)
        assert has_init, (
            "app.py 必须调 limiter.init_app(app), "
            "否则 @limiter.limit 装饰器不生效."
        )


class TestLoginRouteHasRateLimit:
    """守护: auth.py login 路由必须有 @limiter.limit 装饰器."""

    def test_login_route_decorated_with_limit(self):
        content = AUTH_PY.read_text(encoding="utf-8")
        # 找 def login 函数前的装饰器堆
        match = re.search(
            r'((?:@\w[^\n]*\n)+)def login\s*\(',
            content,
        )
        assert match, "找不到 login 函数定义"
        decorators = match.group(1)
        has_limit = "limiter.limit" in decorators or "@limiter" in decorators
        assert has_limit, (
            "auth.py login 函数必须有 @limiter.limit 装饰器. "
            "推荐: @limiter.limit(\"5 per minute; 20 per hour\")"
        )

    def test_login_limit_is_strict_enough(self):
        """限流值必须不超过 10/分钟 (防暴力破解)."""
        content = AUTH_PY.read_text(encoding="utf-8")
        # 找 limiter.limit("...") 字符串
        match = re.search(r'limiter\.limit\s*\(\s*["\']([^"\']+)["\']', content)
        if not match:
            return  # 上一个测试会捕获缺装饰器的情况
        rule = match.group(1)
        # 抓 "N per minute" 部分
        per_min = re.search(r'(\d+)\s*per\s+minute', rule, re.I)
        if per_min:
            n = int(per_min.group(1))
            assert n <= 10, (
                f"login 限流 {n}/min 太松, 暴力破解风险. "
                f"推荐 5/min 或更严格."
            )


class TestAuthImportsLimiter:
    """守护: auth.py 必须 import limiter 才能用装饰器."""

    def test_auth_imports_limiter(self):
        content = AUTH_PY.read_text(encoding="utf-8")
        has_import = re.search(r'from\s+extensions\s+import.*limiter', content) or \
                     re.search(r'import\s+limiter', content)
        assert has_import, (
            "auth.py 必须 from extensions import limiter, "
            "否则 @limiter.limit 装饰器找不到 limiter."
        )
