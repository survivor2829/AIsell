"""守护测: CSRF token 寿命延长到 24h (防浏览器开页面 1h+ 后 POST 报 400).

真实事故 (2026-05-07): 用户报"prod 登录页 POST 时 Bad Request 400"——curl
模拟登录返 200, 复现失败. 根因 = flask-wtf 默认 WTF_CSRF_TIME_LIMIT=3600s
(1h). 用户开 login 页 1+ 小时后回来填密码登录, csrf_token 已过期 → 后端
拒绝 → 400. 修法 = 改 24h, 给"开页面放着不管"的常见用户行为留余量.
"""
from __future__ import annotations
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
APP_PY = REPO / "app.py"


class TestCsrfTimeLimitConfig:
    """守护: app.py 必须显式设 WTF_CSRF_TIME_LIMIT 至少 24h (86400s)."""

    def test_app_py_sets_csrf_time_limit(self):
        content = APP_PY.read_text(encoding="utf-8")
        assert "WTF_CSRF_TIME_LIMIT" in content, (
            "app.py 必须显式设 WTF_CSRF_TIME_LIMIT, 不能依赖 flask-wtf 默认 3600s. "
            "用户报真实事故: 浏览器开 login 页 1h+ 后 POST 报 400 (csrf 过期)."
        )

    def test_csrf_time_limit_at_least_24h(self):
        from app import app
        # flask-wtf 看 app.config["WTF_CSRF_TIME_LIMIT"], 单位秒
        # None = 永不过期; >0 = 秒数
        v = app.config.get("WTF_CSRF_TIME_LIMIT")
        assert v is not None, (
            "WTF_CSRF_TIME_LIMIT 未设. 默认 3600s (1h) 太短, 用户体验差."
        )
        assert v >= 86400, (
            f"WTF_CSRF_TIME_LIMIT={v}s 太短 (推荐 ≥ 86400s = 24h). "
            f"用户开 login 页放着 N 小时后回来 POST 不应报 400."
        )


class TestCsrfStillEnabled:
    """守护: 防回归 — CSRFProtect 必须仍启用 (我们只改 time limit, 不能关 CSRF)."""

    def test_csrfprotect_initialized(self):
        content = APP_PY.read_text(encoding="utf-8")
        assert "CSRFProtect(app)" in content, (
            "app.py 必须仍调 CSRFProtect(app) — 我们只改 time limit, "
            "不能因此关掉 CSRF 保护"
        )

    def test_csrf_not_disabled_in_source_code(self):
        """守护源码层面: app.py 不能含 WTF_CSRF_ENABLED = False (其他测试可
        在测内 override 该 config 关 CSRF, 但 source code 不应永久关).
        """
        content = APP_PY.read_text(encoding="utf-8")
        # app.py 不应有 'WTF_CSRF_ENABLED' = False / 0 这种永久禁用语句
        # (允许 .config[...]= False 在 conftest / 单测内临时关, 不影响 prod)
        bad_patterns = [
            'config["WTF_CSRF_ENABLED"] = False',
            "config['WTF_CSRF_ENABLED'] = False",
            "WTF_CSRF_ENABLED=False",
        ]
        for bad in bad_patterns:
            assert bad not in content, (
                f"app.py 不应含 {bad!r} (永久关 CSRF). "
                f"测试时如需关, 在 conftest/单测内临时 override."
            )
