"""1:1 e-commerce squares are made locally from a finished task, without AI calls."""
import json

from PIL import Image

from ai_refine_v2 import square_set


def _task(tmp_path, with_spec=True):
    task = tmp_path / "v2_task"
    task.mkdir()
    photo = tmp_path / "photo_nobg.png"
    product = Image.new("RGBA", (400, 300), (0, 0, 0, 0))
    product.paste((200, 30, 30, 255), (100, 50, 300, 250))
    product.save(photo)
    roles = ["hero", "feature_wall", "lifestyle_demo"] + (["spec_table"] if with_spec else [])
    blocks, screens = [], []
    for idx, role in enumerate(roles, 1):
        name = f"block_{idx:02d}_{role}.jpg"
        Image.new("RGB", (900, 1200), (idx * 40, 120, 200)).save(task / name)
        blocks.append({"idx": idx, "file": name, "success": True})
        screens.append({"idx": idx, "role": role})
    (task / "_summary.json").write_text(json.dumps({"blocks": blocks}), encoding="utf-8")
    (task / "_planning.json").write_text(json.dumps({"screens": screens}), encoding="utf-8")
    (task / "_input.json").write_text(json.dumps({"product_image_url": str(photo)}), encoding="utf-8")
    return task


def test_four_squares_are_built_from_existing_screens(tmp_path):
    task = _task(tmp_path)
    images = square_set.build(task)
    assert [i["kind"] for i in images] == ["white", "main", "scene", "spec"]
    assert all(i["url"] for i in images)
    for kind in ("white", "main", "scene", "spec"):
        with Image.open(task / f"square_{kind}.jpg") as square:
            assert square.size == (1200, 1200)
    with Image.open(task / "square_white.jpg") as white:
        assert white.getpixel((5, 5)) == (255, 255, 255), "plain white background"
    with Image.open(task / "square_scene.jpg") as scene:
        # The person scene (block 3) sits whole in the middle: its colour is at the centre.
        assert abs(scene.getpixel((600, 600))[0] - 120) < 12


def test_missing_parameter_screen_is_reported_not_invented(tmp_path):
    task = _task(tmp_path, with_spec=False)
    spec = square_set.build(task)[-1]
    assert spec["url"] is None and "参数" in spec["reason"]


def test_product_photo_outside_the_upload_folder_is_not_read(tmp_path):
    task = _task(tmp_path)
    uploads = tmp_path / "uploads" / "1"
    uploads.mkdir(parents=True)
    white = square_set.build(task, uploads_root=uploads)[0]
    assert white["url"] is None and not (task / "square_white.jpg").exists()


def test_bad_block_numbers_do_not_break_the_set(tmp_path):
    task = _task(tmp_path)
    summary = json.loads((task / "_summary.json").read_text(encoding="utf-8"))
    summary["blocks"][0]["idx"] = "first"
    (task / "_summary.json").write_text(json.dumps(summary), encoding="utf-8")
    assert [i["kind"] for i in square_set.build(task)] == ["white", "main", "scene", "spec"]


def test_ai_generated_squares_are_used_as_they_are(tmp_path):
    task = _task(tmp_path)
    summary = json.loads((task / "_summary.json").read_text(encoding="utf-8"))
    Image.new("RGB", (1024, 1024), (10, 200, 10)).save(task / "block_05_screen_05_square_main.jpg")
    summary["blocks"] += [{"idx": 5, "block_id": "screen_05_square_main", "file": "block_05_screen_05_square_main.jpg", "success": True},
                          {"idx": 6, "block_id": "screen_06_square_scene", "file": "block_06_screen_06_square_scene.jpg", "success": False}]
    (task / "_summary.json").write_text(json.dumps(summary), encoding="utf-8")
    images = {i["kind"]: i for i in square_set.build(task)}
    assert images["main"]["url"].split("?")[0].endswith("block_05_screen_05_square_main.jpg")
    assert images["main"]["block_index"] == 4
    assert images["scene"]["url"] is None and images["scene"]["block_index"] == 5 and "重做" in images["scene"]["reason"]
    assert images["spec"]["url"] is None and "参数" in images["spec"]["reason"], "a newer task never falls back to the blurred layout"
    assert images["white"]["url"], "the white square is always made locally"
