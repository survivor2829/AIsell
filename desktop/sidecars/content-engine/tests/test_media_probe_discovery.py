from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from content_engine.media_probe import discover_ffprobe


class FFprobeDiscoveryTests(unittest.TestCase):
    def test_explicit_absolute_environment_path_has_priority(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            configured = Path(temp_dir) / "configured-ffprobe.exe"
            configured.write_bytes(b"fake")
            fallback = Path(temp_dir) / "path-ffprobe.exe"
            fallback.write_bytes(b"fake")
            with (
                mock.patch.dict(
                    os.environ,
                    {"XIAOXI_FFPROBE_PATH": str(configured.resolve())},
                    clear=False,
                ),
                mock.patch(
                    "content_engine.media_probe.shutil.which",
                    return_value=str(fallback.resolve()),
                ),
                mock.patch.object(sys, "frozen", False, create=True),
            ):
                selected = discover_ffprobe()
            self.assertEqual(configured.resolve(), selected)

    def test_relative_environment_value_is_not_executed(self):
        with (
            mock.patch.dict(
                os.environ, {"XIAOXI_FFPROBE_PATH": "relative-ffprobe.exe"}, clear=False
            ),
            mock.patch("content_engine.media_probe.shutil.which", return_value=None),
            mock.patch.object(sys, "frozen", False, create=True),
        ):
            self.assertIsNone(discover_ffprobe())

    def test_frozen_runtime_only_checks_its_executable_directory(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            application = runtime_dir / "content-engine.exe"
            application.write_bytes(b"fake")
            bundled_probe = runtime_dir / "ffprobe.exe"
            bundled_probe.write_bytes(b"fake")
            with (
                mock.patch.dict(os.environ, {"XIAOXI_FFPROBE_PATH": ""}, clear=False),
                mock.patch("content_engine.media_probe.shutil.which", return_value=None),
                mock.patch.object(sys, "frozen", True, create=True),
                mock.patch.object(sys, "executable", str(application)),
            ):
                selected = discover_ffprobe()
            self.assertEqual(bundled_probe.resolve(), selected)


if __name__ == "__main__":
    unittest.main()
