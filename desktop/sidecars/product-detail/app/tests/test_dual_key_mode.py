"""守护测: PR C — 付费/Key 二级模式 (部分回退 P3 砍刀流).

需求 (用户 2026-05-07):
- 付费用户 (User.is_paid=True) → 用 platform key (admin 配 env DEEPSEEK_API_KEY/GPT_IMAGE_API_KEY)
- 非付费用户 (is_paid=False) → 自配 custom_deepseek_key_enc + custom_gpt_image_key_enc
- settings 页面恢复 key 配置 UI, 仅未付费用户可见
- admin 永远走 platform key (相当于 implicit is_paid=True)

DB schema 改动:
- 新加 User.custom_deepseek_key_enc (Fernet 加密)
- 新加 User.custom_gpt_image_key_enc (Fernet 加密)
- 老字段 custom_api_key_enc 保留 (alembic migration 复制到 deepseek_key)

P3 守护测 relax (不删, update 后仍守住核心安全不变量):
- TestSettingsHtmlNoApiKeyCard → relax: paid 用户仍不显示, non-paid 显示
- TestAppPyCustomKeyWriteRemoved → relax: 写入必须 gated 在 is_paid=False
"""
from __future__ import annotations
import re
import os
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
APP_PY = REPO / "app.py"
MODELS_PY = REPO / "models.py"
SETTINGS_HTML = REPO / "templates" / "auth" / "settings.html"


class TestNewKeyColumns:
    """守护: User 模型必须新增 2 个 custom key 列."""

    def test_models_has_custom_deepseek_key_enc(self):
        content = MODELS_PY.read_text(encoding="utf-8")
        assert "custom_deepseek_key_enc" in content, (
            "models.py User 模型必须含 custom_deepseek_key_enc 列 "
            "(Fernet 加密的 DeepSeek key)"
        )

    def test_models_has_custom_gpt_image_key_enc(self):
        content = MODELS_PY.read_text(encoding="utf-8")
        assert "custom_gpt_image_key_enc" in content, (
            "models.py User 模型必须含 custom_gpt_image_key_enc 列 "
            "(Fernet 加密的 GPT-image-2 key)"
        )

    def test_old_custom_api_key_enc_still_exists(self):
        """老字段保留 (向后兼容历史数据 + alembic migration 来源)."""
        content = MODELS_PY.read_text(encoding="utf-8")
        assert "custom_api_key_enc" in content, (
            "老字段 custom_api_key_enc 必须保留, alembic migration 用它当 deepseek_key 数据源"
        )


class TestAlembicMigration:
    """守护: alembic migration 文件存在, 含 UPGRADE + DOWNGRADE."""

    def test_migration_file_exists(self):
        files = list((REPO / "migrations" / "versions").glob("*dual_key*.py"))
        assert files, (
            "migrations/versions/ 必须有 dual key 相关 migration "
            "(为 custom_deepseek_key_enc + custom_gpt_image_key_enc 加列)"
        )

    def test_migration_adds_both_columns(self):
        files = list((REPO / "migrations" / "versions").glob("*dual_key*.py"))
        assert files, "找不到 dual key migration 文件"
        content = files[0].read_text(encoding="utf-8")
        assert "custom_deepseek_key_enc" in content, "migration 缺 deepseek 列添加"
        assert "custom_gpt_image_key_enc" in content, "migration 缺 gpt_image 列添加"
        assert "def upgrade" in content, "migration 必须有 upgrade()"
        assert "def downgrade" in content, "migration 必须有 downgrade() (回滚)"


