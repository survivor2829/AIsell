"""生产密钥生成脚本.

用法:
    python scripts/generate_secrets.py
    python scripts/generate_secrets.py --fmt env      # 直接输出 .env 格式行, 可重定向

输出 4 个密钥:
    SECRET_KEY           — Flask session / CSRF 签名 (换了等同 logout 所有用户)
    FERNET_KEY           — 用户 API Key 加密 (换了等同所有密文 Key 不可用, 慎换)
    POSTGRES_PASSWORD    — Postgres 用户密码
    REDIS_PASSWORD       — Redis auth 密码 (可选, 如果 Redis 对公网)

不写文件. 用户自己贴到 .env. 避免脚本误覆盖已有密钥.
"""
from __future__ import annotations

import argparse
import secrets
import sys


def gen_secret_key() -> str:
    return secrets.token_hex(32)


def gen_fernet_key() -> str:
    from cryptography.fernet import Fernet
    return Fernet.generate_key().decode("ascii")


def gen_password(length: int = 24) -> str:
    # URL-safe, 方便直接写 postgres://user:pwd@host, 不需 escape
    return secrets.token_urlsafe(length)


def main() -> int:
    parser = argparse.ArgumentParser(description="生产密钥生成器")
    parser.add_argument("--fmt", choices=["pretty", "env"], default="pretty",
                        help="pretty: 带说明; env: 只输出 KEY=VALUE 行")
    args = parser.parse_args()

    secret_key = gen_secret_key()
    fernet_key = gen_fernet_key()
    pg_pwd = gen_password()
    redis_pwd = gen_password()

    if args.fmt == "env":
        print(f"SECRET_KEY={secret_key}")
        print(f"FERNET_KEY={fernet_key}")
        print(f"POSTGRES_PASSWORD={pg_pwd}")
        print(f"REDIS_PASSWORD={redis_pwd}")
        return 0

    print("# ════════════════════════════════════════════════════")
    print("# 小玺AI — 生产密钥 (生成一次, 永久保存)")
    print("# ════════════════════════════════════════════════════")
    print()
    print("# Flask session / CSRF 签名. 换了所有用户下线.")
    print(f"SECRET_KEY={secret_key}")
    print()
    print("# 用户 API Key 对称加密. ⚠ 换了所有已存的密文 Key 永久不可解.")
    print("# 轮换前先把所有用户的明文 Key 重新加密, 否则用户需重新填 Key.")
    print(f"FERNET_KEY={fernet_key}")
    print()
    print("# Postgres 超级用户密码 (docker-compose 的 db 服务用)")
    print(f"POSTGRES_PASSWORD={pg_pwd}")
    print()
    print("# Redis auth 密码 (Redis 暴露公网时必填, 仅内网可留空)")
    print(f"REDIS_PASSWORD={redis_pwd}")
    print()
    print("# —— 推导的 URI (贴到 .env) ——")
    print(f"DATABASE_URL=postgresql+psycopg2://xiaoxi:{pg_pwd}@db:5432/xiaoxi")
    print(f"REDIS_URL=redis://:{redis_pwd}@redis:6379/0")
    return 0


if __name__ == "__main__":
    sys.exit(main())
