"""Frozen per-task image settings shared by quoting and submission.

Absence means the historical route, never today's default. Only creation of a
new pipeline task may choose DEFAULT_PROFILE; recovery and rerolls inherit it.
"""
LEGACY_PROFILE = {"model": "gpt-image-2", "resolution": "1K"}
DEFAULT_PROFILE = {"model": "gpt-image-2.5-ext", "version": "sunburst", "resolution": "2K"}


def normalize_profile(profile=None):
    if profile is None:
        return dict(LEGACY_PROFILE)
    if not isinstance(profile, dict) or profile not in (LEGACY_PROFILE, DEFAULT_PROFILE):
        raise ValueError("生图配置不可识别，已保留原任务，未提交新的付费请求。")
    return dict(profile)


def submission_fields(profile=None):
    selected = normalize_profile(profile)
    if selected == LEGACY_PROFILE:
        selected["resolution"] = "1k"
    return selected
