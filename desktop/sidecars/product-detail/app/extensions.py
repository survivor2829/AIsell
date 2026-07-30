"""
Flask 扩展实例化（避免循环导入）
"""
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager
from flask_migrate import Migrate
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

db = SQLAlchemy()
login_manager = LoginManager()
migrate = Migrate()

# P4 §A.4: 按客户端 IP 限流防暴力破解登录. 默认无限流, 装饰器逐路由开.
# 单 worker in-memory 存储足够 demo 阶段; 阶段七多 worker 切 Redis (storage_uri).
limiter = Limiter(key_func=get_remote_address, default_limits=[])

# 未登录时重定向到登录页
login_manager.login_view = "auth.login"
login_manager.login_message = "请先登录"
login_manager.login_message_category = "warning"
