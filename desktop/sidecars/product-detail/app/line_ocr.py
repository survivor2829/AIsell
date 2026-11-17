"""One-line Chinese text reader for the WeChat touch title check.

Windows' built-in OCR read 26 of 64 field chat titles exactly (100% screens, 12-pixel text,
2026-11-17); the PP-OCRv4 recognition model read 58. Only the recognition half of PP-OCR is
used: the caller sends one line (the chat title band), so no detection model, OpenCV or
geometry library is needed beyond the onnxruntime, numpy and Pillow this runtime already has.

Served on loopback only, one token per run:
    product-detail-server.exe --line-ocr-serve
prints {"port": N} on stdout and reads the token from XIAOXI_LINE_OCR_TOKEN.
POST /read with a PNG body and header X-Xiaoxi-Token -> {"text": "...", "score": 0.97}.
"""
from __future__ import annotations

import hmac
import io
import json
import math
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODEL_CONFIG = json.loads((Path(__file__).with_name("line_ocr_model.json")).read_text(encoding="utf-8"))
MAX_BODY_BYTES = 8 * 1024 * 1024
LINE_HEIGHT = 48
MIN_WIDTH = 320


def model_path() -> Path:
    if getattr(sys, "frozen", False):
        return Path(__file__).parent / "models" / MODEL_CONFIG["file"]
    default = Path(__file__).parents[3] / ".build" / "line-ocr-models"
    return Path(os.environ.get("XIAOXI_LINE_OCR_MODEL_DIR", str(default))) / MODEL_CONFIG["file"]


def tight_line(image, pad_x: int = 8, pad_y: int = 6):
    """Crop to the text (anything clearly off the band's background colour) plus a margin.

    The band is mostly empty; recognition works on the text itself."""
    import numpy as np
    from PIL import Image

    rgb = image.convert("RGB")
    gray = np.asarray(rgb.convert("L")).astype(int)
    background = int(np.median(gray))
    mask = np.abs(gray - background) > 40
    cols = np.where(mask.any(axis=0))[0]
    rows = np.where(mask.any(axis=1))[0]
    if not len(cols) or not len(rows):
        return None
    box = (max(0, int(cols[0]) - 2), max(0, int(rows[0]) - 2),
           min(rgb.width, int(cols[-1]) + 3), min(rgb.height, int(rows[-1]) + 3))
    text = rgb.crop(box)
    out = Image.new("RGB", (text.width + 2 * pad_x, text.height + 2 * pad_y), (background,) * 3)
    out.paste(text, (pad_x, pad_y))
    return out


class LineRecognizer:
    def __init__(self, path: Path | None = None):
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        self.session = ort.InferenceSession(str(path or model_path()), options, providers=["CPUExecutionProvider"])
        characters = self.session.get_modelmeta().custom_metadata_map["character"].splitlines()
        self.characters = ["blank", *characters, " "]
        self.input_name = self.session.get_inputs()[0].name
        self.lock = threading.Lock()

    def read(self, image) -> tuple[str, float]:
        import numpy as np
        from PIL import Image

        line = tight_line(image)
        if line is None:
            return "", 0.0
        width = max(1, int(math.ceil(LINE_HEIGHT * line.width / max(1, line.height))))
        resized = line.resize((width, LINE_HEIGHT), Image.BILINEAR)
        # The model was trained on OpenCV's BGR order, normalised to [-1, 1].
        values = (np.asarray(resized, dtype=np.float32)[:, :, ::-1] / 255.0 - 0.5) / 0.5
        batch = np.zeros((1, 3, LINE_HEIGHT, max(MIN_WIDTH, width)), dtype=np.float32)
        batch[0, :, :, :width] = values.transpose(2, 0, 1)
        with self.lock:
            probabilities = self.session.run(None, {self.input_name: batch})[0][0]
        indices = probabilities.argmax(axis=1)
        confidences = probabilities.max(axis=1)
        text, scores, previous = [], [], -1
        for index, confidence in zip(indices, confidences):
            if index != previous and index != 0:
                text.append(self.characters[int(index)])
                scores.append(float(confidence))
            previous = index
        return "".join(text), (sum(scores) / len(scores) if scores else 0.0)


def make_handler(recognizer: LineRecognizer, token: str):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            return  # Screen content never enters a log.

        def _reply(self, status: int, payload: dict):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            from PIL import Image

            if self.path != "/read" or not hmac.compare_digest(self.headers.get("X-Xiaoxi-Token", ""), token):
                return self._reply(403, {"error": "forbidden"})
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY_BYTES:
                return self._reply(413, {"error": "size"})
            try:
                with Image.open(io.BytesIO(self.rfile.read(length))) as image:
                    text, score = recognizer.read(image)
            except Exception as exc:  # A bad image is the caller's problem, never a crash.
                return self._reply(400, {"error": type(exc).__name__})
            return self._reply(200, {"text": text, "score": round(score, 4)})

        def do_GET(self):
            if self.path == "/health" and hmac.compare_digest(self.headers.get("X-Xiaoxi-Token", ""), token):
                return self._reply(200, {"ok": True, "model": MODEL_CONFIG["name"]})
            return self._reply(403, {"error": "forbidden"})

    return Handler


def serve(stdout=None) -> int:
    token = os.environ.get("XIAOXI_LINE_OCR_TOKEN", "")
    if len(token) < 32:
        sys.stderr.write("XIAOXI_LINE_OCR_TOKEN missing\n")
        return 2
    recognizer = LineRecognizer()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(recognizer, token))
    server.daemon_threads = True
    out = stdout or sys.stdout
    out.write(json.dumps({"port": server.server_address[1]}) + "\n")
    out.flush()

    # Ends with the parent: the desktop app closes this pipe when it exits.
    def watch_parent():
        try:
            sys.stdin.read()
        finally:
            server.shutdown()

    threading.Thread(target=watch_parent, daemon=True).start()
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0
