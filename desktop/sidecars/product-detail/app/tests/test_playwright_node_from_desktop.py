"""The package carries no Node.js for Playwright: the desktop executable runs its driver."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
CODE = r'''
import json, os
from pathlib import Path
import desktop_entry
desktop_entry._configure_environment(desktop_entry.prepare_runtime_paths(Path(os.environ["TEST_DATA_DIR"])))
print(json.dumps(os.environ.get("ELECTRON_RUN_AS_NODE")))
'''


def _run(tmp_path, extra):
    env = {k: v for k, v in os.environ.items() if k not in ("PLAYWRIGHT_NODEJS_PATH", "ELECTRON_RUN_AS_NODE")}
    env.update(TEST_DATA_DIR=str(tmp_path / "data"), PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1", **extra)
    completed = subprocess.run([sys.executable, "-c", CODE], cwd=APP_ROOT, env=env, capture_output=True,
                               text=True, encoding="utf-8", timeout=60, check=False)
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout.strip().splitlines()[-1])


def test_desktop_executable_runs_the_driver_as_node(tmp_path):
    assert _run(tmp_path, {"PLAYWRIGHT_NODEJS_PATH": sys.executable}) == "1"


def test_without_it_the_environment_is_untouched(tmp_path):
    assert _run(tmp_path, {}) is None
