from __future__ import annotations

import base64
import urllib.error

import pytest

import ai_image_apimart as adapter


@pytest.fixture(autouse=True)
def _configured_adapter(monkeypatch):
    monkeypatch.setenv("REFINE_API_BASE_URL", "https://provider.invalid/v1")
    monkeypatch.setattr(adapter.time, "sleep", lambda _seconds: None)
    with adapter._UPLOAD_CACHE_LOCK:
        adapter._UPLOAD_CACHE.clear()
    yield
    with adapter._UPLOAD_CACHE_LOCK:
        adapter._UPLOAD_CACHE.clear()


def _png_data_url() -> str:
    return "data:image/png;base64," + base64.b64encode(b"fake-png-bytes").decode("ascii")


def test_data_url_upload_is_reused_and_generation_uses_provider_url(monkeypatch):
    upload_calls = []
    generation_payloads = []

    def fake_upload(url, image_bytes, mime, filename, api_key, timeout=60):
        upload_calls.append((url, image_bytes, mime, filename, api_key, timeout))
        return 200, {"url": "https://cdn.invalid/reference.png"}

    def fake_post(url, payload, api_key, timeout=60):
        generation_payloads.append((url, payload, api_key, timeout))
        return 200, {"code": 200, "data": [{"task_id": "task-upload-1"}]}

    monkeypatch.setattr(adapter, "_http_post_image_upload", fake_upload)
    monkeypatch.setattr(adapter, "_http_post_json", fake_post)
    value = _png_data_url()
    assert adapter.submit_image_task("prompt", value, "secret") == "task-upload-1"
    assert adapter.submit_image_task("prompt", value, "secret") == "task-upload-1"

    assert len(upload_calls) == 1
    assert len(generation_payloads) == 2
    payload = generation_payloads[0][1]
    assert payload["model"] == "gpt-image-2"
    assert payload["resolution"] == "1k"
    assert payload["image_urls"] == ["https://cdn.invalid/reference.png"]
    assert "thinking" not in payload
    assert "reasoning_effort" not in payload
    assert value not in str(payload)


def test_reference_upload_keeps_saved_proxy_route_then_falls_back_to_direct(monkeypatch):
    attempts = []

    class FakeResponse:
        status = 200

        def read(self):
            return b'{"url":"https://cdn.invalid/reference.png"}'

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    class FakeOpener:
        def __init__(self, route):
            self.route = route

        def open(self, _request, timeout):
            attempts.append((self.route, timeout))
            if self.route == "system-proxy":
                raise urllib.error.URLError(OSError(10060, "synthetic connect timeout"))
            return FakeResponse()

    def fake_build_opener(proxy_handler):
        route = "system-proxy" if proxy_handler.proxies else "direct"
        return FakeOpener(route)

    monkeypatch.setattr(adapter, "_APIMART_PROXY_SETTINGS", {
        "https": "http://proxy.invalid:7890",
    })
    monkeypatch.setattr(adapter.urllib.request, "build_opener", fake_build_opener)

    assert adapter.upload_data_url(_png_data_url(), "secret") == "https://cdn.invalid/reference.png"
    assert attempts == [("system-proxy", 60), ("direct", 60)]


def test_reference_upload_transport_failure_does_not_submit_generation(monkeypatch):
    attempts = []
    generation_calls = []

    class FailingOpener:
        def __init__(self, route):
            self.route = route

        def open(self, _request, timeout):
            attempts.append((self.route, timeout))
            raise urllib.error.URLError(OSError(10060, "synthetic connect timeout"))

    def fake_build_opener(proxy_handler):
        route = "system-proxy" if proxy_handler.proxies else "direct"
        return FailingOpener(route)

    def unexpected_generation(*_args, **_kwargs):
        generation_calls.append(True)
        raise AssertionError("generation must not be submitted after upload failure")

    monkeypatch.setattr(adapter, "_APIMART_PROXY_SETTINGS", {
        "https": "http://proxy.invalid:7890",
    })
    monkeypatch.setattr(adapter.urllib.request, "build_opener", fake_build_opener)
    monkeypatch.setattr(adapter, "_http_post_json", unexpected_generation)

    with pytest.raises(adapter.APIMartReferenceUploadTransportError) as caught:
        adapter.submit_image_task("prompt", _png_data_url(), "secret")

    assert "未提交生图任务" in str(caught.value)
    assert attempts == [("system-proxy", 60), ("direct", 60)]
    assert generation_calls == []


