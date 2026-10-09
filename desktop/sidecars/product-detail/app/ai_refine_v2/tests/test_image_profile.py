"""A new model must not silently alter an already purchased task."""
import json
from unittest.mock import Mock

import pytest
from PIL import Image

import ai_image_apimart as adapter
from ai_refine_v2 import pipeline_runner as runner, pricing, refine_generator, refine_planner
from ai_refine_v2.image_profile import DEFAULT_PROFILE, LEGACY_PROFILE
from ai_refine_v2.tests.test_product_driven_planning import TEXT, sample, make_parent
from ai_refine_v2.tests.test_pricing_boundary import quote

READ_QUOTE = pricing.read_quote


def test_ext_price_uses_version_and_resolution_without_account_discount(monkeypatch):
    monkeypatch.setenv("REFINE_API_BASE_URL", "https://api.apimart.ai/v1")
    payload = {"success": True, "data": {
        "model_name": "gpt-image-2.5-ext",
        "billing_type": "version_resolution",
        "version_resolution_prices": {"sunburst": {"1K": .010625, "2K": .0175}, "flare": {"2K": .01}},
        "resolution_prices": {"2K": .001}, "group_ratio": .8,
    }}
    urls = []
    def read(url):
        urls.append(url)
        return json.dumps(payload)
    result = READ_QUOTE(include_planner=False, image_profile=DEFAULT_PROFILE, read=read)
    assert result["image_unit_cny"] == .14
    assert result["image_version"] == "sunburst" and result["image_resolution"] == "2K"
    assert urls == ["https://apimart.ai/api/pricing/model?model=gpt-image-2.5-ext"]
    del payload["data"]["version_resolution_prices"]["sunburst"]["2K"]
    with pytest.raises(pricing.PricingRequired):
        READ_QUOTE(include_planner=False, image_profile=DEFAULT_PROFILE, read=read)


@pytest.mark.parametrize("stored_profile", [None, DEFAULT_PROFILE])
def test_actual_payload_and_normal_receipt_are_frozen_and_not_an_rmb_bill(tmp_path, monkeypatch, stored_profile):
    monkeypatch.setenv("REFINE_API_BASE_URL", "https://api.apimart.ai/v1")
    monkeypatch.delenv("XIAOXI_PROVIDER_GATEWAY_ORIGIN", raising=False)
    payloads = []
    def post(url, payload, key, **kwargs):
        payloads.append(payload)
        return 200, {"data": [{"task_id": "original"}]}
    monkeypatch.setattr(adapter, "_http_post_json", post)
    monkeypatch.setattr(adapter, "_http_get_json", lambda *args, **kwargs: {"data": {
        "status": "completed", "cost": .014, "credits_cost": .14,
        "usage": {"output_tokens": 123, "input_tokens_details": {"image_tokens": 12}, "api_key": "secret-not-numeric"},
        "result": {"images": [{"url": ["https://example.invalid/generated.png"]}]},
    }})
    selected = stored_profile or LEGACY_PROFILE
    quoted = {**quote(), **{f"image_{key}": value for key, value in selected.items()}}
    ledger = pricing.CostJournal(tmp_path)
    ledger.set_plan(quoted, 1)
    ledger.image_call(quoted, adapter.default_api_call, "原图卖点", "https://example.invalid/reference.png", "secret",
                      image_profile=stored_profile, block_id="hero")
    request = payloads[0]
    assert request["model"] == selected["model"]
    assert request["resolution"] == ("2K" if stored_profile else "1k")
    assert request.get("version") == selected.get("version")
    assert request["n"] == 1 and "quality" not in request and "thinking" not in request
    receipt = ledger.load()["operations"]["image:1"]["provider_receipt"]
    assert receipt["cost"] == .014 and receipt["credits_cost"] == .14
    assert receipt["usage"]["output_tokens"] == 123
    assert "secret-not-numeric" not in ledger.path.read_text(encoding="utf-8")
    assert ledger.summary()["actual_cny"] is None


