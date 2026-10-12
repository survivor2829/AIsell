"""Short operation recordings, separate from redistributable production materials."""
import hashlib
import json
import math
import re
import sqlite3
import struct
import threading
import uuid
from pathlib import Path

MAX_VIDEO = 256 * 1024 * 1024
MAX_COVER = 2 * 1024 * 1024
CATEGORIES = [{"id": key, "label": label} for key, label in (
    ("short-video", "短视频获客"), ("wechat", "微信拓客"),
    ("product-detail", "产品详情图"), ("materials", "物保素材库"))]
TOPICS = [{"id": key, "label": label} for key, label in (
    ("digital-human", "数字人"), ("ai-editing", "AI混剪"), ("product-video", "产品效果视频"))]
FILE = re.compile(r"[a-f0-9]{64}\.(?:mp4|jpg|png)\Z")


def movie_duration(filename):
    """Read ISO BMFF movie timing without loading the recording into memory."""
    with Path(filename).open("rb") as stream:
        size = Path(filename).stat().st_size

        def boxes(start, end):
            while start + 8 <= end:
                stream.seek(start)
                length, kind = struct.unpack(">I4s", stream.read(8))
                header = 8
                if length == 1:
                    raw = stream.read(8)
                    if len(raw) != 8:
                        raise ValueError("invalid_mp4")
                    length = struct.unpack(">Q", raw)[0]
                    header = 16
                elif length == 0:
                    length = end - start
                if length < header or start + length > end:
                    raise ValueError("invalid_mp4")
                yield kind, start + header, start + length
                start += length

        def nested(start, end, kinds):
            for kind, body, limit in boxes(start, end):
                if kind == kinds[0]:
                    if len(kinds) == 1:
                        yield body, limit
                    else:
                        yield from nested(body, limit, kinds[1:])

        duration = None
        has_media = False
        has_video = False
        for kind, start, end in boxes(0, size):
            has_media |= kind == b"mdat" and end > start
            if kind != b"moov":
                continue
            for child, body, limit in boxes(start, end):
                if child == b"trak":
                    handlers = []
                    for media_start, media_end in nested(body, limit, (b"mdia", b"hdlr")):
                        if media_end - media_start < 12:
                            raise ValueError("invalid_mp4")
                        stream.seek(media_start + 8)
                        handlers.append(stream.read(4))
                    if b"vide" in handlers:
                        codecs = []
                        for table_start, table_end in nested(body, limit, (b"mdia", b"minf", b"stbl", b"stsd")):
                            if table_end - table_start < 8:
                                raise ValueError("invalid_mp4")
                            codecs.extend(codec for codec, _, _ in boxes(table_start + 8, table_end))
                        # MP4 is only a container. H.265 recordings can have valid
                        # metadata yet fail on customers' Chromium installations.
                        if not codecs or any(codec not in (b"avc1", b"avc3") for codec in codecs):
                            raise ValueError("video_requires_h264")
                        has_video = True
                if child != b"mvhd":
                    continue
                stream.seek(body)
                raw = stream.read(min(32, limit - body))
                if len(raw) >= 20 and raw[0] == 0:
                    timescale, ticks = struct.unpack(">II", raw[12:20])
                elif len(raw) >= 32 and raw[0] == 1:
                    timescale, ticks = struct.unpack(">IQ", raw[20:32])
                else:
                    raise ValueError("invalid_mp4")
                duration = ticks / timescale if timescale else 0
        if not has_media or not has_video or duration is None or not math.isfinite(duration) or not 0 < duration <= 305:
            raise ValueError("video_must_be_under_five_minutes")
        return round(duration, 3)


