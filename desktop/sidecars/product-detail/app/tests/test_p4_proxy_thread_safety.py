"""P4 §C.10 _clear_proxy 多线程 race condition 修复 — 守护测试.

per `docs/superpowers/specs/_stubs/C10-clear-proxy-race-stub.md` 方案 A.

漏洞: ai_image.py / ai_image_volcengine.py 的 `_clear_proxy()` pop os.environ
全局, `_restore_proxy()` 还原. 多线程 (batch_queue 3-worker) 并发时
race condition: A pop → B 看不到 saved → A restore → B 后续请求被污染.

修复:
- ai_image.py: 模块加载时一次性 _disable_proxy_for_dashscope() unset
- ai_image_volcengine.py: 删 _clear_proxy/_restore_proxy (session.trust_env=False
  + proxies={} 已是双保险)

本测试组防止未来 PR 把 race condition 模式加回去.
"""
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
AI_IMAGE = REPO_ROOT / "ai_image.py"
AI_VOLCENGINE = REPO_ROOT / "ai_image_volcengine.py"


class TestVolcengineNoProxyMutation:
    """守护: ai_image_volcengine.py 不能在调用前 pop os.environ."""

    def test_no_clear_proxy_function_in_volcengine(self):
        """volcengine session 已 trust_env=False, _clear_proxy 是死代码 + race 来源."""
        content = AI_VOLCENGINE.read_text(encoding="utf-8")
        forbidden = re.search(r'^def\s+_clear_proxy\s*\(', content, re.M)
        assert forbidden is None, (
            "ai_image_volcengine.py 不应有 _clear_proxy 函数; "
            "session.trust_env=False + proxies={} 已是双保险, "
            "pop os.environ 反而引入多线程 race condition."
        )

    def test_no_restore_proxy_function_in_volcengine(self):
        """配套 _restore_proxy 也应删除."""
        content = AI_VOLCENGINE.read_text(encoding="utf-8")
        forbidden = re.search(r'^def\s+_restore_proxy\s*\(', content, re.M)
        assert forbidden is None, (
            "ai_image_volcengine.py 不应有 _restore_proxy 函数 (与 _clear_proxy 配对删除)."
        )

    def test_no_proxy_pop_calls_in_volcengine_request_path(self):
        """请求路径 (generate_*) 不能 pop os.environ.."""
        content = AI_VOLCENGINE.read_text(encoding="utf-8")
        # 禁止 _clear_proxy() 调用
        assert "_clear_proxy()" not in content, (
            "volcengine 请求路径不应调用 _clear_proxy(), 走 trust_env=False 即可."
        )
        assert "_restore_proxy(" not in content, (
            "volcengine 请求路径不应调用 _restore_proxy()."
        )


class TestDashScopeProcessLevelUnset:
    """守护: ai_image.py 改为 module-level 一次性 unset, 不再 pop/restore."""

    def test_dashscope_has_module_level_disable(self):
        """模块加载时必须有一次性 unset 函数 (调用一次, 不 race)."""
        content = AI_IMAGE.read_text(encoding="utf-8")
        # 接受多种命名: _disable_proxy_for_dashscope / _strip_proxy_env_once / 等
        has_module_unset = (
            "_disable_proxy_for_dashscope" in content
            or "_strip_proxy_env_once" in content
        )
        assert has_module_unset, (
            "ai_image.py 必须有 module-level 一次性 unset 函数 "
            "(如 _disable_proxy_for_dashscope), 取代每次请求 pop/restore."
        )

    def test_dashscope_no_per_request_pop_restore(self):
        """请求路径不应再有 saved=_clear_proxy() ... _restore_proxy(saved) 模式."""
        content = AI_IMAGE.read_text(encoding="utf-8")
        # 禁止 _clear_proxy() 调用 (因函数定义已删)
        # 允许 _disable_proxy_for_dashscope() 在 module-level 出现
        clear_calls = re.findall(r'\b_clear_proxy\s*\(\s*\)', content)
        restore_calls = re.findall(r'\b_restore_proxy\s*\(', content)
        assert len(clear_calls) == 0, (
            f"ai_image.py 仍有 {len(clear_calls)} 处 _clear_proxy() 调用 "
            f"(应改为 module-level 一次性 unset)."
        )
        assert len(restore_calls) == 0, (
            f"ai_image.py 仍有 {len(restore_calls)} 处 _restore_proxy(...) 调用 "
            f"(模块加载时 unset 后无需还原)."
        )


class TestNoSavedDictRacePattern:
    """守护: 任何文件不能再用 'saved={...}; for k in keys: env.pop(k)' 模式做代理隔离."""

    def test_no_pop_save_pattern_in_ai_files(self):
        """这种 pop-then-restore 模式在多线程下 race, 整体禁止."""
        for f in [AI_IMAGE, AI_VOLCENGINE]:
            content = f.read_text(encoding="utf-8")
            # 检测 `saved = {} ... saved[k] = os.environ.pop(k)` 模式
            race_pattern = re.search(
                r'saved\s*=\s*\{\s*\}\s*[\r\n].*os\.environ\.pop',
                content,
                re.DOTALL,
            )
            assert race_pattern is None, (
                f"{f.name} 仍有 'saved={{}}; ... os.environ.pop' race-prone 模式; "
                f"请用 module-level 一次性 unset 替代."
            )
