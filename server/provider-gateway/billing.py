"""Customer compute credit (算力): usage metering, balances and per-video settlement.

Rules (decided by the operator, 2026-11-06):
- 1 元 = 40,000 算力. A charge is supplier cost x markup (default 1.3) in 算力.
- Every account starts with a 20,000,000 算力 grant (new and existing accounts alike).
- Usage is deducted after the fact. A video's calls are held under its job id and
  charged only when the client reports the video succeeded; a failed video is free.
  A job nobody settles within 24 hours counts as failed.
- A balance <= 0 blocks new paid work. Work already running (an open job) finishes,
  so a balance can go negative; a recharge pays the negative off first.
- Accounts the operator marks "unblocked" are metered the same way but never blocked.

Costs here are list-price estimates for metering, not supplier bills.
"""
from __future__ import annotations

import json
import math
import re
import time
import uuid

POINTS_PER_CNY = 40_000
DEFAULT_MARKUP = 1.3
DEFAULT_GRANT_POINTS = 20_000_000
JOB_EXPIRY_SECONDS = 24 * 60 * 60
JOB_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")
FEATURES = ("mix", "product_video", "digital_human", "product_detail", "wechat", "geo", "writing", "other")
FEATURE_NAMES = {
    "mix": "线索视频混剪", "product_video": "产品效果视频", "digital_human": "数字人视频",
    "product_detail": "产品详情图", "wechat": "微信与获客", "geo": "GEO推广", "writing": "AI文案", "other": "其他",
}
CREDIT_MESSAGE = "算力已用完，请联系客服充值后继续使用。"

# CNY list prices (checked 2026-11-06). Override any entry with
# XIAOXI_GATEWAY_BILLING_PRICES_JSON; keys are matched by model-name prefix.
DEFAULT_PRICES = {
    "usd_cny": 8.0,
    # input, cached input, output per million tokens
    "llm": {
        "deepseek": [2.0, 0.04, 8.0],
        "doubao-seed-2-1-pro": [6.0, 1.2, 30.0],
        "doubao": [6.0, 1.2, 30.0],
        "qwen": [0.8, 0.16, 2.0],
        "default": [6.0, 1.2, 30.0],
    },
    # per 10,000 billed characters
    "tts": {
        "seed-tts-2.0": 3.0, "seed-tts-1.0": 5.0, "seed-icl": 3.0,
        "cosyvoice-v3.5-flash": 0.8, "cosyvoice-v3.5-plus": 1.5, "cosyvoice": 2.0,
        "qwen3-tts-flash": 0.8, "default": 3.0,
    },
    # per hour of audio
    "asr": {"volc.bigasr": 4.5, "default": 4.5},
    # per second of generated video, by resolution
    "video": {
        "wan3.0-video": {"480P": 0.3, "720P": 0.6, "1080P": 1.2},
        "wan2.6-i2v-flash": {"720P": 0.15, "1080P": 0.3},
        "videoretalk": {"default": 0.08},
        "default": {"default": 0.6},
    },
    # per generated image, by size
    "image": {
        "gpt-image-2.5-ext": {"1K": 0.085, "2K": 0.3, "4K": 0.4},
        "gpt-image-2": {"1K": 1.69, "2K": 3.43, "4K": 5.7},
        "doubao-seedream": {"default": 0.2},
        "wan2.6-t2i": {"default": 0.2},
        "default": {"default": 0.3},
    },
}


def merge_prices(override):
    prices = json.loads(json.dumps(DEFAULT_PRICES))
    if not isinstance(override, dict):
        return prices
    for group, value in override.items():
        if isinstance(value, dict) and isinstance(prices.get(group), dict):
            prices[group].update(value)
        else:
            prices[group] = value
    return prices


def _by_prefix(table, model, default=None):
    model = str(model or "").lower()
    best = None
    for key in table:
        if key != "default" and model.startswith(key.lower()) and (best is None or len(key) > len(best)):
            best = key
    return table[best] if best else table.get("default", default)


def _json(raw):
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError, UnicodeError):
        return {}


def _sse_events(raw):
    events = []
    for line in bytes(raw or b"").split(b"\n"):
        line = line.strip()
        if line.startswith(b"data:"):
            value = _json(line[5:].strip())
            if value:
                events.append(value)
    return events


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    return float(value)


