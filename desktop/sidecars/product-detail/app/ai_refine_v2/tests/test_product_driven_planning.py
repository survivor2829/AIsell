"""Product evidence -> one image per point, plus original-receipt redo recovery."""
import copy
import json
import os
from pathlib import Path
from unittest.mock import Mock

import pytest
from PIL import Image

from ai_refine_v2 import refine_planner as planner, refine_generator as generator, pipeline_runner as runner

TEXT = "清洁机器人适用于办公楼。自动洗地。自动回充。清洁宽度500mm。"
GUARD = (
    "DO NOT INVENT any brand logos, company names, trademarks, certifications, "
    "or printed text NOT VISIBLE in Image 1. PRESERVE all existing labels, stickers, "
    "model markings, printed text exactly as shown in Image 1 (faithful to position, color, content). "
    "NO 「」-quoted headlines should be added ONTO the product surface itself."
)


def sample(with_specs=True):
    points = [{"id": "p1", "text": "自动洗地", "evidence": ["自动洗地"]},
              {"id": "p2", "text": "自动回充", "evidence": ["自动回充"]}]
    screens = [{"idx": 1, "role": "hero", "title": "清洁机器人", "subtitle": "办公楼日常清洁", "selling_point_id": None, "evidence": ["清洁机器人适用于办公楼"]}]
    screens += [{"idx": i + 2, "role": "scenario", "title": p["text"], "subtitle": "", "selling_point_id": p["id"], "evidence": p["evidence"]} for i, p in enumerate(points)]
    specs = [{"name": "清洁宽度", "value": "500mm", "evidence": "清洁宽度500mm"}] if with_specs else []
    if specs:
        screens.append({"idx": 4, "role": "spec_table", "title": "产品参数", "subtitle": "", "selling_point_id": None, "evidence": ["清洁宽度500mm"]})
    for screen in screens:
        screen["prompt"] = "Soft side lighting in a real office. Preserve the product from Image 1. One visual point, large bold headline and ample clear floor space. " + GUARD
    return {
        "planning_version": planner.PLANNING_VERSION,
        "product_meta": {"name": "清洁机器人", "category": "商用清洁", "primary_color": "Image 1 authoritative", "key_visual_parts": ["Follow reference image"]},
        "selling_points": points, "specifications": specs,
        "style_dna": {"rationale": "办公楼日常清洁用途，配合原图色彩形成清透现场感", "color_palette": "Light blue office tones with sampled green accents", "lighting": "Soft directional neutral light preserves product color", "composition_style": "One visual focus and broad margins for large Chinese type", "mood": "Approachable office environment", "typography_hint": "Large bold readable Chinese", "unified_visual_treatment": "Real office surfaces, airy spatial depth and repeatable lighting across all images"},
        "screen_count": len(screens), "screens": screens,
    }


def response(plan):
    return {"choices": [{"message": {"content": json.dumps(plan, ensure_ascii=False)}}]}


def test_new_plan_allows_same_role_preserves_points_and_optional_specs():
    for specs in (True, False):
        plan = sample(specs)
        assert planner._validate_schema_v2(plan, TEXT) == []
        assert planner._repair_duplicate_roles_v2(plan) == plan
    plan = sample()
    plan["screens"][2]["selling_point_id"] = "p1"
    assert any("重复或遗漏" in warning for warning in planner._validate_schema_v2(plan, TEXT))
    plan = sample()
    plan["specifications"][0]["value"] = "900mm"
    assert any("参数值" in warning for warning in planner._validate_schema_v2(plan, TEXT))


def test_layout_percentages_are_not_performance_claims():
    plan = sample()
    plan["screens"][0]["prompt"] = "产品置于画面中央，占画面约55%，左右留白协调。" + plan["screens"][0]["prompt"]
    assert planner._validate_schema_v2(plan, TEXT) == []
    plan["screens"][0]["prompt"] += "清洁效率提升55%，除菌率99%，ISO 9001认证。"
    warnings = planner._validate_schema_v2(plan, TEXT)
    assert any("55%" in warning and "99%" in warning and "ISO 9001" in warning for warning in warnings)


def test_layout_regions_and_margins_do_not_hide_marketing_percentages():
    prompt = "画面上方约25%区域放标题，顶部约15%区域留空，留白约8%，清洁效率提升28%。"
    assert planner._find_unbacked_commercial_claims(prompt, TEXT, allow_layout=True) == ["28%"]
    assert set(planner._find_unbacked_commercial_claims(prompt, TEXT)) == {"25%", "15%", "8%", "28%"}


def test_spec_list_typography_preserves_facts():
    plan = sample()
    source = TEXT + "自主加排水。适用地面：瓷砖，水磨石，PVC。"
    plan["specifications"] += [
        {"name": "自主加排水", "value": "自主加排水", "evidence": "自主加排水"},
        {"name": "适用地面", "value": "瓷砖、水磨石、PVC", "evidence": "适用地面：瓷砖，水磨石，PVC"},
    ]
    assert planner._validate_schema_v2(plan, source) == []
    plan["specifications"][1]["value"] = "自动清洗"
    plan["specifications"][2]["value"] = "瓷砖、水磨石、PVC、实木"
    warnings = planner._validate_schema_v2(plan, source)
    assert any("specifications[1]" in warning for warning in warnings)
    assert any("specifications[2]" in warning for warning in warnings)


