import json

import pytest
from PIL import Image

from ai_refine_v2 import pipeline_runner, style_presets


def plan():
    dna = {"color_palette": "模型自己定的颜色", "mood": "随意"}
    quoted = json.dumps(dna, ensure_ascii=False)
    return {"style_dna": dna, "screens": [
        {"idx": 1, "prompt": "前文。整套设计：" + quoted + "。本页构图：{}"},
        {"idx": 2, "prompt": "整套设计：" + quoted},
    ]}


def test_choice_is_checked_and_blank_keeps_the_old_behaviour():
    assert style_presets.resolve(None) is None
    assert style_presets.resolve("") is None
    assert style_presets.resolve("premium") == "premium"
    with pytest.raises(ValueError):
        style_presets.resolve("nonsense")
    with pytest.raises(ValueError):
        style_presets.resolve(3)


def test_a_draw_lands_on_one_real_style():
    assert {style_presets.resolve("random") for _ in range(80)} == set(style_presets.PRESETS)


@pytest.mark.parametrize("style_id", sorted(style_presets.PRESETS))
def test_the_chosen_style_reaches_every_screen(style_id):
    source = plan()
    result = style_presets.apply(source, style_id)
    wanted = json.dumps(style_presets.PRESETS[style_id]["style_dna"], ensure_ascii=False)
    assert result["style_dna"] == style_presets.PRESETS[style_id]["style_dna"]
    assert all(wanted in screen["prompt"] and "模型自己定的颜色" not in screen["prompt"] for screen in result["screens"])
    assert "模型自己定的颜色" in source["screens"][0]["prompt"], "the caller's plan is not changed in place"


def test_a_prompt_that_does_not_quote_the_plan_still_gets_the_style():
    source = plan()
    source["screens"][1]["prompt"] = "模型自己写的提示词"
    result = style_presets.apply(source, "bright")
    assert json.dumps(style_presets.PRESETS["bright"]["style_dna"], ensure_ascii=False) in result["screens"][1]["prompt"]


def test_the_chosen_style_overrides_each_screen_scene():
    assert all(style_presets.STYLE_PRIORITY in screen["prompt"] for screen in style_presets.apply(plan(), "fresh")["screens"])


def test_no_style_leaves_the_plan_alone():
    source = plan()
    assert style_presets.apply(source, None) == source


def test_every_style_has_all_the_design_fields():
    for preset in style_presets.PRESETS.values():
        assert set(preset["style_dna"]) >= {"color_palette", "lighting", "composition_style", "mood", "typography_hint", "unified_visual_treatment"}


def test_the_long_image_ends_with_the_disclaimer(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline_runner, "_validate_assembled_png", lambda *args, **kwargs: None)
    for name, colour in (("a.png", (200, 30, 30)), ("b.png", (30, 30, 200))):
        Image.new("RGB", (800, 300), colour).save(tmp_path / name)
    blocks = [{"file": "a.png", "success": True, "block_id": "s1"}, {"file": "b.png", "success": True, "block_id": "s2"}]
    pipeline_runner._run_assembler_v2(tmp_path, blocks)
    with Image.open(tmp_path / "assembled.png") as image:
        assert image.width == 800 and image.height > 600, "a band is added below the screens"
        band = image.convert("RGB").crop((0, 600, 800, image.height))
        assert image.convert("RGB").getpixel((400, 599)) == (30, 30, 200), "the screens themselves are untouched"
        assert len(set(band.getdata())) > 2, "the band carries text, not a blank strip"


def test_a_font_problem_never_costs_the_paid_long_image(monkeypatch):
    import image_composer
    def broken(*args, **kwargs):
        raise OSError("no font")
    monkeypatch.setattr(image_composer, "_load_chinese_font", broken)
    assert pipeline_runner._disclaimer_band(800).width == 800


def test_style_is_frozen_for_recovery(tmp_path):
    pipeline_runner._freeze_task_input(tmp_path, {"product_title": "x", "product_style": "fresh"})
    pipeline_runner._freeze_task_input(tmp_path, {"product_title": "x"})
    assert json.loads((tmp_path / "_input.json").read_text(encoding="utf-8"))["product_style"] == "fresh"


def test_lively_is_commercial_not_cartoon_and_tech_is_light():
    # Customer feedback 2026-11-09: lively looked too cartoonish for a business, tech was too dark navy.
    bright = style_presets.PRESETS["bright"]["style_dna"]
    assert "不用卡通" in bright["unified_visual_treatment"] and "商业" in bright["composition_style"]
    assert "圆润" not in bright["typography_hint"] and "圆角信息卡片" not in bright["composition_style"]
    tech = style_presets.PRESETS["tech"]["style_dna"]
    assert tech["color_palette"].startswith("浅") and "不使用大面积深蓝" in tech["color_palette"]
    assert "深底" not in tech["typography_hint"] and "深蓝渐变" not in tech["unified_visual_treatment"]
