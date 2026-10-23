"""Register bundled, hash-verified CC0 recordings without altering customer rows."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .errors import ContentEngineError


ASSET_ROOT = Path(__file__).parent / "assets"


def sync_builtin_music(domain):
    catalog = json.loads((ASSET_ROOT / "builtin-music.v1.json").read_text(encoding="utf-8"))
    for track in catalog["tracks"]:
        fingerprint = track["sha256"]
        # Include inactive rows: a customer's import or retirement always wins.
        if fingerprint in domain._retired_music_fingerprints or domain.connection.execute(
            "SELECT 1 FROM music_catalog_tracks_v1 WHERE fingerprint=?", (fingerprint,)
        ).fetchone():
            continue
        paths = []
        for file_key, digest_key in (("file", "sha256"), ("evidenceFile", "evidenceSha256")):
            source = (ASSET_ROOT / track[file_key]).resolve()
            if ASSET_ROOT.resolve() not in source.parents or not source.is_file():
                raise ContentEngineError("builtin_music_invalid", "内置配乐文件缺失，请修复软件安装。")
            if hashlib.sha256(source.read_bytes()).hexdigest() != track[digest_key]:
                raise ContentEngineError("builtin_music_invalid", "内置配乐校验失败，请修复软件安装。")
            paths.append(source)
        domain.import_music_catalog_track(
            {
                "sourcePath": str(paths[0]),
                "displayName": track["displayName"],
                "source": "产品内置 CC0 曲库",
                "commercialScope": "CC0: commercial use, adaptation and software redistribution",
                "commercialUseAllowed": True,
                "licenseStatus": "valid",
                "credentialReference": track["sourceUrl"],
                "evidencePath": str(paths[1]),
                "bpm": track["bpm"],
                "moods": track["moods"],
                "energy": track["energy"],
            },
            _bundled_analysis=track["analysis"],
        )
