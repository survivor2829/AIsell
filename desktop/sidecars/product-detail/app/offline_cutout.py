"""Local IS-Net inference. Never downloads models or imports training dependencies."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading

from PIL import Image, ImageOps
import numpy as np

CONFIG = json.loads((Path(__file__).parent / "cutout_model.json").read_text(encoding="utf-8"))
_session = None
_lock = threading.Lock()


def model_path():
    if getattr(sys, "frozen", False):
        return Path(__file__).parent / "models" / CONFIG["file"]
    return Path(os.environ.get("XIAOXI_CUTOUT_MODEL_DIR", str(Path(__file__).parents[3] / ".build" / "cutout-models"))) / CONFIG["file"]


def available():
    return model_path().is_file() and importlib.util.find_spec("onnxruntime") is not None


def remove_background(source, destination):
    global _session
    with Image.open(source) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGBA")
    alpha = np.asarray(image.getchannel("A"))
    if np.any(alpha < 250) and np.any(alpha > 200):
        image.save(destination, format="PNG")
        return "already_transparent"
    if not available():
        raise RuntimeError("CUTOUT_MODEL_UNAVAILABLE")
    # Serialize inference to keep memory bounded when uploads arrive together.
    with _lock:
        if _session is None:
            import onnxruntime as ort
            model = model_path()
            with model.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if digest != CONFIG["sha256"]:
                raise RuntimeError("CUTOUT_MODEL_INVALID")
            options = ort.SessionOptions()
            options.intra_op_num_threads = min(4, os.cpu_count() or 1)
            _session = ort.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"])
        size = CONFIG["inputSize"]
        pixels = np.asarray(image.convert("RGB").resize((size, size), Image.Resampling.LANCZOS), dtype=np.float32)
        pixels = pixels / max(float(pixels.max()), 1e-6) - 0.5
        tensor = pixels.transpose(2, 0, 1)[None, ...]
        prediction = _session.run(None, {_session.get_inputs()[0].name: tensor})[0][0, 0]
        low, high = float(prediction.min()), float(prediction.max())
        if not np.isfinite(prediction).all() or high - low < 1e-6:
            raise RuntimeError("CUTOUT_MASK_INVALID")
        mask = Image.fromarray(((prediction - low) / (high - low) * 255).clip(0, 255).astype(np.uint8))
        mask = mask.resize(image.size, Image.Resampling.LANCZOS)
        values = np.asarray(mask)
        if not np.any(values < 20) or not np.any(values > 235):
            raise RuntimeError("CUTOUT_MASK_INVALID")
        image.putalpha(mask)
        image.save(destination, format="PNG")
    return "completed"
