"""Official media catalog; administrator writes, immutable content-addressed files."""
import base64
import hashlib
import json
import re
import sqlite3
import threading
from pathlib import Path
from urllib.parse import urlsplit

ID = re.compile(r"[a-zA-Z0-9_-]{1,80}\Z")
MAX_FILE = 24 * 1024 * 1024
DEFAULT_CATEGORIES = [{"id": key, "label": label} for key, label in
                      (("factory", "工厂"), ("community", "小区"), ("robot", "机器人"), ("cleaning", "保洁作业"))]


class MaterialsStore:
    def __init__(self, root):
        self.root = Path(root) / "official-materials"
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.root / "catalog.sqlite3", check_same_thread=False)
        self.db.executescript("""CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, body TEXT NOT NULL, published INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value TEXT NOT NULL);""")
        self.db.execute("INSERT OR IGNORE INTO config VALUES('revision','1')")
        self.db.execute("INSERT OR IGNORE INTO config VALUES('categories',?)", (json.dumps(DEFAULT_CATEGORIES),))
        self.db.commit()

    def catalog(self, admin=False):
        with self.lock:
            items = []
            withdrawn = []
            for body, published in self.db.execute("SELECT body,published FROM items ORDER BY id"):
                if not published:
                    withdrawn.append(json.loads(body)["id"])
                if admin or published:
                    item = json.loads(body)
                    if admin:
                        item["published"] = bool(published)
                    items.append(item)
            config = dict(self.db.execute("SELECT key,value FROM config"))
            return {"schema": 1, "revision": int(config["revision"]), "categories": json.loads(config["categories"]), "items": items, "withdrawnIds": withdrawn}

    def change(self, body):
        with self.lock:
            action = body.get("action")
            if action == "categories":
                categories = body.get("categories")
                if not isinstance(categories, list) or not 1 <= len(categories) <= 40:
                    raise ValueError("categories")
                clean = [{"id": self.text(row, "id", 80), "label": self.text(row, "label", 40)} for row in categories]
                if any(not ID.fullmatch(row["id"]) for row in clean) or len({row["id"] for row in clean}) != len(clean):
                    raise ValueError("categories")
                used = {json.loads(row[0])["category"] for row in self.db.execute("SELECT body FROM items")}
                if not used.issubset({row["id"] for row in clean}):
                    raise ValueError("category_in_use")
                self.db.execute("UPDATE config SET value=? WHERE key='categories'", (json.dumps(clean),))
            elif action in ("publish", "unpublish"):
                if not self.db.execute("UPDATE items SET published=? WHERE id=?", (int(action == "publish"), body.get("id"))).rowcount:
                    raise ValueError("missing_item")
            elif action == "upload":
                item = {key: self.text(body, key, limit) for key, limit in
                        (("id", 80), ("title", 150), ("category", 80), ("kind", 10), ("description", 1500), ("sourceUrl", 2000), ("author", 200), ("license", 2000))}
                if not ID.fullmatch(item["id"]) or item["kind"] not in ("image", "video"):
                    raise ValueError("item")
                source = urlsplit(item["sourceUrl"])
                if source.scheme not in ("http", "https") or not source.hostname or source.username or source.password:
                    raise ValueError("source")
                if item["category"] not in {row["id"] for row in self.catalog()["categories"]}:
                    raise ValueError("category")
                raw = base64.b64decode(body.get("data", ""), validate=True)
                ext = str(body.get("extension", "")).lower()
                valid = (ext == ".png" and raw.startswith(b"\x89PNG\r\n\x1a\n")) or (ext in (".jpg", ".jpeg") and raw.startswith(b"\xff\xd8\xff")) or (ext == ".mp4" and raw[4:8] == b"ftyp")
                if not raw or len(raw) > MAX_FILE or not valid or (item["kind"] == "video") != (ext == ".mp4"):
                    raise ValueError("media")
                item.update(sha256=hashlib.sha256(raw).hexdigest(), sizeBytes=len(raw))
                filename = item["sha256"] + ext
                target = self.root / filename
                item["downloadUrl"] = "/v1/materials/files/" + filename
                if body.get("thumbnailData"):
                    thumbnail = base64.b64decode(body["thumbnailData"], validate=True)
                    thumbnail_ext = body.get("thumbnailExtension")
                    if not thumbnail or len(thumbnail) > 512 * 1024 or thumbnail == raw or not ((thumbnail_ext == ".png" and thumbnail.startswith(b"\x89PNG\r\n\x1a\n")) or (thumbnail_ext in (".jpg", ".jpeg") and thumbnail.startswith(b"\xff\xd8\xff"))):
                        raise ValueError("thumbnail")
                    thumbnail_name = hashlib.sha256(thumbnail).hexdigest() + thumbnail_ext
                    (self.root / thumbnail_name).write_bytes(thumbnail)
                    item["thumbnailUrl"] = "/v1/materials/files/" + thumbnail_name
                    item["thumbnailSha256"] = hashlib.sha256(thumbnail).hexdigest()
                    item["thumbnailSizeBytes"] = len(thumbnail)
                else:
                    raise ValueError("separate_thumbnail_required")
                if not target.exists():
                    temp = target.with_suffix(ext + ".tmp")
                    temp.write_bytes(raw)
                    temp.replace(target)
                self.db.execute("INSERT OR REPLACE INTO items VALUES(?,?,0)", (item["id"], json.dumps(item, ensure_ascii=False)))
            else:
                raise ValueError("action")
            self.db.execute("UPDATE config SET value=CAST(value AS INTEGER)+1 WHERE key='revision'")
            self.db.commit()
            return {"ok": True, "revision": self.catalog()["revision"]}

    @staticmethod
    def text(body, key, limit):
        value = body.get(key)
        if not isinstance(value, str) or not value.strip() or len(value) > limit:
            raise ValueError(key)
        return value.strip()

    def public_file(self, filename):
        if not re.fullmatch(r"[a-f0-9]{64}\.(?:jpg|jpeg|png|mp4)", filename):
            return None
        # Unpublishing stops new downloads, but never deletes existing client files.
        if not any(any(row.get(key, "").endswith("/" + filename) for key in ("downloadUrl", "thumbnailUrl")) for row in self.catalog()["items"]):
            return None
        target = self.root / filename
        return target if target.is_file() else None
