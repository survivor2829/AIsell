"""Polling an already submitted image task waits out a shaky network.

Customer computer 2026-11-04: the last screen of a set stopped as outcome
unknown after three status-read failures (~9 s), minutes after the same
computer had failed a reference upload. Reading status buys nothing.
"""
import pytest

import ai_image_apimart as adapter


def test_status_reads_survive_a_run_of_connection_errors(monkeypatch):
    calls = []
    def get_json(url, key, **kwargs):
        calls.append(url)
        if len(calls) <= 5:
            raise OSError("connection reset")
        return {"data": {"status": "completed", "result": {"images": [{"url": "https://example.invalid/last.png"}]}}}
    sleeps = []
    monkeypatch.setattr(adapter, "_http_get_json", get_json)
    monkeypatch.setattr(adapter.time, "sleep", sleeps.append)
    assert adapter.poll_image_task("task-last", "key", poll_interval=3) == "https://example.invalid/last.png"
    assert len(calls) == 6
    assert max(sleeps) <= adapter._MAX_POLL_BACKOFF_S and sleeps == sorted(sleeps)


def test_unknown_outcome_still_says_why(monkeypatch):
    monkeypatch.setattr(adapter, "_http_get_json", lambda *a, **k: (_ for _ in ()).throw(OSError("down")))
    monkeypatch.setattr(adapter.time, "sleep", lambda s: None)
    monkeypatch.setattr(adapter, "_MAX_CONSECUTIVE_POLL_ERRORS", 2)
    with pytest.raises(adapter.APIMartOutcomeUnknown) as error:
        adapter.poll_image_task("task-last", "key")
    assert error.value.poll_reason == "connection"
    from ai_refine_v2.pricing import _image_failure_diagnostic
    assert _image_failure_diagnostic(error.value)["poll_reason"] == "connection"
