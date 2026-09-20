from pathlib import Path

import pytest
from PIL import Image

import offline_cutout


def test_transparent_product_preserved_without_model(tmp_path, monkeypatch):
    monkeypatch.setenv("XIAOXI_CUTOUT_MODEL_DIR", str(tmp_path / "absent"))
    source = tmp_path / "input.png"
    destination = tmp_path / "output.png"
    original = Image.new("RGBA", (8, 8), (255, 255, 255, 0))
    original.paste((200, 80, 30, 255), (2, 2, 6, 6))
    original.save(source)
    assert offline_cutout.remove_background(source, destination) == "already_transparent"
    with Image.open(destination) as output:
        assert output.tobytes() == original.tobytes()


def test_missing_model_fails_without_network_or_output(tmp_path, monkeypatch):
    monkeypatch.setenv("XIAOXI_CUTOUT_MODEL_DIR", str(tmp_path / "absent"))
    source = tmp_path / "input.png"
    destination = tmp_path / "output.png"
    Image.new("RGB", (8, 8), "white").save(source)
    with pytest.raises(RuntimeError, match="CUTOUT_MODEL_UNAVAILABLE"):
        offline_cutout.remove_background(source, destination)
    assert not destination.exists()
