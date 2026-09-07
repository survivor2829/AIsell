"""Bounded, local-only audition of a registered music recording."""
from __future__ import annotations

from pathlib import Path
import uuid

from .auto_mix_resources import voice_preview_data_url
from .errors import ContentEngineError


def preview_music_catalog_track(domain, track_id):
    row = domain.connection.execute("SELECT * FROM music_catalog_tracks_v1 WHERE id=?", (track_id,)).fetchone()
    if row is None or not domain._managed_file_digest_matches(row["managed_relative_path"], row["fingerprint"]):
        raise ContentEngineError("music_preview_unavailable", "配乐试听文件不可用，请重新导入这个版本。")
    source = (domain.data_dir / row["managed_relative_path"]).resolve()
    if domain.data_dir not in source.parents:
        raise ContentEngineError("music_preview_unavailable", "配乐文件位置无效。")
    renderer = getattr(domain.renderer, "ffmpeg_renderer", domain.renderer)
    if not getattr(renderer, "ffmpeg_path", None):
        raise ContentEngineError("music_preview_unavailable", "音频处理运行时不可用。")
    # Fingerprint, version and loop point pin this excerpt to the actual recording.
    start_ms = max(0, int(row["loop_start_ms"] or 0))
    folder = domain.data_dir / "music-catalog" / "previews"
    folder.mkdir(parents=True, exist_ok=True)
    output = folder / f"{row['fingerprint']}-{start_ms}-v1.wav"
    if not output.is_file():
        temporary = folder / f"{uuid.uuid4().hex}.wav"
        try:
            renderer._command([renderer.ffmpeg_path, "-v", "error", "-nostdin", "-i", str(source),
                               "-ss", str(start_ms / 1000), "-t", "20", "-vn", "-ac", "1", "-ar", "24000",
                               "-af", "loudnorm=I=-18:TP=-2:LRA=8,afade=t=in:d=0.3,afade=t=out:st=19.2:d=0.8",
                               "-c:a", "pcm_s16le", str(temporary)], timeout=45)
            if not temporary.is_file() or temporary.stat().st_size <= 44:
                raise ContentEngineError("music_preview_unavailable", "这首配乐未生成有效试听，请检查原文件。")
            temporary.replace(output)
        finally:
            temporary.unlink(missing_ok=True)
    return {"audio_data_url": voice_preview_data_url(output)}
