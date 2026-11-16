"""我做过的详情图：list_task_history / task_thumbnail（2026-11-16）."""
import json

from PIL import Image

from ai_refine_v2 import pipeline_runner


def _task(base, name, *, user_id=1, title="", product="", blocks=None, assembled=True, summary=True,
          status="success", failed=0, reroll_of=""):
    task_dir = base / name
    task_dir.mkdir(parents=True)
    if summary:
        (task_dir / "_summary.json").write_text(json.dumps({
            "user_id": user_id,
            "terminal_status": status,
            "failed_count": failed,
            "product": product,
            "blocks": blocks if blocks is not None else [
                {"block_id": "screen_01_hero", "success": True, "file": "a.jpg", "image_url": f"/static/ai_refine_v2/{name}/a.jpg"},
                {"block_id": "screen_02_x", "success": True, "file": "b.jpg", "image_url": f"/static/ai_refine_v2/{name}/b.jpg"},
                {"block_id": "hero_square_1", "success": True, "file": "s.jpg", "image_url": f"/static/ai_refine_v2/{name}/s.jpg"},
            ],
            "assembled_url": f"/static/ai_refine_v2/{name}/assembled.png" if assembled else "",
        }), encoding="utf-8")
    (task_dir / "_input.json").write_text(json.dumps({"product_title": title, "product_category": "设备类"}), encoding="utf-8")
    if reroll_of:
        (task_dir / "_reroll.json").write_text(json.dumps({"source_task_id": reroll_of, "block_index": 1}), encoding="utf-8")
    return task_dir


def test_lists_own_tasks_with_images_newest_first(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline_runner, "_OUTPUT_BASE", tmp_path)
    _task(tmp_path, "v2_1791606532749_76d396", title="毛驴快跑S9")
    _task(tmp_path, "v2_1794212222735_e5ca36", product="坦虎工业吸尘器HX750B")
    _task(tmp_path, "v2_1794212222736_aaaaaa", user_id=2, title="别人的产品")
    _task(tmp_path, "v2_1794212222737_bbbbbb", title="没有图", blocks=[{"block_id": "x", "success": False}], assembled=False)
    _task(tmp_path, "v2_1794212222738_cccccc", title="还在生成", summary=False)
    (tmp_path / "not-a-task").mkdir()

    items = pipeline_runner.list_task_history(1)
    assert [item["product_name"] for item in items] == ["坦虎工业吸尘器HX750B", "毛驴快跑S9"]
    assert items[0]["screen_count"] == 2, "1:1 square images are not counted as screens"
    assert items[0]["finished"] is True and items[0]["has_long_image"] is True
    assert items[0]["thumbnail_url"] == "/api/ai-refine-v2/thumb/v2_1794212222735_e5ca36"
    assert "设备类" not in [item["product_name"] for item in items], "a specific name, never the category"


def test_unfinished_redo_and_damaged_records(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline_runner, "_OUTPUT_BASE", tmp_path)
    _task(tmp_path, "v2_1791000000000_aaaaaa", title="原版")
    _task(tmp_path, "v2_1792000000000_bbbbbb", title="原版", reroll_of="v2_1791000000000_aaaaaa")
    _task(tmp_path, "v2_1793000000000_cccccc", title="没做完", status="recovery_required", failed=2)
    damaged = _task(tmp_path, "v2_1794000000000_dddddd", title="坏记录")
    (damaged / "_summary.json").write_text(json.dumps({"user_id": 1, "blocks": [{"success": True, "image_url": "x"}], "failed_count": "两屏"}), encoding="utf-8")

    items = pipeline_runner.list_task_history(1)
    assert [item["task_id"] for item in items] == ["v2_1793000000000_cccccc", "v2_1792000000000_bbbbbb"], \
        "the redo replaces the version it was made from; a damaged record is skipped"
    assert items[0]["finished"] is False and items[0]["has_long_image"] is False


def test_other_users_tasks_are_admin_only(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline_runner, "_OUTPUT_BASE", tmp_path)
    _task(tmp_path, "v2_1794212222736_aaaaaa", user_id=2, title="别人的产品")
    assert pipeline_runner.list_task_history(1) == []
    assert [item["product_name"] for item in pipeline_runner.list_task_history(1, is_admin=True)] == ["别人的产品"]
    assert pipeline_runner.task_thumbnail("v2_1794212222736_aaaaaa", 1) is None


def test_thumbnail_is_small_and_cached(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline_runner, "_OUTPUT_BASE", tmp_path)
    task_dir = _task(tmp_path, "v2_1794212222735_e5ca36", title="坦虎")
    Image.new("RGB", (750, 1000), (200, 30, 30)).save(task_dir / "a.jpg")
    thumb = pipeline_runner.task_thumbnail("v2_1794212222735_e5ca36", 1)
    assert thumb == task_dir / "_thumb.jpg"
    with Image.open(thumb) as image:
        assert max(image.size) <= 160
    assert pipeline_runner.task_thumbnail("../../etc", 1) is None


def test_missing_output_folder_is_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline_runner, "_OUTPUT_BASE", tmp_path / "missing")
    assert pipeline_runner.list_task_history(1) == []
