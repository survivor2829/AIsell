from __future__ import annotations

import base64
import hashlib
import http.client
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
from typing import Any, Callable
from urllib import parse, request
import uuid

from .errors import ContentEngineError
from .render_mix import discover_media_executable, _windows_process_options


DEFAULT_ANALYSIS_VERSION = "creative-v1"
DEFAULT_ASR_MODEL = "paraformer-v2"
DEFAULT_VISION_MODEL = "qwen-vl-plus"
DEFAULT_SELECTION_MODEL = "qwen-plus"
DEFAULT_DASHSCOPE_ORIGIN = "https://dashscope.aliyuncs.com"
ANALYSIS_MANIFEST_NAME = "analysis-manifest.json"


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _safe_json_object(value: str) -> dict[str, Any]:
    text = str(value or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I | re.S)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise ContentEngineError("cloud_response_invalid", "百炼返回了无法解析的结果。") from error
    if not isinstance(parsed, dict):
        raise ContentEngineError("cloud_response_invalid", "百炼返回的结果结构无效。")
    return parsed


class DashScopeMediaClient:
    def __init__(
        self,
        *,
        api_key: str | None = None,
        origin: str | None = None,
        compatible_origin: str | None = None,
        asr_model: str | None = None,
        vision_model: str | None = None,
        selection_model: str | None = None,
        timeout_seconds: int = 60,
    ):
        self.api_key = str(api_key or os.environ.get("DASHSCOPE_API_KEY") or "").strip()
        self.origin = str(
            origin or os.environ.get("DASHSCOPE_ORIGIN") or DEFAULT_DASHSCOPE_ORIGIN
        ).rstrip("/")
        self.compatible_origin = str(
            compatible_origin
            or os.environ.get("DASHSCOPE_COMPATIBLE_ORIGIN")
            or f"{self.origin}/compatible-mode/v1"
        ).rstrip("/")
        self.asr_model = str(
            asr_model or os.environ.get("XIAOXI_BAILIAN_ASR_MODEL") or DEFAULT_ASR_MODEL
        ).strip()
        self.vision_model = str(
            vision_model
            or os.environ.get("XIAOXI_BAILIAN_VISION_MODEL")
            or DEFAULT_VISION_MODEL
        ).strip()
        self.selection_model = str(
            selection_model
            or os.environ.get("XIAOXI_BAILIAN_SELECTION_MODEL")
            or DEFAULT_SELECTION_MODEL
        ).strip()
        self.timeout_seconds = max(5, int(timeout_seconds))

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def _request_json(
        self,
        url: str,
        *,
        method: str = "GET",
        payload: Any = None,
        headers: dict[str, str] | None = None,
        timeout: int | None = None,
    ) -> dict[str, Any]:
        request_headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
            **(headers or {}),
        }
        data = None
        if payload is not None:
            data = _json_bytes(payload)
            request_headers.setdefault("Content-Type", "application/json")
        operation = request.Request(url, data=data, headers=request_headers, method=method)
        try:
            with request.urlopen(operation, timeout=timeout or self.timeout_seconds) as response:
                raw = response.read()
        except Exception as error:
            raise ContentEngineError("cloud_request_failed", "无法连接阿里百炼，请检查网络与配置。") from error
        try:
            result = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ContentEngineError("cloud_response_invalid", "百炼返回了无效数据。") from error
        if not isinstance(result, dict):
            raise ContentEngineError("cloud_response_invalid", "百炼返回了无效数据。")
        if result.get("code"):
            raise ContentEngineError("cloud_request_rejected", "百炼拒绝了本次分析请求。")
        return result

    def _temporary_upload(self, source: Path, model: str) -> str:
        query = parse.urlencode({"action": "getPolicy", "model": model})
        policy_response = self._request_json(f"{self.origin}/api/v1/uploads?{query}")
        policy = policy_response.get("data")
        if not isinstance(policy, dict):
            raise ContentEngineError("cloud_response_invalid", "百炼未返回上传凭证。")
        filename = re.sub(r'[\\/"\r\n]', "_", source.name)
        object_key = f"{str(policy.get('upload_dir') or '').rstrip('/')}/{filename}"
        fields = [
            ("OSSAccessKeyId", str(policy.get("oss_access_key_id") or "")),
            ("Signature", str(policy.get("signature") or "")),
            ("policy", str(policy.get("policy") or "")),
            ("x-oss-object-acl", str(policy.get("x_oss_object_acl") or "private")),
            (
                "x-oss-forbid-overwrite",
                str(policy.get("x_oss_forbid_overwrite") or "true"),
            ),
            ("key", object_key),
            ("success_action_status", "200"),
        ]
        if not all(value for _, value in fields[:3]) or not policy.get("upload_host"):
            raise ContentEngineError("cloud_response_invalid", "百炼上传凭证不完整。")
        boundary = f"----xiaoxi-{uuid.uuid4().hex}"
        parts = []
        for name, value in fields:
            parts.append(f"--{boundary}\r\n".encode())
            parts.append(
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
            )
        mime = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(
            (
                f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                f"Content-Type: {mime}\r\n\r\n"
            ).encode()
        )
        preamble = b"".join(parts)
        closing = f"\r\n--{boundary}--\r\n".encode()
        upload_url = parse.urlsplit(str(policy["upload_host"]))
        if upload_url.scheme != "https" or not upload_url.hostname:
            raise ContentEngineError("cloud_response_invalid", "百炼上传地址无效。")
        connection = http.client.HTTPSConnection(
            upload_url.hostname,
            upload_url.port,
            timeout=max(120, self.timeout_seconds),
        )
        try:
            upload_target = upload_url.path or "/"
            if upload_url.query:
                upload_target = f"{upload_target}?{upload_url.query}"
            connection.putrequest("POST", upload_target)
            connection.putheader(
                "Content-Type", f"multipart/form-data; boundary={boundary}"
            )
            connection.putheader(
                "Content-Length", str(len(preamble) + source.stat().st_size + len(closing))
            )
            connection.endheaders()
            connection.send(preamble)
            with source.open("rb") as source_file:
                while chunk := source_file.read(1024 * 1024):
                    connection.send(chunk)
            connection.send(closing)
            response = connection.getresponse()
            response.read()
            if response.status < 200 or response.status >= 300:
                raise OSError("upload rejected")
        except Exception as error:
            raise ContentEngineError("cloud_upload_failed", "分析用音频上传失败。") from error
        finally:
            connection.close()
        return f"oss://{object_key}"

    def transcribe(self, audio_path: Path, should_stop: Callable[[], bool]) -> list[dict[str, Any]]:
        if not self.configured:
            return []
        audio_url = self._temporary_upload(audio_path, self.asr_model)
        submitted = self._request_json(
            f"{self.origin}/api/v1/services/audio/asr/transcription",
            method="POST",
            headers={
                "X-DashScope-Async": "enable",
                "X-DashScope-OssResourceResolve": "enable",
            },
            payload={
                "model": self.asr_model,
                "input": {"file_urls": [audio_url]},
                "parameters": {
                    "channel_id": [0],
                    "language_hints": ["zh", "en"],
                    "timestamp_alignment_enabled": True,
                    "diarization_enabled": True,
                },
            },
        )
        task_id = str(submitted.get("output", {}).get("task_id") or "")
        if not task_id:
            raise ContentEngineError("cloud_response_invalid", "百炼未返回转写任务编号。")
        deadline = time.monotonic() + 60 * 60
        while time.monotonic() < deadline:
            if should_stop():
                return []
            state = self._request_json(
                f"{self.origin}/api/v1/tasks/{parse.quote(task_id)}",
                method="POST",
                payload=None,
            )
            output = state.get("output") or {}
            status = str(output.get("task_status") or "").upper()
            if status == "SUCCEEDED":
                results = output.get("results") or []
                successful = next(
                    (
                        item
                        for item in results
                        if item.get("subtask_status") == "SUCCEEDED"
                        and item.get("transcription_url")
                    ),
                    None,
                )
                if not successful:
                    raise ContentEngineError("cloud_transcription_failed", "百炼未生成转写结果。")
                transcript_request = request.Request(str(successful["transcription_url"]))
                try:
                    with request.urlopen(
                        transcript_request, timeout=self.timeout_seconds
                    ) as response:
                        transcript = json.loads(response.read().decode("utf-8"))
                except Exception as error:
                    raise ContentEngineError(
                        "cloud_transcription_failed", "无法读取百炼转写结果。"
                    ) from error
                return self._sentences(transcript)
            if status in {"FAILED", "CANCELED", "UNKNOWN"}:
                raise ContentEngineError("cloud_transcription_failed", "百炼转写任务失败。")
            time.sleep(2)
        raise ContentEngineError("cloud_transcription_timeout", "百炼转写任务超时。")

    @staticmethod
    def _sentences(payload: dict[str, Any]) -> list[dict[str, Any]]:
        items = []
        for transcript in payload.get("transcripts") or []:
            for sentence in transcript.get("sentences") or []:
                start = sentence.get("begin_time")
                end = sentence.get("end_time")
                text = str(sentence.get("text") or "").strip()
                if not isinstance(start, int) or not isinstance(end, int) or end <= start or not text:
                    continue
                items.append(
                    {
                        "start_ms": start,
                        "end_ms": end,
                        "transcript": text,
                        "speaker": str(sentence.get("speaker_id") or "speaker-0"),
                        "metadata": {
                            "sentence_complete": text.endswith(("。", "！", "？", ".", "!", "?")),
                            "words": sentence.get("words") or [],
                        },
                    }
                )
        return items

    def understand_frames(self, frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not self.configured or not frames:
            return []
        content = []
        for frame in frames[:12]:
            data = base64.b64encode(Path(frame["path"]).read_bytes()).decode("ascii")
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{data}"},
                }
            )
        content.append(
            {
                "type": "text",
                "text": (
                    "这些图片按时间顺序来自培训视频。只根据画面证据返回JSON对象，格式为"
                    '{"frames":[{"index":0,"role":"hook|process|result|general",'
                    '"shot_type":"lecturer|slide|audience|equipment|operation|result|unknown",'
                    '"tags":["标签"],"quality":0.0,"caption":"客观描述"}]}。'
                    "不要虚构课程效果、人物身份或学员评价。"
                ),
            }
        )
        response = self._request_json(
            f"{self.compatible_origin}/chat/completions",
            method="POST",
            payload={
                "model": self.vision_model,
                "messages": [{"role": "user", "content": content}],
                "temperature": 0.1,
                "response_format": {"type": "json_object"},
            },
        )
        choices = response.get("choices") or []
        if not choices:
            raise ContentEngineError("cloud_response_invalid", "百炼未返回画面分析结果。")
        raw = choices[0].get("message", {}).get("content")
        if isinstance(raw, list):
            raw = "".join(str(item.get("text") or "") for item in raw if isinstance(item, dict))
        parsed = _safe_json_object(str(raw or ""))
        results = []
        for item in parsed.get("frames") or []:
            if not isinstance(item, dict) or not isinstance(item.get("index"), int):
                continue
            index = item["index"]
            if 0 <= index < len(frames[:12]):
                results.append({**item, "timestamp_ms": frames[index]["timestamp_ms"]})
        return results

    def rank_course_candidates(
        self,
        candidates: list[dict[str, Any]],
        theme: str,
        *,
        experiment_mode: str | None = None,
    ) -> list[dict[str, Any]]:
        if not self.configured or not candidates:
            return []
        is_supoclip_experiment = experiment_mode == "supoclip_bailian_v1"
        safe_candidates = []
        for item in candidates[:48]:
            safe_item = {
                "id": str(item.get("id") or "")[:80],
                "duration_seconds": round(int(item.get("duration_ms") or 0) / 1000, 1),
                "transcript": str(item.get("transcript") or "")[:800],
            }
            if is_supoclip_experiment:
                safe_item.update(
                    {
                        "start_ms": max(0, int(item.get("start_ms") or 0)),
                        "end_ms": max(0, int(item.get("end_ms") or 0)),
                        "visual": [
                            {
                                "shot_type": str(frame.get("shot_type") or "unknown")[:64],
                                "tags": [str(tag)[:64] for tag in (frame.get("tags") or [])[:12]],
                                "quality": frame.get("quality"),
                                "visual_caption": str(frame.get("visual_caption") or "")[:300],
                            }
                            for frame in (item.get("visual") or [])[:12]
                            if isinstance(frame, dict)
                        ],
                    }
                )
            safe_candidates.append(safe_item)
        if is_supoclip_experiment:
            prompt = (
                "你是中文知识短视频主编。只能依据候选的真实转写和画面证据评分，"
                "不得虚构课程效果、人物身份或学员反馈。主题是：" + str(theme)[:100] + "。"
                "为每个候选给出四项0到25分的整数或小数：hook（前5秒的明确吸引力）、"
                "engagement（语言节奏和持续观看动力）、value（独立且完整的知识收获）、"
                "shareability（值得收藏或转发的程度）。total为四项综合分，范围0到100。"
                "半句话开场、依赖上文、重复铺垫、声音或画面证据差必须降分。"
                "reason只写1到3条可核验的中文短理由。严格返回JSON对象："
                '{"candidates":[{"id":"...","hook":0,"engagement":0,'
                '"value":0,"shareability":0,"total":0,"reason":["..."]}]}。'
                "候选数据：" + json.dumps(safe_candidates, ensure_ascii=False, separators=(",", ":"))
            )
        else:
            prompt = (
                "你是短视频课程内容主编。只依据转写文本评价候选片段，不得虚构。"
                "主题是：" + str(theme)[:100] + "。"
                "请为每个候选分别给出0到1之间的 opening_hook（前5秒是否吸引人）、"
                "standalone_value（脱离上下文仍有明确收获）、content_completeness（观点是否完整）、"
                "language_quality（口头语少且连贯）、theme_relevance（与主题贴合度）。"
                "不要因为文字多就给高分；从半句话开始、只有铺垫、重复内容必须降分。"
                "reason只写1到3条可核验的中文短理由。严格返回JSON对象："
                '{"candidates":[{"id":"...","opening_hook":0.0,'
                '"standalone_value":0.0,"content_completeness":0.0,'
                '"language_quality":0.0,"theme_relevance":0.0,"reason":["..."]}]}。'
                "候选数据：" + json.dumps(safe_candidates, ensure_ascii=False, separators=(",", ":"))
            )
        response = self._request_json(
            f"{self.compatible_origin}/chat/completions",
            method="POST",
            payload={
                "model": self.selection_model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.1,
                "response_format": {"type": "json_object"},
            },
        )
        choices = response.get("choices") or []
        if not choices:
            raise ContentEngineError("cloud_response_invalid", "百炼未返回课程选段结果。")
        parsed = _safe_json_object(str(choices[0].get("message", {}).get("content") or ""))
        results = []
        allowed_ids = {item["id"] for item in safe_candidates if item["id"]}
        for item in parsed.get("candidates") or []:
            if not isinstance(item, dict) or str(item.get("id") or "") not in allowed_ids:
                continue
            normalized = {"id": str(item["id"])}
            fields = (
                ("hook", "engagement", "value", "shareability", "total")
                if is_supoclip_experiment
                else (
                    "opening_hook",
                    "standalone_value",
                    "content_completeness",
                    "language_quality",
                    "theme_relevance",
                )
            )
            for field in fields:
                value = item.get(field)
                if (
                    isinstance(value, (int, float))
                    and not isinstance(value, bool)
                    and math.isfinite(float(value))
                ):
                    maximum = (
                        100.0
                        if field == "total"
                        else 25.0
                        if is_supoclip_experiment
                        else 1.0
                    )
                    normalized[field] = max(0.0, min(maximum, float(value)))
            normalized["reason"] = [
                str(reason).strip()[:60]
                for reason in (item.get("reason") or [])[:3]
                if str(reason).strip()
            ]
            results.append(normalized)
        return results