@pytest.mark.parametrize("source,evidence,allowed", [
    ("自主加排水", "自主加排水", False),
    ("不支持自主加排水", "自主加排水", False),
    ("自主加排水：支持但需配件", "自主加排水：支持", False),
    ("自主加排水：支持，但需配件", "自主加排水：支持", False),
    ("自主加排水：支持", "自主加排水：支持", True),
    ("自主加排水: 支持；其他参数", "自主加排水: 支持", True),
    ("自主加排水：支持，电压：24V", "自主加排水：支持", True),
])
def test_support_value_requires_an_explicit_complete_source_field(source, evidence, allowed):
    plan = sample()
    plan["specifications"].append({"name": "自主加排水", "value": "支持", "evidence": evidence})
    warnings = planner._validate_schema_v2(plan, TEXT + "\n" + source)
    assert (not any("specifications[1]" in warning for warning in warnings)) is allowed


def test_user_product_title_is_cover_evidence_only():
    plan = sample()
    title = "普渡清洁机器人 CC1 Pro"
    plan["screens"][0]["evidence"] = [title]
    assert planner._validate_schema_v2(plan, TEXT, product_title=title) == []
    assert any("逐字依据" in w for w in planner._validate_schema_v2(plan, TEXT))
    plan["selling_points"][0]["evidence"] = [title]
    assert any("selling_points[0]" in w for w in planner._validate_schema_v2(plan, TEXT, product_title=title))


@pytest.mark.parametrize("value,allowed", [("3–4H", True), ("3—4H", True), ("34H", False), ("35H", False)])
def test_parameter_typography_preserves_numeric_meaning(value, allowed):
    plan = sample()
    source = TEXT + "续航时间3-4H。充电时间3.5H。"
    plan["specifications"] = [{"name": "续航时间", "value": value, "evidence": "续航时间3-4H"}]
    plan["screens"][-1]["evidence"] = ["续航时间3-4H"]
    warnings = planner._validate_schema_v2(plan, source)
    assert (not any("参数值" in w for w in warnings)) is allowed
    assert planner._normalize_claim_text("3.5H") != planner._normalize_claim_text("35H")


@pytest.mark.parametrize("original,value,allowed", [
    ("12、24V", "1224V", False),
    ("12,24V", "1224V", False),
    ("12、24V", "12,24V", True),
    ("12,24V", "12、24V", True),
    ("1,000V", "1000V", False),
])
def test_parameter_numeric_enumerations_keep_value_boundaries(original, value, allowed):
    plan = sample()
    evidence = "额定电压：" + original
    plan["specifications"] = [{"name": "额定电压", "value": value, "evidence": evidence}]
    plan["screens"][-1]["evidence"] = [evidence]
    warnings = planner._validate_schema_v2(plan, TEXT + evidence)
    assert (not any("参数值" in warning for warning in warnings)) is allowed


def test_local_colors_are_hints_and_unsupported_evidence_retries(tmp_path, monkeypatch):
    reference = tmp_path / "product.png"
    Image.new("RGB", (80, 80), "#4ab125").save(reference)
    bad = sample()
    bad["selling_points"][0]["evidence"] = ["自动洗地，保证100%一次清洁"]
    calls = []
    def post(payload, key):
        calls.append(payload)
        return response(bad if len(calls) == 1 else sample())
    monkeypatch.setattr(planner.time, "sleep", lambda _: None)
    result = planner.plan_v2(TEXT, str(reference), api_key="fake", http_fn=post)
    assert len(calls) == 2
    prompt = calls[0]["messages"][1]["content"]
    assert "#4AB125" in prompt and str(reference) not in prompt
    assert "非视觉识别" in prompt
    assert result["input_evidence"]["product_text"] == TEXT
    assert "重复" in calls[1]["messages"][1]["content"]


def test_over_capacity_is_actionable_without_silent_truncation():
    post = Mock(return_value=response({"planning_version": planner.PLANNING_VERSION, "capacity_exceeded": True, "required_screen_count": 16}))
    with pytest.raises(planner.ProductInputError) as error:
        planner.plan_v2(TEXT, api_key="fake", http_fn=post)
    assert error.value.code == "AI_REFINE_TOO_MANY_SCREENS"
    assert post.call_count == 1


def test_every_new_image_gets_original_reference_and_shared_style(tmp_path):
    reference = tmp_path / "reference.png"
    Image.new("RGB", (40, 40), "#ab28c4").save(reference)
    calls = []
    def image_call(prompt, images, *args, **kwargs):
        calls.append((prompt, images))
        return "https://example.invalid/generated.png"
    result = generator.generate_v2(sample(), str(reference), api_key="fake", api_call_fn=image_call, cutout_whitelist=[], concurrency=1)
    assert len(result.blocks) == 4
    assert all(images.startswith("data:image/") for _, images in calls)
    assert all("Large bold" in prompt and "Real office surfaces" in prompt for prompt, _ in calls)
    assert all("grayscale" not in prompt for prompt, _ in calls)
    with pytest.raises(ValueError, match="参考图缺失"):
        generator.generate_v2(sample(), api_key="fake", api_call_fn=image_call)