def test_direct_reference_route_is_reused_for_submit_and_poll(monkeypatch):
    calls = []

    def fake_upload(url, image_bytes, mime, filename, api_key, timeout=60, *, direct=False):
        calls.append(("upload", direct))
        if not direct:
            raise urllib.error.URLError(OSError(10060, "synthetic proxy timeout"))
        return 200, {"url": "https://cdn.invalid/reference.png"}

    def fake_post(url, payload, api_key, timeout=30, *, direct=False):
        calls.append(("submit", direct))
        return 200, {"data": {"task_id": "task-direct-route-1"}}

    def fake_get(url, api_key, timeout=30, *, direct=False):
        calls.append(("poll", direct))
        return {
            "data": {
                "status": "completed",
                "result": {"images": [{"url": "https://cdn.invalid/result.png"}]},
            }
        }

    monkeypatch.setattr(adapter, "_APIMART_PROXY_SETTINGS", {
        "https": "http://proxy.invalid:7890",
    })
    monkeypatch.setattr(adapter, "_http_post_image_upload", fake_upload)
    monkeypatch.setattr(adapter, "_http_post_json", fake_post)
    monkeypatch.setattr(adapter, "_http_get_json", fake_get)

    assert (
        adapter.default_api_call("prompt", _png_data_url(), "secret")
        == "https://cdn.invalid/result.png"
    )
    assert calls == [
        ("upload", False),
        ("upload", True),
        ("submit", True),
        ("poll", True),
    ]


def test_submit_503_is_outcome_unknown_without_retry(monkeypatch):
    calls = []

    def fake_post(url, payload, api_key, timeout=60):
        calls.append(payload)
        return 503, {"error": {"message": "temporarily unavailable"}}

    monkeypatch.setattr(adapter, "_http_post_json", fake_post)
    with pytest.raises(adapter.APIMartOutcomeUnknown):
        adapter.submit_image_task("prompt", None, "secret")
    assert len(calls) == 1


@pytest.mark.parametrize(
    "response",
    [
        (200, {"data": []}),
        (500, {"error": {"message": "server error"}}),
    ],
)
def test_submit_2xx_without_task_or_5xx_is_outcome_unknown(monkeypatch, response):
    calls = []

    def fake_post(url, payload, api_key, timeout=60):
        calls.append(payload)
        return response

    monkeypatch.setattr(adapter, "_http_post_json", fake_post)
    with pytest.raises(adapter.APIMartOutcomeUnknown):
        adapter.submit_image_task("prompt", None, "secret")
    assert len(calls) == 1


def test_submit_explicit_4xx_is_definite_failure(monkeypatch):
    calls = []

    def fake_post(url, payload, api_key, timeout=60):
        calls.append(payload)
        return 400, {"error": {"message": "invalid request"}}

    monkeypatch.setattr(adapter, "_http_post_json", fake_post)
    with pytest.raises(adapter.APIMartError) as caught:
        adapter.submit_image_task("prompt", None, "secret")
    assert not isinstance(caught.value, adapter.APIMartOutcomeUnknown)
    assert len(calls) == 1


def test_ambiguous_submit_response_is_not_retried(monkeypatch):
    calls = []

    def fail_post(url, payload, api_key, timeout=60):
        calls.append(payload)
        raise TimeoutError("synthetic timeout")

    monkeypatch.setattr(adapter, "_http_post_json", fail_post)
    with pytest.raises(adapter.APIMartOutcomeUnknown) as caught:
        adapter.submit_image_task("prompt", None, "secret")
    assert caught.value.task_id == ""
    assert len(calls) == 1


def test_poll_uses_same_task_and_parses_current_result_shape(monkeypatch):
    seen = []

    def fake_get(url, api_key, timeout=30):
        seen.append((url, api_key))
        return {
            "data": {
                "status": "completed",
                "result": {"images": [{"url": ["https://cdn.invalid/result.png"]}]},
            }
        }

    monkeypatch.setattr(adapter, "_http_get_json", fake_get)
    assert adapter.poll_image_task("task-poll-1", "secret") == "https://cdn.invalid/result.png"
    assert seen == [("https://provider.invalid/v1/tasks/task-poll-1?language=en", "secret")]


def test_default_api_call_polls_pending_task_to_completion_without_resubmit(monkeypatch):
    submit_calls = []
    poll_calls = []
    responses = iter(
        [
            {"data": {"status": "pending"}},
            {"data": {"status": "processing"}},
            {
                "data": {
                    "status": "completed",
                    "result": {"images": [{"url": "https://cdn.invalid/final.png"}]},
                }
            },
        ]
    )

    def fake_post(url, payload, api_key, timeout=30):
        submit_calls.append((url, payload, api_key, timeout))
        return 200, {"data": {"task_id": "task-pending-1"}}

    def fake_get(url, api_key, timeout=30):
        poll_calls.append((url, api_key, timeout))
        return next(responses)

    monkeypatch.setattr(adapter, "_http_post_json", fake_post)
    monkeypatch.setattr(adapter, "_http_get_json", fake_get)

    assert (
        adapter.default_api_call("prompt", None, "secret")
        == "https://cdn.invalid/final.png"
    )
    assert len(submit_calls) == 1
    assert [call[0] for call in poll_calls] == [
        "https://provider.invalid/v1/tasks/task-pending-1?language=en",
        "https://provider.invalid/v1/tasks/task-pending-1?language=en",
        "https://provider.invalid/v1/tasks/task-pending-1?language=en",
    ]


