from __future__ import annotations

import uuid
from unittest import mock

import pytest

from app import app, db
from ai_refine_v2.refine_planner import (
    MAX_PRODUCT_TEXT_CHARS,
    MAX_PRODUCT_TITLE_CHARS,
)
from models import User


@pytest.fixture()
def authed_client():
    username = f"ai_refine_input_{uuid.uuid4().hex[:8]}"
    app.config["TESTING"] = True
    app.config["WTF_CSRF_ENABLED"] = False
    client = app.test_client()
    with app.app_context():
        user = User(username=username, is_approved=True, is_paid=True)
        user.set_password("x")
        db.session.add(user)
        db.session.commit()
        user_id = user.id
    with client.session_transaction() as session:
        session["_user_id"] = str(user_id)
        session["_fresh"] = True
    yield client
    with app.app_context():
        user = User.query.filter_by(username=username).first()
        if user is not None:
            db.session.delete(user)
            db.session.commit()


def _post(client, **overrides):
    payload = {
        "product_text": "真实产品文案",
        "product_title": "T300",
        "product_image_url": "data:image/png;base64,ZmFrZQ==",
        "schema_mode": "v2",
    }
    payload.update(overrides)
    return client.post("/api/ai-refine-v2/execute", json=payload)


def test_server_rejects_invalid_product_input_with_stable_codes(authed_client):
    cases = (
        (
            {"product_text": "", "product_title": "T300"},
            "AI_REFINE_PRODUCT_TEXT_REQUIRED",
        ),
        (
            {"product_text": "产" * (MAX_PRODUCT_TEXT_CHARS + 1)},
            "AI_REFINE_PRODUCT_TEXT_TOO_LONG",
        ),
        (
            {"product_title": "T" * (MAX_PRODUCT_TITLE_CHARS + 1)},
            "AI_REFINE_PRODUCT_TITLE_TOO_LONG",
        ),
    )

    for overrides, expected_code in cases:
        response = _post(authed_client, **overrides)
        assert response.status_code == 400
        assert response.get_json()["code"] == expected_code


def test_missing_static_reference_has_stable_error_code(authed_client):
    response = _post(
        authed_client,
        product_image_url="/static/uploads/not-found/product.png",
    )
    assert response.status_code == 400
    assert response.get_json()["code"] == "AI_REFINE_PRODUCT_IMAGE_NOT_FOUND"


def test_single_screen_redo_checks_owner_and_uses_existing_execute(authed_client):
    with authed_client.session_transaction() as session:
        owner_id = int(session["_user_id"])
    with mock.patch("ai_refine_v2.pipeline_runner.get_task_status", return_value={"user_id": owner_id + 1}), \
         mock.patch("ai_refine_v2.pipeline_runner.start_screen_reroll") as redo:
        denied = authed_client.post("/api/ai-refine-v2/execute", json={"source_task_id": "v2_existing", "block_index": 1})
        assert denied.status_code == 403
        redo.assert_not_called()
    with mock.patch("ai_refine_v2.pipeline_runner.get_task_status", return_value={"user_id": owner_id}), \
         mock.patch("ai_refine_v2.pipeline_runner.start_screen_reroll", return_value="v2_new") as redo:
        result = authed_client.post("/api/ai-refine-v2/execute", json={"source_task_id": "v2_existing", "block_index": 1})
        assert result.status_code == 200
        assert result.get_json()["task_id"] == "v2_new"
        assert redo.call_args.args[:3] == ("v2_existing", 1, owner_id)


def test_static_reference_cannot_escape_static_root(authed_client):
    with mock.patch("ai_refine_v2.pipeline_runner.start_task") as start_task:
        response = _post(
            authed_client,
            product_image_url="/static/../app.py",
        )
    assert response.status_code == 400
    assert response.get_json()["code"] == "AI_REFINE_PRODUCT_IMAGE_INVALID"
    start_task.assert_not_called()
