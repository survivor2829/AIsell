from __future__ import annotations

from pathlib import Path
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import threading
from typing import Any, Callable
import uuid

from .errors import ContentEngineError
from .hashing import canonical_json_sha256
from .remotion_render import (
    RemotionRenderError,
    RemotionWorkerClient,
    RenderCancelledError,
    _kill_process_tree,
)
from .render_mix import discover_media_executable, _windows_process_options


DIRECTOR_ZONE_LAYOUTS = {
    "top_banner": (54, 76, 972, 196),
    "upper_left": (54, 318, 470, 116),
    "upper_right": (551, 318, 475, 116),
    "middle_left": (54, 720, 470, 116),
    "middle_right": (551, 720, 475, 116),
}

AUTO_MIX_MAX_SPEECH_WINDOW_GAIN_DB = 20.0


class FFmpegCreativeRenderer:
    def __init__(
        self,
        data_dir: Path,
        *,
        ffmpeg_path: str | None = None,
        ffprobe_path: str | None = None,
        command_runner=None,
        popen_factory=subprocess.Popen,
        process_tree_killer=_kill_process_tree,
        timeout_seconds: int = 2 * 60 * 60,
    ):
        self.data_dir = Path(data_dir).resolve()
        self.ffmpeg_path = ffmpeg_path or discover_media_executable(
            "ffmpeg", "XIAOXI_FFMPEG_PATH"
        )
        self.ffprobe_path = ffprobe_path or discover_media_executable(
            "ffprobe", "XIAOXI_FFPROBE_PATH"
        )
        self._run_process = command_runner
        self._popen = popen_factory
        self._tree_killer = process_tree_killer
        self._active_processes: dict[int, Any] = {}
        self._process_lock = threading.Lock()
        self._cancel_requested = threading.Event()
        self.timeout_seconds = max(10, int(timeout_seconds))
        self.font_paths = self._discover_font_paths()
        self.font_path = self.font_paths["microsoft_yahei"]
        self._encoder_checked = False
        self._preferred_encoder = "h264_mf"

    @property
    def capability(self):
        if not self.ffmpeg_path or not self.ffprobe_path:
            return {
                "available": False,
                "code": "media_tools_unavailable",
                "hardware_encoder": False,
            }
        try:
            self._encoder()
        except ContentEngineError as error:
            return {
                "available": False,
                "code": error.code,
                "hardware_encoder": False,
            }
        return {
            "available": True,
            "code": "ready",
            "hardware_encoder": False,
        }

    @staticmethod
    def _is_auto_mix_v2(recipe) -> bool:
        return recipe.get("product_workflow") == "one_click_v2"

    def _managed_audio_path(self, value, *, code, message) -> Path:
        relative = str(value or "").strip()
        relative_path = Path(relative)
        if not relative or relative_path.is_absolute() or relative_path.drive:
            raise ContentEngineError(code, message)
        candidate = (self.data_dir / relative_path).resolve()
        if self.data_dir not in candidate.parents or not candidate.is_file():
            raise ContentEngineError(code, message)
        return candidate

    def _validate_auto_mix_v2_recipe(self, recipe) -> None:
        if not self._is_auto_mix_v2(recipe):
            return
        if recipe.get("kind") != "mix" or recipe.get("audio_mode") != "tts_only":
            raise ContentEngineError(
                "auto_mix_tts_only_required",
                "一键混剪 V2 必须静音素材原声并使用已验证的 TTS。",
            )
        self._managed_audio_path(
            recipe.get("voice_audio_path"),
            code="auto_mix_voice_required",
            message="一键混剪 V2 缺少已验证的 TTS 人声文件。",
        )
        self._managed_audio_path(
            recipe.get("licensed_music_relative_path"),
            code="auto_mix_music_required",
            message="一键混剪 V2 缺少有效授权音乐文件。",
        )
        for caption in recipe.get("captions") or []:
            if (
                not isinstance(caption, dict)
                or caption.get("timing")
                not in {"audio_measured", "asr_aligned", "forced_aligned"}
            ):
                raise ContentEngineError(
                    "auto_mix_caption_estimated",
                    "一键混剪 V2 不接受估算字幕时间。",
                )
        music_meta = recipe.get("licensed_music") or {}
        try:
            track_duration_ms = int(music_meta.get("duration_ms") or 0)
            loop_start_ms = music_meta.get("loop_start_ms")
            loop_end_ms = music_meta.get("loop_end_ms")
            if loop_start_ms is not None or loop_end_ms is not None:
                loop_start_ms = int(loop_start_ms)
                loop_end_ms = int(loop_end_ms)
                if not 0 <= loop_start_ms < loop_end_ms <= track_duration_ms:
                    raise ValueError
        except (TypeError, ValueError) as error:
            raise ContentEngineError(
                "auto_mix_music_loop_invalid", "授权音乐循环点无效。"
            ) from error
        packaging = recipe.get("packaging") or {}
        visual = packaging.get("visualRenderer") or packaging.get("visual_renderer") or {}
        requested = visual.get("requestedEngine", visual.get("requested_engine"))
        allow_fallback = visual.get("allowFallback", visual.get("allow_fallback"))
        if requested != "remotion":
            raise ContentEngineError(
                "auto_mix_remotion_required",
                "一键混剪 V2 正式成片必须使用 Remotion。",
            )
        if allow_fallback is not False:
            raise ContentEngineError(
                "auto_mix_remotion_fallback_forbidden",
                "一键混剪 V2 禁止回退到基础 FFmpeg 成片。",
            )

    def _command(self, args, *, timeout=None, cwd=None, allow_failure=False):
        if self._cancel_requested.is_set():
            raise RenderCancelledError()
        command = list(args)
        options = {
            "cwd": str(cwd) if cwd else None,
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
            "shell": False,
            **_windows_process_options(),
        }
        if self._run_process is not None:
            try:
                result = self._run_process(
                    command,
                    timeout=timeout or self.timeout_seconds,
                    check=False,
                    **options,
                )
            except subprocess.TimeoutExpired as error:
                raise ContentEngineError("render_timeout", "AI 剪辑成片渲染超时。") from error
            if self._cancel_requested.is_set():
                raise RenderCancelledError()
            if result.returncode != 0 and not allow_failure:
                raise ContentEngineError(
                    "render_failed", (result.stderr or "FFmpeg failed")[-2_000:]
                )
            return result

        process = None
        try:
            process = self._popen(command, **options)
            with self._process_lock:
                self._active_processes[id(process)] = process
            if self._cancel_requested.is_set():
                self._terminate_process(process)
            stdout, stderr = process.communicate(
                timeout=timeout or self.timeout_seconds
            )
        except subprocess.TimeoutExpired as error:
            if process is not None:
                self._terminate_process(process)
            raise ContentEngineError("render_timeout", "AI 剪辑成片渲染超时。") from error
        except OSError as error:
            raise ContentEngineError("render_failed", "FFmpeg could not be started.") from error
        finally:
            if process is not None:
                with self._process_lock:
                    self._active_processes.pop(id(process), None)
        if self._cancel_requested.is_set():
            raise RenderCancelledError()
        result = subprocess.CompletedProcess(
            command, process.returncode, stdout=stdout, stderr=stderr
        )
        if result.returncode != 0 and not allow_failure:
            raise ContentEngineError("render_failed", (result.stderr or "FFmpeg failed")[-2_000:])
        return result

    def begin_task(self) -> None:
        self._cancel_requested.clear()

    def cancel(self) -> None:
        self._cancel_requested.set()
        with self._process_lock:
            processes = tuple(self._active_processes.values())
        for process in processes:
            self._terminate_process(process)

    def _terminate_process(self, process) -> None:
        if process.poll() is not None:
            return
        try:
            self._tree_killer(process)
        except (OSError, subprocess.SubprocessError):
            try:
                process.kill()
            except OSError:
                pass

    def _encoder(self):
        if self._encoder_checked:
            return self._preferred_encoder
        if not self.ffmpeg_path:
            raise ContentEngineError(
                "media_encoder_unavailable",
                "未找到 Windows H.264 Media Foundation 编码器。",
            )
        result = self._command(
            [self.ffmpeg_path, "-hide_banner", "-encoders"],
            timeout=30,
            allow_failure=True,
        )
        if result.returncode != 0 or "h264_mf" not in (result.stdout or ""):
            raise ContentEngineError(
                "media_encoder_unavailable",
                "当前 FFmpeg 未提供 Windows H.264 Media Foundation 编码器。",
            )
        self._encoder_checked = True
        return self._preferred_encoder

    def render(
        self,
        *,
        video_id: str,
        recipe: dict[str, Any],
        output_dir: Path,
        resolve_asset_path: Callable[[str], str | Path],
    ) -> dict[str, Path]:
        if self._is_auto_mix_v2(recipe):
            self._validate_auto_mix_v2_recipe(recipe)
            raise ContentEngineError(
                "auto_mix_remotion_required",
                "一键混剪 V2 正式成片不能直接使用基础 FFmpeg 渲染。",
            )
        if not self.capability["available"]:
            raise ContentEngineError(
                "media_tools_unavailable", "FFmpeg and ffprobe are required to render videos."
            )
        output_dir = Path(output_dir)
        temp_dir = output_dir.with_name(f".{output_dir.name}.rendering")
        shutil.rmtree(temp_dir, ignore_errors=True)
        temp_dir.mkdir(parents=True, exist_ok=False)
        try:
            kind = recipe.get("kind")
            output = temp_dir / "video.mp4"
            packaging = recipe.get("packaging") or {}
            render_output = (
                temp_dir / "video-base.mp4"
                if self._needs_finishing(packaging, recipe)
                else output
            )
            captions = recipe.get("captions") or []
            cues = self._caption_cues(captions, recipe)
            self._write_srt(temp_dir / "captions.srt", captions, recipe, cues=cues)
            subtitle = self._write_ass(
                temp_dir / "captions.ass", captions, recipe, cues=cues
            )
            if kind == "course":
                self._render_course(recipe, render_output, subtitle, resolve_asset_path)
            elif kind == "mix":
                self._render_mix(
                    recipe, render_output, subtitle, temp_dir, resolve_asset_path
                )
            else:
                raise ContentEngineError("invalid_recipe", "The render recipe kind is invalid.")
            if render_output != output:
                self._finish_video(
                    render_output, output, recipe, resolve_asset_path
                )
            thumbnail = temp_dir / "cover.jpg"
            cover_mode = str((packaging.get("cover") or {}).get("mode") or "")
            if cover_mode == "reuse":
                # The domain validates and copies the trusted source thumbnail
                # after this atomic render directory is installed. Keep only a
                # target placeholder here instead of rendering work that will
                # immediately be discarded.
                thumbnail.touch()
            else:
                cover_source, cover_seek = self._cover_source(
                    recipe, resolve_asset_path, fallback=output
                )
                self._render_cover(
                    cover_source,
                    thumbnail,
                    packaging,
                    resolve_asset_path,
                    seek_seconds=cover_seek,
                )
            output_dir.parent.mkdir(parents=True, exist_ok=True)
            if output_dir.exists():
                raise ContentEngineError("render_target_exists", "The render target already exists.")
            temp_dir.replace(output_dir)
            return {
                "video_path": output_dir / "video.mp4",
                "thumbnail_path": output_dir / "cover.jpg",
            }
        except Exception:
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise

    def render_mezzanine(
        self,
        *,
        recipe: dict[str, Any],
        output: Path,
        temp_dir: Path,
        resolve_asset_path: Callable[[str], str | Path],
    ) -> Path:
        """Render normalized picture and the final audio master, without overlays."""
        self._validate_auto_mix_v2_recipe(recipe)
        output = Path(output)
        temp_dir = Path(temp_dir)
        kind = recipe.get("kind")
        packaging = recipe.get("packaging") or {}
        base_output = (
            temp_dir / "mezzanine-base.mp4"
            if self._needs_finishing(packaging, recipe)
            else output
        )
        if kind == "course":
            self._render_course_mezzanine(recipe, base_output, resolve_asset_path)
        elif kind == "mix":
            self._render_mix_mezzanine(
                recipe, base_output, temp_dir, resolve_asset_path
            )
        else:
            raise ContentEngineError("invalid_recipe", "The render recipe kind is invalid.")
        if base_output != output:
            self._finish_video(
                base_output,
                output,
                recipe,
                resolve_asset_path,
                include_visual_overlays=False,
            )
        return output

    @staticmethod
    def _mezzanine_audio_filter(recipe):
        if FFmpegCreativeRenderer._is_auto_mix_v2(recipe):
            return FFmpegCreativeRenderer._auto_mix_v2_voice_filter()
        return (
            f"{FFmpegCreativeRenderer._audio_filter(recipe)},"
            "aresample=48000:async=1:first_pts=0,asetpts=PTS-STARTPTS"
        )

    @staticmethod
    def _auto_mix_v2_voice_filter():
        return (
            "highpass=f=70,afftdn=nf=-28,"
            "acompressor=threshold=-18dB:ratio=2.5:attack=10:release=160:makeup=1.5,"
            "aresample=48000:async=1:first_pts=0,asetpts=PTS-STARTPTS"
        )

    def _render_course_mezzanine(self, recipe, output, resolve_asset_path):
        voice = recipe["voice_segment"]
        source = Path(resolve_asset_path(voice["asset_id"]))
        start_ms = int(voice["start_ms"])
        duration_ms = int(voice["end_ms"]) - start_ms
        args = [
            "-ss", f"{start_ms / 1000:.3f}", "-i", str(source),
            "-t", f"{duration_ms / 1000:.3f}",
        ]
        layout_filter = self._course_layout_filter(
            recipe, None, include_overlays=False, reset_pts=True
        )
        if layout_filter:
            args.extend(("-filter_complex", layout_filter))
            video_map = "[vout]"
        else:
            args.extend(
                (
                    "-vf",
                    f"{self._portrait_base_filter()},setpts=PTS-STARTPTS",
                )
            )
            video_map = "0:v:0"
        args.extend(
            (
                "-af", self._mezzanine_audio_filter(recipe),
                "-map", video_map, "-map", "0:a:0?",
            )
        )
        self._encode_mezzanine(args, output)

    def _render_mix_mezzanine(
        self, recipe, output, temp_dir, resolve_asset_path
    ):
        self._render_mix(
            recipe,
            output,
            None,
            temp_dir,
            resolve_asset_path,
            include_overlays=False,
            mezzanine=True,
        )

    def _encode_mezzanine(self, input_args, output, *, audio=True, cwd=None):
        command = [self.ffmpeg_path, "-y", *input_args, "-c:v", self._encoder()]
        command.extend(
            (
                "-rate_control", "quality", "-quality", "80", "-scenario", "archive",
                "-pix_fmt", "yuv420p", "-r", "30", "-fps_mode", "cfr",
                "-color_primaries", "bt709", "-color_trc", "bt709",
                "-colorspace", "bt709",
                "-bsf:v",
                "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
            )
        )
        if audio:
            command.extend(("-c:a", "aac", "-ar", "48000", "-ac", "2"))
        command.extend(("-movflags", "+faststart", str(output)))
        result = self._command(command, cwd=cwd, allow_failure=True)
        if result.returncode == 0:
            return
        raise ContentEngineError(
            "render_failed", str(result.stderr or "FFmpeg failed")[-2_000:]
        )

    def mux_visual_with_mezzanine_audio(
        self, visual_path: Path, mezzanine_path: Path, output_path: Path
    ) -> None:
        self._command(
            [
                self.ffmpeg_path, "-y",
                "-i", str(visual_path), "-i", str(mezzanine_path),
                "-map", "0:v:0", "-map", "1:a:0",
                "-c:v", "copy", "-c:a", "copy",
                "-movflags", "+faststart", "-shortest", str(output_path),
            ]
        )

    def _probe_rendered_media(self, path: Path) -> dict[str, Any]:
        result = self._command(
            [
                self.ffprobe_path,
                "-v", "error", "-show_streams", "-show_format",
                "-of", "json", str(path),
            ],
            timeout=120,
        )
        try:
            payload = json.loads(result.stdout or "{}")
        except (TypeError, ValueError) as error:
            raise RemotionRenderError("output-quality", "media_probe_invalid") from error
        streams = payload.get("streams") if isinstance(payload, dict) else None
        if not isinstance(streams, list):
            raise RemotionRenderError("output-quality", "media_streams_missing")
        video = next(
            (stream for stream in streams if stream.get("codec_type") == "video"), None
        )
        audio = next(
            (stream for stream in streams if stream.get("codec_type") == "audio"), None
        )
        if not video or not audio:
            raise RemotionRenderError("output-quality", "media_streams_missing")
        frame_rate = str(video.get("avg_frame_rate") or "0/1")
        try:
            numerator, denominator = frame_rate.split("/", 1)
            fps = float(numerator) / max(float(denominator), 0.000001)
            duration = float((payload.get("format") or {}).get("duration") or 0)
            video_start = float(video.get("start_time") or 0)
            audio_start = float(audio.get("start_time") or 0)
        except (TypeError, ValueError, ZeroDivisionError) as error:
            raise RemotionRenderError("output-quality", "media_metadata_invalid") from error
        return {
            "video_codec": str(video.get("codec_name") or ""),
            "audio_codec": str(audio.get("codec_name") or ""),
            "width": int(video.get("width") or 0),
            "height": int(video.get("height") or 0),
            "fps": fps,
            "pixel_format": str(video.get("pix_fmt") or ""),
            "color_space": str(video.get("color_space") or ""),
            "color_primaries": str(video.get("color_primaries") or ""),
            "color_transfer": str(video.get("color_transfer") or ""),
            "sample_rate": int(audio.get("sample_rate") or 0),
            "duration_ms": round(duration * 1000),
            "video_duration_ms": self._stream_duration_ms(video),
            "audio_duration_ms": self._stream_duration_ms(audio),
            "video_start_ms": round(video_start * 1000),
            "audio_start_ms": round(audio_start * 1000),
        }

    def probe_audio_duration_ms(self, path: Path) -> int:
        """Return a real audio-stream duration without exposing the input path."""
        try:
            result = self._command(
                [
                    self.ffprobe_path,
                    "-v",
                    "error",
                    "-select_streams",
                    "a:0",
                    "-show_entries",
                    "stream=duration:format=duration",
                    "-of",
                    "json",
                    str(path),
                ],
                timeout=120,
                allow_failure=True,
            )
        except (ContentEngineError, OSError) as error:
            raise ContentEngineError(
                "audio_probe_failed", "无法读取音频时长。"
            ) from error
        if result.returncode != 0:
            raise ContentEngineError("audio_probe_failed", "无法读取音频时长。")
        try:
            payload = json.loads(result.stdout or "{}")
            streams = payload.get("streams") or []
            raw = (streams[0] if streams else {}).get("duration")
            if raw in (None, "N/A"):
                raw = (payload.get("format") or {}).get("duration")
            duration = float(raw)
        except (AttributeError, IndexError, TypeError, ValueError) as error:
            raise ContentEngineError(
                "audio_probe_failed", "无法读取音频时长。"
            ) from error
        if not math.isfinite(duration) or duration <= 0:
            raise ContentEngineError("audio_probe_failed", "无法读取音频时长。")
        return max(1, round(duration * 1000))

    def measure_audio_quality(self, path: Path) -> dict[str, float]:
        """Measure final integrated loudness and true peak with FFmpeg loudnorm."""
        try:
            result = self._command(
                [
                    self.ffmpeg_path,
                    "-hide_banner",
                    "-nostats",
                    "-i",
                    str(path),
                    "-map",
                    "0:a:0",
                    "-af",
                    "loudnorm=I=-15:LRA=8:TP=-1.2:print_format=json",
                    "-f",
                    "null",
                    os.devnull,
                ],
                timeout=180,
                allow_failure=True,
            )
        except (ContentEngineError, OSError) as error:
            raise ContentEngineError(
                "audio_quality_measure_failed", "音频质量指标无法测量。"
            ) from error
        if result.returncode != 0:
            raise ContentEngineError(
                "audio_quality_measure_failed", "音频质量指标无法测量。"
            )
        blocks = re.findall(
            r'\{[^{}]*"input_i"[^{}]*"input_tp"[^{}]*\}',
            result.stderr or "",
            re.DOTALL,
        )
        try:
            payload = json.loads(blocks[-1])
            integrated = float(payload["input_i"])
            true_peak = float(payload["input_tp"])
        except (IndexError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise ContentEngineError(
                "audio_quality_measure_failed", "音频质量指标无法测量。"
            ) from error
        if not all(math.isfinite(value) for value in (integrated, true_peak)):
            raise ContentEngineError(
                "audio_quality_measure_failed", "音频质量指标无法测量。"
            )
        return {
            "integrated_lufs": round(integrated, 2),
            "true_peak_dbtp": round(true_peak, 2),
        }

    def calibrate_final_loudness(self, path):
        """Calibrate the completed mix; measure both loudness and peak again."""
        measured = self.measure_audio_quality(path)
        if -16 <= measured["integrated_lufs"] <= -14 and measured["true_peak_dbtp"] <= -1:
            return measured
        gain = min(-15 - measured["integrated_lufs"], -1.1 - measured["true_peak_dbtp"])
        audio_filter = f"volume={gain:.4f}dB"
        if not -16 <= measured["integrated_lufs"] + gain <= -14:
            scan = self._command([self.ffmpeg_path, "-hide_banner", "-nostats", "-i", str(path),
                "-map", "0:a:0", "-af", "loudnorm=I=-15:LRA=8:TP=-1.5:print_format=json",
                "-f", "null", os.devnull], timeout=180)
            blocks = re.findall(r'\{[^{}]*"input_i"[^{}]*"input_tp"[^{}]*\}', scan.stderr or "", re.DOTALL)
            values = json.loads(blocks[-1])
            numbers = {key: float(values[key]) for key in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")}
            if not all(math.isfinite(v) for v in numbers.values()):
                raise ContentEngineError("audio_quality_measure_failed", "混音测量无效，未修改音频。")
            audio_filter = (f"loudnorm=I=-15:LRA=8:TP=-1.5:measured_I={numbers['input_i']}:"
                f"measured_TP={numbers['input_tp']}:measured_LRA={numbers['input_lra']}:"
                f"measured_thresh={numbers['input_thresh']}:offset={numbers['target_offset']}:linear=false")
        temporary = path.with_name(path.stem + ".calibrated.mp4")
        try:
            self._command([self.ffmpeg_path, "-y", "-i", str(path), "-map", "0:v:0", "-map", "0:a:0",
                           "-c:v", "copy", "-af", audio_filter, "-c:a", "aac", "-b:a", "192k",
                           "-ar", "48000", "-movflags", "+faststart", str(temporary)])
            verified = self.measure_audio_quality(temporary)
            if not (-16 <= verified["integrated_lufs"] <= -14 and verified["true_peak_dbtp"] <= -1):
                raise ContentEngineError("auto_mix_loudness_failed", "最终音频校准后仍未通过响度或峰值检查。")
            temporary.replace(path)
            return verified
        finally:
            temporary.unlink(missing_ok=True)

    def _measure_loudness_series(self, path):
        result = self._command(
            [
                self.ffmpeg_path,
                "-hide_banner",
                "-nostats",
                "-i",
                str(path),
                "-map",
                "0:a:0",
                "-af",
                "ebur128=metadata=1,ametadata=print:key=lavfi.r128.M:file=-",
                "-f",
                "null",
                os.devnull,
            ],
            timeout=120,
            allow_failure=True,
        )
        if result.returncode != 0:
            raise ContentEngineError(
                "audio_quality_measure_failed", "音频窗口响度无法测量。"
            )
        def parse(value):
            samples = []
            timestamp = None
            for line in str(value or "").splitlines():
                time_match = re.search(r"\bpts_time:([-+0-9.eE]+)", line)
                if time_match:
                    try:
                        timestamp = float(time_match.group(1))
                    except ValueError:
                        timestamp = None
                    continue
                loudness_match = re.search(
                    r"lavfi\.r128\.M=([-+]?(?:[0-9.]+|inf))",
                    line,
                    re.IGNORECASE,
                )
                if loudness_match and timestamp is not None:
                    try:
                        samples.append((timestamp * 1000, float(loudness_match.group(1))))
                    except ValueError:
                        pass
                    timestamp = None
            return samples

        series = max(
            (parse(result.stdout), parse(result.stderr)), key=len
        )
        if not series:
            raise ContentEngineError(
                "audio_quality_measure_failed", "音频窗口响度无法测量。"
            )
        return series

    @staticmethod
    def _window_lufs(series, start_ms, end_ms):
        start_ms = max(0, int(start_ms))
        end_ms = max(start_ms + 1, int(end_ms))
        if end_ms - start_ms < 400:
            midpoint = (start_ms + end_ms) // 2
            start_ms = max(0, midpoint - 200)
            end_ms = start_ms + 400
        values = [
            value
            for timestamp, value in series
            if start_ms <= timestamp <= end_ms + 100
            and math.isfinite(value)
            and value > -100
        ]
        if not values:
            return float("-inf")
        energy = sum(10 ** (value / 10) for value in values) / len(values)
        return 10 * math.log10(energy)

    @staticmethod
    def _auto_mix_margin_report_path(path):
        path = Path(path)
        return path.with_name(f"{path.name}.speech-music.json")

    def read_auto_mix_speech_music_report(self, path):
        report_path = self._auto_mix_margin_report_path(path)
        try:
            value = json.loads(report_path.read_text(encoding="utf-8"))
            margin = float(value["speech_music_margin_lu"])
            gain = float(value["music_gain_db"])
            windows = value["windows"]
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise ContentEngineError(
                "audio_quality_measure_failed", "说话窗口混音证据不可用。"
            ) from error
        if (
            not math.isfinite(margin)
            or not math.isfinite(gain)
            or not isinstance(windows, list)
            or not windows
        ):
            raise ContentEngineError(
                "audio_quality_measure_failed", "说话窗口混音证据无效。"
            )
        return {
            "speech_music_margin_lu": round(margin, 2),
            "speech_music_windows": windows,
            "music_gain_db": round(gain, 2),
        }

    @staticmethod
    def _stream_duration_ms(stream):
        try:
            value = stream.get("duration")
            if value is None:
                return None
            return round(float(value) * 1000)
        except (TypeError, ValueError):
            return None

    def _audio_digest(self, path: Path) -> str:
        result = self._command(
            [
                self.ffmpeg_path, "-v", "error", "-i", str(path),
                "-map", "0:a:0", "-c:a", "copy",
                "-f", "hash", "-hash", "sha256", "-",
            ],
            timeout=120,
        )
        match = re.search(r"SHA256=([0-9a-f]{64})", result.stdout or "", re.I)
        if not match:
            raise RemotionRenderError("output-quality", "audio_digest_missing")
        return match.group(1).lower()

    @staticmethod
    def _validate_media_contract(metadata, *, expected_duration_ms, final):
        expected_video = "h264" if final else None
        expected_duration_ms = int(expected_duration_ms)
        video_duration_ms = metadata.get("video_duration_ms", metadata.get("duration_ms"))
        audio_duration_ms = metadata.get("audio_duration_ms", metadata.get("duration_ms"))
        if expected_video and metadata["video_codec"] != expected_video:
            raise RemotionRenderError("output-quality", "final_video_codec_invalid")
        if (
            metadata["audio_codec"] != "aac"
            or metadata["width"] != 1080
            or metadata["height"] != 1920
            or abs(metadata["fps"] - 30) > 0.01
            or metadata["pixel_format"] != "yuv420p"
            or metadata["sample_rate"] != 48_000
            or abs(metadata["video_start_ms"]) > 50
            or abs(metadata["audio_start_ms"]) > 50
        ):
            raise RemotionRenderError("output-quality", "media_contract_mismatch")
        if (
            abs(metadata["duration_ms"] - expected_duration_ms) > 350
            or video_duration_ms is None
            or audio_duration_ms is None
            or abs(video_duration_ms - expected_duration_ms) > 350
            or abs(audio_duration_ms - expected_duration_ms) > 350
            or abs(video_duration_ms - audio_duration_ms) > 350
        ):
            raise RemotionRenderError("output-quality", "media_track_duration_mismatch")
        if not final and any(
            metadata[key] != "bt709"
            for key in ("color_space", "color_primaries", "color_transfer")
        ):
            raise RemotionRenderError("output-quality", "mezzanine_color_mismatch")

    def validate_mezzanine(self, path: Path, *, expected_duration_ms: int):
        metadata = self._probe_rendered_media(path)
        self._validate_media_contract(
            metadata, expected_duration_ms=expected_duration_ms, final=False
        )
        metadata["audio_digest"] = self._audio_digest(path)
        return metadata

    def validate_final(
        self,
        path: Path,
        *,
        expected_duration_ms: int,
        expected_audio_digest: str,
    ):
        metadata = self._probe_rendered_media(path)
        self._validate_media_contract(
            metadata, expected_duration_ms=expected_duration_ms, final=True
        )
        metadata["audio_digest"] = self._audio_digest(path)
        if metadata["audio_digest"] != expected_audio_digest:
            raise RemotionRenderError("output-quality", "final_audio_changed")
        return metadata

    def validate_rendered_output(self, path: Path, *, expected_duration_ms: int):
        """Validate a legacy/fallback output before it can be installed.

        The database duration is not enough: a malformed MP4 can advertise the
        audio/container duration while its video stream ends much earlier.  A
        fallback is only useful if both streams cover the same requested
        timeline.
        """
        metadata = self._probe_rendered_media(path)
        self._validate_media_contract(
            metadata, expected_duration_ms=expected_duration_ms, final=True
        )
        return metadata

    def render_cover_for_candidate(
        self, video_path, cover_path, recipe, resolve_asset_path
    ) -> None:
        packaging = recipe.get("packaging") or {}
        if str((packaging.get("cover") or {}).get("mode") or "") == "reuse":
            Path(cover_path).touch()
            return
        self._render_cover(
            video_path,
            cover_path,
            packaging,
            resolve_asset_path,
            seek_seconds=0.5,
        )

    def _render_course(self, recipe, output, subtitle, resolve_asset_path):
        voice = recipe["voice_segment"]
        source = Path(resolve_asset_path(voice["asset_id"]))
        start_ms = int(voice["start_ms"])
        duration_ms = int(voice["end_ms"]) - start_ms
        args = [
            "-ss",
            f"{start_ms / 1000:.3f}",
            "-i",
            str(source),
            "-t",
            f"{duration_ms / 1000:.3f}",
        ]
        packaging = recipe.get("packaging") or {}
        legacy_presentation = not packaging and any(
            segment.get("frame_mode") == "slide_with_teacher_pip"
            for segment in recipe.get("visual_segments") or []
        )
        layout_filter = (
            self._presentation_filter(subtitle)
            if legacy_presentation
            else self._course_layout_filter(recipe, subtitle)
        )
        if layout_filter:
            args.extend(
                (
                    "-filter_complex",
                    layout_filter,
                )
            )
            video_map = "[vout]"
        else:
            args.extend(
                ("-vf", self._portrait_filter(subtitle, recipe.get("packaging")))
            )
            video_map = "0:v:0"
        args.extend(
            (
                "-af",
                self._audio_filter(recipe),
                "-map",
                video_map,
                "-map",
                "0:a:0?",
            )
        )
        self._encode_with_fallback(args, output)

    def _render_mix(
        self,
        recipe,
        output,
        subtitle,
        temp_dir,
        resolve_asset_path,
        *,
        include_overlays=True,
        mezzanine=False,
    ):
        auto_mix_v2 = self._is_auto_mix_v2(recipe)
        normalized_dir = temp_dir / "visuals"
        normalized_dir.mkdir()
        selected_bgm_asset_id = (
            ""
            if auto_mix_v2
            else str(recipe.get("selected_bgm_asset_id") or "").strip()
        )
        montage_audio = (
            not auto_mix_v2
            and recipe.get("audio_mode") == "visual_montage"
            and not selected_bgm_asset_id
        )
        visual_outputs = []
        for index, segment in enumerate(recipe.get("visual_segments") or []):
            target = normalized_dir / f"visual-{index:03d}.mp4"
            source = Path(resolve_asset_path(segment["asset_id"]))
            target_ms = int(segment["target_duration_ms"])
            start_ms = int(segment.get("start_ms") or 0)
            end_ms = int(segment.get("end_ms") or 0)
            if auto_mix_v2:
                # V2 deliberately keeps the selected source frame intact.  A
                # landscape source becomes a centred foreground card over its
                # own soft portrait background, while a native portrait source
                # continues to fill the canvas.  Do this before Remotion adds
                # titles and captions so no subject is cropped out by the
                # legacy centre-crop fallback.
                if segment.get("media_kind") == "image":
                    source_args = ["-loop", "1", "-i", str(source)]
                else:
                    if end_ms <= start_ms:
                        raise ContentEngineError(
                            "invalid_recipe", "A mix video segment has an invalid source range."
                        )
                    bounded = normalized_dir / f"bounded-{index:03d}.mp4"
                    self._encode_with_fallback(
                        [
                            "-ss",
                            f"{start_ms / 1000:.3f}",
                            "-i",
                            str(source),
                            "-t",
                            f"{(end_ms - start_ms) / 1000:.3f}",
                            "-an",
                        ],
                        bounded,
                        audio=False,
                    )
                    source_args = ["-i", str(bounded)]
                self._encode_with_fallback(
                    [
                        *source_args,
                        "-t",
                        f"{target_ms / 1000:.3f}",
                        "-filter_complex",
                        self._auto_mix_v2_canvas_filter(),
                        "-map",
                        "[auto_mix_vout]",
                        "-an",
                    ],
                    target,
                    audio=False,
                )
                visual_outputs.append(target)
                continue
            product_showcase = (
                recipe.get("layout") == "product_showcase"
            )
            if product_showcase and segment.get("media_kind") == "image":
                # Still images are never held as a frozen full-screen frame:
                # a bounded zoom-pan gives every product image a visual beat.
                frames = max(1, round(target_ms / 1000 * 30))
                motion_filter = (
                    "scale=1400:-2:force_original_aspect_ratio=increase,"
                    "crop=1080:1920,"
                    f"zoompan=z='min(zoom+0.0015,1.12)':d={frames}:"
                    "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30"
                )
            else:
                motion_filter = self._portrait_filter(None)
            common = ["-t", f"{target_ms / 1000:.3f}", "-vf", motion_filter]
            if not montage_audio:
                common.append("-an")
            if segment.get("media_kind") == "image":
                source_args = ["-loop", "1", "-i", str(source)]
            else:
                if end_ms <= start_ms:
                    raise ContentEngineError(
                        "invalid_recipe", "A mix video segment has an invalid source range."
                    )
                bounded = normalized_dir / f"bounded-{index:03d}.mp4"
                self._encode_with_fallback(
                    [
                        "-ss",
                        f"{start_ms / 1000:.3f}",
                        "-i",
                        str(source),
                        "-t",
                        f"{(end_ms - start_ms) / 1000:.3f}",
                        "-vf",
                        self._portrait_filter(None),
                        *([] if montage_audio else ["-an"]),
                    ],
                    bounded,
                    audio=montage_audio,
                )
                # Product recipes are capacity-bounded by the planner: their
                # target duration is exactly the selected source-window
                # duration.  Never add stream_loop on that path, because a
                # rounding or timestamp mismatch would replay the beginning of
                # the shot.  Legacy mix recipes retain their bounded-loop
                # compatibility until they adopt the same capacity contract.
                source_args = (
                    ["-i", str(bounded)]
                    if product_showcase
                    else ["-stream_loop", "-1", "-i", str(bounded)]
                )
            self._encode_with_fallback(
                [*source_args, *common], target, audio=montage_audio
            )
            visual_outputs.append(target)
        if not visual_outputs:
            raise ContentEngineError("invalid_recipe", "Mix recipe has no visual segments.")
        concat_file = normalized_dir / "concat.txt"
        concat_file.write_text(
            "".join(f"file '{item.name}'\n" for item in visual_outputs), encoding="utf-8"
        )
        visuals = temp_dir / "visual-track.mp4"
        # Do not stream-copy the concat demuxer output. The source clips can
        # carry different colour metadata and timestamp time-bases; copying
        # those packets produces a track that reports the right container
        # duration but loses frames when the next CFR encode normalizes it.
        # Re-encode the assembled track once so video and audio share one
        # continuous 30fps timeline before the final mezzanine encode.
        self._encode_mezzanine(
            [
                "-f",
                "concat",
                "-safe",
                "1",
                "-i",
                str(concat_file),
            ],
            visuals,
            audio=montage_audio,
            cwd=normalized_dir,
        )
        voice = recipe["voice_segment"]
        voice_audio_path = recipe.get("voice_audio_path")
        if voice_audio_path:
            candidate = (self.data_dir / str(voice_audio_path)).resolve()
            if self.data_dir not in candidate.parents or not candidate.is_file():
                raise ContentEngineError("product_voice_missing", "商品配音文件不可用。")
            voice_source = candidate
        else:
            voice_source = Path(
                resolve_asset_path(selected_bgm_asset_id or voice["asset_id"])
            )
        voice_start = 0 if selected_bgm_asset_id else int(voice["start_ms"])
        duration_ms = int(voice["end_ms"]) - voice_start
        merge_filter = (
            self._overlay_filter(recipe.get("packaging"), subtitle)
            if include_overlays
            else "setpts=PTS-STARTPTS"
        )
        if montage_audio and not voice_audio_path:
            args = [
                "-i",
                str(visuals),
                "-t",
                f"{duration_ms / 1000:.3f}",
            ]
            audio_map = "0:a:0?"
        else:
            args = ["-i", str(visuals)]
            if selected_bgm_asset_id:
                args.extend(("-stream_loop", "-1"))
            args.extend(
                (
                    "-ss",
                    "0" if voice_audio_path or selected_bgm_asset_id else f"{voice_start / 1000:.3f}",
                    "-i",
                    str(voice_source),
                    "-t",
                    f"{duration_ms / 1000:.3f}",
                )
            )
            audio_map = "1:a:0?"
        if merge_filter:
            args.extend(("-vf", merge_filter))
        audio_filter = (
            self._mezzanine_audio_filter(recipe)
            if mezzanine
            else self._audio_filter(recipe)
        )
        if voice_audio_path:
            if auto_mix_v2:
                # V2's timeline is derived from measured phrase audio. If that
                # contract drifts, end at the real audio instead of fabricating
                # a silent tail; the downstream duration validator then fails
                # the candidate closed.
                audio_filter = (
                    f"{audio_filter},atrim=duration={max(0.001, duration_ms / 1000):.3f},"
                    "asetpts=PTS-STARTPTS"
                )
            else:
                # V1 retains its historical compatibility padding.
                duration_seconds = max(0.001, duration_ms / 1000)
                audio_filter = (
                    f"{audio_filter},apad=whole_dur={duration_seconds:.3f},"
                    f"atrim=duration={duration_seconds:.3f},asetpts=PTS-STARTPTS"
                )
        args.extend(
            (
                "-af",
                audio_filter,
                "-map",
                "0:v:0",
                "-map",
                audio_map if montage_audio or voice_audio_path else "1:a:0",
            )
        )
        if auto_mix_v2:
            args.extend(("-shortest", "-t", f"{duration_ms / 1000:.3f}"))
        if mezzanine:
            self._encode_mezzanine(args, output)
        else:
            self._encode_with_fallback(args, output)

    def _encode_with_fallback(self, input_args, output, *, audio=True):
        command = [self.ffmpeg_path, "-y", *input_args, "-c:v", self._encoder()]
        command.extend(
            (
                "-rate_control", "quality", "-quality", "75", "-scenario", "archive",
                "-pix_fmt", "yuv420p", "-r", "30",
            )
        )
        if audio:
            command.extend(("-c:a", "aac", "-ar", "48000", "-ac", "2"))
        command.extend(("-movflags", "+faststart", str(output)))
        result = self._command(command, allow_failure=True)
        if result.returncode == 0:
            return
        raise ContentEngineError("render_failed", str(result.stderr or "FFmpeg failed")[-2_000:])

    @staticmethod
    def _audio_filter(recipe):
        audio = (recipe.get("packaging") or {}).get("audio") or {}
        profile = audio.get("profile")
        filters = ["highpass=f=80", "afftdn=nf=-25"]
        if profile == "mix_rhythm":
            filters.append(
                "acompressor=threshold=-18dB:ratio=2.5:attack=12:release=180:makeup=1.5"
            )
        filters.extend(
            (
                "loudnorm=I=-16:LRA=11:TP=-1.5",
                "alimiter=limit=0.75:attack=5:release=50:level=false",
            )
        )
        return ",".join(filters)

    @staticmethod
    def _needs_finishing(packaging, recipe=None):
        if recipe and FFmpegCreativeRenderer._is_auto_mix_v2(recipe):
            return True
        if not isinstance(packaging, dict) or not packaging:
            return False
        brand = packaging.get("brand") or {}
        audio = packaging.get("audio") or {}
        return bool(
            brand.get("logo_asset_id")
            or str(brand.get("outro_text") or "").strip()
            or audio.get("bgm")
            or int(audio.get("cue_budget") or 0) > 0
        )

    def _finish_video(
        self,
        source,
        output,
        recipe,
        resolve_asset_path,
        *,
        include_visual_overlays=True,
    ):
        if self._is_auto_mix_v2(recipe):
            return self._finish_auto_mix_v2(source, output, recipe)
        packaging = recipe.get("packaging") or {}
        brand = packaging.get("brand") or {}
        audio = packaging.get("audio") or {}
        visual_montage = recipe.get("audio_mode") == "visual_montage"
        voice = recipe.get("voice_segment") or {}
        duration = max(
            0.1,
            (int(voice.get("end_ms") or 0) - int(voice.get("start_ms") or 0))
            / 1000,
        )
        args = ["-i", str(source)]
        filter_parts = []
        video_label = "0:v"

        logo_id = (
            str(brand.get("logo_asset_id") or "").strip()
            if include_visual_overlays
            else ""
        )
        if logo_id:
            logo_path = Path(resolve_asset_path(logo_id))
            logo_input = 1
            args.extend(("-loop", "1", "-i", str(logo_path)))
            filter_parts.extend(
                (
                    f"[{logo_input}:v]scale=180:-1:force_original_aspect_ratio=decrease,"
                    "format=rgba,colorchannelmixer=aa=0.88[brand_logo]",
                    f"[{video_label}][brand_logo]overlay=W-w-40:40:shortest=1[vlogo]",
                )
            )
            video_label = "vlogo"

        outro = (
            self._ffmpeg_text(brand.get("outro_text") or "")
            if include_visual_overlays
            else ""
        )
        if outro:
            outro_start = max(0.0, duration - 0.8)
            enable = f"between(t,{outro_start:.3f},{duration:.3f})"
            font = self._drawtext_font_option(packaging)
            filter_parts.append(
                f"[{video_label}]drawbox=x=0:y=0:w=iw:h=ih:color=black@0.76:t=fill:"
                f"enable='{enable}',drawtext={font}:text='{outro}':fontcolor=white:"
                f"fontsize=72:x=(w-text_w)/2:y=(h-text_h)/2:enable='{enable}'[vout]"
            )
            video_label = "vout"

        next_input = 2 if logo_id else 1
        audio_labels = []
        primary_audio_label = "[0:a]"
        # Visual-only source clips often already contain their own music bed.
        # Do not stack the procedural product BGM on top of that source track.
        if audio.get("bgm") and not visual_montage:
            bgm_input = next_input
            next_input += 1
            bgm_asset_id = str(audio.get("bgm_asset_id") or "").strip()
            if bgm_asset_id:
                bgm_path = Path(resolve_asset_path(bgm_asset_id))
                args.extend(("-stream_loop", "-1", "-i", str(bgm_path)))
            elif recipe.get("source_bgm_asset_id"):
                # Product footage may carry its own music bed. Reuse it once
                # instead of stacking another procedural track on top.
                bgm_path = Path(resolve_asset_path(recipe["source_bgm_asset_id"]))
                args.extend(("-stream_loop", "-1", "-i", str(bgm_path)))
            else:
                args.extend(
                    (
                        "-f", "lavfi", "-t", f"{duration:.3f}", "-i",
                        "aevalsrc=exprs=0.55*sin(2*PI*110*t)+0.28*sin(2*PI*165*t):s=48000",
                    )
                )
            gain = max(-40.0, min(-12.0, float(audio.get("bgm_gain_db") or -24)))
            fade_out = max(0.0, duration - 0.8)
            filter_parts.extend(
                (
                    "[0:a]asplit=2[primary_mix][primary_sidechain]",
                    f"[{bgm_input}:a]volume={gain:.1f}dB,lowpass=f=1200,"
                    f"afade=t=in:st=0:d=0.4,afade=t=out:st={fade_out:.3f}:d=0.8[bgm]",
                    "[bgm][primary_sidechain]sidechaincompress=threshold=0.04:ratio=8:"
                    "attack=10:release=250[ducked_bgm]",
                )
            )
            primary_audio_label = "[primary_mix]"
            audio_labels.append("[ducked_bgm]")

        audio_labels.insert(0, primary_audio_label)

        cue_budget = 0 if visual_montage else max(0, min(4, int(audio.get("cue_budget") or 0)))
        cue_times = []
        for event in packaging.get("events") or []:
            cue_ms = max(
                0,
                min(
                    int(duration * 1000) - 120,
                    int(event.get("start_ms") or 0),
                ),
            )
            if any(abs(cue_ms - existing) < 500 for existing in cue_times):
                continue
            cue_times.append(cue_ms)
            if len(cue_times) >= cue_budget:
                break
        for cue_ms in cue_times:
            cue_input = next_input
            next_input += 1
            args.extend(("-f", "lavfi", "-i", "sine=frequency=880:duration=0.12"))
            label = f"cue_{cue_input}"
            filter_parts.append(
                f"[{cue_input}:a]volume=0.045,afade=t=out:st=0.06:d=0.06,"
                f"adelay={cue_ms}|{cue_ms}[{label}]"
            )
            audio_labels.append(f"[{label}]")

        if len(audio_labels) > 1:
            filter_parts.append(
                f"{''.join(audio_labels)}amix=inputs={len(audio_labels)}:"
                "duration=first:dropout_transition=0,"
                "loudnorm=I=-16:LRA=11:TP=-1.5,"
                "alimiter=limit=0.75:attack=5:release=50:level=false[aout]"
            )

        if filter_parts:
            args.extend(("-filter_complex", ";".join(filter_parts)))
        args.extend(("-map", f"[{video_label}]" if video_label != "0:v" else "0:v:0"))
        args.extend(("-map", "[aout]" if len(audio_labels) > 1 else "0:a:0?"))
        args.extend(("-t", f"{duration:.3f}"))
        if include_visual_overlays:
            self._encode_with_fallback(args, output)
        else:
            self._encode_mezzanine(args, output)

    def _auto_mix_music_input(self, music_path, recipe, required_duration_ms, output):
        meta = recipe.get("licensed_music") or {}
        track_duration_ms = int(meta.get("duration_ms") or 0)
        if track_duration_ms >= int(required_duration_ms):
            return ["-i", str(music_path)], None
        loop_start_ms = meta.get("loop_start_ms")
        loop_end_ms = meta.get("loop_end_ms")
        try:
            loop_start_ms = int(loop_start_ms)
            loop_end_ms = int(loop_end_ms)
        except (TypeError, ValueError) as error:
            raise ContentEngineError(
                "auto_mix_music_too_short",
                "授权音乐不足以覆盖成片，且没有可用循环区间。",
            ) from error
        if not 0 <= loop_start_ms < loop_end_ms <= track_duration_ms:
            raise ContentEngineError(
                "auto_mix_music_loop_invalid", "授权音乐循环点无效。"
            )
        loop_path = Path(output).parent / f".auto-mix-loop-{uuid.uuid4().hex}.wav"
        self._command(
            [
                self.ffmpeg_path,
                "-y",
                "-ss",
                f"{loop_start_ms / 1000:.3f}",
                "-t",
                f"{(loop_end_ms - loop_start_ms) / 1000:.3f}",
                "-i",
                str(music_path),
                "-vn",
                "-c:a",
                "pcm_s16le",
                "-ar",
                "48000",
                "-ac",
                "2",
                str(loop_path),
            ],
            timeout=180,
        )
        return ["-stream_loop", "-1", "-i", str(loop_path)], loop_path

    def _measure_auto_mix_window_margins(
        self,
        source,
        music_input,
        captions,
        *,
        duration,
        music_duration,
        fade_out,
        delay_filter,
        output,
        music_envelope_filter="",
        post_duck_gain_filter="",
        music_fade_in=0.0,
    ):
        voice_stem = Path(output).parent / f".auto-mix-voice-{uuid.uuid4().hex}.wav"
        music_stem = Path(output).parent / f".auto-mix-music-{uuid.uuid4().hex}.wav"
        graph = ";".join(
            (
                "[0:a]highpass=f=70,loudnorm=I=-16:LRA=7:TP=-1.2[voice_meter]",
                "[1:a]asetpts=PTS-STARTPTS,"
                "loudnorm=I=-26:LRA=11:TP=-2.0,"
                f"{delay_filter}afade=t=in:st={music_fade_in:.3f}:d=0.4,"
                f"afade=t=out:st={fade_out:.3f}:d=0.8"
                f"{music_envelope_filter}[music_norm]",
                f"[music_norm]{post_duck_gain_filter or 'anull'}[music_meter]",
            )
        )
        try:
            self._command(
                [
                    self.ffmpeg_path,
                    "-y",
                    "-i",
                    str(source),
                    *music_input,
                    "-filter_complex",
                    graph,
                    "-map",
                    "[voice_meter]",
                    "-t",
                    f"{duration:.3f}",
                    "-vn",
                    "-c:a",
                    "pcm_s16le",
                    "-ar",
                    "48000",
                    "-ac",
                    "1",
                    str(voice_stem),
                    "-map",
                    "[music_meter]",
                    "-t",
                    f"{duration:.3f}",
                    "-vn",
                    "-c:a",
                    "pcm_s16le",
                    "-ar",
                    "48000",
                    "-ac",
                    "1",
                    str(music_stem),
                ],
                timeout=300,
            )
            voice_series = self._measure_loudness_series(voice_stem)
            music_series = self._measure_loudness_series(music_stem)
            windows = []
            for caption in captions:
                start_ms = int(caption.get("start_ms") or 0)
                end_ms = int(caption.get("end_ms") or 0)
                if end_ms <= start_ms:
                    raise ContentEngineError(
                        "audio_quality_measure_failed", "口播字幕时间窗口无效。"
                    )
                voice_lufs = self._window_lufs(voice_series, start_ms, end_ms)
                music_lufs = self._window_lufs(music_series, start_ms, end_ms)
                if not math.isfinite(voice_lufs):
                    raise ContentEngineError(
                        "audio_quality_measure_failed", "口播窗口没有可测量人声。"
                    )
                if not math.isfinite(music_lufs) or music_lufs <= -70:
                    raise ContentEngineError(
                        "auto_mix_music_not_audible",
                        "每句口播都必须有可测量的背景音乐。",
                    )
                margin = voice_lufs - music_lufs
                windows.append(
                    {
                        "captionId": str(caption.get("captionId") or ""),
                        "startMs": start_ms,
                        "endMs": end_ms,
                        "voiceLufs": round(voice_lufs, 2),
                        "musicLufs": round(music_lufs, 2),
                        "rawMarginLu": round(margin, 2),
                    }
                )
            if not windows:
                raise ContentEngineError(
                    "auto_mix_music_not_audible",
                    "说话窗口内未检测到可测量音乐，正式成片已停止。",
                )
            return windows
        finally:
            voice_stem.unlink(missing_ok=True)
            music_stem.unlink(missing_ok=True)

    @staticmethod
    def _auto_mix_speech_window_gain_filter(speech_window_gains, *, duration_ms):
        """Build a smooth post-duck music envelope that is full during speech."""
        duration = max(0.001, int(duration_ms or 0) / 1000)
        points = [(0.0, 0.0)]

        def append_point(at_seconds, gain_db):
            at_seconds = min(duration, max(0.0, float(at_seconds)))
            gain_db = float(gain_db)
            if points and at_seconds < points[-1][0] - 0.0001:
                raise ContentEngineError(
                    "auto_mix_voice_music_margin_failed",
                    "口播字幕时间窗口重叠，无法安全执行逐句音乐平衡。",
                )
            if points and abs(points[-1][0] - at_seconds) <= 0.0001:
                points[-1] = (points[-1][0], gain_db)
            else:
                points.append((at_seconds, gain_db))

        previous_end = 0.0
        previous_gain = 0.0
        for item in speech_window_gains:
            start = min(duration, max(0.0, int(item["startMs"]) / 1000))
            end = min(duration, max(start, int(item["endMs"]) / 1000))
            gain = float(item["gainDb"])
            if end <= start:
                raise ContentEngineError(
                    "audio_quality_measure_failed", "口播字幕时间窗口无效。"
                )
            if start < previous_end - 0.0001:
                raise ContentEngineError(
                    "auto_mix_voice_music_margin_failed",
                    "口播字幕时间窗口重叠，无法安全执行逐句音乐平衡。",
                )
            gap = max(0.0, start - previous_end)
            if gap:
                ramp = min(0.08, gap / 2)
                append_point(previous_end, previous_gain)
                append_point(previous_end + ramp, 0.0)
                append_point(start - ramp, 0.0)
            append_point(start, gain)
            append_point(end, gain)
            previous_end = end
            previous_gain = gain
        if previous_end < duration:
            append_point(previous_end, previous_gain)
            append_point(previous_end + min(0.08, duration - previous_end), 0.0)
        append_point(duration, 0.0)

        expression = f"{points[-1][1]:.4f}"
        for index in range(len(points) - 2, -1, -1):
            start, start_gain = points[index]
            end, end_gain = points[index + 1]
            span = end - start
            if span <= 0.0001:
                continue
            interpolated = (
                f"({start_gain:.4f}+({end_gain - start_gain:.4f})*"
                f"(t-{start:.3f})/{span:.3f})"
            )
            expression = f"if(lt(t,{end:.3f}),{interpolated},{expression})"
        return f"volume='pow(10,({expression})/20)':eval=frame"

    @staticmethod
    def _auto_mix_music_gain_plan(windows, *, duration_ms):
        """Choose a global gain when possible, otherwise balance each phrase."""
        prepared = []
        for index, item in enumerate(windows):
            raw_margin = float(item["rawMarginLu"])
            start_ms = int(item["startMs"])
            end_ms = int(item["endMs"])
            if (
                not math.isfinite(raw_margin)
                or end_ms <= start_ms
            ):
                raise ContentEngineError(
                    "audio_quality_measure_failed", "说话窗口混音证据无效。"
                )
            prepared.append(
                {
                    "captionId": str(item.get("captionId") or f"caption-{index + 1}"),
                    "startMs": start_ms,
                    "endMs": end_ms,
                    "rawMarginLu": raw_margin,
                }
            )
        if not prepared:
            raise ContentEngineError(
                "auto_mix_music_not_audible", "说话窗口内未检测到可测量音乐。"
            )

        lower = max(item["rawMarginLu"] - 12 for item in prepared)
        upper = min(item["rawMarginLu"] - 8 for item in prepared)
        if lower <= upper + 0.01:
            desired = (
                sum(item["rawMarginLu"] for item in prepared) / len(prepared) - 10
            )
            gain = min(max(desired, lower), upper)
            if abs(gain) > AUTO_MIX_MAX_SPEECH_WINDOW_GAIN_DB:
                raise ContentEngineError(
                    "auto_mix_voice_music_margin_failed",
                    "逐句音乐平衡需要超出安全范围的音乐增益，正式成片已停止。",
                )
            speech_window_gains = [
                {
                    "captionId": item["captionId"],
                    "startMs": item["startMs"],
                    "endMs": item["endMs"],
                    "gainDb": round(gain, 2),
                }
                for item in prepared
            ]
            return {
                "strategy": "global",
                "music_gain_db": round(gain, 2),
                "post_duck_gain_filter": f"volume={gain:.3f}dB",
                "speech_window_gains": speech_window_gains,
            }

        speech_window_gains = []
        for item in prepared:
            gain = item["rawMarginLu"] - 10.0
            if abs(gain) > AUTO_MIX_MAX_SPEECH_WINDOW_GAIN_DB:
                raise ContentEngineError(
                    "auto_mix_voice_music_margin_failed",
                    "逐句平衡需要超出安全范围的音乐增益，正式成片已停止。",
                )
            speech_window_gains.append(
                {
                    "captionId": item["captionId"],
                    "startMs": item["startMs"],
                    "endMs": item["endMs"],
                    "gainDb": round(gain, 2),
                }
            )
        return {
            "strategy": "per_speech_window",
            "music_gain_db": round(
                sum(item["gainDb"] for item in speech_window_gains)
                / len(speech_window_gains),
                2,
            ),
            "post_duck_gain_filter": FFmpegCreativeRenderer._auto_mix_speech_window_gain_filter(
                speech_window_gains, duration_ms=duration_ms
            ),
            "speech_window_gains": speech_window_gains,
        }

    @staticmethod
    def _validate_auto_mix_window_margins(windows, speech_window_gains):
        gain_by_window = {
            (item["captionId"], int(item["startMs"]), int(item["endMs"])): item["gainDb"]
            for item in speech_window_gains
        }
        verified = []
        for item in windows:
            margin = float(item["rawMarginLu"])
            if not math.isfinite(margin) or margin < 8 - 0.01 or margin > 12 + 0.01:
                raise ContentEngineError(
                    "auto_mix_voice_music_margin_failed",
                    "说话窗口人声与音乐余量未达到 8 到 12 LU。",
                )
            result = dict(item)
            result["marginLu"] = round(margin, 2)
            key = (result["captionId"], result["startMs"], result["endMs"])
            if key in gain_by_window:
                result["musicGainDb"] = round(float(gain_by_window[key]), 2)
            verified.append(result)
        if not verified:
            raise ContentEngineError(
                "auto_mix_music_not_audible", "说话窗口内未检测到可测量音乐。"
            )
        return verified

    @staticmethod
    def _auto_mix_music_envelope_filter(audio_config, duration_ms):
        """Translate the material energy plan into one bounded FFmpeg envelope."""
        duration_ms = max(1, int(duration_ms or 0))
        points_by_position = {}
        for item in (audio_config.get("energy_curve") or [])[:16]:
            if not isinstance(item, dict):
                continue
            try:
                position = float(item.get("position"))
                energy = float(item.get("energy"))
            except (TypeError, ValueError):
                continue
            if not math.isfinite(position) or not math.isfinite(energy):
                continue
            points_by_position[min(1.0, max(0.0, position))] = min(
                0.95, max(0.12, energy)
            )
        points = sorted(points_by_position.items())
        if points and points[0][0] > 0:
            points.insert(0, (0.0, points[0][1]))
        if points and points[-1][0] < 1:
            points.append((1.0, points[-1][1]))

        db_expression = "0"
        if points:
            mean_energy = sum(energy for _, energy in points) / len(points)
            gains_db = [
                min(1.5, max(-1.5, (energy - mean_energy) * 4.0))
                for _, energy in points
            ]
            db_expression = f"{gains_db[-1]:.4f}"
            duration_seconds = duration_ms / 1000
            for index in range(len(points) - 2, -1, -1):
                boundary = max(
                    0.001,
                    min(duration_seconds, points[index + 1][0] * duration_seconds),
                )
                db_expression = (
                    f"if(lt(t,{boundary:.3f}),{gains_db[index]:.4f},"
                    f"{db_expression})"
                )

        accents = {}
        for value in (audio_config.get("transition_points_ms") or [])[:16]:
            try:
                at_ms = int(value)
            except (TypeError, ValueError):
                continue
            if 0 < at_ms < duration_ms:
                accents[at_ms] = max(accents.get(at_ms, 0.0), 0.45)
        for hint in (audio_config.get("music_section_hints") or [])[:12]:
            if not isinstance(hint, dict):
                continue
            try:
                at_ms = int(hint.get("atMs"))
            except (TypeError, ValueError):
                continue
            hint_type = str(hint.get("type") or "").casefold()
            if 0 < at_ms < duration_ms and hint_type in {"accent", "cta"}:
                accents[at_ms] = max(
                    accents.get(at_ms, 0.0), 0.7 if hint_type == "accent" else 0.55
                )
        accent_terms = []
        for at_ms, gain_db in sorted(accents.items())[:12]:
            start = at_ms / 1000
            end = min(duration_ms, at_ms + 220) / 1000
            accent_terms.append(
                f"{gain_db:.3f}*between(t,{start:.3f},{end:.3f})"
            )
        if accent_terms:
            db_expression = f"({db_expression}+{'+'.join(accent_terms)})"
        if not points and not accent_terms:
            return ""
        return f",volume='pow(10,({db_expression})/20)':eval=frame"

    def _finish_auto_mix_v2(self, source, output, recipe):
        """Mix verified TTS with one managed, licensed music track.

        This path intentionally shares no V1 procedural-music or fixed-gain
        branch. Speech and music are normalized independently, the music is
        ducked by the speech envelope, and the finished master targets the V2
        loudness contract.
        """
        self._validate_auto_mix_v2_recipe(recipe)
        music_path = self._managed_audio_path(
            recipe.get("licensed_music_relative_path"),
            code="auto_mix_music_required",
            message="一键混剪 V2 缺少有效授权音乐文件。",
        )
        voice = recipe.get("voice_segment") or {}
        duration = max(
            0.001,
            (int(voice.get("end_ms") or 0) - int(voice.get("start_ms") or 0))
            / 1000,
        )
        audio_config = (recipe.get("packaging") or {}).get("audio") or {}
        intro_delay_ms = max(
            0,
            min(
                max(0, round(duration * 1000) - 500),
                int(audio_config.get("intro_delay_ms") or 0),
            ),
        )
        music_duration = max(0.5, duration - intro_delay_ms / 1000)
        music_fade_in = intro_delay_ms / 1000
        fade_out = max(0.0, duration - 0.8)
        delay_filter = (
            f"adelay={intro_delay_ms}|{intro_delay_ms},"
            if intro_delay_ms
            else ""
        )
        music_envelope_filter = self._auto_mix_music_envelope_filter(
            audio_config, round(duration * 1000)
        )
        music_input, loop_path = self._auto_mix_music_input(
            music_path, recipe, round(duration * 1000), output
        )
        try:
            baseline_windows = self._measure_auto_mix_window_margins(
                source,
                music_input,
                recipe.get("captions") or [],
                duration=duration,
                music_duration=music_duration,
                fade_out=fade_out,
                delay_filter=delay_filter,
                output=output,
                music_envelope_filter=music_envelope_filter,
                music_fade_in=music_fade_in,
            )
            gain_plan = self._auto_mix_music_gain_plan(
                baseline_windows, duration_ms=round(duration * 1000)
            )
            post_duck_gain_filter = gain_plan["post_duck_gain_filter"]
            speech_window_gains = [
                dict(item) for item in gain_plan["speech_window_gains"]
            ]
            music_gain_db = float(gain_plan["music_gain_db"])
            measured_windows = self._measure_auto_mix_window_margins(
                source,
                music_input,
                recipe.get("captions") or [],
                duration=duration,
                music_duration=music_duration,
                fade_out=fade_out,
                delay_filter=delay_filter,
                output=output,
                music_envelope_filter=music_envelope_filter,
                post_duck_gain_filter=post_duck_gain_filter,
                music_fade_in=music_fade_in,
            )
            for _ in range(2):
                margins = [float(item["rawMarginLu"]) for item in measured_windows]
                if margins and min(margins) >= 8 - 0.01 and max(margins) <= 12 + 0.01:
                    break
                calibration_plan = self._auto_mix_music_gain_plan(
                    measured_windows, duration_ms=round(duration * 1000)
                )
                if calibration_plan["strategy"] != "global":
                    raise ContentEngineError(
                        "auto_mix_voice_music_margin_failed",
                        "逐句音乐平衡后的余量仍不稳定，正式成片已停止。",
                    )
                calibration_gain_db = float(calibration_plan["music_gain_db"])
                post_duck_gain_filter = (
                    f"{post_duck_gain_filter},"
                    f"{calibration_plan['post_duck_gain_filter']}"
                )
                for item in speech_window_gains:
                    next_gain_db = float(item["gainDb"]) + calibration_gain_db
                    if abs(next_gain_db) > AUTO_MIX_MAX_SPEECH_WINDOW_GAIN_DB:
                        raise ContentEngineError(
                            "auto_mix_voice_music_margin_failed",
                            "逐句音乐平衡需要超出安全范围的音乐增益，正式成片已停止。",
                        )
                    item["gainDb"] = round(next_gain_db, 2)
                music_gain_db = round(music_gain_db + calibration_gain_db, 2)
                measured_windows = self._measure_auto_mix_window_margins(
                    source,
                    music_input,
                    recipe.get("captions") or [],
                    duration=duration,
                    music_duration=music_duration,
                    fade_out=fade_out,
                    delay_filter=delay_filter,
                    output=output,
                    music_envelope_filter=music_envelope_filter,
                    post_duck_gain_filter=post_duck_gain_filter,
                    music_fade_in=music_fade_in,
                )
            measured_windows = self._validate_auto_mix_window_margins(
                measured_windows, speech_window_gains
            )
            graph = ";".join(
                (
                    "[0:a]highpass=f=70,loudnorm=I=-16:LRA=7:TP=-1.2[voice_mix]",
                    "[1:a]asetpts=PTS-STARTPTS,"
                    "loudnorm=I=-26:LRA=11:TP=-2.0,"
                    f"{delay_filter}afade=t=in:st={music_fade_in:.3f}:d=0.4,"
                    f"afade=t=out:st={fade_out:.3f}:d=0.8"
                    f"{music_envelope_filter}[music_norm]",
                    f"[music_norm]{post_duck_gain_filter}[music_mix]",
                    "[voice_mix][music_mix]amix=inputs=2:duration=first:"
                    "dropout_transition=0,loudnorm=I=-15:LRA=8:TP=-1.2,"
                    "alimiter=limit=0.86:attack=5:release=50:level=false[aout]",
                )
            )
            args = [
                "-i",
                str(source),
                *music_input,
                "-filter_complex",
                graph,
                "-map",
                "0:v:0",
                "-map",
                "[aout]",
                "-t",
                f"{duration:.3f}",
                "-shortest",
            ]
            self._encode_mezzanine(args, output)
            report = {
                "speech_music_margin_lu": min(
                    item["marginLu"] for item in measured_windows
                ),
                "music_gain_db": round(music_gain_db, 2),
                "windows": measured_windows,
            }
            report_path = self._auto_mix_margin_report_path(output)
            if recipe.get("narrated_preserve_shot_duration"):
                self.calibrate_final_loudness(output)
            temporary = report_path.with_name(f"{report_path.name}.tmp")
            try:
                temporary.write_text(
                    json.dumps(report, ensure_ascii=False, sort_keys=True),
                    encoding="utf-8",
                )
                temporary.replace(report_path)
            finally:
                temporary.unlink(missing_ok=True)
        finally:
            if loop_path is not None:
                loop_path.unlink(missing_ok=True)

    @staticmethod
    def _portrait_base_filter():
        return (
            "scale=1215:2160:force_original_aspect_ratio=increase,"
            "crop=1080:1920:(in_w-1080)/2:max(0\\,(in_h-1920)*0.58),fps=30,format=yuv420p"
        )

    @staticmethod
    def _auto_mix_v2_canvas_filter():
        """Build V2's 9:16 source canvas without cropping a landscape shot."""
        return (
            "[0:v]setpts=PTS-STARTPTS,split=2[auto_mix_bg_src][auto_mix_fg_src];"
            "[auto_mix_bg_src]scale=1080:1920:force_original_aspect_ratio=increase,"
            "crop=1080:1920:(iw-1080)/2:(ih-1920)/2,gblur=sigma=18:steps=2,setsar=1,fps=30[auto_mix_bg];"
            "[auto_mix_fg_src]scale=1080:1920:force_original_aspect_ratio=decrease:"
            "force_divisible_by=2,setsar=1,fps=30[auto_mix_fg];"
            "[auto_mix_bg][auto_mix_fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[auto_mix_vout]"
        )

    def _portrait_filter(self, subtitle, packaging=None):
        base = self._portrait_base_filter()
        overlay = self._overlay_filter(packaging, subtitle)
        return f"{base},{overlay}" if overlay else base

    @staticmethod
    def _presentation_base_filter():
        return (
            "[slide_source]crop=iw:ih*0.58:0:0,"
            "scale=1080:1920:force_original_aspect_ratio=increase,"
            "crop=1080:1920,fps=30[slide];"
            "[classroom_source]scale=324:576:force_original_aspect_ratio=decrease,"
            "pad=324:576:(ow-iw)/2:(oh-ih)/2:black,fps=30[classroom];"
            "[slide][classroom]overlay=W-w-36:H-h-180[slide_composed]"
        )

    @staticmethod
    def _course_intervals(recipe, frame_mode):
        voice = recipe.get("voice_segment") or {}
        base = int(voice.get("start_ms") or 0)
        duration = max(1, int(voice.get("end_ms") or base + 1) - base)
        intervals = []
        for segment in recipe.get("visual_segments") or []:
            if segment.get("frame_mode") != frame_mode:
                continue
            start = max(0, int(segment.get("start_ms") or base) - base)
            end = min(duration, int(segment.get("end_ms") or base) - base)
            if end > start:
                intervals.append((start / 1000, end / 1000))
        return intervals

    @staticmethod
    def _enable_expression(intervals):
        return "+".join(
            f"between(t,{start:.3f},{end:.3f})" for start, end in intervals
        )

    def _course_layout_filter(
        self, recipe, subtitle, *, include_overlays=True, reset_pts=False
    ):
        packaging = recipe.get("packaging") or {}
        effects = packaging.get("effects") or {}
        slide_intervals = self._course_intervals(
            recipe, "slide_with_teacher_pip"
        )
        if effects.get("slide_focus") and effects.get("teacher_pip") and slide_intervals:
            enable = self._enable_expression(slide_intervals)
            filters = (
                "[0:v]split=3[teacher_source][slide_source][classroom_source];"
                f"[teacher_source]{self._portrait_base_filter()}[teacher];"
                f"{self._presentation_base_filter()};"
                f"[teacher][slide_composed]overlay=0:0:enable='{enable}'[layout]"
            )
        elif effects.get("classroom_broll"):
            intervals = self._event_intervals(
                packaging, {"keyword"}, limit=2, maximum_duration_ms=2_400
            )
            if not intervals:
                return ""
            enable = self._enable_expression(intervals)
            filters = (
                "[0:v]split=3[teacher_source][wide_background_source][wide_source];"
                f"[teacher_source]{self._portrait_base_filter()}[teacher];"
                "[wide_background_source]scale=1080:1920:force_original_aspect_ratio=increase,"
                "crop=1080:1920,gblur=sigma=18:steps=2,fps=30[wide_background];"
                "[wide_source]scale=990:1680:force_original_aspect_ratio=decrease,"
                "pad=990:1680:(ow-iw)/2:(oh-ih)/2:black,fps=30[wide_foreground];"
                "[wide_background][wide_foreground]overlay=(W-w)/2:(H-h)/2[wide];"
                f"[teacher][wide]overlay=0:0:enable='{enable}'[layout]"
            )
        else:
            return ""
        overlay = (
            self._overlay_filter(packaging, subtitle) if include_overlays else ""
        )
        if overlay:
            suffix = f"{overlay},format=yuv420p"
        else:
            suffix = "format=yuv420p"
        if reset_pts:
            suffix = f"{suffix},setpts=PTS-STARTPTS"
        return f"{filters};[layout]{suffix}[vout]"

    def _presentation_filter(self, subtitle, packaging=None):
        # Kept for old recipes and direct callers. New packaged course recipes
        # use `_course_layout_filter` so slide layouts are applied only during
        # the analyzed relative intervals.
        filters = (
            "[0:v]split=2[slide_source][classroom_source];"
            f"{self._presentation_base_filter()}"
        )
        overlay = self._overlay_filter(packaging, subtitle)
        if overlay:
            return f"{filters};[slide_composed]{overlay},format=yuv420p[vout]"
        return f"{filters};[slide_composed]format=yuv420p[vout]"

    def _overlay_filter(self, packaging, subtitle):
        filters = []
        packaging_filter = self._packaging_filter(packaging)
        if packaging_filter:
            filters.append(packaging_filter)
        subtitle_filter = self._subtitle_filter(subtitle)
        if subtitle_filter:
            filters.append(subtitle_filter)
        return ",".join(filters)

    @staticmethod
    def _event_intervals(
        packaging, event_types, *, limit=None, maximum_duration_ms=None
    ):
        accepted = {str(value) for value in event_types}
        intervals = []
        for event in sorted(
            packaging.get("events") or [],
            key=lambda item: (
                int(item.get("start_ms") or 0), int(item.get("end_ms") or 0)
            ),
        ):
            if str(event.get("type") or "") not in accepted:
                continue
            start_ms = max(0, int(event.get("start_ms") or 0))
            end_ms = max(start_ms, int(event.get("end_ms") or start_ms))
            if maximum_duration_ms is not None:
                end_ms = min(end_ms, start_ms + max(1, int(maximum_duration_ms)))
            if end_ms <= start_ms:
                continue
            intervals.append((start_ms / 1000, end_ms / 1000))
            if limit is not None and len(intervals) >= max(0, int(limit)):
                break
        return intervals

    @classmethod
    def _event_enable(cls, packaging, event_types, **options):
        intervals = cls._event_intervals(packaging, event_types, **options)
        return cls._enable_expression(intervals) if intervals else ""

    @staticmethod
    def _event_label(event_type, index):
        labels = {
            "hook": "开场重点",
            "keyword": f"观点 {index:02d}",
            "process": f"步骤 {index:02d}",
            "result": "结果总结",
            "close": "本期总结",
            "slide_focus": "课件重点",
        }
        return labels.get(event_type, f"重点 {index:02d}")

    def _director_event_filters(self, packaging, font, primary, accent):
        filters = []
        events = [
            event
            for event in packaging.get("events") or []
            if event.get("text") and event.get("zone") in DIRECTOR_ZONE_LAYOUTS
        ]
        for event in events[:12]:
            start = max(0, int(event.get("start_ms") or 0)) / 1000
            end = max(int(event.get("start_ms") or 0) + 1, int(event.get("end_ms") or 0)) / 1000
            enable = self._enable_expression([(start, end)])
            x, y, width, height = DIRECTOR_ZONE_LAYOUTS[event["zone"]]
            size = str(event.get("size") or "chip")
            text = self._ffmpeg_text(event.get("text") or "")
            text_length = max(1, len(str(event.get("text") or "")))
            if size == "hero":
                font_size = 54 if text_length <= 14 else 44
            elif size == "card":
                font_size = 42 if text_length <= 12 else 34
            else:
                font_size = 36 if text_length <= 12 else 30
            filters.extend(
                (
                    f"drawbox=x={x}:y={y}:w={width}:h={height}:"
                    f"color={primary}@0.86:t=fill:enable='{enable}'",
                    f"drawbox=x={x}:y={y}:w=12:h={height}:"
                    f"color={accent}@1:t=fill:enable='{enable}'",
                    f"drawtext={font}:text='{text}':fontcolor=white:fontsize={font_size}:"
                    f"x={x + 34}:y={y + max(18, (height - font_size) // 2)}:"
                    "shadowcolor=black@0.55:shadowx=2:shadowy=2:"
                    f"enable='{enable}'",
                )
            )
        return filters

    def _packaging_filter(self, packaging):
        if not isinstance(packaging, dict) or not packaging:
            return ""
        effects = packaging.get("effects") or {}
        brand = packaging.get("brand") or {}
        preset_id = str(packaging.get("preset_id") or "")
        is_course = preset_id in {
            "knowledge_focus", "slide_teacher", "classroom_value"
        }
        primary = self._ffmpeg_color(brand.get("primary_color") or "#6D5DFB")
        accent = self._ffmpeg_color(brand.get("accent_color") or "#FFE45C")
        title = self._ffmpeg_text(packaging.get("title") or "")
        font = self._drawtext_font_option(packaging)
        filters = []
        # Do not apply `zoompan` to an already-rendered video stream here.
        # On concatenated MP4 inputs it can collapse the input PTS timeline
        # (for example, a 75s stream becomes ~39s) while the audio remains
        # full length.  Still-image motion is handled in `_render_mix`, and
        # Remotion owns dynamic motion when it is available; FFmpeg fallback
        # must keep the video timeline stable.
        if (packaging.get("director") or {}).get("provider"):
            filters.extend(
                self._director_event_filters(packaging, font, primary, accent)
            )
            return ",".join(filters)
        if effects.get("title_card") and title:
            title_enable = self._event_enable(
                packaging, {"title"}, limit=1, maximum_duration_ms=2_400
            ) or "lt(t,2.4)"
            filters.extend(
                (
                    f"drawbox=x=54:y=76:w=972:h=196:color={primary}@0.78:t=fill:enable='{title_enable}'",
                    f"drawbox=x=54:y=76:w=14:h=196:color={accent}@1:t=fill:enable='{title_enable}'",
                    f"drawtext={font}:"
                    f"text='{title}':fontcolor=white:fontsize=54:"
                    "x=92:y=128:shadowcolor=black@0.65:shadowx=2:shadowy=2:"
                    f"enable='{title_enable}'",
                )
            )
        # Product One-Click must never replace evidence-based captions with
        # generic labels such as "开场重点" or "步骤 01" when the dynamic
        # renderer is temporarily unavailable.  The title is safe because it
        # is supplied by the selected product script and it occupies a
        # different part of the frame; semantic cards resume only when the
        # Remotion path has rendered them from their grounded event text.
        if packaging.get("fallback_safe_clean"):
            return ",".join(filters)
        if effects.get("keyword_card"):
            for index, (start, end) in enumerate(
                self._event_intervals(
                    packaging, {"keyword"}, limit=3, maximum_duration_ms=2_200
                ),
                1,
            ):
                enable = self._enable_expression([(start, end)])
                label = self._ffmpeg_text(self._event_label("keyword", index))
                filters.extend(
                    (
                        f"drawbox=x=66:y=318:w=430:h=92:color={primary}@0.70:t=fill:enable='{enable}'",
                        f"drawbox=x=66:y=318:w=10:h=92:color={accent}@1:t=fill:enable='{enable}'",
                        f"drawtext={font}:text='{label}':fontcolor=white:fontsize=38:"
                        f"x=98:y=342:enable='{enable}'",
                    )
                )
        if effects.get("slide_focus"):
            enable = self._event_enable(
                packaging, {"slide_focus"}, limit=4, maximum_duration_ms=4_000
            )
            if enable:
                label = self._ffmpeg_text(self._event_label("slide_focus", 1))
                filters.extend(
                    (
                        f"drawbox=x=54:y=300:w=300:h=76:color={primary}@0.74:t=fill:enable='{enable}'",
                        f"drawtext={font}:text='{label}':fontcolor=white:fontsize=34:"
                        f"x=82:y=320:enable='{enable}'",
                    )
                )
        if effects.get("classroom_broll"):
            enable = self._event_enable(
                packaging, {"keyword"}, limit=2, maximum_duration_ms=2_400
            )
            if enable:
                label = self._ffmpeg_text("培训现场")
                filters.extend(
                    (
                        f"drawbox=x=750:y=304:w=276:h=72:color={primary}@0.68:t=fill:enable='{enable}'",
                        f"drawtext={font}:text='{label}':fontcolor=white:fontsize=32:"
                        f"x=790:y=324:enable='{enable}'",
                    )
                )
        if effects.get("hook_punch"):
            enable = self._event_enable(
                packaging, {"hook"}, limit=1, maximum_duration_ms=3_000
            )
            if enable:
                label = self._ffmpeg_text(self._event_label("hook", 1))
                filters.extend(
                    (
                        f"drawbox=x=32:y=32:w=1016:h=1856:color={accent}@0.88:t=8:enable='{enable}'",
                        f"drawbox=x=646:y=306:w=374:h=92:color={primary}@0.82:t=fill:enable='{enable}'",
                        f"drawtext={font}:text='{label}':fontcolor=white:fontsize=38:"
                        f"x=686:y=330:enable='{enable}'",
                    )
                )
        if effects.get("step_cards"):
            for index, (start, end) in enumerate(
                self._event_intervals(
                    packaging, {"process"}, limit=3, maximum_duration_ms=2_800
                ),
                1,
            ):
                enable = self._enable_expression([(start, end)])
                label = self._ffmpeg_text(self._event_label("process", index))
                y = 316 + (index - 1) * 102
                filters.extend(
                    (
                        f"drawbox=x=64:y={y}:w=330:h=84:color={primary}@0.78:t=fill:enable='{enable}'",
                        f"drawbox=x=64:y={y}:w=12:h=84:color={accent}@1:t=fill:enable='{enable}'",
                        f"drawtext={font}:text='{label}':fontcolor=white:fontsize=36:"
                        f"x=96:y={y + 22}:enable='{enable}'",
                    )
                )
        if effects.get("result_card"):
            enable = self._event_enable(
                packaging, {"result", "close"}, limit=2, maximum_duration_ms=2_800
            )
            if enable:
                label = self._ffmpeg_text(self._event_label("result", 1))
                filters.extend(
                    (
                        f"drawbox=x=92:y=330:w=896:h=132:color={primary}@0.82:t=fill:enable='{enable}'",
                        f"drawbox=x=92:y=330:w=896:h=8:color={accent}@1:t=fill:enable='{enable}'",
                        f"drawtext={font}:text='{label}':fontcolor=white:fontsize=46:"
                        f"x=(w-text_w)/2:y=370:enable='{enable}'",
                    )
                )
        sticker_budget = 0 if is_course else max(
            0, min(2, int(effects.get("sticker_budget") or 0))
        )
        sticker_events = [
            event
            for event in packaging.get("events") or []
            if str(event.get("type") or "") in {"hook", "process", "result"}
        ]
        for index, event in enumerate(sticker_events[:sticker_budget], 1):
            start = max(0, int(event.get("start_ms") or 0)) / 1000
            end = max(
                int(event.get("start_ms") or 0) + 1,
                min(
                    int(event.get("end_ms") or 0),
                    int(event.get("start_ms") or 0) + 1_600,
                ),
            ) / 1000
            enable = self._enable_expression([(start, end)])
            label = self._ffmpeg_text(
                self._event_label(str(event.get("type") or ""), index)
            )
            x = 710 if index % 2 else 66
            y = 470 + (index - 1) * 110
            filters.extend(
                (
                    f"drawbox=x={x}:y={y}:w=300:h=76:color={accent}@0.92:t=fill:enable='{enable}'",
                    f"drawtext={font}:text='{label}':fontcolor=black:fontsize=31:"
                    f"x={x + 22}:y={y + 21}:enable='{enable}'",
                )
            )
        return ",".join(filters)

    def _cover_filter(self, packaging):
        base = (
            "scale=1080:1920:force_original_aspect_ratio=increase,"
            "crop=1080:1920"
        )
        if not isinstance(packaging, dict) or not packaging:
            return base
        brand = packaging.get("brand") or {}
        primary = self._ffmpeg_color(brand.get("primary_color") or "#6D5DFB")
        accent = self._ffmpeg_color(brand.get("accent_color") or "#FFE45C")
        title = self._ffmpeg_cover_text(packaging.get("title") or "课程现场价值")
        font = self._drawtext_font_option(packaging)
        return ",".join(
            (
                base,
                "drawbox=x=0:y=0:w=1080:h=1920:color=black@0.12:t=fill",
                f"drawbox=x=72:y=1180:w=936:h=430:color={primary}@0.86:t=fill",
                f"drawbox=x=72:y=1180:w=18:h=430:color={accent}@1:t=fill",
                f"drawtext={font}:"
                f"text='{title}':fontcolor=white:fontsize=68:"
                "x=122:y=1280:shadowcolor=black@0.7:shadowx=3:shadowy=3",
            )
        )

    def _cover_video_args(self, source, packaging, resolve_asset_path=None):
        args = ["-i", str(source)]
        brand = packaging.get("brand") if isinstance(packaging, dict) else None
        logo_id = str((brand or {}).get("logo_asset_id") or "").strip()
        if logo_id and resolve_asset_path is not None:
            logo = Path(resolve_asset_path(logo_id))
            args.extend(("-loop", "1", "-i", str(logo)))
            graph = (
                f"[0:v]{self._cover_filter(packaging)}[cover_base];"
                "[1:v]scale=180:-1:force_original_aspect_ratio=decrease,"
                "format=rgba,colorchannelmixer=aa=0.9[cover_logo];"
                "[cover_base][cover_logo]overlay=W-w-46:46:shortest=1[vout]"
            )
            args.extend(("-filter_complex", graph, "-map", "[vout]"))
        else:
            args.extend(("-vf", self._cover_filter(packaging)))
        return args

    def _render_cover(
        self,
        output,
        thumbnail,
        packaging,
        resolve_asset_path=None,
        *,
        seek_seconds=0.5,
    ):
        seek_args = (
            ["-ss", f"{max(0.0, float(seek_seconds)):.3f}"]
            if seek_seconds is not None
            else []
        )
        self._command(
            [
                self.ffmpeg_path,
                "-y",
                *seek_args,
                *self._cover_video_args(
                    output, packaging, resolve_asset_path
                ),
                "-frames:v",
                "1",
                "-q:v",
                "2",
                str(thumbnail),
            ],
            timeout=120,
        )

    @staticmethod
    def _cover_source(recipe, resolve_asset_path, *, fallback):
        kind = recipe.get("kind")
        segment = None
        if kind == "course":
            segment = recipe.get("voice_segment") or None
        elif kind == "mix":
            visuals = recipe.get("visual_segments") or []
            segment = visuals[0] if visuals else None
        if not segment or not segment.get("asset_id"):
            return Path(fallback), 0.5
        source = Path(resolve_asset_path(segment["asset_id"]))
        if segment.get("media_kind") == "image":
            return source, None
        start_ms = max(0, int(segment.get("start_ms") or 0))
        end_ms = int(segment.get("end_ms") or 0)
        offset_ms = 500 if not end_ms or end_ms - start_ms >= 1_000 else 0
        return source, (start_ms + offset_ms) / 1_000

    def compose_cover(
        self, background_path, target_path, packaging, resolve_asset_path=None
    ):
        background_path = Path(background_path).resolve(strict=True)
        target_path = Path(target_path).resolve()
        temporary = target_path.with_name(f".{target_path.stem}.composing.jpg")
        try:
            self._render_cover(
                background_path,
                temporary,
                packaging,
                resolve_asset_path,
                seek_seconds=None,
            )
            temporary.replace(target_path)
            return target_path
        except Exception:
            temporary.unlink(missing_ok=True)
            raise

    @staticmethod
    def _ffmpeg_color(value):
        candidate = str(value or "").strip()
        return f"0x{candidate[1:]}" if re.fullmatch(r"#[0-9A-Fa-f]{6}", candidate) else "0x6D5DFB"

    @staticmethod
    def _discover_font_paths():
        configured = os.environ.get("XIAOXI_CREATIVE_FONT_PATH")
        windows_root = Path(os.environ.get("WINDIR") or "C:/Windows")
        fallback = Path(configured) if configured else None
        bundled = (
            Path(__file__).resolve().parent
            / "assets"
            / "fonts"
            / "NotoSansSC-Variable.ttf"
        )

        def first(*candidates):
            return next(
                (item.resolve() for item in candidates if item and item.is_file()),
                None,
            )

        packaged_font = first(fallback, bundled)
        microsoft_yahei = first(
            packaged_font,
            windows_root / "Fonts" / "msyh.ttc",
            windows_root / "Fonts" / "msyhbd.ttc",
            windows_root / "Fonts" / "simhei.ttf",
        )
        return {
            "microsoft_yahei": microsoft_yahei,
            "source_han_sans": first(
                packaged_font, windows_root / "Fonts" / "Deng.ttf", microsoft_yahei
            ),
            "neutral_sans": first(
                packaged_font, windows_root / "Fonts" / "simhei.ttf", microsoft_yahei
            ),
        }

    @staticmethod
    def _font_preset(packaging):
        brand = packaging.get("brand") if isinstance(packaging, dict) else None
        value = str((brand or {}).get("font_preset") or "microsoft_yahei")
        return value if value in {"microsoft_yahei", "source_han_sans", "neutral_sans"} else "microsoft_yahei"

    def _drawtext_font_option(self, packaging=None):
        font_path = self.font_paths.get(self._font_preset(packaging)) or self.font_path
        if font_path:
            escaped = str(font_path).replace("\\", "/").replace(":", "\\:")
            return f"fontfile='{escaped}'"
        return f"font='{self._font_family(packaging)}'"

    @classmethod
    def _font_family(cls, packaging=None):
        return {
            "microsoft_yahei": "Microsoft YaHei",
            "source_han_sans": "DengXian",
            "neutral_sans": "SimHei",
        }[cls._font_preset(packaging)]

    @staticmethod
    def _ffmpeg_text(value):
        return (
            str(value or "")[:60]
            .replace("\\", "／")
            .replace("'", "’")
            .replace(":", "\\:")
            .replace("%", "％")
            .replace(",", "，")
        )

    @classmethod
    def _ffmpeg_cover_text(cls, value):
        normalized = str(value or "")[:28]
        if cls._caption_width(normalized) <= 13:
            return cls._ffmpeg_text(normalized)
        split_at = min(13, max(7, len(normalized) // 2))
        return f"{cls._ffmpeg_text(normalized[:split_at])}\\n{cls._ffmpeg_text(normalized[split_at:])}"

    @staticmethod
    def _subtitle_filter(subtitle):
        if not subtitle:
            return ""
        escaped = str(Path(subtitle).resolve()).replace("\\", "/").replace(":", "\\:")
        return f"subtitles=filename='{escaped}'"

    @classmethod
    def _caption_cues(cls, captions, recipe):
        base = int(recipe.get("voice_segment", {}).get("start_ms") or 0)
        style = recipe.get("subtitle_style") or {}
        if style.get("preset") == "none":
            return []
        max_chars = max(8, min(18, int(style.get("max_chars") or 12)))
        word_timed = (
            (
                recipe.get("experiment_mode") == "supoclip_bailian_v1"
                or bool((recipe.get("packaging") or {}).get("version"))
            )
            and style.get("preset") in {"knowledge_course", "energetic_talking"}
        )
        cues = []
        for caption in captions:
            text = str(caption.get("text") or "").strip()
            if not text:
                continue
            try:
                caption_priority = max(1, min(4, int(caption.get("caption_priority") or 1)))
            except (TypeError, ValueError):
                caption_priority = 1
            if word_timed:
                word_cues = cls._word_caption_cues(caption, base, max_chars)
                if word_cues:
                    for cue in word_cues:
                        cue["caption_priority"] = caption_priority
                    cues.extend(word_cues)
                    continue
            start_ms = max(0, int(caption["start_ms"]) - base)
            end_ms = max(start_ms + 1, int(caption["end_ms"]) - base)
            phrases = cls._split_caption_text(text, max_chars)
            weights = [max(1, cls._caption_width(item)) for item in phrases]
            total_weight = sum(weights)
            elapsed_weight = 0
            for index, phrase in enumerate(phrases):
                cue_start = start_ms + round(
                    (end_ms - start_ms) * elapsed_weight / total_weight
                )
                elapsed_weight += weights[index]
                cue_end = (
                    end_ms
                    if index == len(phrases) - 1
                    else start_ms
                    + round((end_ms - start_ms) * elapsed_weight / total_weight)
                )
                cues.append(
                    {
                        "start_ms": cue_start,
                        "end_ms": max(cue_start + 1, cue_end),
                        "text": phrase,
                        "caption_priority": caption_priority,
                    }
                )
        return cls._single_caption_lane(cues)

    @staticmethod
    def _single_caption_lane(cues):
        """Defend persisted recipes against simultaneous bottom subtitles.

        New product recipes are normalized before rendering, but historical
        candidates can contain an AI visual label and a source transcript at
        the same time.  ASS has no collision handling for two Dialogue lines
        at the same position, so retain one deterministic cue instead.
        """
        accepted = []
        def priority(value):
            try:
                return max(1, min(4, int(value.get("caption_priority") or 1)))
            except (AttributeError, TypeError, ValueError):
                return 1

        for cue in sorted(
            (item for item in cues if isinstance(item, dict)),
            key=lambda item: (
                -priority(item),
                int(item.get("start_ms") or 0),
                int(item.get("end_ms") or 0),
                str(item.get("text") or ""),
            ),
        ):
            start = int(cue.get("start_ms") or 0)
            end = int(cue.get("end_ms") or start)
            if end <= start or any(
                start < int(current["end_ms"])
                and int(current["start_ms"]) < end
                for current in accepted
            ):
                continue
            accepted.append(cue)
        return sorted(
            accepted,
            key=lambda item: (int(item["start_ms"]), int(item["end_ms"])),
        )

    @classmethod
    def _word_caption_cues(cls, caption, base, max_chars):
        caption_start = int(caption.get("start_ms") or 0)
        caption_end = int(caption.get("end_ms") or 0)
        words = []
        for item in caption.get("words") or []:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or "").strip()
            try:
                start = int(item.get("start"))
                end = int(item.get("end"))
            except (TypeError, ValueError):
                continue
            if (
                not text
                or start < caption_start
                or end > caption_end
                or end <= start
            ):
                continue
            words.append({"text": text, "start_ms": start - base, "end_ms": end - base})
        words.sort(key=lambda item: (item["start_ms"], item["end_ms"]))
        if not words:
            return []

        groups = []
        current = []
        for word in words:
            proposed = cls._join_caption_words([*current, word])
            too_wide = current and cls._caption_width(proposed) > max_chars
            too_long = current and word["end_ms"] - current[0]["start_ms"] > 3_200
            if too_wide or too_long:
                groups.append(current)
                current = []
            current.append(word)
            if re.search(r"[。！？!?]$", word["text"]):
                groups.append(current)
                current = []
        if current:
            groups.append(current)

        return [
            {
                "start_ms": max(0, group[0]["start_ms"]),
                "end_ms": max(group[0]["start_ms"] + 1, group[-1]["end_ms"]),
                "text": cls._join_caption_words(group),
                "words": group,
            }
            for group in groups
            if group
        ]

    @staticmethod
    def _join_caption_words(words):
        text = ""
        for word in words:
            value = str(word.get("text") or "")
            if text and re.search(r"[A-Za-z0-9]$", text) and re.match(r"[A-Za-z0-9]", value):
                text += " "
            text += value
        return text

    @classmethod
    def _split_caption_text(cls, text, max_chars):
        normalized = re.sub(r"\s+", " ", str(text)).strip()
        clauses = re.findall(r"[^，。！？；：,.!?;:]+[，。！？；：,.!?;:]*", normalized)
        clauses = [item.strip() for item in clauses if item.strip()] or [normalized]
        phrases = []
        for clause in clauses:
            remainder = clause
            while cls._caption_width(remainder) > max_chars:
                width = 0.0
                cut = 0
                for index, character in enumerate(remainder):
                    width += 0.55 if ord(character) < 128 else 1.0
                    if width > max_chars:
                        break
                    cut = index + 1
                nearby_space = remainder.rfind(" ", 0, cut + 1)
                if nearby_space >= max(4, cut - 5):
                    cut = nearby_space
                phrases.append(remainder[:cut].strip())
                remainder = remainder[cut:].strip()
            if remainder:
                phrases.append(remainder)
        merged = []
        for phrase in phrases:
            if merged and cls._caption_width(phrase) <= 2:
                merged[-1] = f"{merged[-1]}{phrase}"
            else:
                merged.append(phrase)
        return merged

    @staticmethod
    def _caption_width(text):
        return sum(0.55 if ord(character) < 128 else 1.0 for character in text)

    @classmethod
    def _write_ass(cls, path, captions, recipe, *, cues=None):
        cues = cls._caption_cues(captions, recipe) if cues is None else cues
        if not cues:
            return None
        style = recipe.get("subtitle_style") or {}
        preset = str(style.get("preset") or "dynamic_clean")
        is_supoclip = (
            (
                recipe.get("experiment_mode") == "supoclip_bailian_v1"
                or bool((recipe.get("packaging") or {}).get("version"))
            )
            and preset in {"knowledge_course", "energetic_talking"}
        )
        if preset == "knowledge_course" and is_supoclip:
            font_size = max(36, min(48, int(style.get("font_size") or 44)))
            margin_bottom = max(120, min(260, int(style.get("margin_bottom") or 150)))
            primary, secondary = "&H00FFFFFF", "&H003DDCFF"
            border_style, outline, shadow = 1, 4, 1
        elif preset == "energetic_talking" and is_supoclip:
            font_size = max(38, min(52, int(style.get("font_size") or 48)))
            margin_bottom = max(120, min(260, int(style.get("margin_bottom") or 145)))
            primary, secondary = "&H00FFFFFF", "&H00FFE45C"
            border_style, outline, shadow = 1, 5, 2
        else:
            font_size = max(36, min(64, int(style.get("font_size") or 48)))
            margin_bottom = max(120, min(360, int(style.get("margin_bottom") or 170)))
            primary, secondary = "&H00FFFFFF", "&H005CDBFF"
            border_style, outline, shadow = 3, 3, 0
        preset_comment = f"; Preset: {preset}\n" if is_supoclip else ""
        font_family = cls._font_family(recipe.get("packaging"))
        header = (
            "[Script Info]\n"
            "ScriptType: v4.00+\n"
            "PlayResX: 1080\n"
            "PlayResY: 1920\n"
            "WrapStyle: 2\n"
            "ScaledBorderAndShadow: yes\n\n"
            f"{preset_comment}"
            "[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
            "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
            "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
            "Alignment, MarginL, MarginR, MarginV, Encoding\n"
            f"Style: Dynamic,{font_family},{font_size},{primary},{secondary},"
            f"&H90000000,&H78000000,-1,0,0,0,100,100,0,0,{border_style},{outline},{shadow},2,70,70,"
            f"{margin_bottom},1\n\n"
            "[Events]\n"
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
            "Effect, Text\n"
        )
        events = []
        for cue in cues:
            if is_supoclip and cue.get("words"):
                text = cls._ass_karaoke(cue)
                emoji = cls._caption_emoji(cue["text"]) if preset == "energetic_talking" else ""
                text = f"{emoji} {text}" if emoji else text
                animation = (
                    r"{\fad(55,45)\fscx108\fscy108\t(0,105,\fscx100\fscy100)}"
                    if preset == "energetic_talking"
                    else r"{\fad(70,60)\fscx102\fscy102\t(0,130,\fscx100\fscy100)}"
                )
            else:
                text = cls._ass_emphasis(cue["text"])
                animation = r"{\fad(70,60)\fscx104\fscy104\t(0,120,\fscx100\fscy100)}"
            events.append(
                "Dialogue: 0,"
                f"{cls._ass_stamp(cue['start_ms'])},{cls._ass_stamp(cue['end_ms'])},"
                f"Dynamic,,0,0,0,,{animation}{text}"
            )
        path.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
        return path

    @classmethod
    def _ass_karaoke(cls, cue):
        words = cue.get("words") or []
        parts = []
        for index, word in enumerate(words):
            next_start = (
                words[index + 1]["start_ms"]
                if index + 1 < len(words)
                else word["end_ms"]
            )
            duration = max(10, int(next_start) - int(word["start_ms"]))
            safe = cls._ass_safe_text(word.get("text") or "")
            parts.append(r"{\kf" + str(max(1, round(duration / 10))) + "}" + safe)
        return "".join(parts)

    @staticmethod
    def _caption_emoji(text):
        mappings = (
            (("注意", "不能", "错误", "避免"), "⚠"),
            (("关键", "核心", "重点"), "💡"),
            (("方法", "步骤"), "✓"),
            (("结果", "完成", "成功"), "✨"),
        )
        value = str(text)
        return next(
            (emoji for markers, emoji in mappings if any(marker in value for marker in markers)),
            "",
        )

    @staticmethod
    def _ass_safe_text(text):
        return str(text).replace("\\", "／").replace("{", "（").replace("}", "）")

    @staticmethod
    def _ass_emphasis(text):
        safe = FFmpegCreativeRenderer._ass_safe_text(text)
        pattern = re.compile(
            r"(\d+(?:\.\d+)?%?|不是|而是|关键|核心|一定|不能|必须|最重要)"
        )
        accent = r"{\c&H005CDBFF&}"
        normal = r"{\c&H00FFFFFF&}"
        return pattern.sub(lambda match: f"{accent}{match.group(0)}{normal}", safe)

    @staticmethod
    def _ass_stamp(value):
        value = max(0, int(value))
        hours, remainder = divmod(value, 3_600_000)
        minutes, remainder = divmod(remainder, 60_000)
        seconds, millis = divmod(remainder, 1_000)
        return f"{hours}:{minutes:02d}:{seconds:02d}.{millis // 10:02d}"

    @classmethod
    def _write_srt(cls, path, captions, recipe, *, cues=None):
        cues = cls._caption_cues(captions, recipe) if cues is None else cues
        if not cues:
            return None

        def stamp(value):
            value = max(0, int(value))
            hours, remainder = divmod(value, 3_600_000)
            minutes, remainder = divmod(remainder, 60_000)
            seconds, millis = divmod(remainder, 1_000)
            return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"

        lines = []
        for index, caption in enumerate(cues, 1):
            lines.append(
                f"{index}\n{stamp(caption['start_ms'])} --> {stamp(caption['end_ms'])}\n"
                f"{caption['text']}"
            )
        if not lines:
            return None
        path.write_text("\n\n".join(lines) + "\n", encoding="utf-8")
        return path


class HybridCreativeRenderer:
    MANIFEST_NAME = "candidate-manifest.json"
    MANIFEST_VERSION = 1
    _SAFE_CANDIDATE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
    _SAFE_OPAQUE = re.compile(r"^[A-Za-z0-9_.-]{0,128}$")
    _SAFE_RUNTIME_HASH = re.compile(r"^[a-f0-9]{64}$")
    _SEMANTIC_PRESET_ALIASES = {"auto_mix_v2": "knowledge_focus"}

    def __init__(
        self,
        data_dir: Path,
        *,
        ffmpeg_renderer: FFmpegCreativeRenderer | None = None,
        worker_client: RemotionWorkerClient | None = None,
    ):
        self.data_dir = Path(data_dir).resolve()
        self.ffmpeg_renderer = ffmpeg_renderer or FFmpegCreativeRenderer(self.data_dir)
        self.worker_client = worker_client or RemotionWorkerClient(data_dir=self.data_dir)
        self._cancel_requested = threading.Event()

    @property
    def capability(self):
        legacy = self.ffmpeg_renderer.capability
        worker_capability = self.worker_client.capability
        runtime_hash_value = str(worker_capability.get("runtime_hash") or "")
        runtime_hash = (
            runtime_hash_value
            if self._SAFE_RUNTIME_HASH.fullmatch(runtime_hash_value)
            else None
        )
        remotion_available = bool(
            worker_capability.get("available")
            and runtime_hash
            and worker_capability.get("runtime_hash_includes_bundle") is True
        )
        failure_class = worker_capability.get("failure_class")
        if failure_class not in {
            None, "capability", "transient-local", "contract", "security",
            "output-quality",
        }:
            failure_class = "contract"
        if remotion_available:
            capability_code = "ready"
            capability_failure_class = None
        elif not worker_capability.get("available"):
            capability_code = (
                self._opaque(worker_capability.get("code")) or "worker_unavailable"
            )
            capability_failure_class = failure_class
        else:
            capability_code = "runtime_hash_invalid"
            capability_failure_class = "contract"
        remotion = {
            "available": remotion_available,
            "code": capability_code,
            "failure_class": capability_failure_class,
            "taxonomy_version": int(
                worker_capability.get("taxonomy_version") or 1
            ),
            "runtime_hash": runtime_hash,
            "runtime_hash_includes_bundle": remotion_available,
        }
        return {
            "available": bool(legacy.get("available")),
            "code": legacy.get("code") or "media_tools_unavailable",
            "hardware_encoder": bool(legacy.get("hardware_encoder")),
            "remotion_packaging_v1": bool(
                legacy.get("available") and remotion_available
            ),
            "runtime_hash": runtime_hash if remotion_available else None,
            "runtime_hash_includes_bundle": remotion_available,
            "remotion": remotion,
        }

    def close(self, timeout_seconds: float = 3.0) -> None:
        self.worker_client.close(timeout_seconds=timeout_seconds)

    def begin_task(self) -> None:
        self._cancel_requested.clear()
        begin_ffmpeg = getattr(self.ffmpeg_renderer, "begin_task", None)
        if callable(begin_ffmpeg):
            begin_ffmpeg()
        begin_worker = getattr(self.worker_client, "begin_task", None)
        if callable(begin_worker):
            begin_worker()

    def cancel(self) -> None:
        self._cancel_requested.set()
        cancel_ffmpeg = getattr(self.ffmpeg_renderer, "cancel", None)
        if callable(cancel_ffmpeg):
            cancel_ffmpeg()
        self.worker_client.cancel()

    def _raise_if_cancelled(self) -> None:
        if self._cancel_requested.is_set():
            raise RenderCancelledError()

    def compose_cover(self, *args, **kwargs):
        return self.ffmpeg_renderer.compose_cover(*args, **kwargs)

    @staticmethod
    def _visual_config(recipe):
        packaging = recipe.get("packaging")
        if not isinstance(packaging, dict):
            return None
        value = packaging.get("visualRenderer")
        if value is None:
            value = packaging.get("visual_renderer")
        return value if isinstance(value, dict) else None

    @staticmethod
    def _value(config, camel, snake=None, default=None):
        if camel in config:
            return config[camel]
        if snake and snake in config:
            return config[snake]
        return default

    @classmethod
    def _requests_remotion(cls, recipe):
        config = cls._visual_config(recipe)
        return bool(
            config
            and str(
                cls._value(config, "requestedEngine", "requested_engine", "")
            ).strip()
            == "remotion"
        )

    @staticmethod
    def _is_auto_mix_v2(recipe):
        return recipe.get("product_workflow") == "one_click_v2"

    @classmethod
    def _validate_auto_mix_v2_boundary(cls, recipe):
        if not cls._is_auto_mix_v2(recipe):
            return
        if not str(recipe.get("voice_audio_path") or "").strip():
            raise RemotionRenderError("contract", "auto_mix_voice_required")
        if not str(recipe.get("licensed_music_relative_path") or "").strip():
            raise RemotionRenderError("contract", "auto_mix_music_required")
        config = cls._visual_config(recipe) or {}
        requested = cls._value(config, "requestedEngine", "requested_engine", "")
        if requested != "remotion":
            raise RemotionRenderError("contract", "auto_mix_remotion_required")
        if cls._value(config, "allowFallback", "allow_fallback", None) is not False:
            raise RemotionRenderError(
                "contract", "auto_mix_remotion_fallback_forbidden"
            )

    @staticmethod
    def _normalized_audio_quality_report(value):
        if not isinstance(value, dict):
            raise RemotionRenderError(
                "output-quality", "audio_quality_report_missing"
            )
        try:
            report = {
                "integrated_lufs": round(float(value["integrated_lufs"]), 2),
                "true_peak_dbtp": round(float(value["true_peak_dbtp"]), 2),
                "speech_music_margin_lu": round(
                    float(value["speech_music_margin_lu"]), 2
                ),
            }
        except (KeyError, TypeError, ValueError) as error:
            raise RemotionRenderError(
                "output-quality", "audio_quality_report_invalid"
            ) from error
        if not all(math.isfinite(item) for item in report.values()):
            raise RemotionRenderError(
                "output-quality", "audio_quality_report_invalid"
            )
        raw_windows = value.get("speech_music_windows") or []
        if raw_windows:
            windows = []
            try:
                for item in raw_windows:
                    windows.append(
                        {
                            "captionId": str(item.get("captionId") or "")[:128],
                            "startMs": int(item["startMs"]),
                            "endMs": int(item["endMs"]),
                            "voiceLufs": round(float(item["voiceLufs"]), 2),
                            "musicLufs": round(float(item["musicLufs"]), 2),
                            "rawMarginLu": round(float(item["rawMarginLu"]), 2),
                            "marginLu": round(float(item["marginLu"]), 2),
                        }
                    )
            except (AttributeError, KeyError, TypeError, ValueError) as error:
                raise RemotionRenderError(
                    "output-quality", "audio_quality_report_invalid"
                ) from error
            if not windows or not all(
                math.isfinite(number)
                for item in windows
                for number in (
                    item["voiceLufs"],
                    item["musicLufs"],
                    item["rawMarginLu"],
                    item["marginLu"],
                )
            ):
                raise RemotionRenderError(
                    "output-quality", "audio_quality_report_invalid"
                )
            report["speech_music_windows"] = windows
        if "music_gain_db" in value:
            try:
                gain = round(float(value["music_gain_db"]), 2)
            except (TypeError, ValueError) as error:
                raise RemotionRenderError(
                    "output-quality", "audio_quality_report_invalid"
                ) from error
            if not math.isfinite(gain):
                raise RemotionRenderError(
                    "output-quality", "audio_quality_report_invalid"
                )
            report["music_gain_db"] = gain
        return report

    @classmethod
    def _fallback_allowed(cls, config):
        comparison_id = str(
            cls._value(config, "comparisonGroupId", "comparison_group_id", "")
            or ""
        ).strip()
        if comparison_id:
            return False
        explicit = cls._value(config, "allowFallback", "allow_fallback", True)
        return explicit is True

    @staticmethod
    def _duration_ms(recipe):
        voice = recipe.get("voice_segment") or {}
        return max(
            1, int(voice.get("end_ms") or 0) - int(voice.get("start_ms") or 0)
        )

    @staticmethod
    def _sha256_file(path):
        digest = hashlib.sha256()
        with Path(path).open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    @classmethod
    def _opaque(cls, value):
        candidate = str(value or "")[:128]
        return candidate if cls._SAFE_OPAQUE.fullmatch(candidate) else ""

    @classmethod
    def _recipe_hash(cls, recipe):
        copied = json.loads(
            json.dumps(recipe, ensure_ascii=False, allow_nan=False)
        )
        config = cls._visual_config(copied)
        if config:
            for key in (
                "actualEngine", "actual_engine", "actualStyleVersion",
                "actual_style_version", "fallbackCode", "fallback_code",
            ):
                config.pop(key, None)
        return canonical_json_sha256(copied)

    @classmethod
    def _public_props(cls, recipe, config):
        duration = cls._duration_ms(recipe)
        packaging = recipe.get("packaging") or {}
        semantic_preset = str(
            packaging.get("semantic_preset_id") or packaging.get("preset_id")
            or "knowledge_focus"
        )[:40]
        # ``auto_mix_v2`` identifies this product workflow's packaging, not a
        # Remotion semantic preset. Keep the packaging identifier intact while
        # passing the matching registered preset to the worker.
        semantic_preset = cls._SEMANTIC_PRESET_ALIASES.get(
            semantic_preset, semantic_preset
        )

        captions = []
        for cue in FFmpegCreativeRenderer._caption_cues(
            recipe.get("captions") or [], recipe
        ):
            timed_items = cue.get("words") or [cue]
            for item in timed_items:
                text = str(item.get("text") or "").strip()
                start = max(0, int(item.get("start_ms") or 0))
                end = min(
                    duration,
                    max(start + 1, int(item.get("end_ms") or start + 1)),
                )
                if text and end > start:
                    captions.append(
                        {"text": text, "startMs": start, "endMs": end}
                    )
        events = []
        for index, item in enumerate(packaging.get("events") or []):
            raw_start = int(item.get("start_ms") or 0)
            raw_end = int(item.get("end_ms") or raw_start)
            if raw_end <= raw_start or not str(item.get("text") or "").strip():
                continue
            events.append(
                {
                    "type": str(item.get("type") or "")[:24],
                    "text": str(item.get("text") or "").strip()[:48],
                    "startMs": max(0, raw_start),
                    "endMs": min(duration, raw_end),
                    "preferredZone": str(
                        item.get("zone") or item.get("preferred_zone") or ""
                    )[:24],
                    "size": str(item.get("size") or "")[:16],
                    "priority": max(1, min(3, int(item.get("priority") or 2))),
                    "icon": str(item.get("icon") or "spark")[:24],
                    "ordinal": index + 1,
                    "reason": str(item.get("reason") or "")[:80],
                }
            )

        # Product scripts keep visual evidence cards separate from the spoken
        # caption lane.  Older persisted recipes may contain ``visual_labels``
        # without a copied packaging event, so bridge them here as a renderer
        # compatibility boundary.  Keep a single visual-card lane: a hook or
        # CTA wins over a lower-priority shot label at the same time.
        if recipe.get("product_workflow") == "one_click_v1":
            label_events = []
            zone_cycle = ("upper_left", "upper_right", "middle_left", "middle_right")
            for index, item in enumerate(recipe.get("visual_labels") or []):
                if not isinstance(item, dict):
                    continue
                text = str(item.get("text") or "").strip()[:48]
                start = max(0, int(item.get("start_ms") or 0))
                end = min(duration, max(start + 1, int(item.get("end_ms") or start + 1)))
                if not text or end <= start:
                    continue
                source = str(item.get("label_source") or "")
                role = str(item.get("role") or "process")
                if source == "hook" or role == "hook":
                    event_type, priority, zone, size = "hook", 3, "top_banner", "hero"
                elif source == "cta" or role == "result":
                    event_type, priority, zone, size = "result", 3, "middle_right", "card"
                else:
                    event_type, priority = "scene", 2
                    zone, size = zone_cycle[index % len(zone_cycle)], "card"
                label_events.append(
                    {
                        "type": event_type,
                        "text": text,
                        "startMs": start,
                        "endMs": end,
                        "preferredZone": zone,
                        "size": size,
                        "priority": priority,
                        "icon": "spark",
                        "ordinal": len(events) + index + 1,
                        "reason": source or "product_visual_evidence",
                    }
                )
            accepted_labels = []
            for item in sorted(
                label_events,
                key=lambda value: (-value["priority"], value["startMs"], value["endMs"]),
            ):
                if any(
                    item["startMs"] < current["endMs"]
                    and current["startMs"] < item["endMs"]
                    for current in [*events, *accepted_labels]
                ):
                    continue
                accepted_labels.append(item)
            events.extend(
                sorted(accepted_labels, key=lambda value: (value["startMs"], -value["priority"]))
            )

        def rectangles(key, *, protected=False):
            output = []
            for item in packaging.get(key) or []:
                value = {
                    "startMs": max(0, int(item.get("start_ms") or 0)),
                    "endMs": min(duration, int(item.get("end_ms") or duration)),
                    "x": float(item.get("x") or 0),
                    "y": float(item.get("y") or 0),
                    "width": float(item.get("width") or 0.1),
                    "height": float(item.get("height") or 0.1),
                }
                if protected:
                    value["role"] = str(item.get("role") or "subject")[:24]
                output.append(value)
            return output

        director = packaging.get("director") or {}
        return {
            "version": 1,
            "semanticPresetId": semantic_preset,
            "styleId": str(
                cls._value(config, "visualStyleId", "visual_style_id", "social_pop")
            )[:40],
            "deterministicSeed": str(
                cls._value(config, "deterministicSeed", "deterministic_seed", "render")
            )[:80],
            "durationMs": duration,
            "title": str(packaging.get("title") or "")[:60],
            "sourceFile": f"{uuid.uuid4().hex}.mp4",
            "director": {
                "version": max(1, int(director.get("version") or 1)),
                "provider": str(director.get("provider") or "local")[:24],
                "model": str(director.get("model") or "")[:64] or None,
            },
            "captions": captions,
            "events": events,
            "focusRects": rectangles("focus_rects"),
            "protectedRects": rectangles("protected_rects", protected=True),
        }

    @classmethod
    def _manifest(
        cls,
        *,
        video_id,
        recipe_hash,
        config,
        actual_engine,
        fallback_code,
        runtime_hash,
        video_path,
        cover_path,
        audio_quality_report=None,
    ):
        manifest = {
            "version": cls.MANIFEST_VERSION,
            "candidateId": video_id,
            "recipeHash": recipe_hash,
            "semanticPlanHash": str(
                cls._opaque(
                    cls._value(config, "semanticPlanHash", "semantic_plan_hash", "")
                )
            ),
            "visualStyleId": str(
                cls._value(config, "visualStyleId", "visual_style_id", "")
            )[:40],
            "requestedStyleVersion": int(
                cls._value(config, "requestedStyleVersion", "requested_style_version", 1)
                or 1
            ),
            "actualEngine": actual_engine,
            "actualStyleVersion": (
                int(config.get("actualStyleVersion") or 1)
                if actual_engine == "remotion"
                else None
            ),
            "fallbackCode": fallback_code,
            "runtimeHash": cls._opaque(runtime_hash),
            "videoSha256": cls._sha256_file(video_path),
            "coverSha256": cls._sha256_file(cover_path),
        }
        if audio_quality_report is not None:
            manifest["audioQualityReport"] = cls._normalized_audio_quality_report(
                audio_quality_report
            )
        return manifest

    @classmethod
    def _adopt_installed(cls, output_dir, *, video_id, recipe_hash):
        manifest_path = output_dir / cls.MANIFEST_NAME
        video = output_dir / "video.mp4"
        cover = output_dir / "cover.jpg"
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if (
            manifest.get("version") != cls.MANIFEST_VERSION
            or manifest.get("candidateId") != video_id
            or manifest.get("recipeHash") != recipe_hash
            or not video.is_file()
            or not cover.is_file()
        ):
            return None
        if (
            manifest.get("videoSha256") != cls._sha256_file(video)
            or manifest.get("coverSha256") != cls._sha256_file(cover)
        ):
            return None
        return {"video_path": video, "thumbnail_path": cover}, manifest

    @staticmethod
    def _write_manifest(path, manifest):
        path.write_text(
            json.dumps(
                manifest,
                ensure_ascii=True,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ),
            encoding="utf-8",
        )

    def _install(self, staging, output_dir, *, audio_quality_report=None):
        output_dir.parent.mkdir(parents=True, exist_ok=True)
        if output_dir.exists():
            raise RemotionRenderError("output-quality", "render_target_conflict")
        staging.replace(output_dir)
        result = {
            "video_path": output_dir / "video.mp4",
            "thumbnail_path": output_dir / "cover.jpg",
        }
        if audio_quality_report is not None:
            result["audioQualityReport"] = self._normalized_audio_quality_report(
                audio_quality_report
            )
        return result

    def _render_candidate_cover(
        self,
        *,
        video_path,
        cover_path,
        recipe,
        resolve_asset_path,
        final_parent,
    ):
        cover = ((recipe.get("packaging") or {}).get("cover") or {})
        if str(cover.get("mode") or "") != "reuse":
            self.ffmpeg_renderer.render_cover_for_candidate(
                video_path, cover_path, recipe, resolve_asset_path
            )
            return
        source_id = str(cover.get("source_generated_video_id") or "")
        if not self._SAFE_CANDIDATE_ID.fullmatch(source_id):
            raise RemotionRenderError("contract", "reuse_cover_source_invalid")
        project_root = Path(final_parent).resolve(strict=True)
        source = project_root / source_id / "cover.jpg"
        if source.is_symlink():
            raise RemotionRenderError("security", "reuse_cover_reparse_rejected")
        try:
            resolved = source.resolve(strict=True)
        except OSError as error:
            raise RemotionRenderError("output-quality", "reuse_cover_missing") from error
        try:
            resolved.relative_to(project_root)
        except ValueError as error:
            raise RemotionRenderError("security", "reuse_cover_outside_project") from error
        if not resolved.is_file():
            raise RemotionRenderError("output-quality", "reuse_cover_missing")
        shutil.copyfile(resolved, cover_path)

    def _legacy_into_staging(
        self,
        *,
        video_id,
        recipe,
        staging,
        resolve_asset_path,
        manifest_args,
        final_parent,
    ):
        legacy_dir = staging / "legacy"
        rendered = self.ffmpeg_renderer.render(
            video_id=video_id,
            recipe=recipe,
            output_dir=legacy_dir,
            resolve_asset_path=resolve_asset_path,
        )
        validator = getattr(self.ffmpeg_renderer, "validate_rendered_output", None)
        if callable(validator):
            validator(
                Path(rendered["video_path"]),
                expected_duration_ms=self._duration_ms(recipe),
            )
        video = staging / "video.mp4"
        cover = staging / "cover.jpg"
        Path(rendered["video_path"]).replace(video)
        Path(rendered["thumbnail_path"]).replace(cover)
        shutil.rmtree(legacy_dir, ignore_errors=True)
        if str((((recipe.get("packaging") or {}).get("cover") or {}).get("mode") or "")) == "reuse":
            self._render_candidate_cover(
                video_path=video,
                cover_path=cover,
                recipe=recipe,
                resolve_asset_path=resolve_asset_path,
                final_parent=final_parent,
            )
        self._write_manifest(
            staging / self.MANIFEST_NAME,
            self._manifest(
                **manifest_args,
                actual_engine="ffmpeg",
                runtime_hash="",
                video_path=video,
                cover_path=cover,
            ),
        )

    def render(
        self,
        *,
        video_id: str,
        recipe: dict[str, Any],
        output_dir: Path,
        resolve_asset_path: Callable[[str], str | Path],
    ) -> dict[str, Any]:
        if not self._SAFE_CANDIDATE_ID.fullmatch(str(video_id or "")):
            raise RemotionRenderError("security", "candidate_id_invalid")
        auto_mix_v2 = self._is_auto_mix_v2(recipe)
        self._validate_auto_mix_v2_boundary(recipe)
        if not self._requests_remotion(recipe):
            return self.ffmpeg_renderer.render(
                video_id=video_id,
                recipe=recipe,
                output_dir=output_dir,
                resolve_asset_path=resolve_asset_path,
            )
        output_dir = Path(output_dir).resolve()
        config = self._visual_config(recipe)
        recipe_hash = self._recipe_hash(recipe)
        if output_dir.exists():
            adopted = self._adopt_installed(
                output_dir, video_id=video_id, recipe_hash=recipe_hash
            )
            if adopted:
                paths, manifest = adopted
                if auto_mix_v2 and recipe.get("narrated_preserve_shot_duration"):
                    audio = manifest.get("audioQualityReport") or {}
                    if not -16 <= float(audio.get("integrated_lufs", -100)) <= -14:
                        video = output_dir / "video.mp4"
                        backup = output_dir / "video.before-loudness.mp4"
                        if backup.exists() and self._sha256_file(backup) != self._sha256_file(video):
                            raise RemotionRenderError("output-quality", "audio_repair_backup_exists")
                        if not backup.exists():
                            shutil.copy2(video, backup)
                        try:
                            corrected = self.ffmpeg_renderer.calibrate_final_loudness(video)
                            manifest["audioQualityReport"] = {**audio, **corrected}
                            manifest["videoSha256"] = self._sha256_file(video)
                            manifest["audioCalibration"] = {"previousVideoSha256": self._sha256_file(backup),
                                                            "method": "measured_final_mix_calibration"}
                            self._write_manifest(output_dir / self.MANIFEST_NAME, manifest)
                        except Exception:
                            shutil.copy2(backup, video)
                            raise
                if auto_mix_v2:
                    paths["audioQualityReport"] = self._normalized_audio_quality_report(
                        manifest.get("audioQualityReport")
                    )
                config["actualEngine"] = manifest["actualEngine"]
                config["actualStyleVersion"] = manifest.get("actualStyleVersion")
                config["fallbackCode"] = manifest.get("fallbackCode")
                return paths
            raise RemotionRenderError("output-quality", "installed_candidate_mismatch")
        # Keep the transient tree short. A mix fallback nests legacy/visuals
        # and bounded clip names; placing it beside the project directory can
        # exceed Windows' MAX_PATH even though the installed candidate path is
        # valid. The final directory remains the caller-owned output_dir and
        # is still installed atomically on the same volume.
        staging = output_dir.parent.parent / f".creative-render-{uuid.uuid4().hex}"
        staging.mkdir(parents=True, exist_ok=False)
        fallback_code = None
        manifest_args = {
            "video_id": video_id,
            "recipe_hash": recipe_hash,
            "config": config,
            "fallback_code": None,
        }
        try:
            requested_runtime_hash = str(
                self._value(
                    config,
                    "requestedRuntimeHash",
                    "requested_runtime_hash",
                    "",
                )
                or ""
            )
            if self._SAFE_RUNTIME_HASH.fullmatch(requested_runtime_hash):
                expected_runtime_hash = requested_runtime_hash
            else:
                capability = self.worker_client.capability
                if not capability.get("available"):
                    raise RemotionRenderError(
                        str(capability.get("failure_class") or "capability"),
                        str(capability.get("code") or "worker_unavailable"),
                    )
                expected_runtime_hash = str(capability.get("runtime_hash") or "")
            if not self._SAFE_RUNTIME_HASH.fullmatch(expected_runtime_hash):
                raise RemotionRenderError("contract", "runtime_hash_invalid")
            mezzanine = staging / "mezzanine.mp4"
            duration_ms = self._duration_ms(recipe)
            self.ffmpeg_renderer.render_mezzanine(
                recipe=recipe,
                output=mezzanine,
                temp_dir=staging,
                resolve_asset_path=resolve_asset_path,
            )
            self._raise_if_cancelled()
            mezzanine_info = self.ffmpeg_renderer.validate_mezzanine(
                mezzanine, expected_duration_ms=duration_ms
            )
            self._raise_if_cancelled()
            visual_output = staging / "visual-only.mp4"
            worker_args = {
                "source_path": mezzanine,
                "output_path": visual_output,
                "public_props": self._public_props(recipe, config),
                "expected_runtime_hash": expected_runtime_hash,
            }
            try:
                worker_result = self.worker_client.render(**worker_args)
            except RemotionRenderError as first_error:
                # Browser/process exits are often transient on Windows. Retry
                # the local Remotion step once, reusing the already validated
                # mezzanine and without submitting any cloud work again.
                if first_error.failure_class != "transient-local":
                    raise
                visual_output.unlink(missing_ok=True)
                self._raise_if_cancelled()
                worker_result = self.worker_client.render(**worker_args)
            self._raise_if_cancelled()
            if worker_result.get("runtime_hash") != expected_runtime_hash:
                raise RemotionRenderError("contract", "runtime_hash_mismatch")
            final_video = staging / "video.mp4"
            self.ffmpeg_renderer.mux_visual_with_mezzanine_audio(
                visual_output, mezzanine, final_video
            )
            self._raise_if_cancelled()
            self.ffmpeg_renderer.validate_final(
                final_video,
                expected_duration_ms=duration_ms,
                expected_audio_digest=mezzanine_info["audio_digest"],
            )
            audio_quality_report = None
            if auto_mix_v2:
                measure_audio_quality = getattr(
                    self.ffmpeg_renderer, "measure_audio_quality", None
                )
                if not callable(measure_audio_quality):
                    raise RemotionRenderError(
                        "contract", "audio_quality_measure_unavailable"
                    )
                read_margin_report = getattr(
                    self.ffmpeg_renderer,
                    "read_auto_mix_speech_music_report",
                    None,
                )
                if not callable(read_margin_report):
                    raise RemotionRenderError(
                        "contract", "speech_music_measure_unavailable"
                    )
                measured = measure_audio_quality(final_video)
                measured.update(read_margin_report(mezzanine))
                audio_quality_report = self._normalized_audio_quality_report(measured)
            cover = staging / "cover.jpg"
            self._render_candidate_cover(
                video_path=final_video,
                cover_path=cover,
                recipe=recipe,
                resolve_asset_path=resolve_asset_path,
                final_parent=output_dir.parent,
            )
            self._raise_if_cancelled()
            config["actualEngine"] = "remotion"
            config["actualStyleVersion"] = int(
                worker_result.get("style_version") or 1
            )
            config["fallbackCode"] = None
            self._write_manifest(
                staging / self.MANIFEST_NAME,
                self._manifest(
                    **manifest_args,
                    actual_engine="remotion",
                    runtime_hash=worker_result.get("runtime_hash"),
                    video_path=final_video,
                    cover_path=cover,
                    audio_quality_report=audio_quality_report,
                ),
            )
            mezzanine.unlink(missing_ok=True)
            Path(f"{mezzanine}.speech-music.json").unlink(missing_ok=True)
            visual_output.unlink(missing_ok=True)
            return self._install(
                staging,
                output_dir,
                audio_quality_report=audio_quality_report,
            )
        except RemotionRenderError as error:
            if error.code == "render_cancelled":
                raise RenderCancelledError() from error
            self._raise_if_cancelled()
            fallback_code = error.code
            if not (
                not auto_mix_v2
                and self._fallback_allowed(config)
                and error.failure_class in {"capability", "transient-local"}
            ):
                raise
            shutil.rmtree(staging, ignore_errors=True)
            staging.mkdir(parents=True, exist_ok=False)
            config["actualEngine"] = "ffmpeg"
            config["actualStyleVersion"] = None
            config["fallbackCode"] = fallback_code
            manifest_args["fallback_code"] = fallback_code
            self._legacy_into_staging(
                video_id=video_id,
                recipe=recipe,
                staging=staging,
                resolve_asset_path=resolve_asset_path,
                manifest_args=manifest_args,
                final_parent=output_dir.parent,
            )
            return self._install(staging, output_dir)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