def make_parent(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_OUTPUT_BASE", tmp_path)
    monkeypatch.setattr(runner, "_TASKS", {})
    monkeypatch.setenv("V2_ALLOW_REAL_API", "true")
    parent = tmp_path / "v2_original"
    parent.mkdir()
    plan = sample()
    blocks = []
    for index, screen in enumerate(plan["screens"]):
        filename = f"source_{index}.jpg"
        Image.frombytes("RGB", (400, 400), os.urandom(480000)).save(parent / filename, quality=95)
        blocks.append({"block_id": f"screen_{index + 1:02d}_{screen['role']}", "file": filename, "success": True, "image_url": f"/static/ai_refine_v2/v2_original/{filename}"})
    runner._atomic_write_json(parent / "_planning.json", plan)
    runner._atomic_write_json(parent / "_input.json", {"product_image_url": str(parent / "source_0.jpg")})
    runner._TASKS["v2_original"] = runner.TaskState(task_id="v2_original", user_id=7, status="success", blocks=blocks, planning=plan)
    return parent, plan


def test_reroll_unknown_recovers_original_provider_task_only(tmp_path, monkeypatch):
    import ai_image_apimart
    parent, plan = make_parent(tmp_path, monkeypatch)
    before = {p.name: p.read_bytes() for p in parent.iterdir()}
    real_thread = runner.threading.Thread
    thread = Mock()
    monkeypatch.setattr(runner.threading, "Thread", thread)
    calls = []
    def unknown(prompt, images, key, **kwargs):
        calls.append(prompt)
        kwargs["lifecycle_callback"]({"event": "submitted", "provider_task_id": "original_provider_id"})
        raise ai_image_apimart.APIMartOutcomeUnknown("original_provider_id", "poll timeout")
    monkeypatch.setattr(generator, "_default_api_call", unknown)
    task_id = runner.start_screen_reroll("v2_original", 2, 7, "fake")
    args = thread.call_args.kwargs["args"]
    monkeypatch.setattr(runner.threading, "Thread", real_thread)
    runner._reroll_worker(*args)
    assert runner.get_task_status(task_id)["status"] == "outcome_unknown"
    assert len(calls) == 1
    checked = []
    def poll(task, key, **kwargs):
        checked.append(task)
        return "https://example.invalid/recovered.jpg"
    monkeypatch.setattr(ai_image_apimart, "poll_image_task", poll)
    def download(url, destination, **kwargs):
        destination.write_bytes(before["source_2.jpg"])
        return "direct"
    monkeypatch.setattr(runner, "_download_image", download)
    state = runner._recover_task(task_id, "fake")
    assert state["status"] == "success" and len(state["blocks"]) == 4
    assert checked == ["original_provider_id"] and len(calls) == 1
    assert all(p.read_bytes() == before[p.name] for p in parent.iterdir())
    assert runner._read_json(tmp_path / task_id / "_planning.json") == plan
    assert (tmp_path / task_id / "assembled.png").is_file()


def test_reroll_rejects_unknown_parent_and_invalid_index(tmp_path, monkeypatch):
    make_parent(tmp_path, monkeypatch)
    with pytest.raises(ValueError, match="原方案"):
        runner.start_screen_reroll("v2_original", True, 7, "fake")
    runner._TASKS["v2_original"].status = "outcome_unknown"
    with pytest.raises(ValueError, match="结果不明"):
        runner.start_screen_reroll("v2_original", 1, 7, "fake")


def test_reroll_uses_validated_upload_when_stored_reference_is_missing(tmp_path, monkeypatch):
    parent, _ = make_parent(tmp_path, monkeypatch)
    runner._atomic_write_json(parent / "_input.json", {"product_image_url": str(tmp_path / "deleted.png")})
    reference = tmp_path / "uploaded-original.png"
    Image.new("RGB", (100, 100), "#43af8b").save(reference)
    thread = Mock()
    monkeypatch.setattr(runner.threading, "Thread", thread)
    task_id = runner.start_screen_reroll("v2_original", 1, 7, "fake", str(reference))
    assert thread.call_args.kwargs["args"][2] == str(reference)
    assert runner._read_json(tmp_path / task_id / "_input.json")["product_image_url"] == str(reference)
    assert runner._read_json(parent / "_input.json")["product_image_url"].endswith("deleted.png")


def test_single_simple_cover_is_not_rejected_by_old_eight_screen_byte_floor(tmp_path):
    from PIL import ImageDraw
    cover = Image.new("RGB", (600, 800), "white")
    ImageDraw.Draw(cover).rectangle((100, 200, 500, 600), fill="#43af8b")
    output = tmp_path / "assembled.png"
    cover.save(output)
    assert output.stat().st_size < 100_000
    assert runner._validate_assembled_png(output) == (600, 800)
