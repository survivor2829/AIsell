"""Customer accounts: phone number + password, one active device per account.

The account's ``subject`` is the identity every other table already uses (receipts,
script usage, voice slots). An account converted from a license keeps that license's
id as its subject, so nothing a customer used before has to move.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import threading
import time
import uuid

PHONE = re.compile(r"1[3-9]\d{9}")
DEVICE_TOKEN = re.compile(r"[A-Za-z0-9_-]{32,128}")
SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1}
MIN_PASSWORD, MAX_PASSWORD = 8, 64
DEVICE_TTL_SECONDS = 90 * 24 * 60 * 60
FAILED_LOGIN_LIMIT, FAILED_LOGIN_WINDOW = 5, 15 * 60


class AccountError(Exception):
    def __init__(self, code: str, status: int = 400):
        super().__init__(code)
        self.code = code
        self.status = status


def password_problem(value) -> str | None:
    if not isinstance(value, str) or not MIN_PASSWORD <= len(value) <= MAX_PASSWORD:
        return "password_length"
    if not (re.search(r"[A-Za-z]", value) and re.search(r"\d", value)):
        return "password_too_simple"
    return None


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, dklen=32, **SCRYPT)
    return "scrypt$%d$%d$%d$%s$%s" % (SCRYPT["n"], SCRYPT["r"], SCRYPT["p"],
                                       base64.b64encode(salt).decode(), base64.b64encode(digest).decode())


def check_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, digest = str(stored or "").split("$")
        actual = hashlib.scrypt(str(password).encode("utf-8"), salt=base64.b64decode(salt), dklen=32, n=int(n), r=int(r), p=int(p))
        return hmac.compare_digest(actual, base64.b64decode(digest))
    except (ValueError, TypeError):
        return False


class AccountStore:
    def __init__(self, db: sqlite3.Connection, lock: threading.Lock, secret: bytes):
        self.db, self.lock, self.secret = db, lock, secret
        self.failures: dict[str, list[float]] = {}
        with self.lock:
            self.db.execute("""CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone TEXT UNIQUE, password_hash TEXT, display_name TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
                subject TEXT NOT NULL UNIQUE, legacy_license_id TEXT UNIQUE,
                must_change_password INTEGER NOT NULL DEFAULT 1, expires_at REAL,
                active_install_id TEXT, device_digest BLOB, device_expires_at REAL,
                limits_json TEXT NOT NULL DEFAULT '{}',
                created_at REAL NOT NULL, last_login_at REAL)""")
            self.db.commit()

    # ---- helpers -------------------------------------------------------------------
    def _digest(self, token: str) -> bytes:
        return hmac.new(self.secret, b"device:" + token.encode("utf-8"), hashlib.sha256).digest()

    def _row(self, where: str, args) -> dict | None:
        self.db.row_factory = sqlite3.Row
        try:
            row = self.db.execute(f"SELECT * FROM accounts WHERE {where}", args).fetchone()
        finally:
            self.db.row_factory = None
        return dict(row) if row else None

    def _usable(self, account: dict | None) -> dict:
        if account is None:
            raise AccountError("account_invalid", 401)
        if account["status"] != "active":
            raise AccountError("account_disabled", 403)
        if account["expires_at"] and account["expires_at"] <= time.time():
            raise AccountError("account_expired", 403)
        return account

    def _throttled(self, key: str) -> bool:
        now = time.time()
        recent = [moment for moment in self.failures.get(key, []) if now - moment < FAILED_LOGIN_WINDOW]
        self.failures[key] = recent
        return len(recent) >= FAILED_LOGIN_LIMIT

    def _bind_device(self, account_id: int, install_id: str) -> str:
        """The new device becomes the only one: its token replaces every older one."""
        token = secrets.token_urlsafe(48)
        self.db.execute("""UPDATE accounts SET active_install_id=?, device_digest=?, device_expires_at=?, last_login_at=?
            WHERE id=?""", (install_id, self._digest(token), time.time() + DEVICE_TTL_SECONDS, time.time(), account_id))
        self.db.commit()
        return token

    @staticmethod
    def public(account: dict) -> dict:
        # id is the identity the desktop keys local data on (a converted license keeps its license id).
        return {"id": account["subject"], "phone": account["phone"] or "", "displayName": account["display_name"],
                "mustChangePassword": bool(account["must_change_password"]),
                "setupRequired": not account["phone"],
                "expiresAt": account["expires_at"]}

    # ---- customer logins -------------------------------------------------------------
    def login_password(self, phone, password, install_id: str, client: str) -> tuple[dict, str]:
        phone = str(phone or "").strip()
        if not PHONE.fullmatch(phone) or not isinstance(password, str):
            raise AccountError("account_invalid", 401)
        with self.lock:
            if self._throttled("phone:" + phone) or self._throttled("client:" + client):
                raise AccountError("login_throttled", 429)
            account = self._row("phone=?", (phone,))
            if account is None or not check_password(password, account["password_hash"]):
                for key in ("phone:" + phone, "client:" + client):
                    self.failures.setdefault(key, []).append(time.time())
                raise AccountError("account_invalid", 401)
            self.failures.pop("phone:" + phone, None)
            account = self._usable(account)
            return account, self._bind_device(account["id"], install_id)

    def login_device(self, token, install_id: str) -> dict:
        if not isinstance(token, str) or not DEVICE_TOKEN.fullmatch(token):
            raise AccountError("device_invalid", 401)
        with self.lock:
            account = self._row("device_digest=?", (self._digest(token),))
            if account is None:
                # The token was replaced: another computer signed in with this account.
                raise AccountError("account_signed_in_elsewhere", 401)
            if account["active_install_id"] != install_id or (account["device_expires_at"] or 0) <= time.time():
                raise AccountError("device_invalid", 401)
            account = self._usable(account)
            self.db.execute("UPDATE accounts SET last_login_at=? WHERE id=?", (time.time(), account["id"]))
            self.db.commit()
            return account

    def login_license(self, license_id: str, license_expires: float, install_id: str, bind: bool = True) -> tuple[dict, str]:
        """Transition only: a license seen for the first time becomes an account to set up.
        Once the customer has chosen a phone and password, the license no longer logs in.
        bind=False is for clients older than accounts: they never keep a device token, so they
        must not take the binding away from an updated computer sharing the same license."""
        with self.lock:
            account = self._row("legacy_license_id=?", (license_id,))
            if account is None:
                self.db.execute("""INSERT INTO accounts (subject, legacy_license_id, must_change_password, expires_at, created_at)
                    VALUES (?,?,1,?,?)""", (license_id, license_id, license_expires, time.time()))
                self.db.commit()
                account = self._row("legacy_license_id=?", (license_id,))
            if account["phone"]:
                raise AccountError("account_use_password", 401)
            account = self._usable(account)
            return account, self._bind_device(account["id"], install_id) if bind else ""

    def setup(self, subject: str, phone, password) -> dict:
        """A converted license chooses its phone and password once."""
        phone = str(phone or "").strip()
        if not PHONE.fullmatch(phone):
            raise AccountError("phone_invalid")
        problem = password_problem(password)
        if problem:
            raise AccountError(problem)
        with self.lock:
            account = self._usable(self._row("subject=?", (subject,)))
            if account["phone"]:
                raise AccountError("account_already_set_up", 409)
            if self._row("phone=?", (phone,)):
                raise AccountError("phone_taken", 409)
            self.db.execute("UPDATE accounts SET phone=?, password_hash=?, must_change_password=0 WHERE id=?",
                            (phone, hash_password(password), account["id"]))
            self.db.commit()
            return self._row("id=?", (account["id"],))

    def change_password(self, subject: str, current, new) -> dict:
        problem = password_problem(new)
        if problem:
            raise AccountError(problem)
        with self.lock:
            account = self._usable(self._row("subject=?", (subject,)))
            if not account["phone"] or not check_password(current, account["password_hash"]):
                raise AccountError("password_wrong", 403)
            if check_password(new, account["password_hash"]):
                raise AccountError("password_unchanged")
            self.db.execute("UPDATE accounts SET password_hash=?, must_change_password=0 WHERE id=?",
                            (hash_password(new), account["id"]))
            self.db.commit()
            return self._row("id=?", (account["id"],))

    def by_subject(self, subject: str) -> dict | None:
        with self.lock:
            return self._row("subject=?", (subject,))

    # ---- administration ------------------------------------------------------------------
    def admin_list(self, usage) -> list[dict]:
        with self.lock:
            self.db.row_factory = sqlite3.Row
            try:
                rows = [dict(row) for row in self.db.execute("SELECT * FROM accounts ORDER BY created_at DESC")]
            finally:
                self.db.row_factory = None
        return [{"id": row["id"], "phone": row["phone"] or "", "displayName": row["display_name"], "note": row["note"],
                 "status": row["status"], "converted": bool(row["legacy_license_id"]), "setUp": bool(row["phone"]),
                 "mustChangePassword": bool(row["must_change_password"]), "expiresAt": row["expires_at"],
                 "createdAt": row["created_at"], "lastLoginAt": row["last_login_at"],
                 "deviceActive": bool(row["device_digest"]), "limits": json.loads(row["limits_json"] or "{}"),
                 "usage": usage(row["subject"])} for row in rows]

    def admin_create(self, phone, password, display_name="", note="", expires_at=None) -> dict:
        phone = str(phone or "").strip()
        if not PHONE.fullmatch(phone):
            raise AccountError("phone_invalid")
        problem = password_problem(password)
        if problem:
            raise AccountError(problem)
        with self.lock:
            if self._row("phone=?", (phone,)):
                raise AccountError("phone_taken", 409)
            self.db.execute("""INSERT INTO accounts (phone, password_hash, display_name, note, subject, must_change_password, expires_at, created_at)
                VALUES (?,?,?,?,?,1,?,?)""", (phone, hash_password(password), str(display_name or "")[:40], str(note or "")[:200],
                                              "acct_" + uuid.uuid4().hex, expires_at, time.time()))
            self.db.commit()
            return self._row("phone=?", (phone,))

    def admin_reset_password(self, account_id: int, password) -> dict:
        problem = password_problem(password)
        if problem:
            raise AccountError(problem)
        with self.lock:
            account = self._row("id=?", (account_id,))
            if account is None or not account["phone"]:
                raise AccountError("account_not_found", 404)
            # A reset signs every device out; the customer must choose a new password at next login.
            self.db.execute("""UPDATE accounts SET password_hash=?, must_change_password=1, device_digest=NULL,
                active_install_id=NULL WHERE id=?""", (hash_password(password), account_id))
            self.db.commit()
            return self._row("id=?", (account_id,))

    def admin_set_status(self, account_id: int, status: str) -> dict:
        if status not in {"active", "disabled"}:
            raise AccountError("status_invalid")
        with self.lock:
            if self._row("id=?", (account_id,)) is None:
                raise AccountError("account_not_found", 404)
            self.db.execute("UPDATE accounts SET status=? WHERE id=?", (status, account_id))
            if status == "disabled":
                self.db.execute("UPDATE accounts SET device_digest=NULL, active_install_id=NULL WHERE id=?", (account_id,))
            self.db.commit()
            return self._row("id=?", (account_id,))

    def admin_sign_out(self, account_id: int) -> dict:
        with self.lock:
            if self._row("id=?", (account_id,)) is None:
                raise AccountError("account_not_found", 404)
            self.db.execute("UPDATE accounts SET device_digest=NULL, active_install_id=NULL WHERE id=?", (account_id,))
            self.db.commit()
            return self._row("id=?", (account_id,))