class TutorialsStore:
    def __init__(self, root):
        self.root = Path(root) / "tutorials"
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.root / "catalog.sqlite3", timeout=10, check_same_thread=False)
        self.db.executescript("""PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, body TEXT NOT NULL, published INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS files(name TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
            INSERT OR IGNORE INTO config VALUES('revision',1);""")
        self.db.commit()

    def catalog(self, admin=False):
        with self.lock:
            rows = self.db.execute("SELECT body,published FROM items ORDER BY rowid DESC").fetchall()
            items = [{**json.loads(body), **({"published": bool(published)} if admin else {})}
                     for body, published in rows if admin or published]
            return {"schema": 1, "revision": self.db.execute("SELECT value FROM config WHERE key='revision'").fetchone()[0],
                    "categories": CATEGORIES, "topics": TOPICS, "items": items}

    def upload(self, stream, length, kind, content_type):
        extension = {"video/mp4": ".mp4", "image/png": ".png", "image/jpeg": ".jpg"}.get(content_type)
        cap = MAX_VIDEO if kind == "video" else MAX_COVER
        if kind not in ("video", "cover") or not extension or (extension == ".mp4") != (kind == "video") or not 0 < length <= cap:
            raise ValueError("invalid_file")
        temporary = self.root / (uuid.uuid4().hex + ".upload")
        digest = hashlib.sha256()
        try:
            with temporary.open("xb") as output:
                remaining = length
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("incomplete_upload")
                    output.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
            with temporary.open("rb") as source:
                magic = source.read(16)
            valid = (extension == ".mp4" and magic[4:8] == b"ftyp") or (extension == ".png" and magic.startswith(b"\x89PNG\r\n\x1a\n")) or (extension == ".jpg" and magic.startswith(b"\xff\xd8\xff"))
            if not valid:
                raise ValueError("invalid_file")
            metadata = {"sha256": digest.hexdigest(), "sizeBytes": length, "kind": kind}
            if kind == "video":
                metadata["durationSeconds"] = movie_duration(temporary)
            name = metadata["sha256"] + extension
            metadata["file"] = name
            with self.lock:
                temporary.replace(self.root / name)
                self.db.execute("INSERT OR REPLACE INTO files VALUES(?,?)", (name, json.dumps(metadata)))
                self.db.commit()
            return metadata
        finally:
            temporary.unlink(missing_ok=True)

    def change(self, body):
        with self.lock:
            action, item_id = body.get("action"), body.get("id")
            if not isinstance(item_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", item_id):
                raise ValueError("id")
            if action == "save":
                title = body.get("title")
                category, topic = body.get("category"), body.get("topic", "")
                if not isinstance(title, str) or not title.strip() or len(title) > 120:
                    raise ValueError("title")
                if category not in {row["id"] for row in CATEGORIES} or (topic and (category != "short-video" or topic not in {row["id"] for row in TOPICS})):
                    raise ValueError("category")
                item = {"id": item_id, "title": title.strip(), "category": category, "topic": topic}
                for key, kind in (("video", "video"), ("cover", "cover")):
                    row = self.db.execute("SELECT body FROM files WHERE name=?", (body.get(key),)).fetchone()
                    if not row:
                        raise ValueError("missing_file")
                    file = json.loads(row[0])
                    if file["kind"] != kind or not (self.root / file["file"]).is_file():
                        raise ValueError("invalid_file")
                    item[key] = {**file, "url": "/v1/tutorials/files/" + file["file"]}
                    del item[key]["file"]
                    del item[key]["kind"]
                self.db.execute("INSERT OR REPLACE INTO items VALUES(?,?,0)", (item_id, json.dumps(item, ensure_ascii=False)))
            elif action in ("publish", "unpublish"):
                row = self.db.execute("SELECT body FROM items WHERE id=?", (item_id,)).fetchone()
                if not row:
                    raise ValueError("missing_item")
                if action == "publish":
                    item = json.loads(row[0])
                    for key in ("video", "cover"):
                        target = self.root / item[key]["url"].rsplit("/", 1)[-1]
                        if not target.is_file() or target.stat().st_size != item[key]["sizeBytes"]:
                            raise ValueError("missing_file")
                        digest = hashlib.sha256()
                        with target.open("rb") as source:
                            while chunk := source.read(1024 * 1024):
                                digest.update(chunk)
                        if digest.hexdigest() != item[key]["sha256"]:
                            raise ValueError("file_integrity")
                self.db.execute("UPDATE items SET published=? WHERE id=?", (int(action == "publish"), item_id))
            else:
                raise ValueError("action")
            self.db.execute("UPDATE config SET value=value+1 WHERE key='revision'")
            self.db.commit()
            return {"ok": True, "revision": self.catalog()["revision"]}

    def public_file(self, name, admin=False):
        if not FILE.fullmatch(name):
            return None
        if not admin and not any(item[key]["url"].endswith("/" + name) for item in self.catalog()["items"] for key in ("video", "cover")):
            return None
        target = self.root / name
        return target if target.is_file() else None


def serve_file(handler, target):
    """One byte range per request; browser seeking never reads the full video."""
    size = target.stat().st_size
    start, end = 0, size - 1
    requested = handler.headers.get("Range")
    if requested:
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested)
        try:
            if not match or not any(match.groups()):
                raise ValueError()
            first, last = match.groups()
            if first:
                start, end = int(first), min(int(last), size - 1) if last else size - 1
            else:
                suffix = int(last)
                if suffix <= 0:
                    raise ValueError()
                start = max(0, size - suffix)
            if start >= size or start > end:
                raise ValueError()
        except ValueError:
            handler.send_response(416)
            handler.send_header("Content-Range", f"bytes */{size}")
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return
    handler.send_response(206 if requested else 200)
    handler.send_header("Content-Type", {".mp4": "video/mp4", ".png": "image/png", ".jpg": "image/jpeg"}[target.suffix])
    handler.send_header("Content-Length", str(end - start + 1))
    handler.send_header("Accept-Ranges", "bytes")
    handler.send_header("Cache-Control", "private, max-age=60")
    handler.send_header("X-Content-Type-Options", "nosniff")
    if requested:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    handler.end_headers()
    if handler.command == "HEAD":
        return
    try:
        with target.open("rb") as source:
            source.seek(start)
            remaining = end - start + 1
            while remaining:
                chunk = source.read(min(65536, remaining))
                if not chunk:
                    break
                handler.wfile.write(chunk)
                remaining -= len(chunk)
    except (BrokenPipeError, ConnectionResetError):
        pass
