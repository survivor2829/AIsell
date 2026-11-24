"""Which shot of a mixed video its cover is taken from.

Every work of one batch opens on the same best hook shot, so a cover that is always the
first shot looks the same across the batch (user report 2026-11-23). Each work picks a
shot of its own that the batch's earlier covers did not use: another material first,
then another time range of a used material, and only when neither is left a repeat.
"""


def segment_window(segment):
    """(asset_id, start_ms, end_ms) of a recipe segment or a timeline shot."""
    start = int(segment.get("source_start_ms", segment.get("start_ms")) or 0)
    end = int(segment.get("source_end_ms", segment.get("end_ms")) or 0)
    # Images carry no range: the whole file is one window.
    return str(segment.get("asset_id") or ""), start, max(end, start + 1)


def _clashes(window, avoid):
    asset, start, end = window
    return any(asset == other and start < other_end and other_start < end
               for other, other_start, other_end in avoid)


def cover_segment(segments, avoid=()):
    """The segment to take the cover from; None when there is no material segment."""
    with_asset = [item for item in segments or [] if isinstance(item, dict) and item.get("asset_id")]
    # The appended ending image is an assist, not the customer's footage.
    usable = [item for item in with_asset if item.get("role") != "supplemental"] or with_asset
    if not usable:
        return None
    avoid = [tuple(item) for item in avoid or [] if isinstance(item, (list, tuple)) and len(item) == 3]
    used_assets = {item[0] for item in avoid}
    for item in usable:
        if segment_window(item)[0] not in used_assets:
            return item
    for item in usable:
        if not _clashes(segment_window(item), avoid):
            return item
    return usable[len(avoid) % len(usable)]


def recipe_cover_segment(recipe):
    """The recipe's chosen cover segment; older recipes use their first visual segment."""
    segments = recipe.get("visual_segments") or []
    chosen = recipe.get("cover_segment_id")
    if chosen:
        match = next((item for item in segments if isinstance(item, dict)
                      and item.get("segment_id") == chosen and item.get("asset_id")), None)
        if match is not None:
            return match
    return segments[0] if segments else None
