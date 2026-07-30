"""
API Key 加密/解密工具（Fernet 对称加密）
"""
import os
from cryptography.fernet import Fernet

_FERNET_KEY = os.environ.get("FERNET_KEY", "")
_fernet_instance = None
_FERNET_KEY_PLACEHOLDERS = {
    "生成一个key填这里",
    "change-me-in-production",
    "dev-change-me-in-production",
}

def _get_fernet():
    global _fernet_instance
    if _fernet_instance is not None:
        return _fernet_instance
    if not _FERNET_KEY:
        raise RuntimeError("未设置 FERNET_KEY 环境变量，无法加密/解密 API Key")
    if _FERNET_KEY.strip() in _FERNET_KEY_PLACEHOLDERS:
        raise RuntimeError("FERNET_KEY 是占位符，请使用 Fernet.generate_key() 生成真实密钥")
    _fernet_instance = Fernet(_FERNET_KEY.encode() if isinstance(_FERNET_KEY, str) else _FERNET_KEY)
    return _fernet_instance

def encrypt_api_key(plaintext: str) -> str:
    """加密 API Key，返回密文字符串"""
    if not plaintext:
        return ""
    return _get_fernet().encrypt(plaintext.encode()).decode()

def decrypt_api_key(ciphertext: str) -> str:
    """解密 API Key，返回明文"""
    if not ciphertext:
        return ""
    return _get_fernet().decrypt(ciphertext.encode()).decode()