class FFmpegCreativeAnalyzer:
    def __init__(
        self,
        data_dir: Path,
        *,
        ffmpeg_path: str | None = None,
        cloud_client: DashScopeMediaClient | None = None,
        command_runner=subprocess.run,
    ):
        self.data_dir = Path(data_dir).resolve()
        self.ffmpeg_path = ffmpeg_path or discover_media_executable(
            "ffmpeg", "XIAOXI_FFMPEG_PATH"
        )
        self.cloud_client = cloud_client or DashScopeMediaClient()
        self._run_process = command_runner

    @property
    def capability(self):
        return {
            "available": bool(self.ffmpeg_path),
            "cloud_configured": self.cloud_client.configured,
            "provider": "bailian" if self.cloud_client.configured else "local_baseline",
        }

    def _command(self, args, timeout=2 * 60 * 60):
        if not self.ffmpeg_path:
            raise ContentEngineError("media_tools_unavailable", "FFmpeg is required for analysis.")
        try:
            result = self._run_process(
                list(args),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
                shell=False,
                **_windows_process_options(),
            )
        except subprocess.TimeoutExpired as error:
            raise ContentEngineError("analysis_timeout", "素材分析超时。") from error
        if result.returncode != 0:
            raise ContentEngineError("analysis_failed", (result.stderr or "FFmpeg failed")[-2_000:])

    def rank_course_windows(self, windows, theme, *, experiment_mode=None):
        candidates = [
            {
                "id": item.get("signature"),
                "start_ms": item.get("start_ms"),
                "end_ms": item.get("end_ms"),
                "duration_ms": item.get("duration_ms"),
                "transcript": item.get("transcript"),
                "visual": [
                    {
                        "shot_type": segment.get("shot_type"),
                        "tags": segment.get("tags") or [],
                        "quality": segment.get("quality_score"),
                        "visual_caption": (segment.get("metadata") or {}).get("visual_caption"),
                    }
                    for segment in item.get("segments") or []
                ],
            }
            for item in windows
        ]
        return self.cloud_client.rank_course_candidates(
            candidates, theme, experiment_mode=experiment_mode
        )

    def analyze(self, *, asset, source_path, task_id, profile, should_stop):
        if not self.capability["available"]:
            raise ContentEngineError("media_tools_unavailable", "FFmpeg is required for analysis.")
        source = Path(source_path)
        profile = profile if isinstance(profile, dict) else {}
        version_seed = {
            "base": DEFAULT_ANALYSIS_VERSION,
            "fingerprint": asset["fingerprint"],
            "provider": self.capability["provider"],
            "asr_model": self.cloud_client.asr_model,
            "vision_model": self.cloud_client.vision_model,
            "profile": profile,
        }
        analysis_version = hashlib.sha256(_json_bytes(version_seed)).hexdigest()[:24]
        final_dir = self.data_dir / "derivatives" / asset["id"] / analysis_version
        temp_dir = self.data_dir / "analysis-temp" / task_id / asset["id"]
        if final_dir.is_dir():
            cached = self._read_manifest(final_dir, analysis_version)
            if cached is not None:
                shutil.rmtree(temp_dir, ignore_errors=True)
                return {**cached, "reuse_existing": True}
        shutil.rmtree(temp_dir, ignore_errors=True)
        temp_dir.mkdir(parents=True, exist_ok=True)
        try:
            if should_stop():
                return {"stopped": True}
            duration_ms = int(asset["duration_ms"] or 0)
            derivatives = []
            if asset["media_kind"] == "video":
                proxy = temp_dir / "proxy.mp4"
                self._command(
                    [
                        self.ffmpeg_path,
                        "-y",
                        "-i",
                        str(source),
                        "-vf",
                        "fps=30,scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280",
                        "-an",
                        "-c:v",
                        "libx264",
                        "-preset",
                        "veryfast",
                        "-crf",
                        "28",
                        "-pix_fmt",
                        "yuv420p",
                        "-movflags",
                        "+faststart",
                        str(proxy),
                    ]
                )
                derivatives.append(self._derivative("proxy", proxy))
                if asset["has_audio"]:
                    audio = temp_dir / "speech.wav"
                    self._command(
                        [
                            self.ffmpeg_path,
                            "-y",
                            "-i",
                            str(source),
                            "-vn",
                            "-ac",
                            "1",
                            "-ar",
                            "16000",
                            "-c:a",
                            "pcm_s16le",
                            str(audio),
                        ]
                    )
                    derivatives.append(self._derivative("audio", audio))
                frames = self._extract_frames(source, temp_dir, duration_ms)
                derivatives.extend(
                    self._derivative("keyframe", item["path"], index, {"timestamp_ms": item["timestamp_ms"]})
                    for index, item in enumerate(frames)
                )
            else:
                frame_path = temp_dir / "frame-000.jpg"
                self._command(
                    [
                        self.ffmpeg_path,
                        "-y",
                        "-i",
                        str(source),
                        "-frames:v",
                        "1",
                        "-vf",
                        "scale=720:-2",
                        str(frame_path),
                    ]
                )
                frames = [{"path": frame_path, "timestamp_ms": 0}]
                derivatives.append(self._derivative("keyframe", frame_path, 0, {"timestamp_ms": 0}))
                duration_ms = 3_000
            if should_stop():
                return {"stopped": True}
            sentences = []
            audio_path = temp_dir / "speech.wav"
            if audio_path.is_file() and self.cloud_client.configured:
                sentences = self.cloud_client.transcribe(audio_path, should_stop)
            visual = self.cloud_client.understand_frames(frames) if self.cloud_client.configured else []
            segments = self._segments(duration_ms, sentences, visual, frames)
            srt = temp_dir / "transcript.srt"
            if sentences:
                srt.write_text(self._srt(sentences), encoding="utf-8")
                derivatives.append(self._derivative("srt", srt))
            manifest = self._manifest_payload(
                analysis_version=analysis_version,
                provider=self.capability["provider"],
                derivatives=derivatives,
                segments=segments,
            )
            manifest_temp = temp_dir / f".{ANALYSIS_MANIFEST_NAME}.tmp"
            manifest_temp.write_text(
                json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            os.replace(manifest_temp, temp_dir / ANALYSIS_MANIFEST_NAME)
            final_dir.parent.mkdir(parents=True, exist_ok=True)
            if final_dir.exists():
                shutil.rmtree(final_dir)
            temp_dir.replace(final_dir)
            completed = self._read_manifest(final_dir, analysis_version)
            if completed is None:
                raise ContentEngineError(
                    "analysis_failed", "Analysis cache manifest is invalid."
                )
            return completed
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    def _extract_frames(self, source, temp_dir, duration_ms):
        count = min(12, max(3, int(duration_ms / 60_000) + 3))
        if duration_ms <= 0:
            timestamps = [0]
        else:
            timestamps = [int(duration_ms * (index + 1) / (count + 1)) for index in range(count)]
        frames = []
        for index, timestamp in enumerate(timestamps):
            output = temp_dir / f"frame-{index:03d}.jpg"
            self._command(
                [
                    self.ffmpeg_path,
                    "-y",
                    "-ss",
                    f"{timestamp / 1000:.3f}",
                    "-i",
                    str(source),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=480:-2",
                    "-q:v",
                    "3",
                    str(output),
                ],
                timeout=300,
            )
            frames.append({"path": output, "timestamp_ms": timestamp})
        return frames

    @staticmethod
    def _derivative(kind, path, ordinal=0, metadata=None):
        return {
            "kind": kind,
            "ordinal": ordinal,
            "relative_path": str(path),
            "metadata": metadata or {},
        }

    @staticmethod
    def _manifest_payload(*, analysis_version, provider, derivatives, segments):
        return {
            "schema_version": 1,
            "analysis_version": analysis_version,
            "provider": str(provider or "local")[:64],
            "derivatives": [
                {
                    "kind": str(item.get("kind") or ""),
                    "ordinal": int(item.get("ordinal") or 0),
                    "file_name": Path(str(item.get("relative_path") or "")).name,
                    "metadata": item.get("metadata") or {},
                }
                for item in derivatives
            ],
            "segments": segments,
        }

    def _read_manifest(self, final_dir, expected_version):
        manifest_path = final_dir / ANALYSIS_MANIFEST_NAME
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if (
                not isinstance(manifest, dict)
                or manifest.get("schema_version") != 1
                or manifest.get("analysis_version") != expected_version
                or not isinstance(manifest.get("provider"), str)
                or not isinstance(manifest.get("derivatives"), list)
                or not isinstance(manifest.get("segments"), list)
            ):
                return None
            derivatives = []
            for item in manifest["derivatives"]:
                if not isinstance(item, dict):
                    return None
                kind = item.get("kind")
                ordinal = item.get("ordinal")
                file_name = item.get("file_name")
                metadata = item.get("metadata")
                if (
                    kind not in {"proxy", "audio", "keyframe", "srt"}
                    or not isinstance(ordinal, int)
                    or isinstance(ordinal, bool)
                    or not isinstance(file_name, str)
                    or not file_name
                    or Path(file_name).name != file_name
                    or not isinstance(metadata, dict)
                ):
                    return None
                if kind in {"proxy", "audio", "srt"} and ordinal != 0:
                    return None
                derivative_path = final_dir / file_name
                if not derivative_path.is_file():
                    return None
                derivatives.append(
                    {
                        "kind": kind,
                        "ordinal": ordinal,
                        "relative_path": str(derivative_path.relative_to(self.data_dir)),
                        "metadata": metadata,
                    }
                )
            for segment in manifest["segments"]:
                if not isinstance(segment, dict):
                    return None
                start = segment.get("start_ms")
                end = segment.get("end_ms")
                if (
                    not isinstance(start, int)
                    or isinstance(start, bool)
                    or not isinstance(end, int)
                    or isinstance(end, bool)
                    or end <= start
                    or not isinstance(segment.get("metadata") or {}, dict)
                ):
                    return None
            return {
                "analysis_version": expected_version,
                "provider": manifest["provider"],
                "derivatives": derivatives,
                "segments": manifest["segments"],
            }
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError):
            return None

    @staticmethod
    def _segments(duration_ms, sentences, visual, frames):
        if sentences:
            base = sentences
        else:
            step = 15_000
            base = [
                {
                    "start_ms": start,
                    "end_ms": min(duration_ms, start + step),
                    "transcript": "",
                    "speaker": "",
                    "metadata": {"sentence_complete": False},
                }
                for start in range(0, max(duration_ms, 1), step)
                if min(duration_ms, start + step) > start
            ]
        results = []
        for index, sentence in enumerate(base):
            midpoint = (sentence["start_ms"] + sentence["end_ms"]) // 2
            closest = min(
                visual,
                key=lambda item: abs(int(item.get("timestamp_ms") or 0) - midpoint),
                default={},
            )
            if closest:
                role = str(closest.get("role") or "general")
            else:
                ratio = midpoint / max(duration_ms, 1)
                role = "hook" if ratio < 0.2 else "result" if ratio > 0.8 else "process"
            if role not in {"hook", "process", "result", "general"}:
                role = "general"
            quality = closest.get("quality", 0.62 if sentence.get("transcript") else 0.52)
            try:
                quality = min(1.0, max(0.0, float(quality)))
            except (TypeError, ValueError):
                quality = 0.5
            results.append(
                {
                    **sentence,
                    "role": role,
                    "shot_type": str(closest.get("shot_type") or "unknown")[:64],
                    "tags": [str(tag)[:64] for tag in (closest.get("tags") or [])[:20]],
                    "quality_score": quality,
                    "metadata": {
                        **(sentence.get("metadata") or {}),
                        "visual_caption": str(closest.get("caption") or "")[:500],
                        "keyframe_ordinal": min(index, max(0, len(frames) - 1)),
                    },
                }
            )
        return results

    @staticmethod
    def _srt(sentences):
        def stamp(milliseconds):
            hours, remainder = divmod(milliseconds, 3_600_000)
            minutes, remainder = divmod(remainder, 60_000)
            seconds, millis = divmod(remainder, 1_000)
            return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"

        return "\n\n".join(
            f"{index}\n{stamp(item['start_ms'])} --> {stamp(item['end_ms'])}\n{item['transcript']}"
            for index, item in enumerate(sentences, 1)
        ) + "\n"
