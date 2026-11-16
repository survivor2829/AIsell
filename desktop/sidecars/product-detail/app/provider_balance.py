"""Recognise a supplier refusing work because our API account has no money or quota left.

2026-11-16: DeepSeek answered 402 "Insufficient Balance" and the detail page reported
"策划请求结果不明", so neither the customer nor we could tell what happened. Any such
refusal now reads "API余额不足". The customer's own 算力 running out is a different
message (the company gateway answers 402 credit_exhausted for it).
"""

from __future__ import annotations

import json
import re
from typing import Any

API_BALANCE_MESSAGE = "API余额不足，请联系客服处理后再试。"
CREDIT_MESSAGE = "算力已用完，请联系客服充值后继续使用。"

_SUPPLIER_BALANCE = re.compile(
    r"insufficient[_\s-]*(?:account[_\s-]*)?(?:balance|quota|user[_\s-]*quota|funds|credit)"
    r"|arrearage|account[_\s-]*overdue|overdue[_\s-]*payment|quota[_\s-]*exhausted"
    r"|余额不足|欠费|额度不足|额度已用完",
    re.IGNORECASE,
)


def balance_message(body: Any) -> str:
    """The message to show for a balance refusal in a rejection body, else ""."""

    if isinstance(body, (bytes, bytearray)):
        body = bytes(body[:65536]).decode("utf-8", errors="replace")
    if isinstance(body, str):
        text = body[:65536]
        try:
            body = json.loads(text)
        except ValueError:
            body = None
    else:
        try:
            text = json.dumps(body, ensure_ascii=False)[:65536] if body is not None else ""
        except (TypeError, ValueError):
            text = ""
    if isinstance(body, dict) and body.get("error") == "credit_exhausted":
        return CREDIT_MESSAGE
    return API_BALANCE_MESSAGE if _SUPPLIER_BALANCE.search(text) else ""
