from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Any


MAX_DURATION_MS = 31 * 24 * 60 * 60 * 1000
MAX_DIMENSION = 32_768
MAX_FPS = 1_000.0
MAX_STREAMS = 256
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
DEFAULT_TIMEOUT_SECONDS = 15.0


@dataclass(frozen=True)
class ProbeOutcome:
    status: str
    duration_ms: int | None = None
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    has_audio: bool | None = None
    error_code: str | None = None

    @classmethod
    def unavailable(cls, error_code: str = "ffprobe_unavailable") -> "ProbeOutcome":
        return cls(status="unavailable", error_code=error_code)

    @classmethod
    def failed(cls, error_code: str) -> "ProbeOutcome":
        return cls(status="failed", error_code=error_code)


def discover_ffprobe() -> Path | None:
    """Find ffprobe only in explicitly supported locations."""
    candidates: list[Path] = []
    configured = os.environ.get("XIAOXI_FFPROBE_PATH", "").strip()
    if configured:
        configured_path = Path(configured)
        if configured_path.is_absolute():
            candidates.append(configured_path)

    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent / "ffprobe.exe")

    from_path = shutil.which("ffprobe")
    if from_path:
        candidates.append(Path(from_path))

    seen: set[str] = set()
    for candidate in candidates:
        try:
            resolved = candidate.resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        key = os.path.normcase(str(resolved))
        if key in seen:
            continue
        seen.add(key)
        if resolved.is_file():
            return resolved
    return None


class FFprobeAdapter:
    def __init__(
        self,
        binary_path: Path | None = None,
        *,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        auto_discover: bool = True,
    ):
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not math.isfinite(float(timeout_seconds))
            or not 0.1 <= float(timeout_seconds) <= 120
        ):
            raise ValueError("timeout_seconds must be between 0.1 and 120.")
        self._binary_path = (
            Path(binary_path).resolve(strict=False)
            if binary_path is not None
            else discover_ffprobe() if auto_discover else None
        )
        self.timeout_seconds = float(timeout_seconds)

    @property
    def available(self) -> bool:
        return bool(self._binary_path and self._binary_path.is_file())

    def probe(self, media_path: Path, media_kind: str) -> ProbeOutcome:
        if media_kind not in {"video", "image"}:
            return ProbeOutcome.failed("unsupported_media_kind")
        binary_path = self._binary_path
        if binary_path is None or not binary_path.is_file():
            return ProbeOutcome.unavailable()

        command = [
            str(binary_path),
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            "--",
            str(media_path),
        ]
        run_options: dict[str, Any] = {
            "stdin": subprocess.DEVNULL,
            "capture_output": True,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
            "timeout": self.timeout_seconds,
            "check": False,
            "shell": False,
        }
        if os.name == "nt":
            run_options["creationflags"] = subprocess.CREATE_NO_WINDOW
        try:
            completed = subprocess.run(command, **run_options)
        except subprocess.TimeoutExpired:
            return ProbeOutcome.failed("ffprobe_timeout")
        except FileNotFoundError:
            return ProbeOutcome.unavailable()
        except OSError:
            return ProbeOutcome.failed("ffprobe_execution_error")

        if completed.returncode != 0:
            return ProbeOutcome.failed("ffprobe_error")
        stdout = completed.stdout
        if not isinstance(stdout, str) or len(stdout.encode("utf-8")) > MAX_OUTPUT_BYTES:
            return ProbeOutcome.failed("ffprobe_invalid_output")
        try:
            payload = json.loads(stdout)
            return parse_ffprobe_payload(payload, media_kind)
        except (json.JSONDecodeError, TypeError, ValueError, OverflowError):
            return ProbeOutcome.failed("ffprobe_invalid_output")


def parse_ffprobe_payload(payload: Any, media_kind: str) -> ProbeOutcome:
    if media_kind not in {"video", "image"} or not isinstance(payload, dict):
        raise ValueError("Invalid probe payload.")
    streams = payload.get("streams")
    if not isinstance(streams, list) or len(streams) > MAX_STREAMS:
        raise ValueError("Invalid stream collection.")
    video_stream = next(
        (
            stream
            for stream in streams
            if isinstance(stream, dict) and stream.get("codec_type") == "video"
        ),
        None,
    )
    if video_stream is None:
        return ProbeOutcome.failed("video_stream_missing")

    width = _bounded_integer(video_stream.get("width"), MAX_DIMENSION)
    height = _bounded_integer(video_stream.get("height"), MAX_DIMENSION)
    if width is None or height is None:
        raise ValueError("Video dimensions are required.")
    has_audio = any(
        isinstance(stream, dict) and stream.get("codec_type") == "audio"
        for stream in streams
    )

    if media_kind == "image":
        return ProbeOutcome(
            status="ok",
            width=width,
            height=height,
            has_audio=False,
        )

    format_payload = payload.get("format")
    if format_payload is not None and not isinstance(format_payload, dict):
        raise ValueError("Invalid format payload.")
    duration_value = (
        format_payload.get("duration") if isinstance(format_payload, dict) else None
    )
    if duration_value in (None, "", "N/A"):
        duration_value = video_stream.get("duration")
    duration_ms = _duration_milliseconds(duration_value)
    fps = _frame_rate(
        video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate")
    )
    return ProbeOutcome(
        status="ok",
        duration_ms=duration_ms,
        width=width,
        height=height,
        fps=fps,
        has_audio=has_audio,
    )


def _bounded_integer(value: Any, maximum: int) -> int | None:
    if value in (None, "", "N/A"):
        return None
    if isinstance(value, bool):
        raise ValueError("Boolean is not a media dimension.")
    text = str(value)
    if len(text) > 16 or not text.isdecimal():
        raise ValueError("Invalid media dimension.")
    parsed = int(text)
    if not 1 <= parsed <= maximum:
        raise ValueError("Media dimension is outside supported bounds.")
    return parsed


def _duration_milliseconds(value: Any) -> int | None:
    if value in (None, "", "N/A"):
        return None
    if isinstance(value, bool):
        raise ValueError("Boolean is not a media duration.")
    text = str(value)
    if len(text) > 64:
        raise ValueError("Invalid media duration.")
    seconds = float(text)
    if not math.isfinite(seconds) or not 0 <= seconds <= MAX_DURATION_MS / 1000:
        raise ValueError("Media duration is outside supported bounds.")
    return round(seconds * 1000)


def _frame_rate(value: Any) -> float | None:
    if value in (None, "", "N/A", "0/0", 0):
        return None
    if isinstance(value, bool):
        raise ValueError("Boolean is not a frame rate.")
    text = str(value)
    if len(text) > 64:
        raise ValueError("Invalid frame rate.")
    try:
        parsed = float(Fraction(text))
    except (ValueError, ZeroDivisionError):
        raise ValueError("Invalid frame rate.") from None
    if not math.isfinite(parsed) or not 0 < parsed <= MAX_FPS:
        raise ValueError("Frame rate is outside supported bounds.")
    return round(parsed, 6)
