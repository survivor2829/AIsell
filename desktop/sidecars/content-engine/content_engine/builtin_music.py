"""Register user-authorized bundled music without requiring license files."""
from __future__ import annotations

import json
import logging
from pathlib import Path

from .errors import ContentEngineError

logger = logging.getLogger(__name__)
ASSET_ROOT = Path(__file__).parent / "assets"


def sync_builtin_music(domain):
    try:
        catalog = json.loads((ASSET_ROOT / "builtin-music.v1.json").read_text(encoding="utf-8"))
        tracks = catalog["tracks"]
        if not isinstance(tracks, list):
            raise ValueError("invalid tracks")
    except (OSError, ValueError, KeyError, TypeError):
        logger.warning("builtin_music_catalog_invalid: skipped bundled catalog")
        return
    for track in tracks:
        try:
            source = (ASSET_ROOT / track["file"]).resolve()
            if ASSET_ROOT.resolve() not in source.parents or not source.is_file():
                raise ContentEngineError("builtin_music_invalid", "内置配乐文件缺失。")
            # The fingerprint identifies audio, not its commercial authorization.
            fingerprint = domain._sha256_file(source)
            if fingerprint in domain._retired_music_fingerprints or domain.connection.execute(
                "SELECT 1 FROM music_catalog_tracks_v1 WHERE fingerprint=?", (fingerprint,)
            ).fetchone():
                continue
            # Reuse measurements only for identical audio; changed audio is measured
            # locally instead of failing startup or trusting stale measurements.
            analysis = track.get("analysis") if fingerprint == track.get("sha256") else None
            domain.import_music_catalog_track({
                "sourcePath": str(source), "displayName": track["displayName"],
                "source": "用户提供配乐", "commercialScope": "用户确认已获授权，可商用",
                "commercialUseAllowed": True, "licenseStatus": "valid",
                "credentialReference": "user_confirmed", "bpm": track.get("bpm"),
                "moods": track.get("moods", []), "energy": track.get("energy", .4),
            }, _bundled_analysis=analysis)
        except (ContentEngineError, OSError, ValueError, KeyError, TypeError):
            logger.warning("builtin_music_track_invalid: skipped track %s", track.get("id", "unknown") if isinstance(track, dict) else "unknown")
