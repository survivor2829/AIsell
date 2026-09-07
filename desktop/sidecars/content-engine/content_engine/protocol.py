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
    "list_asset_collections": lambda service, params: service.list_asset_collections(),
    "save_asset_collection": lambda service, params: service.save_asset_collection(params),
    "list_narrated_batches": lambda service, params: service.list_narrated_batches(),
    "archive_narrated_batch": lambda service, params: service.archive_narrated_batch(params.get("batch_id")),
    "save_narrated_batch": lambda service, params: service.save_narrated_batch(params),
    "get_narrated_batch": lambda service, params: service.get_narrated_batch(params.get("batch_id")),
    "get_narrated_batch_status": lambda service, params: service.get_narrated_batch_status(params.get("batch_id")),
    "recommend_narrated_batch": lambda service, params: service.recommend_narrated_batch(params.get("batch_id")),
    "prepare_narrated_scripts": lambda service, params: service.prepare_narrated_scripts(params.get("batch_id")),
    "confirm_narrated_script": lambda service, params: service.confirm_narrated_script(params),
    "get_narrated_output_directory": lambda service, params: service.get_narrated_output_directory(params["batch_id"]),
    "preview_music_catalog_track": lambda service, params: service.preview_music_catalog_track(params.get("track_id")),
    "resolve_narrated_planning_outcome": lambda service, params: service.resolve_narrated_planning_outcome(params),
    "generate_narrated_samples": lambda service, params: service.generate_narrated_samples(params.get("batch_id")),
    "continue_narrated_batch": lambda service, params: service.continue_narrated_batch(params.get("batch_id")),
    "update_narrated_candidate": lambda service, params: service.update_narrated_candidate(params),
    "resolve_asset_preview": lambda service, params: service.resolve_asset_preview(params.get("asset_id"), params.get("variant", "thumbnail")),
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
    "analyze_assets": lambda service, params: service.analyze_assets(
        params.get("asset_ids"), params.get("profile")
    ),
    "list_media_segments": lambda service, params: service.list_media_segments(
        asset_id=params.get("asset_id"),
        role=params.get("role"),
        limit=params.get("limit", 2_000),
    ),
    "generate_course_cuts": lambda service, params: service.generate_course_cuts(
        params.get("asset_id"),
        min_duration_ms=params.get("min_duration_ms", 30_000),
        max_duration_ms=params.get("max_duration_ms", 90_000),
        count=params.get("count", 5),
        theme=params.get("theme", "培训现场价值"),
        subtitle_font_size=params.get("subtitle_font_size", 48),
        subtitle_margin_bottom=params.get("subtitle_margin_bottom", 170),
        experiment_mode=params.get("experiment_mode", "standard"),
        subtitle_preset=params.get("subtitle_preset", "dynamic_clean"),
        packaging_mode=params.get("packaging_mode", "auto"),
        packaging_preset_id=params.get("packaging_preset_id"),
        brand_profile_id=params.get("brand_profile_id"),
        cover_mode=params.get("cover_mode", "auto"),
        visual_renderer=params.get("visual_renderer"),
        confirm_paid_calls=params.get("confirm_paid_calls", False),
    ),
    "generate_mix_batch": lambda service, params: service.generate_mix_batch(
        params.get("asset_ids"),
        theme=params.get("theme", "培训现场价值"),
        target_count=params.get("target_count", 30),
        voice_asset_id=params.get("voice_asset_id"),
        pilot_mode=params.get("pilot_mode", False),
        packaging_mode=params.get("packaging_mode", "auto"),
        packaging_preset_id=params.get("packaging_preset_id"),
        brand_profile_id=params.get("brand_profile_id"),
        cover_mode=params.get("cover_mode", "auto"),
        visual_renderer=params.get("visual_renderer"),
        confirm_paid_calls=params.get("confirm_paid_calls", False),
    ),
    "create_one_click_project": lambda service, params: service.create_one_click_project(
        params.get("name"),
        params.get("asset_ids"),
        params.get("options"),
    ),
    "create_auto_mix_v2": lambda service, params: service.create_auto_mix_v2(params),
    "prepare_guided_auto_mix_v2": lambda service, params: service.prepare_guided_auto_mix_v2(
        params.get("asset_ids")
    ),
    "get_guided_auto_mix_session_v2": lambda service, params: service.get_guided_auto_mix_session_v2(
        session_id=params.get("session_id"), task_id=params.get("task_id")
    ),
    "generate_guided_auto_mix_script_v2": lambda service, params: service.generate_guided_auto_mix_script_v2(
        params.get("session_id"), params.get("title"), params.get("answers")
    ),
    "get_guided_auto_mix_supplemental_image_v2": lambda service, params: service.get_guided_auto_mix_supplemental_image_v2(
        params.get("session_id"), params.get("script_revision")
    ),
    "create_guided_auto_mix_supplemental_image_v2": lambda service, params: service.create_guided_auto_mix_supplemental_image_v2(
        params.get("session_id"),
        params.get("script_revision"),
        params.get("draft_hash"),
        confirm_paid_calls=params.get("confirm_paid_calls", False),
    ),
    "get_auto_mix_plan_v2": lambda service, params: service.get_auto_mix_plan_v2(
        project_id=params.get("project_id"), run_id=params.get("run_id")
    ),
    "regenerate_auto_mix_layer": lambda service, params: service.regenerate_auto_mix_layer(
        params.get("project_id"),
        params.get("layer"),
        expected_run_id=params.get("expected_run_id"),
    ),
    "import_music_catalog_track": lambda service, params: service.import_music_catalog_track(
        params
    ),
    "list_music_catalog_tracks": lambda service, params: service.list_music_catalog_tracks(),
    "list_auto_mix_voice_personas": lambda service, params: service.list_auto_mix_voice_personas(),
    "design_auto_mix_voice_persona": lambda service, params: service.design_auto_mix_voice_persona(
        params.get("voice_persona_id")
    ),
    "preview_auto_mix_voice_persona": lambda service, params: service.preview_auto_mix_voice_persona(
        params.get("voice_persona_id")
    ),
    "approve_auto_mix_voice_persona": lambda service, params: service.approve_auto_mix_voice_persona(
        params.get("voice_persona_id")
    ),
    "analyze_product_assets": lambda service, params: service.analyze_product_assets(
        params.get("project_id")
    ),
    "generate_product_copy": lambda service, params: service.generate_product_copy(
        params.get("project_id"), params.get("brief")
    ),
    "generate_product_voice": lambda service, params: service.generate_product_voice(
        params.get("project_id"), params.get("script_id")
    ),
    "generate_one_click_candidates": lambda service, params: service.generate_one_click_candidates(
        params.get("project_id"), params.get("options")
    ),
    "list_one_click_candidates": lambda service, params: service.list_one_click_candidates(
        params.get("project_id"), params.get("limit", 20)
    ),
    "list_packaging_presets": lambda service, params: service.list_packaging_presets(
        params.get("kind")
    ),
    "list_brand_profiles": lambda service, params: service.list_brand_profiles(),
    "save_brand_profile": lambda service, params: service.save_brand_profile(
        params.get("profile")
    ),
    "package_generated_videos": lambda service, params: service.package_generated_videos(
        params.get("candidate_ids"), params.get("options")
    ),
    "repackage_video": lambda service, params: service.repackage_video(
        params.get("candidate_id"), params.get("options")
    ),
    "preflight_visual_comparison": lambda service, params: service.preflight_visual_comparison(
        params.get("candidate_id")
    ),
    "create_visual_comparison_task": lambda service, params: service.create_visual_comparison_task(
        params.get("candidate_id")
    ),
    "get_packaging_cost_estimate": lambda service, params: service.get_packaging_cost_estimate(
        params.get("candidate_ids"),
        cover_mode=params.get("cover_mode", "auto"),
        planned_count=params.get("planned_count"),
        asset_ids=params.get("asset_ids"),
        generation_kind=params.get("generation_kind"),
    ),
    "record_media_review": lambda service, params: service.record_media_review(
        params.get("candidate_id"),
        device=params.get("device", "phone"),
        verdict=params.get("verdict", "pass"),
        reason=params.get("reason", ""),
        reviewer=params.get("reviewer", ""),
    ),
    "list_media_reviews": lambda service, params: service.list_media_reviews(
        params.get("candidate_id")
    ),
    "regenerate_cover": lambda service, params: service.regenerate_cover(
        params.get("candidate_id")
    ),
    "update_cover_operation": lambda service, params: service.update_cover_operation(
        params.get("cover_operation_id"),
        params.get("status"),
        external_task_id=params.get("external_task_id"),
        error_code=params.get("error_code"),
    ),
    "resume_creative_task": lambda service, params: service.resume_creative_task(
        params.get("task_id")
    ),
    "get_creative_project": lambda service, params: service.get_creative_project(
        params.get("project_id")
    ),
    "list_generated_videos": lambda service, params: service.list_generated_videos(
        project_id=params.get("project_id"),
        status=params.get("status"),
        limit=params.get("limit", 500),
    ),
    "regenerate_video": lambda service, params: service.regenerate_video(
        params.get("candidate_id")
    ),
    "reject_generated_video": lambda service, params: service.reject_generated_video(
        params.get("candidate_id")
    ),
    "queue_generated_videos": lambda service, params: service.queue_generated_videos(
        params.get("candidate_ids"), params.get("channel")
    ),
    "resolve_generated_video_path": lambda service, params: service.resolve_generated_video_path(
        params.get("candidate_id"), params.get("variant", "video")
    ),
    "resolve_guided_auto_mix_supplemental_image_path": lambda service, params: service.resolve_guided_auto_mix_supplemental_image_path(
        params.get("operation_id")
    ),
    "create_mix_project": lambda service, params: service.create_mix_project(
        params.get("name"), params.get("slots"), params.get("constraints")
    ),
    "update_mix_project": lambda service, params: service.update_mix_project(
        params.get("project_id"),
        name=params.get("name"),
        slots=params.get("slots"),
        constraints=params.get("constraints"),
    ),
    "get_mix_project": lambda service, params: service.get_mix_project(
        params.get("project_id")
    ),
    "list_mix_projects": lambda service, params: service.list_mix_projects(
        limit=params.get("limit", 500)
    ),
    "calculate_mix_combinations": lambda service, params: service.calculate_mix_combinations(
        params.get("project_id")
    ),
    "generate_mix_candidates": lambda service, params: service.generate_mix_candidates(
        params.get("project_id"),
        limit=params.get("limit", 20),
        seed=params.get("seed"),
    ),
    "list_mix_candidates": lambda service, params: service.list_mix_candidates(
        project_id=params.get("project_id"),
        review_status=params.get("review_status"),
        limit=params.get("limit", 500),
    ),
    "review_mix_candidate": lambda service, params: service.review_mix_candidate(
        params.get("candidate_id"),
        params.get("review_status"),
        params.get("review_note"),
    ),
    "list_publish_queue": lambda service, params: service.list_publish_queue(
        status=params.get("status"), limit=params.get("limit", 500)
    ),
    "update_publish_queue_item": lambda service, params: service.update_publish_queue_item(
        params.get("queue_item_id"),
        params.get("status"),
        params.get("error_message"),
    ),
    "render_mix_candidate": lambda service, params: service.render_mix_candidate(
        params.get("candidate_id"),
        platforms=params.get("platforms"),
        title=params.get("title"),
        description=params.get("description"),
    ),
    "list_export_packages": lambda service, params: service.list_export_packages(
        candidate_id=params.get("candidate_id"),
        limit=params.get("limit", 500),
    ),
    "resolve_export_package_path": lambda service, params: service.resolve_export_package_path(
        params.get("package_id")
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
    visual_capability = service.creative_domain._visual_comparison_capability()
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
                "mix_projects": True,
                "mix_candidate_generation": True,
                "publish_queue": True,
                "mix_render": bool(service.mix_renderer.capability["available"]),
                "creative_analysis": bool(
                    service.creative_analyzer.capability["available"]
                ),
                "creative_cloud_analysis": bool(
                    service.creative_analyzer.capability["cloud_configured"]
                ),
                "creative_render": bool(
                    visual_capability["renderer_available"]
                ),
                "creative_packaging": True,
                "brand_profiles": True,
                "creative_cover": bool(service.creative_cover_client.configured),
                "remotion_packaging_v1": bool(
                    visual_capability["remotion_available"]
                ),
                "visual_comparison_v1": bool(
                    visual_capability["available"]
                ),
                "auto_mix_v2": True,
                "licensed_music_catalog_v1": True,
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