@pytest.mark.parametrize("legacy", [False, True])
def test_real_worker_reprices_and_submits_original_frozen_profile(tmp_path, monkeypatch, legacy):
    monkeypatch.setattr(runner, "_OUTPUT_BASE", tmp_path)
    monkeypatch.setattr(runner, "_TASKS", {})
    monkeypatch.setenv("V2_ALLOW_REAL_API", "true")
    directory = tmp_path / "profile-task"
    directory.mkdir()
    reference = tmp_path / "reference.png"
    Image.new("RGB", (80, 80), "#78ab12").save(reference)
    if legacy:
        runner._atomic_write_json(directory / "_input.json", {"product_text": TEXT})
    expected = LEGACY_PROFILE if legacy else DEFAULT_PROFILE
    quotes = []
    def read_quote(**kwargs):
        assert runner._read_json(directory / "_input.json")["image_profile"] == expected
        assert kwargs["image_profile"] == expected
        quotes.append(kwargs)
        if len(quotes) == 1:
            raise pricing.PricingRequired("first quote unavailable")
        return {**quote(), **{f"image_{key}": value for key, value in expected.items()}}
    monkeypatch.setattr(pricing, "read_quote", read_quote)
    monkeypatch.setattr(adapter, "upload_data_url", lambda *a, **kw: "https://example.invalid/ref.png")
    monkeypatch.setattr(refine_planner, "plan_v2", lambda **kw: sample())
    submitted = []
    def paid_call(*args, image_profile, lifecycle_callback, **kwargs):
        submitted.append(image_profile)
        lifecycle_callback({"event": "submitted", "provider_task_id": f"paid-{len(submitted)}"})
        return "https://example.invalid/image.png"
    monkeypatch.setattr(refine_generator, "_default_api_call", paid_call)
    def download(url, destination, **kwargs):
        Image.effect_noise((600, 800), 40).convert("RGB").save(destination)
        return "direct"
    monkeypatch.setattr(runner, "_download_image", download)
    runner._TASKS[directory.name] = runner.TaskState(task_id=directory.name, user_id=73)
    runner._worker_v2(directory.name, TEXT, str(reference), "产品", "planner-key", "image-key")
    assert runner.get_task_status(directory.name)["status"] == "pricing_required"
    assert not submitted
    runner._TASKS.clear()  # Simulated process restart before repricing.
    runner._worker_v2(directory.name, TEXT, str(reference), "产品", "planner-key", "image-key")
    state = runner.get_task_status(directory.name)
    assert state["status"] == "success", state.get("error")
    assert submitted == [expected] * len(sample()["screens"])
    assert (directory / "assembled.png").is_file()


@pytest.mark.parametrize("saved", [None, DEFAULT_PROFILE])
def test_reroll_inherits_profile_without_mutating_parent(tmp_path, monkeypatch, saved):
    parent, _ = make_parent(tmp_path, monkeypatch)
    inputs = runner._read_json(parent / "_input.json")
    if saved:
        runner._atomic_write_json(parent / "_input.json", {**inputs, "image_profile": saved})
    before = (parent / "_input.json").read_bytes()
    thread = Mock()
    monkeypatch.setattr(runner.threading, "Thread", thread)
    new_task = runner.start_screen_reroll(parent.name, 1, 7, "fake")
    assert runner._read_json(tmp_path / new_task / "_input.json")["image_profile"] == (saved or LEGACY_PROFILE)
    assert (parent / "_input.json").read_bytes() == before


def test_mismatched_quote_never_reserves_or_posts(tmp_path):
    ledger = pricing.CostJournal(tmp_path)
    ledger.set_plan(quote(), 1)
    paid = Mock()
    with pytest.raises(pricing.PricingRequired, match="核价不一致"):
        ledger.image_call(quote(), paid, image_profile=DEFAULT_PROFILE)
    paid.assert_not_called()
    assert ledger.load()["operations"] == {}
