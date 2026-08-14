from __future__ import annotations

from pathlib import Path
import re
import shutil
import subprocess
from typing import Any, Callable

from .errors import ContentEngineError
from .render_mix import discover_media_executable, _windows_process_options


class FFmpegCreativeRenderer:
    def __init__(
        self,
        data_dir: Path,
        *,
        ffmpeg_path: str | None = None,
        ffprobe_path: str | None = None,
        command_runner=subprocess.run,
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
        self.timeout_seconds = max(10, int(timeout_seconds))
        self._encoder_checked = False
        self._preferred_encoder = "libx264"

    @property
    def capability(self):
        available = bool(self.ffmpeg_path and self.ffprobe_path)
        return {
            "available": available,
            "code": "ready" if available else "media_tools_unavailable",
            "hardware_encoder": self._preferred_encoder == "h264_qsv",
        }

    def _command(self, args, *, timeout=None, cwd=None, allow_failure=False):
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
                timeout=timeout or self.timeout_seconds,
                check=False,
                shell=False,
                **_windows_process_options(),
            )
        except subprocess.TimeoutExpired as error:
            raise ContentEngineError("render_timeout", "AI 剪辑成片渲染超时。") from error
        if result.returncode != 0 and not allow_failure:
            raise ContentEngineError("render_failed", (result.stderr or "FFmpeg failed")[-2_000:])
        return result

    def _encoder(self):
        if self._encoder_checked or not self.ffmpeg_path:
            return self._preferred_encoder
        self._encoder_checked = True
        result = self._command(
            [self.ffmpeg_path, "-hide_banner", "-encoders"],
            timeout=30,
            allow_failure=True,
        )
        if result.returncode == 0 and "h264_qsv" in (result.stdout or ""):
            self._preferred_encoder = "h264_qsv"
        return self._preferred_encoder

    def render(
        self,
        *,
        video_id: str,
        recipe: dict[str, Any],
        output_dir: Path,
        resolve_asset_path: Callable[[str], str | Path],
    ) -> dict[str, Path]:
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
            captions = recipe.get("captions") or []
            self._write_srt(temp_dir / "captions.srt", captions, recipe)
            subtitle = self._write_ass(temp_dir / "captions.ass", captions, recipe)
            if kind == "course":
                self._render_course(recipe, output, subtitle, resolve_asset_path)
            elif kind == "mix":
                self._render_mix(recipe, output, subtitle, temp_dir, resolve_asset_path)
            else:
                raise ContentEngineError("invalid_recipe", "The render recipe kind is invalid.")
            thumbnail = temp_dir / "cover.jpg"
            self._command(
                [
                    self.ffmpeg_path,
                    "-y",
                    "-ss",
                    "0.500",
                    "-i",
                    str(output),
                    "-frames:v",
                    "1",
                    "-q:v",
                    "2",
                    str(thumbnail),
                ],
                timeout=120,
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

    def _render_course(self, recipe, output, subtitle, resolve_asset_path):
        voice = recipe["voice_segment"]
        source = Path(resolve_asset_path(voice["asset_id"]))
        start_ms = int(voice["start_ms"])
        duration_ms = int(voice["end_ms"]) - start_ms
        presentation_focus = any(
            segment.get("frame_mode") == "slide_with_teacher_pip"
            for segment in recipe.get("visual_segments") or []
        )
        args = [
            "-ss",
            f"{start_ms / 1000:.3f}",
            "-i",
            str(source),
            "-t",
            f"{duration_ms / 1000:.3f}",
        ]
        if presentation_focus:
            args.extend(("-filter_complex", self._presentation_filter(subtitle)))
            video_map = "[vout]"
        else:
            args.extend(("-vf", self._portrait_filter(subtitle)))
            video_map = "0:v:0"
        args.extend(
            (
                "-af",
                "highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:LRA=11:TP=-1.5",
                "-map",
                video_map,
                "-map",
                "0:a:0?",
            )
        )
        self._encode_with_fallback(args, output)

    def _render_mix(self, recipe, output, subtitle, temp_dir, resolve_asset_path):
        normalized_dir = temp_dir / "visuals"
        normalized_dir.mkdir()
        visual_outputs = []
        for index, segment in enumerate(recipe.get("visual_segments") or []):
            target = normalized_dir / f"visual-{index:03d}.mp4"
            source = Path(resolve_asset_path(segment["asset_id"]))
            target_ms = int(segment["target_duration_ms"])
            start_ms = int(segment.get("start_ms") or 0)
            end_ms = int(segment.get("end_ms") or 0)
            common = [
                "-t",
                f"{target_ms / 1000:.3f}",
                "-vf",
                self._portrait_filter(None),
                "-an",
            ]
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
                        "-an",
                    ],
                    bounded,
                    audio=False,
                )
                source_args = [
                    "-stream_loop",
                    "-1",
                    "-i",
                    str(bounded),
                ]
            self._encode_with_fallback([*source_args, *common], target, audio=False)
            visual_outputs.append(target)
        if not visual_outputs:
            raise ContentEngineError("invalid_recipe", "Mix recipe has no visual segments.")
        concat_file = normalized_dir / "concat.txt"
        concat_file.write_text(
            "".join(f"file '{item.name}'\n" for item in visual_outputs), encoding="utf-8"
        )
        visuals = temp_dir / "visual-track.mp4"
        self._command(
            [
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
                str(visuals),
            ],
            cwd=normalized_dir,
        )
        voice = recipe["voice_segment"]
        voice_source = Path(resolve_asset_path(voice["asset_id"]))
        voice_start = int(voice["start_ms"])
        duration_ms = int(voice["end_ms"]) - voice_start
        merge_filter = self._subtitle_filter(subtitle)
        args = [
            "-i",
            str(visuals),
            "-ss",
            f"{voice_start / 1000:.3f}",
            "-i",
            str(voice_source),
            "-t",
            f"{duration_ms / 1000:.3f}",
        ]
        if merge_filter:
            args.extend(("-vf", merge_filter))
        args.extend(
            (
                "-af",
                "highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:LRA=11:TP=-1.5",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
            )
        )
        self._encode_with_fallback(args, output)

    def _encode_with_fallback(self, input_args, output, *, audio=True):
        encoders = [self._encoder()]
        if encoders[0] != "libx264":
            encoders.append("libx264")
        last_error = None
        for encoder in encoders:
            command = [self.ffmpeg_path, "-y", *input_args, "-c:v", encoder]
            if encoder == "libx264":
                command.extend(("-preset", "medium", "-crf", "20"))
            else:
                command.extend(("-global_quality", "20", "-look_ahead", "0"))
            command.extend(("-pix_fmt", "yuv420p", "-r", "30"))
            if audio:
                command.extend(("-c:a", "aac", "-ar", "48000", "-ac", "2"))
            command.extend(("-movflags", "+faststart", str(output)))
            result = self._command(command, allow_failure=True)
            if result.returncode == 0:
                self._preferred_encoder = encoder
                return
            last_error = result.stderr
        raise ContentEngineError("render_failed", str(last_error or "FFmpeg failed")[-2_000:])

    def _portrait_filter(self, subtitle):
        base = (
            "scale=1215:2160:force_original_aspect_ratio=increase,"
            "crop=1080:1920:(in_w-1080)/2:max(0\\,(in_h-1920)*0.58),fps=30,format=yuv420p"
        )
        overlay = self._subtitle_filter(subtitle)
        return f"{base},{overlay}" if overlay else base

    def _presentation_filter(self, subtitle):
        # The analyzed shot type is the evidence for entering this layout. The
        # full classroom frame remains visible in the PIP; no synthetic B-roll
        # or inferred person coordinates are introduced.
        filters = (
            "[0:v]split=2[slide_source][classroom_source];"
            "[slide_source]crop=iw:ih*0.58:0:0,"
            "scale=1080:1920:force_original_aspect_ratio=increase,"
            "crop=1080:1920,fps=30[slide];"
            "[classroom_source]scale=324:576:force_original_aspect_ratio=decrease,"
            "pad=324:576:(ow-iw)/2:(oh-ih)/2:black,fps=30[classroom];"
            "[slide][classroom]overlay=W-w-36:H-h-180[composed]"
        )
        overlay = self._subtitle_filter(subtitle)
        if overlay:
            return f"{filters};[composed]{overlay},format=yuv420p[vout]"
        return f"{filters};[composed]format=yuv420p[vout]"

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
        max_chars = max(8, min(18, int(style.get("max_chars") or 12)))
        word_timed = (
            recipe.get("experiment_mode") == "supoclip_bailian_v1"
            and style.get("preset") in {"knowledge_course", "energetic_talking"}
        )
        cues = []
        for caption in captions:
            text = str(caption.get("text") or "").strip()
            if not text:
                continue
            if word_timed:
                word_cues = cls._word_caption_cues(caption, base, max_chars)
                if word_cues:
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
                    }
                )
        return cues

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
    def _write_ass(cls, path, captions, recipe):
        cues = cls._caption_cues(captions, recipe)
        if not cues:
            return None
        style = recipe.get("subtitle_style") or {}
        preset = str(style.get("preset") or "dynamic_clean")
        is_supoclip = (
            recipe.get("experiment_mode") == "supoclip_bailian_v1"
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
            f"Style: Dynamic,Microsoft YaHei,{font_size},{primary},{secondary},"
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
    def _write_srt(cls, path, captions, recipe):
        cues = cls._caption_cues(captions, recipe)
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
