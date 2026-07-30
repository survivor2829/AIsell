"""Stage A 冒烟测试 — 验证 app.py 能 import, 新钩子对空库无害."""
import os
import sys
from pathlib import Path

# 保证 cwd 是项目根
ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))

db_path = (ROOT / "instance" / "smoke_stage_a.db").as_posix()
os.makedirs(os.path.dirname(db_path), exist_ok=True)
os.environ["DATABASE_URL"] = f"sqlite:///{db_path}"
os.environ["FLASK_ENV"] = "development"
os.environ.pop("HTTP_PROXY", None)

import app  # noqa: E402  triggers db.create_all() + startup recovery

print("== app imported OK ==")
print("DB URI      :", app.app.config.get("SQLALCHEMY_DATABASE_URI"))
print("ENGINE_OPTS :", app.app.config.get("SQLALCHEMY_ENGINE_OPTIONS",
                                          "(sqlite: not set, as designed)"))
print("pubsub      :", __import__("pubsub").get_backend().stats().get("backend"))

# 清理 smoke DB
try:
    os.remove(db_path)
except OSError:
    pass
