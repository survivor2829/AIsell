// A supplier refusing work because our API account has no money or quota left
// (DeepSeek 402 "Insufficient Balance" 2026-11-16, 百炼 Arrearage, quota used up).
// Every feature shows it as "API余额不足". The customer's own 算力 running out is a
// different case: the company gateway answers 402 credit_exhausted for it.
"use strict";

const API_BALANCE_MESSAGE = "API余额不足，请联系客服处理后再试。";
const SUPPLIER_BALANCE = /insufficient[_\s-]*(?:account[_\s-]*)?(?:balance|quota|user[_\s-]*quota|funds|credit)|arrearage|account[_\s-]*overdue|overdue[_\s-]*payment|quota[_\s-]*exhausted|余额不足|欠费|额度不足|额度已用完/iu;

function bodyText(body) {
  if (typeof body === "string") return body.slice(0, 65536);
  try { return JSON.stringify(body ?? "").slice(0, 65536); } catch { return ""; }
}

// True when a rejection body says the supplier account is out of balance/quota.
function supplierBalanceRefused(body) {
  if (body && typeof body === "object" && body.error === "credit_exhausted") return false;
  return SUPPLIER_BALANCE.test(bodyText(body));
}

module.exports = { API_BALANCE_MESSAGE, supplierBalanceRefused };