class Meter:
    """Turns one finished upstream exchange into charge items. Never raises."""

    def __init__(self, prices):
        self.prices = prices

    def llm_cost(self, model, usage):
        if not isinstance(usage, dict):
            return None
        prompt = _number(usage.get("prompt_tokens", usage.get("input_tokens")))
        output = _number(usage.get("completion_tokens", usage.get("output_tokens")))
        if prompt is None and output is None:
            return None
        details = usage.get("prompt_tokens_details") if isinstance(usage.get("prompt_tokens_details"), dict) else {}
        cached = _number(usage.get("prompt_cache_hit_tokens", details.get("cached_tokens"))) or 0.0
        prompt, output = prompt or 0.0, output or 0.0
        cached = min(cached, prompt)
        rate_in, rate_cache, rate_out = _by_prefix(self.prices["llm"], model)
        cost = ((prompt - cached) * rate_in + cached * rate_cache + output * rate_out) / 1e6
        return {"model": str(model or "")[:80], "unit": "tokens", "quantity": prompt + output, "cost": cost}

    def tts_cost(self, model, characters):
        if not characters:
            return None
        rate = _by_prefix(self.prices["tts"], model)
        return {"model": str(model or "")[:80], "unit": "characters", "quantity": characters, "cost": characters * rate / 10000}

    def asr_cost(self, model, milliseconds):
        if not milliseconds:
            return None
        rate = _by_prefix(self.prices["asr"], model)
        return {"model": str(model or "")[:80], "unit": "audio_seconds", "quantity": milliseconds / 1000,
                "cost": milliseconds / 3_600_000 * rate}

    def video_cost(self, model, resolution, seconds):
        if not seconds:
            return None
        table = _by_prefix(self.prices["video"], model)
        rate = table.get(str(resolution or "").upper()) or table.get("default") or max(table.values())
        return {"model": str(model or "")[:80], "unit": "video_seconds", "quantity": seconds, "cost": seconds * rate}

    def image_cost(self, model, size, count):
        if not count:
            return None
        table = _by_prefix(self.prices["image"], model)
        rate = table.get(str(size or "").upper()) or table.get("default") or max(table.values())
        return {"model": str(model or "")[:80], "unit": "images", "quantity": count, "cost": count * rate}

    # -- per provider -------------------------------------------------------------
    def measure(self, provider, method, path, request_headers, body, result):
        """Return (items, async_registration). Items are charge dicts; registration is
        {provider, task_id, model, detail} for an async submission to be priced on completion."""
        try:
            status = int(result.get("status", 0))
            if not 200 <= status < 300:
                return [], None
            raw = result.get("raw") or b""
            request = _json(body) if body else {}
            content_type = str(result.get("headers", {}).get("Content-Type", ""))
            if provider in ("deepseek", "volcengine_ark"):
                if path.endswith("/images/generations"):
                    payload = _json(raw)
                    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
                    count = _number(usage.get("generated_images")) or len(payload.get("data") or [])
                    item = self.image_cost(payload.get("model") or request.get("model"), request.get("size"), count)
                    return [item] if item else [], None
                if content_type.startswith("text/event-stream"):
                    events = _sse_events(raw)
                    usage = next((event["usage"] for event in reversed(events) if isinstance(event.get("usage"), dict)), None)
                    model = next((event.get("model") for event in events if event.get("model")), request.get("model"))
                else:
                    payload = _json(raw)
                    usage, model = payload.get("usage"), payload.get("model") or request.get("model")
                item = self.llm_cost(model, usage)
                return [item] if item else [], None
            if provider == "volcengine_asr":
                payload = _json(raw)
                info = payload.get("audio_info") if isinstance(payload.get("audio_info"), dict) else {}
                item = self.asr_cost("volc.bigasr", _number(info.get("duration")))
                return [item] if item else [], None
            if provider == "volcengine_tts":
                characters = None
                for event in _sse_events(raw) if not content_type.startswith("application/json") else [_json(raw)]:
                    usage = event.get("usage") if isinstance(event.get("usage"), dict) else {}
                    characters = _number(usage.get("text_words")) or characters
                if characters is None:
                    text = (request.get("req_params") or {}).get("text") if isinstance(request.get("req_params"), dict) else None
                    characters = float(len(text)) if isinstance(text, str) else None
                resource = request_headers.get("X-Api-Resource-Id") or "seed-tts-2.0"
                item = self.tts_cost(resource, characters)
                return [item] if item else [], None
            if provider == "bailian":
                return self._bailian(method, path, request_headers, request, raw, content_type)
            if provider == "apimart":
                return self._apimart(method, path, request, raw)
        except Exception:
            pass
        return [], None

    def _bailian(self, method, path, headers, request, raw, content_type):
        if content_type.startswith("text/event-stream"):
            # Streamed speech (e.g. CosyVoice with X-DashScope-SSE): the last event carries the usage.
            payload = next((event for event in reversed(_sse_events(raw)) if isinstance(event.get("usage"), dict)), {})
        else:
            payload = _json(raw)
        output = payload.get("output") if isinstance(payload.get("output"), dict) else {}
        model = request.get("model") or ""
        # Only video models are priced by output seconds; other async jobs (e.g. paraformer
        # transcription) must never fall back to a video rate.
        if (method == "POST" and output.get("task_id") and headers.get("X-DashScope-Async") == "enable"
                and re.search(r"wan|video|i2v|t2v|retalk", str(model), re.I)):
            parameters = request.get("parameters") if isinstance(request.get("parameters"), dict) else {}
            return [], {"task_id": str(output["task_id"])[:255], "model": str(model)[:80],
                        "detail": {"resolution": parameters.get("resolution"), "duration": parameters.get("duration")}}
        if method == "GET" and "/tasks/" in path:
            return [], None  # priced through the async registration (see Billing.complete_async)
        if "/compatible-mode/" in path:
            item = self.llm_cost(payload.get("model") or model, payload.get("usage"))
            return [item] if item else [], None
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        characters = _number(usage.get("characters"))
        if characters and ("tts" in path or "SpeechSynthesizer" in path or "multimodal-generation" in path):
            item = self.tts_cost(model, characters)
            return [item] if item else [], None
        if usage.get("input_tokens") is not None or usage.get("output_tokens") is not None:
            item = self.llm_cost(model, usage)
            return [item] if item else [], None
        return [], None

    def _apimart(self, method, path, request, raw):
        payload = _json(raw)
        if method == "POST" and (path.endswith("/images/generations") or path.endswith("/videos/generations")):
            data = payload.get("data")
            nodes = data if isinstance(data, list) else [data] if isinstance(data, dict) else []
            task_id = next((str(node.get("task_id") or node.get("id")) for node in nodes
                            if isinstance(node, dict) and (node.get("task_id") or node.get("id"))), "")
            if task_id:
                kind = "video" if path.endswith("/videos/generations") else "image"
                return [], {"task_id": task_id[:255], "model": str(request.get("model") or "")[:80],
                            "detail": {"kind": kind, "size": request.get("resolution") or request.get("size"),
                                       "n": request.get("n") or 1, "duration": request.get("duration")}}
        return [], None

    def price_async(self, registration, provider, raw):
        """Price a finished async task from its poll response, or None while it is still running/failed."""
        payload = _json(raw)
        detail = registration.get("detail") or {}
        model = registration.get("model")
        if provider == "bailian":
            output = payload.get("output") if isinstance(payload.get("output"), dict) else {}
            if output.get("task_status") != "SUCCEEDED":
                return None
            usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
            seconds = _number(usage.get("video_duration")) or _number(usage.get("duration")) or _number(detail.get("duration"))
            return self.video_cost(model, detail.get("resolution") or usage.get("SR") or usage.get("video_ratio"), seconds)
        node = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        if str(node.get("status", "")).lower() not in ("completed", "succeeded", "success"):
            return None
        cost_usd = node.get("cost")
        if isinstance(cost_usd, str) and re.fullmatch(r"\d+(?:\.\d+)?", cost_usd):
            cost_usd = float(cost_usd)
        if _number(cost_usd) is not None:
            return {"model": str(model or "")[:80], "unit": "supplier_usd", "quantity": float(cost_usd),
                    "cost": float(cost_usd) * float(self.prices.get("usd_cny", 8.0))}
        if detail.get("kind") == "video":
            return self.video_cost(model, detail.get("size"), _number(detail.get("duration")))
        count = _number(detail.get("n")) or 1
        return self.image_cost(model, detail.get("size") or "1K", count)


