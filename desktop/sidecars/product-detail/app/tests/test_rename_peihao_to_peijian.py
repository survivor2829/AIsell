"""守护测: 配耗类 → 配件类 全栈重命名 (用户 2026-05-07 指示).

背景: 4 大产品类原本是 [设备类, 耗材类, 配耗类, 工具类]. 用户反馈 "配耗" 不直观,
改成 "配件类" 更符合用户认知 (机器人配件 + 耗材组合 → 实际就是配件).

要求 (按 feedback_full_stack_atomic_change.md 铁律, 全栈原子):
- 后端 ALLOWED_PRODUCT_TYPES / dict / prompt 全改
- 模板目录 templates/配耗类/ → templates/配件类/
- 前端 UI 文案改
- DB schema 注释改
- 历史文档 (audit/raw/archive) 保持不动 (时间线真相)
"""
from __future__ import annotations
import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


class TestAllowedProductTypes:
    """守护: ALLOWED_PRODUCT_TYPES 必须含 '配件类' 不含 '配耗类'."""

    def test_peijian_in_allowed(self):
        from app import ALLOWED_PRODUCT_TYPES
        assert "配件类" in ALLOWED_PRODUCT_TYPES, (
            "ALLOWED_PRODUCT_TYPES 必须含 '配件类' (用户改名后)"
        )

    def test_peihao_not_in_allowed(self):
        from app import ALLOWED_PRODUCT_TYPES
        assert "配耗类" not in ALLOWED_PRODUCT_TYPES, (
            "ALLOWED_PRODUCT_TYPES 不能再有 '配耗类' (改名后旧值废弃)"
        )


class TestDictsRenamed:
    """守护: P5.1 的 _PARAM_LABELS_BY_CATEGORY / _CAT_FALLBACK key 必须改名."""

    def test_param_labels_has_peijian(self):
        from app import _PARAM_LABELS_BY_CATEGORY
        assert "配件类" in _PARAM_LABELS_BY_CATEGORY
        assert "配耗类" not in _PARAM_LABELS_BY_CATEGORY

    def test_cat_fallback_has_peijian(self):
        from app import _CAT_FALLBACK
        assert "配件类" in _CAT_FALLBACK
        assert "配耗类" not in _CAT_FALLBACK


class TestTemplateDir:
    """守护: 模板目录改名 templates/配耗类/ → templates/配件类/."""

    def test_peijian_dir_exists(self):
        peijian = REPO / "templates" / "配件类"
        assert peijian.is_dir(), (
            f"templates/配件类/ 必须存在 (从 templates/配耗类/ 改名而来)"
        )
        assert (peijian / "build_config.json").is_file(), (
            "templates/配件类/build_config.json 必须存在"
        )

    def test_peihao_dir_not_exists(self):
        peihao = REPO / "templates" / "配耗类"
        assert not peihao.exists(), (
            f"templates/配耗类/ 必须删除 (改名后旧目录废弃)"
        )


class TestBuildConfigAndThemes:
    """守护: 配件类配置文件和主题默认映射不能漏旧名."""

    def test_peijian_build_config_metadata_renamed(self):
        cfg_path = REPO / "templates" / "配件类" / "build_config.json"
        raw = cfg_path.read_text(encoding="utf-8")
        cfg = json.loads(raw)

        assert cfg.get("name") == "配件类"
        assert cfg.get("product_type") == "配件类"
        assert "配耗类" not in raw

    def test_minimal_white_default_for_peijian(self):
        themes_path = REPO / "static" / "themes" / "themes.json"
        data = json.loads(themes_path.read_text(encoding="utf-8"))
        minimal_white = next(t for t in data["themes"] if t["id"] == "minimal-white")

        assert minimal_white.get("default_for") == ["配件类"]

    def test_themes_json_no_user_facing_peihao(self):
        themes_path = REPO / "static" / "themes" / "themes.json"
        raw = themes_path.read_text(encoding="utf-8")

        assert "配耗类" not in raw


class TestThemeMatcher:
    """守护: theme_matcher.CATEGORY_DEFAULT 必须改名."""

    def test_category_default_has_peijian(self):
        from theme_matcher import CATEGORY_DEFAULT
        assert "配件类" in CATEGORY_DEFAULT
        assert "配耗类" not in CATEGORY_DEFAULT


class TestDeepSeekPrompt:
    """守护: 耗材类 / 配件类 DeepSeek prompt 不能再 hardcode '配耗类'."""

    def test_app_py_no_peihao_in_prompts(self):
        """app.py 主代码区不能再 mention '配耗类'.

        允许的地方: 注释里 '从 配耗类 改名' 这种历史说明 OK,
        但 prompt JSON / if elif 分支必须用 '配件类'.
        """
        content = (REPO / "app.py").read_text(encoding="utf-8")
        # 强制要求 product_type == 检查必须用 配件类 不用 配耗类
        assert 'product_type == "配耗类"' not in content, (
            'app.py 不能有 product_type == "配耗类" 分支, 必须改 "配件类"'
        )
        # ALLOWED_PRODUCT_TYPES 行不能有 配耗类 (已被 TestAllowedProductTypes 覆盖)
        # 这里检查 _PARAM_LABELS_BY_CATEGORY / _CAT_FALLBACK key
        assert '"配耗类":' not in content, (
            'app.py 不能再有 "配耗类": 字典 key (P5.1 dict 已改名)'
        )


class TestFrontendTemplates:
    """守护: 前端 UI 文案 (workspace.html / batch/upload.html) 必须改成 '配件'."""

    def test_workspace_no_peihao(self):
        f = REPO / "templates" / "workspace.html"
        content = f.read_text(encoding="utf-8")
        assert "配耗类" not in content, (
            "workspace.html 不能再显示 '配耗类' 给用户看"
        )

    def test_batch_upload_no_peihao(self):
        f = REPO / "templates" / "batch" / "upload.html"
        content = f.read_text(encoding="utf-8")
        assert "配耗类" not in content, (
            "batch/upload.html 不能再显示 '配耗类' 给用户看"
        )


class TestModelsComment:
    """守护: models.py 的 product_category 注释要更新."""

    def test_models_comment_updated(self):
        content = (REPO / "models.py").read_text(encoding="utf-8")
        # 注释里不能再列 配耗类 作为合法值
        assert "配耗类" not in content, (
            "models.py 注释必须改 '配耗类' → '配件类'"
        )