class TestGetDeepseekKeyHelper:
    """守护: app.py 必须有 _get_deepseek_key(user) 二级模式 helper."""

    def test_helper_exists(self):
        content = APP_PY.read_text(encoding="utf-8")
        assert re.search(r"def\s+_get_deepseek_key\s*\(", content), (
            "app.py 必须定义 _get_deepseek_key(user) helper "
            "(二级模式 dispatcher: paid → platform, else → custom)"
        )

    def test_helper_checks_is_paid(self):
        """二级模式 dispatcher 必须检查 is_paid (或 is_admin) 决定走 platform 还是 custom.

        2026-05-09 重构后接受 2 种结构:
        (a) 老结构: _get_deepseek_key 内联 is_paid 检查
        (b) 新结构: _get_deepseek_key 是薄 wrapper, 检查抽到 _get_platform_key dispatcher
        """
        content = APP_PY.read_text(encoding="utf-8")
        # findall 抓 _get_(deepseek|platform)_key 任一函数体, 拼起来检查
        bodies = re.findall(
            r"def\s+_get_(?:deepseek|platform)_key\s*\([^)]*\)[^:]*:\s*\n([\s\S]+?)(?=\n(?:def|@app|class)\s)",
            content,
        )
        assert bodies, "找不到 _get_deepseek_key 或 _get_platform_key 函数体"
        combined = "\n".join(bodies)
        assert "is_paid" in combined or "is_admin" in combined, (
            "二级模式 dispatcher 必须检查 is_paid (在 _get_deepseek_key 或 _get_platform_key 内)"
        )


class TestGetGptImageKeyHelper:
    """守护: app.py 必须有 _get_gpt_image_key(user) 二级模式 helper."""

    def test_helper_exists(self):
        content = APP_PY.read_text(encoding="utf-8")
        assert re.search(r"def\s+_get_gpt_image_key\s*\(", content), (
            "app.py 必须定义 _get_gpt_image_key(user) helper "
            "(二级模式 dispatcher: paid → platform GPT_IMAGE_API_KEY, else → custom)"
        )

    def test_helper_checks_is_paid(self):
        """gpt_image 二级模式 dispatcher 必须检查 is_paid.

        2026-05-09 重构后接受 2 种结构 (同 deepseek 测试).
        """
        content = APP_PY.read_text(encoding="utf-8")
        bodies = re.findall(
            r"def\s+_get_(?:gpt_image|platform)_key\s*\([^)]*\)[^:]*:\s*\n([\s\S]+?)(?=\n(?:def|@app|class)\s)",
            content,
        )
        assert bodies, "找不到 _get_gpt_image_key 或 _get_platform_key 函数体"
        combined = "\n".join(bodies)
        assert "is_paid" in combined or "is_admin" in combined, (
            "二级模式 dispatcher 必须检查 is_paid (在 _get_gpt_image_key 或 _get_platform_key 内)"
        )


class TestRefineApiKeyCompatibility:
    """守护: 平台精修 key 主入口统一为 REFINE_API_KEY."""

    def test_paid_gpt_image_key_uses_refine_api_key_primary(self, monkeypatch):
        import app as app_mod

        class PaidUser:
            is_admin = False
            is_paid = True

        monkeypatch.setenv("REFINE_API_KEY", "sk-refine-primary")
        monkeypatch.delenv("GPT_IMAGE_API_KEY", raising=False)

        key, source = app_mod._get_gpt_image_key(PaidUser())
        assert key == "sk-refine-primary"
        assert source == "platform"

    def test_paid_gpt_image_key_keeps_legacy_fallback(self, monkeypatch):
        import app as app_mod

        class PaidUser:
            is_admin = False
            is_paid = True

        monkeypatch.delenv("REFINE_API_KEY", raising=False)
        monkeypatch.setenv("GPT_IMAGE_API_KEY", "sk-gpt-legacy")

        key, source = app_mod._get_gpt_image_key(PaidUser())
        assert key == "sk-gpt-legacy"
        assert source == "platform"

    def test_router_gpt_image_resolves_refine_api_key(self, monkeypatch):
        import ai_image_router

        monkeypatch.setenv("REFINE_API_KEY", "sk-refine-primary")
        monkeypatch.delenv("GPT_IMAGE_API_KEY", raising=False)

        assert ai_image_router._resolve_key("gpt-image-2", {}) == "sk-refine-primary"


