"""Resolve the one Chromium runtime trusted by the desktop package."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any


_BROWSER_ENV = "XIAOXI_PRODUCT_DETAIL_BROWSER_PATH"


def _packaged_browser_path() -> Path:
    """Return the browser packaged beside the content engine, if present."""

    return (
        Path(sys.executable).resolve().parent.parent
        / "content-engine"
        / "browser"
        / "chrome.exe"
    )


def chromium_executable() -> Path | None:
    """Resolve a trusted explicit browser without silently falling back in a package."""

    configured = os.environ.get(_BROWSER_ENV, "").strip()
    if getattr(sys, "frozen", False):
        expected = _packaged_browser_path()
        if not configured:
            return None
        try:
            candidate = Path(configured).expanduser().resolve(strict=True)
        except (OSError, RuntimeError):
            return None
        return candidate if candidate == expected.resolve() and candidate.is_file() else None

    if not configured:
        return None
    try:
        candidate = Path(configured).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    return candidate if candidate.is_file() else None


def launch_chromium(playwright: Any, **kwargs: Any):
    """Launch Chromium from the release runtime, or the normal Playwright depot in dev."""

    executable = chromium_executable()
    if getattr(sys, "frozen", False) and executable is None:
        raise RuntimeError("shared Chromium runtime is unavailable")
    if executable is not None:
        kwargs.setdefault("executable_path", str(executable))
    return playwright.chromium.launch(**kwargs)


def playwright_available(*, verify_launch: bool = False) -> bool:
    """Check the selected browser, with an optional actual headless-launch probe."""

    try:
        from playwright.sync_api import sync_playwright

        executable = chromium_executable()
        if getattr(sys, "frozen", False) and executable is None:
            return False
        with sync_playwright() as playwright:
            if executable is None:
                return Path(playwright.chromium.executable_path).is_file()
            if not executable.is_file():
                return False
            if not verify_launch:
                return True
            browser = launch_chromium(playwright, headless=True)
            try:
                page = browser.new_page()
                page.set_content("<main>xiaoxi browser smoke</main>")
                return page.locator("main").inner_text() == "xiaoxi browser smoke"
            finally:
                browser.close()
    except Exception:
        return False