class Billing:
    def __init__(self, db, lock, *, markup=DEFAULT_MARKUP, grant_points=DEFAULT_GRANT_POINTS, prices=None):
        self.db, self.lock = db, lock
        self.markup = float(markup)
        self.grant_points = int(grant_points)
        self.meter = Meter(prices or merge_prices(None))
        self._last_expiry = 0.0
        with self.lock:
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS billing_accounts (
                    subject TEXT PRIMARY KEY, balance INTEGER NOT NULL,
                    unblocked INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS billing_ledger (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, kind TEXT NOT NULL,
                    points INTEGER NOT NULL, amount_cny REAL, note TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS billing_charges (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, dedupe TEXT NOT NULL UNIQUE,
                    job_id TEXT, feature TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
                    unit TEXT NOT NULL, quantity REAL NOT NULL, cost_cny REAL NOT NULL, points INTEGER NOT NULL,
                    state TEXT NOT NULL, created_at REAL NOT NULL, settled_at REAL);
                CREATE INDEX IF NOT EXISTS billing_charges_job ON billing_charges(subject, job_id, state);
                CREATE INDEX IF NOT EXISTS billing_charges_subject ON billing_charges(subject, state, created_at);
                CREATE TABLE IF NOT EXISTS billing_jobs (
                    subject TEXT NOT NULL, job_id TEXT NOT NULL, feature TEXT NOT NULL, state TEXT NOT NULL,
                    created_at REAL NOT NULL, updated_at REAL NOT NULL, PRIMARY KEY(subject, job_id));
                CREATE TABLE IF NOT EXISTS billing_requests (
                    request_id TEXT PRIMARY KEY, created_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS billing_async (
                    provider TEXT NOT NULL, task_id TEXT NOT NULL, subject TEXT NOT NULL, job_id TEXT,
                    feature TEXT NOT NULL, model TEXT NOT NULL, detail_json TEXT NOT NULL,
                    created_at REAL NOT NULL, PRIMARY KEY(provider, task_id));
            """)
            self.db.commit()

    # -- helpers (call with lock held) ----------------------------------------------
    def points(self, cost_cny):
        return max(0, math.ceil(cost_cny * self.markup * POINTS_PER_CNY - 1e-9))

    def _account(self, subject):
        row = self.db.execute("SELECT balance, unblocked FROM billing_accounts WHERE subject=?", (subject,)).fetchone()
        if row:
            return {"balance": row[0], "unblocked": bool(row[1])}
        now = time.time()
        self.db.execute("INSERT INTO billing_accounts (subject, balance, unblocked, created_at) VALUES (?,?,0,?)",
                        (subject, self.grant_points, now))
        self.db.execute("INSERT INTO billing_ledger (subject, kind, points, note, created_at) VALUES (?,?,?,?,?)",
                        (subject, "grant", self.grant_points, "开户赠送", now))
        return {"balance": self.grant_points, "unblocked": False}

    def _expire_jobs(self, now):
        if now - self._last_expiry < 60:
            return
        self._last_expiry = now
        stale = self.db.execute("SELECT subject, job_id FROM billing_jobs WHERE state='open' AND updated_at<?",
                                (now - JOB_EXPIRY_SECONDS,)).fetchall()
        for subject, job_id in stale:
            self._settle_locked(subject, job_id, "expired", now)

    def _settle_locked(self, subject, job_id, outcome, now):
        if outcome == "succeeded":
            total = self.db.execute("""SELECT COALESCE(SUM(points),0) FROM billing_charges
                WHERE subject=? AND job_id=? AND state='pending'""", (subject, job_id)).fetchone()[0]
            self._account(subject)
            self.db.execute("UPDATE billing_accounts SET balance=balance-? WHERE subject=?", (total, subject))
            self.db.execute("""UPDATE billing_charges SET state='charged', settled_at=?
                WHERE subject=? AND job_id=? AND state='pending'""", (now, subject, job_id))
        else:
            total = 0
            self.db.execute("""UPDATE billing_charges SET state='waived', settled_at=?
                WHERE subject=? AND job_id=? AND state='pending'""", (now, subject, job_id))
        self.db.execute("UPDATE billing_jobs SET state=?, updated_at=? WHERE subject=? AND job_id=?",
                        (outcome, now, subject, job_id))
        return total

    @staticmethod
    def clean_job(value):
        value = str(value or "").strip()
        return value if JOB_ID.fullmatch(value) else ""

    @staticmethod
    def clean_feature(value):
        value = str(value or "").strip()
        return value if value in FEATURES else "other"

    # -- request gate -----------------------------------------------------------------
    def admit(self, subject, job_id="", feature="other"):
        """True when this request may start paid work. Opens/touches the job when allowed."""
        now = time.time()
        with self.lock:
            account = self._account(subject)
            self._expire_jobs(now)
            job = self.db.execute("SELECT state FROM billing_jobs WHERE subject=? AND job_id=?",
                                  (subject, job_id)).fetchone() if job_id else None
            allowed = account["unblocked"] or account["balance"] > 0 or (job is not None and job[0] == "open")
            if allowed and job_id:
                if job is None:
                    self.db.execute("""INSERT INTO billing_jobs (subject, job_id, feature, state, created_at, updated_at)
                        VALUES (?,?,?,'open',?,?)""", (subject, job_id, feature, now, now))
                else:
                    # New paid work on a settled job is a rerun of the same task (the content engine
                    # requeues failed tasks under their old id): open it again so the rerun is held
                    # and settled on its own. Charges already settled stay as they are.
                    self.db.execute("UPDATE billing_jobs SET state='open', updated_at=? WHERE subject=? AND job_id=?",
                                    (now, subject, job_id))
            self.db.commit()
            return bool(allowed)

    def balance(self, subject):
        with self.lock:
            account = self._account(subject)
            self.db.commit()
        return {"balance": account["balance"], "unblocked": account["unblocked"],
                "blocked": not account["unblocked"] and account["balance"] <= 0, "pointsPerCny": POINTS_PER_CNY}

    # -- recording ----------------------------------------------------------------------
    def record(self, subject, job_id, feature, provider, item, dedupe=None):
        if not item or not subject:
            return
        now = time.time()
        cost = float(item.get("cost") or 0.0)
        points = self.points(cost)
        dedupe = dedupe or "call:" + uuid.uuid4().hex
        with self.lock:
            self._account(subject)
            state = "charged"
            if job_id:
                job = self.db.execute("SELECT state FROM billing_jobs WHERE subject=? AND job_id=?", (subject, job_id)).fetchone()
                if job is None:
                    self.db.execute("""INSERT INTO billing_jobs (subject, job_id, feature, state, created_at, updated_at)
                        VALUES (?,?,?,'open',?,?)""", (subject, job_id, feature, now, now))
                    state = "pending"
                elif job[0] in ("open", "expired"):
                    self.db.execute("UPDATE billing_jobs SET state='open', updated_at=? WHERE subject=? AND job_id=?",
                                    (now, subject, job_id))
                    state = "pending"
                elif job[0] == "failed":
                    state = "waived"
            cursor = self.db.execute("""INSERT OR IGNORE INTO billing_charges
                (subject, dedupe, job_id, feature, provider, model, unit, quantity, cost_cny, points, state, created_at, settled_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (subject, dedupe, job_id or None, feature, provider, item.get("model", ""), item.get("unit", ""),
                 float(item.get("quantity") or 0), cost, points, state, now, None if state == "pending" else now))
            if cursor.rowcount and state == "charged":
                self.db.execute("UPDATE billing_accounts SET balance=balance-? WHERE subject=?", (points, subject))
            self.db.commit()

    def register_async(self, provider, registration, subject, job_id, feature):
        with self.lock:
            self.db.execute("""INSERT OR IGNORE INTO billing_async
                (provider, task_id, subject, job_id, feature, model, detail_json, created_at) VALUES (?,?,?,?,?,?,?,?)""",
                (provider, registration["task_id"], subject, job_id or None, feature, registration.get("model", ""),
                 json.dumps(registration.get("detail") or {}), time.time()))
            self.db.commit()

    def complete_async(self, provider, task_id, raw):
        with self.lock:
            row = self.db.execute("""SELECT subject, job_id, feature, model, detail_json FROM billing_async
                WHERE provider=? AND task_id=?""", (provider, task_id)).fetchone()
        if not row:
            return
        item = self.meter.price_async({"model": row[3], "detail": json.loads(row[4] or "{}")}, provider, raw)
        if item:
            self.record(row[0], row[1], row[2], provider, item, dedupe=f"async:{provider}:{task_id}")

    def settle(self, subject, job_id, outcome):
        if outcome not in ("succeeded", "failed"):
            raise ValueError("outcome")
        now = time.time()
        with self.lock:
            self._account(subject)
            self._expire_jobs(now)
            job = self.db.execute("SELECT state FROM billing_jobs WHERE subject=? AND job_id=?", (subject, job_id)).fetchone()
            if job is None:
                self.db.execute("""INSERT INTO billing_jobs (subject, job_id, feature, state, created_at, updated_at)
                    VALUES (?,?,?,?,?,?)""", (subject, job_id, "other", outcome, now, now))
                charged = 0
            elif job[0] in ("succeeded", "failed"):
                charged = 0  # already settled; a repeated report changes nothing
            else:
                charged = self._settle_locked(subject, job_id, outcome, now)
            self.db.commit()
            balance = self.db.execute("SELECT balance FROM billing_accounts WHERE subject=?", (subject,)).fetchone()[0]
        return {"jobId": job_id, "outcome": outcome, "charged": charged, "balance": balance}

    # -- operator -------------------------------------------------------------------------
    def recharge(self, subject, amount_cny=None, points=None, note="", request_id=""):
        if amount_cny is not None:
            if isinstance(amount_cny, bool) or not isinstance(amount_cny, (int, float)) or not 0 < amount_cny <= 1_000_000:
                raise ValueError("amount")
            points, kind = round(amount_cny * POINTS_PER_CNY), "recharge"
        else:
            if isinstance(points, bool) or not isinstance(points, int) or points == 0 or abs(points) > 4_000_000_000:
                raise ValueError("points")
            kind = "adjust"
        now = time.time()
        request_id = self.clean_job(request_id)
        with self.lock:
            self._account(subject)
            if request_id and not self.db.execute("INSERT OR IGNORE INTO billing_requests (request_id, created_at) VALUES (?,?)",
                                                  (request_id, now)).rowcount:
                # The same recharge click arrived twice (e.g. a retried admin request): apply it once.
                self.db.commit()
                return self.db.execute("SELECT balance FROM billing_accounts WHERE subject=?", (subject,)).fetchone()[0]
            self.db.execute("UPDATE billing_accounts SET balance=balance+? WHERE subject=?", (points, subject))
            self.db.execute("INSERT INTO billing_ledger (subject, kind, points, amount_cny, note, created_at) VALUES (?,?,?,?,?,?)",
                            (subject, kind, points, amount_cny, str(note or "")[:200], now))
            self.db.commit()
            return self.db.execute("SELECT balance FROM billing_accounts WHERE subject=?", (subject,)).fetchone()[0]

    def set_unblocked(self, subject, unblocked):
        with self.lock:
            self._account(subject)
            self.db.execute("UPDATE billing_accounts SET unblocked=? WHERE subject=?", (1 if unblocked else 0, subject))
            self.db.commit()

    def summary(self, subject):
        month_start = time.mktime(time.localtime()[:2] + (1, 0, 0, 0, 0, 0, -1))
        with self.lock:
            account = self._account(subject)
            self._expire_jobs(time.time())
            self.db.commit()
            month, total = self.db.execute("""SELECT
                COALESCE(SUM(CASE WHEN created_at>=? THEN points END),0), COALESCE(SUM(points),0)
                FROM billing_charges WHERE subject=? AND state='charged'""", (month_start, subject)).fetchone()
        return {"balance": account["balance"], "unblocked": account["unblocked"], "monthPoints": month, "totalPoints": total}

    def detail(self, subject):
        month_start = time.mktime(time.localtime()[:2] + (1, 0, 0, 0, 0, 0, -1))
        with self.lock:
            self._account(subject)
            self.db.commit()
            features = self.db.execute("""SELECT feature,
                    COALESCE(SUM(CASE WHEN created_at>=? THEN points END),0),
                    COALESCE(SUM(CASE WHEN created_at>=? THEN cost_cny END),0),
                    COALESCE(SUM(points),0), COALESCE(SUM(cost_cny),0)
                FROM billing_charges WHERE subject=? AND state='charged' GROUP BY feature""",
                (month_start, month_start, subject)).fetchall()
            waived = self.db.execute("""SELECT COALESCE(SUM(cost_cny),0) FROM billing_charges
                WHERE subject=? AND state='waived'""", (subject,)).fetchone()[0]
            jobs = dict(self.db.execute("SELECT state, count(*) FROM billing_jobs WHERE subject=? GROUP BY state",
                                        (subject,)).fetchall())
            ledger = self.db.execute("""SELECT kind, points, amount_cny, note, created_at FROM billing_ledger
                WHERE subject=? ORDER BY id DESC LIMIT 50""", (subject,)).fetchall()
        return {
            "features": [{"feature": row[0], "name": FEATURE_NAMES.get(row[0], row[0]), "monthPoints": row[1],
                          "monthCostCny": round(row[2], 4), "totalPoints": row[3], "totalCostCny": round(row[4], 4)}
                         for row in features],
            "waivedCostCny": round(waived, 4),
            "jobs": {"succeeded": jobs.get("succeeded", 0), "failed": jobs.get("failed", 0) + jobs.get("expired", 0),
                     "open": jobs.get("open", 0)},
            "ledger": [{"kind": row[0], "points": row[1], "amountCny": row[2], "note": row[3], "at": row[4]} for row in ledger],
        }
