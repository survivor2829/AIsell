"""守护测: docker-compose.yml 必须为 static/ai_refine_v2/ 配 named volume.

真实事故 (2026-05-07):
用户花 ¥5.6 生成的 v2_1778126382035_b3cca1 (8 屏 + assembled.png 13MB) 在
docker compose up -d --build 时**整个目录被清光**, 因为 docker-compose.yml
volumes 节给 uploads/outputs/cache 都挂载了 named volume 持久化, 唯独漏了
ai_refine_v2/. 容器重建时 Docker 用镜像里的空目录覆盖, 用户数据丢失.

PR #17 disk fallback 修了"内存丢但磁盘还在"的场景, 但**磁盘也被清空**时
fallback 也无米之炊. 必须先保证磁盘持久化.

修复:
- volumes 节加 named volume `ai_refine_v2:`
- web service volumes 节加 `- ai_refine_v2:/app/static/ai_refine_v2`
"""
from __future__ import annotations
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
COMPOSE = REPO / "docker-compose.yml"


class TestComposeHasAiRefineV2Volume:
    """守护: docker-compose.yml 必须挂载 ai_refine_v2 named volume."""

    def test_named_volume_declared(self):
        """volumes 节必须声明 ai_refine_v2 named volume."""
        content = COMPOSE.read_text(encoding="utf-8")
        # 顶级 volumes 节末尾 (or 中间) 必须有 ai_refine_v2:
        # 匹配 ^volumes:\n  ai_refine_v2:$ 或类似形式
        match = re.search(
            r"^volumes:\s*\n(?:  \w+:.*\n)*  ai_refine_v2:",
            content,
            re.M,
        )
        assert match, (
            "docker-compose.yml volumes 节必须声明 named volume 'ai_refine_v2:'. "
            "防 deploy 时 ai_refine_v2/ 目录被容器 rebuild 清光, 用户烧的钱白烧."
        )

    def test_web_mounts_ai_refine_v2(self):
        """web service 必须把 ai_refine_v2 named volume 挂到 /app/static/ai_refine_v2."""
        content = COMPOSE.read_text(encoding="utf-8")
        # 匹配 - ai_refine_v2:/app/static/ai_refine_v2
        has_mount = re.search(
            r"-\s+ai_refine_v2\s*:\s*/app/static/ai_refine_v2",
            content,
        )
        assert has_mount, (
            "docker-compose.yml web service volumes 节必须挂 "
            "`- ai_refine_v2:/app/static/ai_refine_v2`. "
            "缺这条 → deploy 时 v2 精修产物 (¥5.6/产品) 全丢."
        )

    def test_ai_refine_v2_in_same_block_as_uploads(self):
        """ai_refine_v2 mount 必须跟 uploads/outputs/cache 在同一个 web volumes 块.

        防御: 防止有人误把 mount 加到 db/redis service 下.
        """
        content = COMPOSE.read_text(encoding="utf-8")
        # 找 web service 的 volumes 节 (包含 uploads + outputs + cache)
        # 在该 block 范围内必须含 ai_refine_v2 mount
        # 用 multiline 匹配: 从 "volumes:" 开始到下一个非缩进行结束的块
        pattern = (
            r"volumes:\s*\n"
            r"(?:[\s\S]*?- uploads:/app/static/uploads)"
            r"[\s\S]*?- ai_refine_v2:/app/static/ai_refine_v2"
        )
        match = re.search(pattern, content)
        assert match, (
            "ai_refine_v2 mount 必须跟 uploads/outputs/cache 在同一 web volumes 块, "
            "不能放到 db/redis service 下"
        )
