from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DETAIL = ROOT / "templates" / "batch" / "history_detail.html"


def read_detail() -> str:
    return DETAIL.read_text(encoding="utf-8")


def test_result_workbench_toolbar_exists():
    html = read_detail()
    assert "生产结果管理" in html
    for stat_id in [
        "statTotal",
        "statDone",
        "statFailed",
        "statMissingHtml",
        "statMissingAi",
        "statRerollable",
    ]:
        assert f'id="{stat_id}"' in html
    for filter_name in ["all", "failed", "missing", "unrefined", "refined", "rerollable"]:
        assert f'data-filter="{filter_name}"' in html
        assert f'data-count-for="{filter_name}"' in html


def test_workbench_uses_frontend_item_flags_without_new_schema():
    html = read_detail()
    assert "function itemFlags(item)" in html
    assert "missingHtml" in html
    assert "missingAi" in html
    assert "canReroll" in html
    assert "function updateWorkbench(items)" in html
    assert "function renderFilteredItems(batchId)" in html


def test_reroll_fetch_keeps_csrf_header():
    html = read_detail()
    assert '<meta name="csrf-token" content="{{ csrf_token() }}">' in html
    assert "const csrfToken = document.querySelector('meta[name=\"csrf-token\"]').content" in html
    assert "'X-CSRFToken': csrfToken" in html


def test_screen_regenerated_targets_item_and_block():
    html = read_detail()
    assert 'data-item-pk="${item.id}" data-index="${i}"' in html
    assert 'data-item-pk="${item.id}" src="${escapeHtml(aiUrl)}"' in html
    assert '.hd-card[data-item-id="${msg.item_pk}"]' in html
    assert '.hd-screen-card[data-item-pk="${msg.item_pk}"][data-index="${msg.block_index}"]' in html
    assert '.hd-ai-img[data-item-pk="${msg.item_pk}"]' in html


def test_toast_helper_is_available_on_detail_page():
    html = read_detail()
    assert "function showToast(message, type = 'default')" in html
    assert "window._showToast = showToast" in html
    assert "window.__showToast = showToast" in html
    assert "showToast(`第 ${Number(msg.block_index) + 1} 屏已重生" in html
