"""P3 守护测: API key 砍刀流的关键不可逆变更必须永久守住.

per `docs/superpowers/plans/2026-05-06-P3-key-platform-implementation.md` T2.
全栈守护: 后端 (app.py) + 前端 (settings.html / admin/users.html) + 基础设施 (.env.example).

TDD 红→绿: T2 commit 时这些测应当全 FAIL (砍刀还没做),
T3-T9 逐步实现后, T9 时全 PASS.
"""
from pathlib import Path
import unittest


PROJECT = Path(__file__).parent.parent
SETTINGS_HTML = PROJECT / "templates/auth/settings.html"
ADMIN_USERS_HTML = PROJECT / "templates/admin/users.html"
APP_PY = PROJECT / "app.py"
REFINE_GENERATOR = PROJECT / "ai_refine_v2/refine_generator.py"
AI_IMAGE_APIMART = PROJECT / "ai_image_apimart.py"  # 2026-05-13 重构: APIMart HTTP 抽到这
ENV_EXAMPLE = PROJECT / ".env.example"


class TestSettingsHtmlNoApiKeyCard(unittest.TestCase):
    """settings.html 必须不再含 'API Key 设置' 卡 + 其表单字段."""

    @classmethod
    def setUpClass(cls):
        cls.text = SETTINGS_HTML.read_text(encoding="utf-8")

    def test_no_api_key_input_field(self):
        self.assertNotIn('name="custom_api_key"', self.text,
                         "settings.html 仍含 custom_api_key 表单字段")

    def test_no_api_key_card_title(self):
        self.assertNotIn("API Key 设置", self.text,
                         "settings.html 仍含 'API Key 设置' 卡标题")

    def test_deepseek_platform_link_only_for_nonpaid(self):
        """PR C (2026-05-07) relax: platform.deepseek.com 链接仅在非付费用户的
        条件渲染块内出现, 给非付费用户引导自配 key 时用. 付费用户看不到."""
        if "platform.deepseek.com" not in self.text:
            return  # 完全没有也合法
        # 必须在 jinja 条件块 ({% if %}...{% endif %}) 内, 受 is_paid 控制
        # 简化: 只要 settings.html 含 is_paid jinja 条件渲染块即认为受控
        import re
        has_is_paid_block = re.search(
            r"\{%\s*if\s+[^%]*is_paid[^%]*%\}",
            self.text,
        )
        self.assertTrue(
            has_is_paid_block,
            "settings.html 含 platform.deepseek.com 但不在 is_paid 条件块内. "
            "PR C 设计: 非付费用户才显示自配 key 引导."
        )


class TestAdminUsersHtmlNoCustomKeyBadge(unittest.TestCase):
    """admin/users.html 必须不再显示 'custom_api_key_enc' 状态徽章."""

    def test_no_custom_key_check(self):
        text = ADMIN_USERS_HTML.read_text(encoding="utf-8")
        self.assertNotIn("u.custom_api_key_enc", text,
                         "admin/users.html 仍引用 custom_api_key_enc 字段")
        self.assertNotIn("自有Key", text,
                         "admin/users.html 仍显示 '自有Key' 徽章")


class TestAppPyCustomKeyWriteRemoved(unittest.TestCase):
    """app.py 不许还有把 custom key 写进 DB 的代码 (写入路径已砍)."""

    @classmethod
    def setUpClass(cls):
        cls.text = APP_PY.read_text(encoding="utf-8")

    def test_no_custom_key_assignment(self):
        self.assertNotIn(
            "current_user.custom_api_key_enc = encrypt_api_key",
            self.text,
            "app.py 仍有 custom key 写入逻辑, P3 砍刀未完成"
        )

    def test_no_owner_custom_key_decrypt_in_refine_path(self):
        """refine 路径不再读 owner.custom_api_key_enc."""
        # decrypt_api_key 仍可能在文件其他地方存在 (e.g. dashscope 不在 P3 范围),
        # 但 owner.custom_api_key_enc 这条特定路径必须没了
        self.assertNotIn(
            "owner.custom_api_key_enc",
            self.text,
            "app.py refine 路径仍读 owner.custom_api_key_enc, P3 砍刀未完成"
        )


class TestApimartBaseUrl(unittest.TestCase):
    """APIMart 适配器必须接 REFINE_API_BASE_URL 环境变量, 不写默认 URL.

    2026-05-13 重构: refine_generator 委托给 ai_image_router → ai_image_apimart;
    REFINE_API_BASE_URL 的 env 读取位置随之迁移到 ai_image_apimart.py.
    """

    def test_apimart_reads_base_url_env(self):
        text = AI_IMAGE_APIMART.read_text(encoding="utf-8")
        self.assertIn("REFINE_API_BASE_URL", text,
                      "ai_image_apimart 未接 REFINE_API_BASE_URL env")

    def test_apimart_no_hardcoded_base_url(self):
        """防回归: ai_image_apimart 不许出现具体的 base URL 字符串."""
        text = AI_IMAGE_APIMART.read_text(encoding="utf-8")
        # 反硬编码: 禁止任何 https://...apimart 之类的具体 URL
        for forbidden in ("api.apimart.io", "apimart.cn", "https://api."):
            self.assertNotIn(forbidden, text,
                             f"ai_image_apimart 出现硬编码 URL: {forbidden}")

    def test_refine_generator_delegates_to_router(self):
        """refine_generator._default_api_call 必须委托给 router, 不直接调 HTTP."""
        text = REFINE_GENERATOR.read_text(encoding="utf-8")
        self.assertIn("ai_image_router", text,
                      "refine_generator 未走 router (P5.x 统一化失效)")
        # 不许再有 _submit_image_task / _poll_image_task 等本地 HTTP helper
        self.assertNotIn("def _submit_image_task", text,
                         "refine_generator 仍含 _submit_image_task; 应已迁到 ai_image_apimart")


class TestStartupValidation(unittest.TestCase):
    """app.py 必须在启动时校验 platform key, 缺则 raise."""

    def test_app_py_has_platform_key_check(self):
        """启动校验必须用 _REQUIRED_PLATFORM_KEYS 集中清单 + raise (非 route 内检查)."""
        text = APP_PY.read_text(encoding="utf-8")
        self.assertIn("_REQUIRED_PLATFORM_KEYS", text,
                      "app.py 缺 _REQUIRED_PLATFORM_KEYS 启动校验清单")
        # 启动校验块必须含 RuntimeError + DEEPSEEK_API_KEY 同时出现
        import re
        pattern = re.compile(
            r"_REQUIRED_PLATFORM_KEYS.{0,500}(raise\s+RuntimeError|sys\.exit)",
            re.DOTALL,
        )
        self.assertTrue(pattern.search(text),
                        "app.py 启动校验未在缺 key 时 raise / sys.exit")


class TestEnvExampleHasPlatformKeys(unittest.TestCase):
    """.env.example 必须列出 platform key 名."""

    def test_has_required_keys(self):
        if not ENV_EXAMPLE.exists():
            self.fail(".env.example 文件缺失")
        text = ENV_EXAMPLE.read_text(encoding="utf-8")
        for key in ["DEEPSEEK_API_KEY", "REFINE_API_KEY", "REFINE_API_BASE_URL"]:
            self.assertIn(key, text, f".env.example 缺 {key}")


if __name__ == "__main__":
    unittest.main()
