"""项目根 conftest — 测试时注入 fake platform keys.

per `docs/superpowers/plans/2026-05-06-P3-key-platform-implementation.md` T3.

P3 砍刀流后 app.py 启动会校验 _REQUIRED_PLATFORM_KEYS, 缺则 RuntimeError.
本文件在 pytest 导入 conftest 时 (任何 test module import 之前)
设置 fake env vars, 让测试可以正常 `import app` 不被启动校验阻塞.

setdefault 而非直接赋值: 保留本机 .env 已有的真实 key (走真值跑集成测试时有用).
"""
import os

# Platform API Keys — P3 砍刀流后必填, 测试用 fake 值绕过启动校验
os.environ.setdefault("DEEPSEEK_API_KEY", "sk-test-deepseek-fake")
os.environ.setdefault("REFINE_API_KEY", "sk-test-refine-fake")
os.environ.setdefault("REFINE_API_BASE_URL", "https://api.test-refine.local/v1")

# 兼容历史 ARK / ARK_API_KEY (P3 不动它, 但若启动有依赖则塞 fake)
os.environ.setdefault("ARK_API_KEY", "ark-test-fake")
