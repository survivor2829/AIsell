from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Any, Callable, Iterable

from .errors import ContentEngineError


DEFAULT_RENDER_TIMEOUT_SECONDS = 600
DEFAULT_IMAGE_DURATION_MS = 3_000


@dataclass(frozen=True)
class PlatformPreset:
    key: str
    width: int = 1080
    height: int = 1920
    fps: int = 30
    video_codec: str = "h264_mf"
    audio_codec: str = "aac"
    pixel_format: str = "yuv420p"
    faststart: bool = True


PLATFORM_PRESETS = {
    key: PlatformPreset(key=key) for key in ("wechat", "douyin", "kuaishou")
}


def _runtime_search_directories() -> tuple[Path, ...]:
    candidates = [Path(sys.executable).resolve().parent]
    if getattr(sys, "frozen", False):
        bundle_dir = Path(getattr(sys, "_MEIPASS", candidates[0]))
        candidates.extend((bundle_dir, bundle_dir / "media-tools"))
    candidates.extend((candidates[0] / "media-tools", candidates[0] / "runtime"))
    return tuple(dict.fromkeys(candidates))


def discover_media_executable(name: str, env_name: str) -> str | None:
    explicit = os.environ.get(env_name)
    if explicit:
        path = Path(explicit).expanduser()
        return str(path.resolve()) if path.is_absolute() and path.is_file() else None
    executable_names = (f"{name}.exe", name) if os.name == "nt" else (name,)
    for directory in _runtime_search_directories():
        for executable_name in executable_names:
            candidate = directory / executable_name
            if candidate.is_file():
                return str(candidate.resolve())
    return shutil.which(name)


def _windows_process_options() -> dict[str, Any]:
    if os.name != "nt":
        return {}
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}