class TestSettingsHtmlConditionalKeyCard:
    """守护: settings.html 必须有条件渲染的 API Key 配置卡 (仅 non-paid 显示)."""

    def test_has_is_paid_conditional(self):
        """settings.html 必须有 is_paid 条件块决定是否显示 key 配置卡.

        接受任意形式: if not is_paid / if is_paid or is_admin (带 else) / etc.
        """
        content = SETTINGS_HTML.read_text(encoding="utf-8")
        # 必须有 jinja 条件块 + 块内引用 is_paid
        has_conditional = re.search(
            r"\{%\s*if\s+[^%]*is_paid[^%]*%\}",
            content,
        )
        assert has_conditional, (
            "settings.html 必须含 jinja 条件块引用 is_paid "
            "(if not is_paid / if is_paid or is_admin 都接受), "
            "决定是否显示 API Key 配置卡"
        )

    def test_has_deepseek_key_input(self):
        content = SETTINGS_HTML.read_text(encoding="utf-8")
        # 输入框 name 必须是 custom_deepseek_key
        assert 'name="custom_deepseek_key"' in content, (
            'settings.html 必须含 input name="custom_deepseek_key"'
        )

    def test_has_gpt_image_key_input(self):
        content = SETTINGS_HTML.read_text(encoding="utf-8")
        assert 'name="custom_gpt_image_key"' in content, (
            'settings.html 必须含 input name="custom_gpt_image_key"'
        )


class TestSettingsPostHandler:
    """守护: app.py 必须有 settings POST handler 接收 + 加密存 key."""

    def test_settings_post_route_exists(self):
        content = APP_PY.read_text(encoding="utf-8")
        # 找 /settings POST 端点 (方法包含 POST)
        match = re.search(
            r'@app\.route\(\s*[\'"]/settings[\'"]\s*,[\s\S]*?methods=\[[^]]*[\'"]POST[\'"]',
            content,
        )
        # 或者匹配 methods=["GET", "POST"] 形式
        match2 = re.search(
            r'@app\.route\(\s*[\'"]/settings[\'"][\s\S]{0,200}methods=\[[^]]*POST',
            content,
        )
        assert match or match2, (
            "app.py 必须有 /settings 路由的 POST 方法 handler (写入 user custom keys)"
        )

    def test_handler_uses_encrypt_api_key(self):
        """settings handler 必须用 encrypt_api_key 加密 (不能存明文)."""
        content = APP_PY.read_text(encoding="utf-8")
        # 找 settings POST handler 函数体
        # 简化: 全文必须含 encrypt_api_key 调用 (P3 砍刀流前有, P3 删了, PR C 加回)
        assert "encrypt_api_key" in content, (
            "app.py 必须 import + 用 encrypt_api_key 加密 user 配的 key, 不能存明文"
        )

    def test_handler_gates_on_is_paid_false(self):
        """settings POST 写入逻辑必须 gated 在 is_paid (付费用户不应该写).

        接受任意形式: if not is_paid: ... / if is_paid: redirect / etc.
        都是 'paid 用户不能 POST 自配 key' 的等价 gate.
        """
        content = APP_PY.read_text(encoding="utf-8")
        # 找 user_settings 函数体
        match = re.search(
            r"def\s+user_settings\s*\([^)]*\)[^:]*:\s*\n([\s\S]+?)(?=\n(?:def|@app|class)\s)",
            content,
        )
        assert match, "找不到 user_settings 函数"
        body = match.group(1)
        # POST 分支必须见 is_paid (无论是 not is_paid 还是 is_paid + redirect)
        assert "is_paid" in body and "POST" in body, (
            "user_settings 函数体必须含 POST 分支并引用 is_paid (付费用户 gate)"
        )


class TestAdminBehavesAsPaid:
    """守护: admin 用户视为 is_paid=True (admin 永远走 platform key)."""

    def test_helpers_treat_admin_as_paid(self):
        """二级模式 dispatcher 必须把 admin 当付费用户处理.

        2026-05-09 重构后接受 2 种结构: 检查可在 _get_deepseek_key / _get_gpt_image_key
        内联, 或抽到共享的 _get_platform_key dispatcher.
        """
        content = APP_PY.read_text(encoding="utf-8")
        # 抓所有候选 dispatcher 函数体并拼起来检查 'is_admin'
        bodies = re.findall(
            r"def\s+_get_(?:deepseek|gpt_image|platform)_key[\s\S]+?(?=\n(?:def|@app|class)\s)",
            content,
        )
        assert bodies, (
            "找不到任何二级模式 helper (_get_deepseek_key / _get_gpt_image_key / "
            "_get_platform_key)"
        )
        combined = "\n".join(bodies)
        assert "is_admin" in combined, (
            "二级模式 dispatcher 必须把 admin 视为 paid (否则 admin 测试时也得自配 key)"
        )
