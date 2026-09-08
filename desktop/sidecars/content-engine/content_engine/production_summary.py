"""Read-only business productions, grouped before filtering and pagination.

Task rows are execution steps. Only persisted batch/session/run relationships
establish ownership; sharing a project is deliberately not a relationship.
"""
from __future__ import annotations

import json

from .errors import ContentEngineError
from .public_data import redact_text


RUNNING = {"queued", "analyzing", "rendering"}
HISTORY = {"completed", "cancelled"}
INTERNAL_TYPES = {
    "asset_import", "creative_analysis", "product_asset_analysis", "product_copy",
    "product_voice", "guided_auto_mix_analysis", "guided_auto_mix_draft",
    "guided_auto_mix_supplemental_image",
}
VIEWS = {"pending", "active", "needs_attention", "history", "archived", "all"}


def _object(value):
    try:
        parsed = json.loads(value or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except (ValueError, TypeError):
        return {}


def _step(task):
    return {
        "task_id": task["id"], "task_type": task["task_type"],
        "status": task["status"], "progress": task["progress"],
        "error_code": task["error_code"],
        "error_message": redact_text(task["error_message"]) if task["error_message"] else None,
        "created_at": task["created_at"], "updated_at": task["updated_at"],
    }


class ProductionSummary:
    def __init__(self, connection):
        self.db = connection

    def _groups(self):
        # No LIMIT here: filtering task rows first loses older active productions.
        # One SQLite read snapshot keeps the count and ownership consistent while
        # another connection advances a production.
        self.db.execute("SAVEPOINT production_summary_read")
        try:
            snapshots = {table: [dict(row) for row in self.db.execute(f"SELECT * FROM {table}")]
                         for table in ("content_tasks", "narrated_batches_v1",
                                       "guided_auto_mix_sessions_v1", "auto_mix_runs_v2")}
        finally:
            self.db.execute("RELEASE production_summary_read")
        tasks = {r["id"]: r for r in snapshots["content_tasks"]}
        payloads = {key: _object(row["payload_json"]) for key, row in tasks.items()}
        batches = {r["id"]: {**_object(r["state_json"]), "batch_id": r["id"],
                             "project_id": r["project_id"], "updated_at": r["updated_at"]}
                   for r in snapshots["narrated_batches_v1"]}
        sessions = {r["id"]: r for r in snapshots["guided_auto_mix_sessions_v1"]}
        runs = {r["id"]: r for r in snapshots["auto_mix_runs_v2"]}
        task_owner, run_owner, groups = {}, {}, {}

        def group(kind, identifier):
            key = f"{kind}:{identifier}"
            return groups.setdefault(key, {"production_id": key, "kind": kind,
                                          "identifier": identifier, "tasks": {}, "runs": {}})

        def assign_task(task_id, owner):
            if task_id in tasks:
                task_owner[task_id] = owner

        for batch_id, batch in batches.items():
            owner = group("narrated_batch", batch_id)
            owner["batch"] = batch
            assign_task(batch.get("task_id"), owner)
            for candidate in batch.get("candidates") or []:
                if isinstance(candidate, dict) and candidate.get("_run_id") in runs:
                    run_owner[candidate["_run_id"]] = owner
        for session_id, session in sessions.items():
            owner = group("guided_session", session_id)
            owner["session"] = session
            for field in ("analysis_task_id", "draft_task_id"):
                assign_task(session[field], owner)
        for task_id, payload in payloads.items():
            batch_id, session_id = payload.get("batch_id"), payload.get("session_id")
            if batch_id in batches:
                assign_task(task_id, group("narrated_batch", batch_id))
            elif session_id in sessions:
                assign_task(task_id, group("guided_session", session_id))

        roots = {}
        def root(run_id):
            if run_id in roots:
                return roots[run_id]
            seen, cursor = [], run_id
            while cursor in runs and cursor not in seen:
                seen.append(cursor)
                parent = runs[cursor].get("parent_run_id")
                if not parent or parent not in runs:
                    break
                cursor = parent
            # Corrupt cycles remain deterministic and never join an unrelated run.
            result = min(seen) if cursor in seen[:-1] else seen[-1]
            for value in seen:
                roots[value] = result
            return result

        # Discover ownership for all explicit roots before walking their children.
        for run_id, run in runs.items():
            session_id = _object(run["private_state_json"]).get("guided_session_id")
            owner = run_owner.get(run_id) or task_owner.get(run.get("task_id"))
            if owner is None and session_id in sessions:
                owner = group("guided_session", session_id)
            if owner is not None:
                run_owner[root(run_id)] = owner
        for run_id, run in runs.items():
            owner = run_owner.get(root(run_id))
            if owner is None:
                owner = group("auto_mix_v2", root(run_id))
            owner["runs"][run_id] = run
            run_owner[run_id] = owner
            assign_task(run.get("task_id"), owner)
        for task_id, task in tasks.items():
            payload = payloads[task_id]
            owner = task_owner.get(task_id)
            if owner is None:
                owner = run_owner.get(payload.get("run_id"))
            if owner is None and task["task_type"] not in INTERNAL_TYPES:
                owner = group("task", task_id)
            if owner is not None:
                owner["tasks"][task_id] = task
        return [self._production(item, payloads) for item in groups.values()]

    def _production(self, group, payloads):
        steps = sorted(group["tasks"].values(), key=lambda t: (t["updated_at"], t["created_at"], t["id"]), reverse=True)
        runs = sorted(group["runs"].values(), key=lambda r: (r["created_at"], r["generation"], r["id"]), reverse=True)
        task = steps[0] if steps else None
        run = runs[0] if runs else None
        batch, session = group.get("batch"), group.get("session")
        session_is_current = bool(session and (not run or session["updated_at"] > run["updated_at"]))
        title, state, archived = "", "draft", False
        project_id = run["project_id"] if run else None
        created_at = min((t["created_at"] for t in steps), default="")
        updated_at = max((t["updated_at"] for t in steps), default="")
        if batch:
            task = group["tasks"].get(batch.get("task_id"))
            title, state = batch.get("title") or "口播制作", batch.get("status") or "draft"
            archived = bool(batch.get("_archived_at"))
            project_id = batch.get("project_id")
            created_at = batch.get("created_at") or created_at
            updated_at = max(updated_at, batch.get("updated_at") or "")
            if batch.get("_planning_inflight") and (not task or task["status"] not in RUNNING):
                state = "outcome_unknown"
        elif session_is_current:
            task = group["tasks"].get(session["draft_task_id"] or session["analysis_task_id"])
            title = _object(session["draft_json"]).get("title") or "引导式一键成片"
            state, project_id = session["status"], None
            created_at, updated_at = session["created_at"], max(updated_at, session["updated_at"])
        elif run:
            task = group["tasks"].get(run.get("task_id"))
            title, state = run["title"] or "一键成片", run["status"]
            created_at = min(created_at or run["created_at"], run["created_at"])
            updated_at = max(updated_at, run["updated_at"])
        elif task:
            payload = payloads[task["id"]]
            title = payload.get("title") or ""
            state, project_id = task["status"], payload.get("project_id")

        # Current domain result outranks historical failures within this production.
        if archived:
            category = "archived"
        elif state == "outcome_unknown":
            category = "needs_attention"
        elif task and task["status"] in RUNNING:
            category, state = "active", task["status"]
        elif state in HISTORY:
            category = "history"
        elif task and task["status"] == "cancelled":
            category, state = "history", "cancelled"
        else:
            category = "needs_attention"
            if task and task["status"] in {"paused", "failed"}:
                state = "outcome_unknown" if "unknown" in str(task["error_code"] or "") else task["status"]
        public = _step(task) if task else {}
        progress = 1 if state == "completed" else public.get("progress", 0)
        if batch:
            # Match the batch's completed_count: only completed candidates within
            # the requested target count, never the progress of an inner task.
            target_count = batch.get("target_count")
            progress = 0  # An unset target cannot establish a completion ratio.
            if type(target_count) is int and target_count > 0:
                candidates = (batch.get("candidates") or [])[:target_count]
                completed_count = sum(isinstance(candidate, dict) and candidate.get("status") == "completed"
                                      for candidate in candidates)
                progress = completed_count / target_count
        return {
            "production_id": group["production_id"], "kind": group["kind"],
            "title": redact_text(str(title))[:160], "state": state,
            "category": category, "archived": archived,
            "task_id": public.get("task_id"), "task_type": public.get("task_type") or group["kind"],
            "task_status": public.get("status"), "progress": progress,
            "project_id": project_id, "run_id": run["id"] if run and not session_is_current else None,
            "batch_id": batch["batch_id"] if batch else None,
            "session_id": session["id"] if session else None,
            "error_code": public.get("error_code") if category == "needs_attention" else None,
            "error_message": public.get("error_message") if category == "needs_attention" else None,
            "created_at": created_at, "updated_at": updated_at,
            "step_count": len(steps), "steps": steps,
        }

    @staticmethod
    def _summary(items):
        counts = {category: sum(item["category"] == category for item in items)
                  for category in ("active", "needs_attention", "history", "archived")}
        return {**counts, "pending": counts["active"] + counts["needs_attention"], "total": len(items)}

    def summary(self):
        return self._summary(self._groups())

    def list(self, *, view="pending", offset=0, limit=20):
        if view not in VIEWS:
            raise ContentEngineError("invalid_production_view", "制作列表筛选无效。")
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
            raise ContentEngineError("invalid_limit", "制作列表分页参数无效。")
        items = self._groups()
        summary = self._summary(items)
        selected = [item for item in items if view == "all" or item["category"] == view
                    or view == "pending" and item["category"] in {"active", "needs_attention"}]
        selected.sort(key=lambda item: (item["updated_at"], item["production_id"]), reverse=True)
        page = selected[offset:offset + limit]
        for item in page:
            item["steps"] = [_step(task) for task in item["steps"]]
        return {"items": page, "total": len(selected), "offset": offset, "limit": limit,
                "has_more": offset + limit < len(selected), "summary": summary}