class FFmpegMixRenderer:
    def __init__(
        self,
        data_dir: Path,
        *,
        ffmpeg_path: str | None = None,
        ffprobe_path: str | None = None,
        timeout_seconds: int = DEFAULT_RENDER_TIMEOUT_SECONDS,
        command_runner: Callable[..., Any] = subprocess.run,
    ):
        self.data_dir = Path(data_dir).resolve()
        self.ffmpeg_path = ffmpeg_path or discover_media_executable(
            "ffmpeg", "XIAOXI_FFMPEG_PATH"
        )
        self.ffprobe_path = ffprobe_path or discover_media_executable(
            "ffprobe", "XIAOXI_FFPROBE_PATH"
        )
        self.timeout_seconds = timeout_seconds
        self._run_process = command_runner

    @property
    def capability(self) -> dict[str, Any]:
        available = bool(self.ffmpeg_path and self.ffprobe_path)
        return {
            "available": available,
            "code": "ready" if available else "media_tools_unavailable",
            "platforms": list(PLATFORM_PRESETS),
        }

    def render(
        self,
        package_id: str,
        segments: list[dict[str, Any]],
        platforms: Iterable[str],
        metadata: dict[str, str],
    ) -> dict[str, Any]:
        if not self.capability["available"]:
            raise ContentEngineError(
                "media_tools_unavailable",
                "FFmpeg and ffprobe are required to render export packages.",
            )
        selected_platforms = tuple(platforms)
        temp_dir = self.data_dir / "render-temp" / package_id
        package_dir = self.data_dir / "exports" / package_id
        shutil.rmtree(temp_dir, ignore_errors=True)
        temp_dir.mkdir(parents=True, exist_ok=False)
        try:
            outputs: dict[str, str] = {}
            preset_groups: dict[tuple[Any, ...], list[str]] = {}
            for platform in selected_platforms:
                preset = PLATFORM_PRESETS[platform]
                signature = (
                    preset.width,
                    preset.height,
                    preset.fps,
                    preset.video_codec,
                    preset.audio_codec,
                    preset.pixel_format,
                    preset.faststart,
                )
                preset_groups.setdefault(signature, []).append(platform)
            for group_index, grouped_platforms in enumerate(preset_groups.values()):
                platform = grouped_platforms[0]
                preset = PLATFORM_PRESETS[platform]
                platform_dir = temp_dir / f"preset-{group_index}"
                platform_dir.mkdir()
                segment_paths = [
                    self._normalize_segment(item, preset, platform_dir, index)
                    for index, item in enumerate(segments)
                ]
                output_name = f"{platform}.mp4"
                output_path = temp_dir / output_name
                self._concat(segment_paths, preset, output_path, platform_dir)
                outputs[platform] = output_name
                for sibling in grouped_platforms[1:]:
                    sibling_name = f"{sibling}.mp4"
                    shutil.copy2(output_path, temp_dir / sibling_name)
                    outputs[sibling] = sibling_name

            first_output = temp_dir / outputs[selected_platforms[0]]
            cover_path = temp_dir / "cover.jpg"
            self._command(
                [
                    self.ffmpeg_path,
                    "-y",
                    "-i",
                    str(first_output),
                    "-frames:v",
                    "1",
                    "-q:v",
                    "2",
                    str(cover_path),
                ]
            )
            manifest = {
                "packageId": package_id,
                "title": metadata.get("title", ""),
                "description": metadata.get("description", ""),
                "metadataSource": "user_or_empty",
                "platforms": list(selected_platforms),
                "outputs": outputs,
                "cover": "cover.jpg",
                "render": {
                    platform: {
                        "width": PLATFORM_PRESETS[platform].width,
                        "height": PLATFORM_PRESETS[platform].height,
                        "fps": PLATFORM_PRESETS[platform].fps,
                        "videoCodec": PLATFORM_PRESETS[platform].video_codec,
                        "audioCodec": PLATFORM_PRESETS[platform].audio_codec,
                        "pixelFormat": PLATFORM_PRESETS[platform].pixel_format,
                        "faststart": PLATFORM_PRESETS[platform].faststart,
                    }
                    for platform in selected_platforms
                },
            }
            (temp_dir / "manifest.json").write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            for group_index in range(len(preset_groups)):
                shutil.rmtree(temp_dir / f"preset-{group_index}", ignore_errors=True)
            package_dir.parent.mkdir(parents=True, exist_ok=True)
            temp_dir.replace(package_dir)
            return {
                "directory": package_dir,
                "outputs": outputs,
                "cover": "cover.jpg",
                "manifest": "manifest.json",
            }
        except ContentEngineError:
            shutil.rmtree(temp_dir, ignore_errors=True)
            shutil.rmtree(package_dir, ignore_errors=True)
            raise
        except Exception as error:
            shutil.rmtree(temp_dir, ignore_errors=True)
            shutil.rmtree(package_dir, ignore_errors=True)
            raise ContentEngineError("render_failed", str(error)) from error

    def cleanup_package(self, package_id: str) -> None:
        shutil.rmtree(self.data_dir / "render-temp" / package_id, ignore_errors=True)
        shutil.rmtree(self.data_dir / "exports" / package_id, ignore_errors=True)

    def _normalize_segment(self, segment, preset, platform_dir, index):
        source = Path(segment["path"])
        target_ms = int(segment["target_duration_ms"])
        source_start_ms = max(0, int(segment.get("source_start_ms") or 0))
        source_end_ms = segment.get("source_end_ms")
        if source_end_ms is not None:
            source_end_ms = int(source_end_ms)
            if source_end_ms <= source_start_ms:
                raise ContentEngineError(
                    "invalid_duration", "Source end must be after source start."
                )
            target_ms = min(target_ms, source_end_ms - source_start_ms)
        output = platform_dir / f"segment-{index:04d}.mp4"
        video_filter = (
            f"scale={preset.width}:{preset.height}:force_original_aspect_ratio=increase,"
            f"crop={preset.width}:{preset.height},fps={preset.fps},"
            f"format={preset.pixel_format}"
        )
        common_output = [
            "-t",
            f"{target_ms / 1000:.3f}",
            "-c:v",
            preset.video_codec,
            "-rate_control",
            "quality",
            "-quality",
            "75",
            "-scenario",
            "archive",
            "-pix_fmt",
            preset.pixel_format,
            "-r",
            str(preset.fps),
            "-c:a",
            preset.audio_codec,
            "-ar",
            "48000",
            "-ac",
            "2",
            str(output),
        ]
        if segment["media_kind"] == "image":
            command = [
                self.ffmpeg_path,
                "-y",
                "-loop",
                "1",
                "-i",
                str(source),
                "-f",
                "lavfi",
                "-i",
                "anullsrc=channel_layout=stereo:sample_rate=48000",
                "-vf",
                video_filter,
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-shortest",
                *common_output,
            ]
        elif segment.get("has_audio"):
            command = [
                self.ffmpeg_path,
                "-y",
                "-ss",
                f"{source_start_ms / 1000:.3f}",
                "-i",
                str(source),
                "-vf",
                video_filter,
                "-map",
                "0:v:0",
                "-map",
                "0:a:0",
                *common_output,
            ]
        else:
            command = [
                self.ffmpeg_path,
                "-y",
                "-ss",
                f"{source_start_ms / 1000:.3f}",
                "-i",
                str(source),
                "-f",
                "lavfi",
                "-i",
                "anullsrc=channel_layout=stereo:sample_rate=48000",
                "-vf",
                video_filter,
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-shortest",
                *common_output,
            ]
        self._command(command)
        return output

    def _concat(self, segment_paths, preset, output_path, platform_dir):
        concat_file = platform_dir / "concat.txt"
        concat_file.write_text(
            "".join(f"file '{path.name}'\n" for path in segment_paths),
            encoding="utf-8",
        )
        command = [
            self.ffmpeg_path,
            "-y",
            "-f",
            "concat",
            "-safe",
            "1",
            "-i",
            str(concat_file),
            "-c",
            "copy",
        ]
        if preset.faststart:
            command.extend(("-movflags", "+faststart"))
        command.append(str(output_path))
        self._command(command, cwd=platform_dir)

    def _command(self, args, *, cwd=None):
        try:
            result = self._run_process(
                list(args),
                cwd=str(cwd) if cwd else None,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.timeout_seconds,
                check=False,
                shell=False,
                **_windows_process_options(),
            )
        except subprocess.TimeoutExpired as error:
            raise ContentEngineError("render_timeout", "FFmpeg render timed out.") from error
        if result.returncode != 0:
            detail = (result.stderr or "FFmpeg render failed.")[-2_000:]
            raise ContentEngineError("render_failed", detail)
        return result
