"""Android phone app releases.

Same contract as the desktop releases: the publisher signs the manifest (Ed25519) and uploads over SSH only;
the phone verifies the signature with its pinned key. Phone releases live in their own folder
(releases/mobile-<channel>/) and never touch the desktop channels.
"""
import json
import re
from pathlib import Path

HEX = re.compile(r"[a-f0-9]{64}\Z")
VERSION = re.compile(r"(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2}\Z")
MOBILE_APP_IDS = {"test": "com.xiaoxi.mobile"}
MOBILE_ROUTE = re.compile(r"/v1/mobile/releases/(test)/latest")
PLATFORMS = {"douyin", "kuaishou", "xhs", "wechat"}
MAX_APK_BYTES = 512 * 1024**2
MAX_INT = 9007199254740991
MAX_DOCUMENT = 65536


def folder(root, channel):
    return Path(root) / "releases" / ("mobile-" + channel)


def validate_envelope(envelope):
    """Shape of the signed manifest. The signature itself is checked by the publisher and by every phone."""
    if (not isinstance(envelope, dict) or set(envelope) != {"payload", "signature"}
            or not isinstance(envelope["payload"], str) or len(envelope["payload"].encode("utf-8")) > 16384
            or not isinstance(envelope["signature"], str) or not 0 < len(envelope["signature"]) <= 128):
        raise ValueError("mobile_envelope_invalid")
    m = json.loads(envelope["payload"])
    count = lambda v, low=1: type(v) is int and low <= v <= MAX_INT
    if (not isinstance(m, dict) or m.get("schema") != 1 or not isinstance(m.get("channel"), str)
            or m["channel"] not in MOBILE_APP_IDS
            or m.get("appId") != MOBILE_APP_IDS[m["channel"]] or m.get("platform") != "android"
            or not count(m.get("versionCode")) or not VERSION.fullmatch(str(m.get("versionName", "")))
            or not count(m.get("sequence")) or not count(m.get("minVersionCode"))
            or m["minVersionCode"] > m["versionCode"]
            or not HEX.fullmatch(str(m.get("sha256", ""))) or not HEX.fullmatch(str(m.get("certSha256", "")))
            or type(m.get("size")) is not int or not 0 < m["size"] <= MAX_APK_BYTES
            or m.get("file") != f"/artifacts/{m['sha256']}.apk"
            or not isinstance(m.get("notes"), str) or len(m["notes"]) > 2000
            or not isinstance(m.get("publishedAt"), str)
            or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", m["publishedAt"])):
        raise ValueError("mobile_release_identity")
    paused = m.get("paused")
    if not isinstance(paused, list) or len(paused) > len(PLATFORMS):
        raise ValueError("mobile_release_identity")
    seen = set()
    for item in paused:
        if (not isinstance(item, dict) or set(item) != {"platform", "reason"} or not isinstance(item["platform"], str)
                or item["platform"] not in PLATFORMS
                or item["platform"] in seen or not isinstance(item["reason"], str) or not 0 < len(item["reason"]) <= 200):
            raise ValueError("mobile_release_identity")
        seen.add(item["platform"])
    return m


def read_envelope(file):
    """A stored envelope, size-capped and checked; ValueError on anything off."""
    if file.is_symlink() or not file.is_file() or file.stat().st_size > MAX_DOCUMENT:
        raise ValueError("mobile_release_unavailable")
    try:
        envelope = json.loads(file.read_text(encoding="utf-8"))
        validate_envelope(envelope)
    except (TypeError, KeyError, UnicodeError) as error:
        raise ValueError("mobile_release_unavailable") from error
    return envelope


def latest(root, channel):
    """The signed envelope phones read, or {"empty": True} before the first publication."""
    file = folder(root, channel) / "latest.json"
    if not file.exists() and not file.is_symlink():
        return {"empty": True}
    return read_envelope(file)
