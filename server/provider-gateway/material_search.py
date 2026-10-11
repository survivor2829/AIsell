"""Bounded, license-scoped Bocha search. Reservations survive unknown outcomes."""
import hashlib
import ipaddress
import json
import os
import re
import sqlite3
import threading
import time
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler


def public_url(value):
    try:
        parsed = urlsplit(str(value))
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 80, 443):
            return ""
        host = parsed.hostname.lower()
        if "." not in host or host.endswith((".local", ".localhost", ".internal")):
            return ""
        try:
            if not ipaddress.ip_address(host).is_global:
                return ""
        except ValueError:
            pass
        return str(value)[:2000]
    except ValueError:
        return ""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class MaterialSearch:
    def __init__(self, path, env=None, transport=None):
        env = os.environ if env is None else env
        self.enabled = env.get("XIAOXI_MATERIAL_SEARCH_ENABLED") == "1"
        self.key = env.get("XIAOXI_BOCHA_API_KEY", "")
        self.budget = max(0, int(env.get("XIAOXI_MATERIAL_SEARCH_BUDGET_MICROS", "0")))
        self.cost = max(0, int(env.get("XIAOXI_MATERIAL_SEARCH_COST_MICROS", "0")))
        self.daily = max(0, int(env.get("XIAOXI_MATERIAL_SEARCH_DAILY_LIMIT", "20")))
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.executescript("""CREATE TABLE IF NOT EXISTS material_search_calls(subject TEXT,task TEXT,round INTEGER,day INTEGER,cost INTEGER,state TEXT,result TEXT,query_hash TEXT,PRIMARY KEY(subject,task,round));
        CREATE TABLE IF NOT EXISTS material_search_cancel(subject TEXT,task TEXT,PRIMARY KEY(subject,task));""")
        self.transport = transport or self._bocha
        if str(path) == ":memory:" and transport is None:
            self.enabled = False  # Paid calls require durable reservations across restarts.

    def cancel(self, subject, task):
        with self.lock:
            self.db.execute("INSERT OR IGNORE INTO material_search_cancel VALUES(?,?)", (subject, task))
            self.db.commit()
        return {"taskId": task, "status": "cancelled", "round": 0, "items": []}

    def status(self):
        return {"enabled": bool(self.enabled and self.key and self.budget and self.cost)}

    def cancelled(self, subject, task):
        return bool(self.db.execute("SELECT 1 FROM material_search_cancel WHERE subject=? AND task=?", (subject, task)).fetchone())

    def search(self, subject, body):
        task, query, round_no = body.get("taskId"), body.get("query"), body.get("round", 1)
        if not isinstance(task, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", task) or not isinstance(query, str) or not 1 <= len(query.strip()) <= 300 or type(round_no) is not int or round_no not in (1, 2):
            raise ValueError("invalid_search")
        result = {"taskId": task, "status": "completed", "round": round_no, "items": []}
        if not self.enabled or not self.key or not self.budget or not self.cost:
            return dict(result, message="联网找素材尚未启用，已优先查找官方素材。", enabled=False)
        subject = hashlib.sha256(subject.encode()).hexdigest()
        fingerprint = hashlib.sha256(query.strip().encode()).hexdigest()
        with self.lock:
            if self.cancelled(subject, task):
                return dict(result, status="cancelled")
            old = self.db.execute("SELECT state,result,query_hash FROM material_search_calls WHERE subject=? AND task=? AND round=?", (subject, task, round_no)).fetchone()
            if old:
                if old[2] != fingerprint:
                    raise ValueError("task_conflict")
                return json.loads(old[1]) if old[0] == "completed" else dict(result, status="failed", message="本次查询结果尚未确认，请稍后查看。")
            if round_no == 2:
                first = self.db.execute("SELECT state,result FROM material_search_calls WHERE subject=? AND task=? AND round=1", (subject, task)).fetchone()
                if not first or first[0] != "completed" or len(json.loads(first[1])["items"]) >= 5:
                    raise ValueError("second_round_not_needed")
            spent = self.db.execute("SELECT COALESCE(SUM(cost),0) FROM material_search_calls").fetchone()[0]
            count = self.db.execute("SELECT COUNT(*) FROM material_search_calls WHERE subject=? AND day=?", (subject, int(time.time() // 86400))).fetchone()[0]
            if spent + self.cost > self.budget or count >= self.daily:
                return dict(result, message="今日查询额度或总预算已用完，请使用官方素材或稍后再试。")
            self.db.execute("INSERT INTO material_search_calls VALUES(?,?,?,?,?,'reserved',NULL,?)", (subject, task, round_no, int(time.time() // 86400), self.cost, fingerprint))
            self.db.commit()
        try:
            response = self.transport(query.strip())
            rows = response.get("data", {}).get("webPages", {}).get("value", [])
            if not isinstance(rows, list):
                raise ValueError("response")
            seen = set()
            for row in rows[:20]:
                url = public_url(row.get("url")) if isinstance(row, dict) else ""
                if not url or url in seen:
                    continue
                seen.add(url)
                result["items"].append({"id": hashlib.sha256(url.encode()).hexdigest()[:24], "title": str(row.get("name") or urlsplit(url).hostname)[:200], "url": url, "description": str(row.get("summary") or row.get("snippet") or "")[:1200], "source": urlsplit(url).hostname, "usage": "reference"})
            with self.lock:
                if self.cancelled(subject, task):
                    result.update(status="cancelled", items=[])
                self.db.execute("UPDATE material_search_calls SET state='completed',result=? WHERE subject=? AND task=? AND round=?", (json.dumps(result, ensure_ascii=False), subject, task, round_no))
                self.db.commit()
            return result
        except Exception:
            # Keep the reservation: an upstream timeout can already have incurred a charge.
            return dict(result, status="failed", items=[], message="搜索暂时没有返回结果，请稍后重试。")

    def cancel_request(self, subject, task):
        if not isinstance(task, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", task):
            raise ValueError("task")
        return self.cancel(hashlib.sha256(subject.encode()).hexdigest(), task)

    def _bocha(self, query):
        request = Request("https://api.bochaai.com/v1/web-search", data=json.dumps({"query": query, "summary": True, "count": 10}).encode(), headers={"Authorization": "Bearer " + self.key, "Content-Type": "application/json"}, method="POST")
        with build_opener(NoRedirect()).open(request, timeout=30) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                raise ValueError("response_size")
            body = json.loads(raw)
            if body.get("code") not in (None, 200):
                raise ValueError("search_failed")
            return body
