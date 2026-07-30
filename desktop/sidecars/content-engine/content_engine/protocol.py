from __future__ import annotations

import json
import math
import sys
from typing import Any

from . import __version__
from .errors import ContentEngineError
from .service import ContentEngineService

MAX_REQUEST_BYTES = 2 * 1024 * 1024


def _validate_json_numbers(value):
    if isinstance(value, float) and not math.isfinite(value):
        raise ContentEngineError("invalid_json", "The request is not valid JSON.")
    if isinstance(value, dict):
        for child in value.values():
            _validate_json_numbers(child)
    elif isinstance(value, list):
        for child in value:
            _validate_json_numbers(child)



METHODS = {
    "health": lambda service, params: service.health(),
    "import_files": lambda service, params: service.import_files(params.get("paths")),
    "import_folder": lambda service, params: service.import_folder(
        params.get("path"),
        recursive=params.get("recursive", True),
        batch_size=params.get("batch_size", 200),
    ),
    "resume_import_folder": lambda service, params: service.resume_import_folder(
        params.get("task_id"), batch_size=params.get("batch_size", 200)
    ),
    "list_assets": lambda service, params: service.list_assets(
        include_archived=params.get("include_archived", False),
        limit=params.get("limit", 500),
    ),
    "probe_asset": lambda service, params: service.probe_asset(
        params.get("asset_id")
    ),
    "probe_pending": lambda service, params: service.probe_pending(
        limit=params.get("limit", 10)
    ),
    "update_asset_rights": lambda service, params: service.update_asset_rights(
        params.get("asset_id"), params.get("rights_status")
    ),
    "archive_asset": lambda service, params: service.archive_asset(
        params.get("asset_id")
    ),
    "reveal_asset": lambda service, params: service.reveal_asset(
        params.get("asset_id")
    ),
    "resolve_asset_path": lambda service, params: service.resolve_asset_path(
        params.get("asset_id")
    ),
    "create_task": lambda service, params: service.create_task(
        params.get("task_type"), params.get("payload")
    ),
    "update_task": lambda service, params: service.update_task(
        params.get("task_id"),
        params.get("status"),
        progress=params.get("progress"),
        result=params.get("result"),
        error_code=params.get("error_code"),
        error_message=params.get("error_message"),
    ),
    "list_tasks": lambda service, params: service.list_tasks(
        status=params.get("status"), limit=params.get("limit", 500)
    ),
    "register_finished": lambda service, params: service.register_finished(
        params.get("output_path"),
        title=params.get("title"),
        task_id=params.get("task_id"),
        metadata=params.get("metadata"),
    ),
    "list_finished": lambda service, params: service.list_finished(
        limit=params.get("limit", 500)
    ),
    "resolve_finished_path": lambda service, params: service.resolve_finished_path(
        params.get("finished_video_id")
    ),
    "get_setting": lambda service, params: service.get_setting(
        params.get("key"), params.get("default")
    ),
    "set_setting": lambda service, params: service.set_setting(
        params.get("key"), params.get("value")
    ),
}


def _write_json_line(output, payload: dict[str, Any]) -> None:
    output.write(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
    )
    output.flush()


def serve_jsonl(
    service: ContentEngineService,
    *,
    input_stream=None,
    output_stream=None,
) -> None:
    input_stream = input_stream or sys.stdin
    output_stream = output_stream or sys.stdout
    _write_json_line(
        output_stream,
        {
            "type": "ready",
            "service": "content-engine",
            "version": __version__,
            "protocol_version": 1,
            "capabilities": {
                "asset_index": True,
                "asset_media_probe": bool(service.media_probe.available),
                "asset_rights": True,
                "task_recovery": True,
                "resumable_folder_import": True,
                "main_process_path_resolution": True,
                "finished_videos": True,
                "path_redaction": True,
            },
        },
    )

    for raw_line in input_stream:
        request_id = None
        should_shutdown = False
        try:
            if len(raw_line.encode("utf-8")) > MAX_REQUEST_BYTES:
                raise ContentEngineError(
                    "request_too_large", "The request exceeds the JSONL size limit."
                )
            request = json.loads(raw_line)
            if isinstance(request, dict):
                candidate_id = request.get("id")
                _validate_json_numbers(candidate_id)
                if candidate_id is not None and (
                    isinstance(candidate_id, bool)
                    or not isinstance(candidate_id, (str, int))
                ):
                    raise ContentEngineError(
                        "invalid_request", "id must be text or an integer."
                    )
                request_id = candidate_id
            _validate_json_numbers(request)
            if not isinstance(request, dict):
                raise ContentEngineError(
                    "invalid_request", "Each request must be a JSON object."
                )
            method = request.get("method")
            params = request.get("params", {})
            if not isinstance(params, dict):
                raise ContentEngineError("invalid_params", "params must be an object.")
            if method == "shutdown":
                result = {"status": "stopping"}
                should_shutdown = True
            else:
                handler = METHODS.get(method)
                if handler is None:
                    raise ContentEngineError(
                        "method_not_found", "The requested method is not available."
                    )
                result = handler(service, params)
            response = {"id": request_id, "ok": True, "result": result}
        except json.JSONDecodeError:
            response = {
                "id": request_id,
                "ok": False,
                "error": {
                    "code": "invalid_json",
                    "message": "The request is not valid JSON.",
                },
            }
        except ContentEngineError as error:
            response = {
                "id": request_id,
                "ok": False,
                "error": {"code": error.code, "message": error.message},
            }
        except Exception:
            response = {
                "id": request_id,
                "ok": False,
                "error": {
                    "code": "internal_error",
                    "message": "The content engine could not complete the request.",
                },
            }
        _write_json_line(output_stream, response)
        if should_shutdown:
            break