def test_default_api_call_checkpoints_task_id_before_poll_and_completed_url(monkeypatch):
    events = []

    def fake_post(url, payload, api_key, timeout=30):
        return 200, {"data": {"task_id": "task-checkpoint-1"}}

    def fake_get(url, api_key, timeout=30):
        assert events == [
            {
                "event": "submitted",
                "provider_task_id": "task-checkpoint-1",
                "route": "system",
            }
        ]
        return {
            "data": {
                "status": "completed",
                "result": {"images": [{"url": "https://cdn.invalid/final.png"}]},
            }
        }

    monkeypatch.setattr(adapter, "_http_post_json", fake_post)
    monkeypatch.setattr(adapter, "_http_get_json", fake_get)

    assert adapter.default_api_call(
        "prompt", None, "secret", lifecycle_callback=events.append,
    ) == "https://cdn.invalid/final.png"
    assert events == [
        {
            "event": "submitted",
            "provider_task_id": "task-checkpoint-1",
            "route": "system",
        },
        {
            "event": "completed",
            "provider_task_id": "task-checkpoint-1",
            "raw_url": "https://cdn.invalid/final.png",
            "route": "system",
        },
    ]


def test_poll_recovers_from_transient_connection_failure_on_same_task(monkeypatch):
    calls = []

    def flaky_get(url, api_key, timeout=30):
        calls.append(url)
        if len(calls) == 1:
            raise ConnectionError("synthetic transient disconnect")
        return {
            "data": {
                "status": "completed",
                "result": {"images": [{"url": "https://cdn.invalid/recovered.png"}]},
            }
        }

    monkeypatch.setattr(adapter, "_http_get_json", flaky_get)
    assert (
        adapter.poll_image_task("task-transient-1", "secret")
        == "https://cdn.invalid/recovered.png"
    )
    assert calls == [
        "https://provider.invalid/v1/tasks/task-transient-1?language=en",
        "https://provider.invalid/v1/tasks/task-transient-1?language=en",
    ]


def test_repeated_poll_connection_failure_is_outcome_unknown_without_resubmit(monkeypatch):
    calls = []

    def fail_get(url, api_key, timeout=30):
        calls.append(url)
        raise ConnectionError("synthetic disconnect")

    monkeypatch.setattr(adapter, "_http_get_json", fail_get)
    with pytest.raises(adapter.APIMartOutcomeUnknown) as caught:
        adapter.poll_image_task("task-uncertain-1", "secret")
    assert caught.value.task_id == "task-uncertain-1"
    assert calls == [
        "https://provider.invalid/v1/tasks/task-uncertain-1?language=en",
        "https://provider.invalid/v1/tasks/task-uncertain-1?language=en",
        "https://provider.invalid/v1/tasks/task-uncertain-1?language=en",
    ]


@pytest.mark.parametrize("status_code", [429, 503])
def test_repeated_poll_http_error_stops_after_three_gets(monkeypatch, status_code):
    calls = []

    def fail_get(url, api_key, timeout=30):
        calls.append(url)
        raise urllib.error.HTTPError(
            url,
            status_code,
            "synthetic provider response",
            hdrs=None,
            fp=None,
        )

    monkeypatch.setattr(adapter, "_http_get_json", fail_get)
    with pytest.raises(adapter.APIMartOutcomeUnknown) as caught:
        adapter.poll_image_task("task-http-error-1", "secret")
    assert caught.value.task_id == "task-http-error-1"
    assert calls == [
        "https://provider.invalid/v1/tasks/task-http-error-1?language=en",
        "https://provider.invalid/v1/tasks/task-http-error-1?language=en",
        "https://provider.invalid/v1/tasks/task-http-error-1?language=en",
    ]


@pytest.mark.parametrize(
    "poll_response",
    [
        [],
        {"data": {"status": "completed", "result": []}},
        {"data": {"status": "completed", "result": {"images": ["invalid"]}}},
        {"data": {"status": "completed", "result": {"images": [{"url": 123}]}}},
        {"data": {"status": "completed", "result": {"images": [{"url": {"x": 1}}]}}},
        {"data": {"status": "completed", "result": {"images": [{"url": [123]}]}}},
        {"data": {"status": "completed", "result": {"images": [{"url": "ftp://invalid"}]}}},
    ],
)
def test_malformed_poll_result_never_resubmits_paid_task(monkeypatch, poll_response):
    submit_calls = []
    poll_calls = []

    def fake_post(url, payload, api_key, timeout=30):
        submit_calls.append((url, payload, api_key, timeout))
        return 200, {"data": {"task_id": "task-malformed-1"}}

    def fake_get(url, api_key, timeout=30):
        poll_calls.append((url, api_key, timeout))
        return poll_response

    monkeypatch.setattr(adapter, "_http_post_json", fake_post)
    monkeypatch.setattr(adapter, "_http_get_json", fake_get)

    with pytest.raises(adapter.APIMartOutcomeUnknown) as caught:
        adapter.default_api_call("prompt", None, "secret")
    assert caught.value.task_id == "task-malformed-1"
    assert len(submit_calls) == 1
    assert len(poll_calls) == 1
