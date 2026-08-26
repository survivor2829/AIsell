from __future__ import annotations

import json
import os
from pathlib import Path
import threading
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from content_engine import hashing
import content_engine.service as service_module
import worker as worker_module
from content_engine.database import Database
from content_engine.errors import ContentEngineError
from content_engine.service import ContentEngineService


def assert_public_payload(test_case: unittest.TestCase, payload, private_paths):
    encoded = json.dumps(payload, ensure_ascii=False)
    for private_path in private_paths:
        test_case.assertNotIn(str(private_path), encoded)

    def visit(value):
        if isinstance(value, dict):
            test_case.assertNotIn("absolute_path", value)
            test_case.assertNotIn("output_path", value)
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(payload)


class DatabaseTests(unittest.TestCase):
    def test_migrations_are_idempotent_and_pragmas_are_enabled(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            first = Database(data_dir)
            first.open()
            first_count = first.connection.execute(
                "SELECT COUNT(*) FROM schema_migrations"
            ).fetchone()[0]
            journal_mode = first.connection.execute("PRAGMA journal_mode").fetchone()[0]
            foreign_keys = first.connection.execute("PRAGMA foreign_keys").fetchone()[0]
            busy_timeout = first.connection.execute("PRAGMA busy_timeout").fetchone()[0]
            first.close()

            second = Database(data_dir)
            second.open()
            second_count = second.connection.execute(
                "SELECT COUNT(*) FROM schema_migrations"
            ).fetchone()[0]
            tables = {
                row[0]
                for row in second.connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            second.close()

            self.assertGreaterEqual(first_count, 1)
            self.assertEqual(first_count, second_count)
            self.assertEqual("wal", journal_mode.lower())
            self.assertEqual(1, foreign_keys)
            self.assertGreaterEqual(busy_timeout, 5_000)
            self.assertTrue(
                {
                    "assets",
                    "asset_locations",
                    "content_tasks",
                    "finished_videos",
                    "settings",
                    "schema_migrations",
                }.issubset(tables)
            )



    def test_concurrent_first_open_applies_each_migration_once(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            barrier = threading.Barrier(2)
            errors = []

            def open_database():
                database = Database(data_dir)
                try:
                    barrier.wait(timeout=5)
                    database.open()
                except Exception as error:
                    errors.append(error)
                finally:
                    database.close()

            threads = [threading.Thread(target=open_database) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=10)

            self.assertEqual([], errors)
            database = Database(data_dir).open()
            migration_count = database.connection.execute(
                "SELECT COUNT(*) FROM schema_migrations"
            ).fetchone()[0]
            database.close()
            self.assertGreaterEqual(migration_count, 2)
class FingerprintTests(unittest.TestCase):
    def test_sparse_large_file_uses_bounded_reads(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "large.mp4"
            with source.open("wb") as handle:
                handle.write(b"start")
                handle.seek(512 * 1024 * 1024 - 4)
                handle.write(b"tail")

            real_open = open
            bytes_read = 0

            class ReadSpy:
                def __init__(self, wrapped):
                    self._wrapped = wrapped

                def __enter__(self):
                    self._wrapped.__enter__()
                    return self

                def __exit__(self, *args):
                    return self._wrapped.__exit__(*args)

                def __getattr__(self, name):
                    return getattr(self._wrapped, name)

                def read(self, size=-1):
                    nonlocal bytes_read
                    data = self._wrapped.read(size)
                    bytes_read += len(data)
                    return data

            def spy_open(*args, **kwargs):
                return ReadSpy(real_open(*args, **kwargs))

            with mock.patch.object(hashing, "open_file", side_effect=spy_open):
                fingerprint = hashing.sampled_sha256(source, sample_bytes=64 * 1024)

            self.assertEqual(64, len(fingerprint))
            self.assertLessEqual(bytes_read, 3 * 64 * 1024)
            self.assertGreater(bytes_read, 0)


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.data_dir = self.root / "data"
        self.source_dir = self.root / "source"
        self.source_dir.mkdir()
        self.service = ContentEngineService(self.data_dir)

    def tearDown(self):
        self.service.close()
        self.temp_dir.cleanup()

    def _make_video(self, name: str, content: bytes = b"video-content") -> Path:
        path = self.source_dir / name
        path.write_bytes(content)
        return path

    def test_duplicate_import_reuses_asset_without_copying_original(self):
        first = self._make_video("lesson.mp4")
        second = self._make_video("lesson-copy.mov")
        result = self.service.import_files([str(first), str(second)])

        self.assertEqual(1, result["created_assets"])
        self.assertEqual(2, result["created_locations"])
        self.assertEqual(2, len(result["items"]))
        self.assertEqual(result["items"][0]["asset_id"], result["items"][1]["asset_id"])
        self.assertTrue(first.exists())
        self.assertTrue(second.exists())
        self.assertFalse(any(self.data_dir.rglob("lesson.mp4")))

        assets = self.service.list_assets()
        self.assertEqual(1, len(assets["items"]))
        self.assertEqual("unknown", assets["items"][0]["rights_status"])
        self.assertEqual(2, assets["items"][0]["location_count"])
        assert_public_payload(self, assets, [first.resolve(), second.resolve()])

    def test_archive_and_reveal_do_not_delete_or_expose_path(self):
        source = self._make_video("archive-me.mp4")
        item = self.service.import_files([str(source)])["items"][0]

        reveal = self.service.reveal_asset(item["asset_id"])
        archived = self.service.archive_asset(item["asset_id"])

        self.assertTrue(source.exists())
        self.assertTrue(reveal["available"])
        self.assertTrue(archived["archived"])
        self.assertEqual([], self.service.list_assets()["items"])
        self.assertEqual(
            1, len(self.service.list_assets(include_archived=True)["items"])
        )
        assert_public_payload(self, reveal, [source.resolve()])
        assert_public_payload(self, archived, [source.resolve()])

    def test_import_folder_skips_unsupported_files_and_symlink(self):
        accepted = self._make_video("accepted.MP4")
        (self.source_dir / "notes.txt").write_text("not media", encoding="utf-8")
        outside = self.root / "outside.mp4"
        outside.write_bytes(b"outside")
        link = self.source_dir / "linked.mp4"
        try:
            os.symlink(outside, link)
        except OSError:
            link = None

        result = self.service.import_folder(str(self.source_dir))

        self.assertEqual(1, result["created_assets"])
        self.assertEqual("accepted.mp4", result["items"][0]["display_name"].lower())
        self.assertGreaterEqual(result["skipped_count"], 1)
        if link is not None:
            self.assertFalse(any(item["display_name"] == "linked.mp4" for item in result["items"]))
        self.assertTrue(accepted.exists())

    def test_invalid_paths_and_illegal_task_transition_are_rejected(self):
        relative = "relative.mp4"
        with self.assertRaisesRegex(ContentEngineError, "absolute"):
            self.service.import_files([relative])
        with self.assertRaisesRegex(ContentEngineError, "does not exist"):
            self.service.import_files([str((self.root / "missing.mp4").resolve())])

        unsupported = self.source_dir / "notes.txt"
        unsupported.write_text("notes", encoding="utf-8")
        result = self.service.import_files([str(unsupported)])
        self.assertEqual(0, result["created_assets"])
        self.assertEqual(1, result["skipped_count"])

        task = self.service.create_task("course_clipping", {"title": "lesson"})
        with self.assertRaisesRegex(ContentEngineError, "transition"):
            self.service.update_task(task["task_id"], "completed")

    def test_inflight_tasks_are_paused_when_service_restarts(self):
        analyzing = self.service.create_task("course_clipping", {})
        rendering = self.service.create_task("smart_mix", {})
        self.service.update_task(analyzing["task_id"], "analyzing")
        self.service.update_task(rendering["task_id"], "analyzing")
        self.service.update_task(rendering["task_id"], "ready_for_review")
        self.service.update_task(rendering["task_id"], "rendering")
        self.service.close()

        self.service = ContentEngineService(self.data_dir)
        tasks = {item["task_id"]: item for item in self.service.list_tasks()["items"]}

        self.assertEqual("paused", tasks[analyzing["task_id"]]["status"])
        self.assertEqual("analyzing", tasks[analyzing["task_id"]]["resume_from_status"])
        self.assertEqual("paused", tasks[rendering["task_id"]]["status"])
        self.assertEqual("rendering", tasks[rendering["task_id"]]["resume_from_status"])

    def test_finished_videos_are_registered_without_exposing_output_path(self):
        output = self.root / "exports" / "final.mp4"
        output.parent.mkdir()
        output.write_bytes(b"finished")
        task = self.service.create_task("course_clipping", {})
        self.service.update_task(task["task_id"], "analyzing")
        self.service.update_task(task["task_id"], "ready_for_review")
        self.service.update_task(task["task_id"], "rendering")
        self.service.update_task(task["task_id"], "completed")

        registered = self.service.register_finished(
            str(output),
            title="课程精华",
            task_id=task["task_id"],
            metadata={"width": 1080, "height": 1920},
        )
        listed = self.service.list_finished()

        self.assertEqual(registered["finished_video_id"], listed["items"][0]["finished_video_id"])
        self.assertEqual("课程精华", listed["items"][0]["title"])
        self.assertTrue(registered["available"])
        self.assertTrue(listed["items"][0]["available"])
        assert_public_payload(self, registered, [output.resolve()])
        assert_public_payload(self, listed, [output.resolve()])

        output.unlink()
        missing = self.service.list_finished()
        self.assertEqual(registered["finished_video_id"], missing["items"][0]["finished_video_id"])
        self.assertFalse(missing["items"][0]["available"])



    def test_sample_collision_does_not_merge_different_large_files(self):
        first = self.source_dir / "collision-a.mp4"
        second = self.source_dir / "collision-b.mp4"
        with first.open("wb") as handle:
            handle.truncate(8 * 1024 * 1024)
        with second.open("wb") as handle:
            handle.truncate(8 * 1024 * 1024)
            handle.seek(2 * 1024 * 1024)
            handle.write(b"different-outside-samples")

        self.assertEqual(hashing.sampled_sha256(first), hashing.sampled_sha256(second))
        result = self.service.import_files([str(first), str(second)])

        self.assertEqual(2, result["created_assets"])
        self.assertNotEqual(result["items"][0]["asset_id"], result["items"][1]["asset_id"])

    def test_public_metadata_and_task_errors_redact_nested_paths(self):
        source = self._make_video("private-source.mp4")
        output = self.root / "exports" / "private-final.mp4"
        output.parent.mkdir()
        output.write_bytes(b"finished")
        asset = self.service.import_files([str(source)])["items"][0]
        finished = self.service.register_finished(
            str(output),
            metadata={
                "absolute_path": str(output),
                "nested": {"note": f"generated from {source.resolve()}"},
            },
        )

        task = self.service.create_task("course_clipping", {})
        self.service.update_task(task["task_id"], "analyzing")
        failed = self.service.update_task(
            task["task_id"], "failed", error_message=f"failed at {source.resolve()}"
        )

        public_payloads = [
            self.service.list_assets(),
            self.service.reveal_asset(asset["asset_id"]),
            finished,
            self.service.list_finished(),
            failed,
            self.service.list_tasks(),
        ]
        for payload in public_payloads:
            assert_public_payload(self, payload, [source.resolve(), output.resolve()])
        self.assertNotIn("absolute_path", finished["metadata"])
        self.assertIn("[redacted path]", failed["error_message"])

        asset_resolution = self.service.resolve_asset_path(asset["asset_id"])
        finished_resolution = self.service.resolve_finished_path(
            finished["finished_video_id"]
        )
        self.assertEqual(str(source.resolve()), asset_resolution["absolute_path"])
        self.assertEqual(str(output.resolve()), finished_resolution["absolute_path"])

    def test_pause_is_idempotent_and_resume_clears_restart_error(self):
        private_path = str((self.root / "private" / "lesson.mp4").resolve())
        task = self.service.create_task("course_clipping", {})
        self.service.update_task(task["task_id"], "analyzing")
        paused = self.service.update_task(
            task["task_id"],
            "paused",
            error_code="application_restarted",
            error_message=f"paused at {private_path}",
        )
        paused_again = self.service.update_task(task["task_id"], "paused")

        self.assertEqual("analyzing", paused["resume_from_status"])
        self.assertEqual("analyzing", paused_again["resume_from_status"])
        self.assertNotIn(private_path, paused_again["error_message"])

        resumed = self.service.update_task(task["task_id"], "analyzing")
        self.assertIsNone(resumed["resume_from_status"])
        self.assertIsNone(resumed["error_code"])
        self.assertIsNone(resumed["error_message"])

    def test_second_service_for_same_data_directory_is_rejected(self):
        with self.assertRaisesRegex(ContentEngineError, "already using"):
            ContentEngineService(self.data_dir)

    def test_folder_import_resumes_from_file_checkpoint_after_restart(self):
        for index in range(3):
            self._make_video(f"batch-{index}.mp4", f"video-{index}".encode())

        with mock.patch.object(
            service_module,
            "stable_sampled_sha256",
            wraps=service_module.stable_sampled_sha256,
        ) as sampled:
            first = self.service.import_folder(str(self.source_dir), batch_size=1)
            self.assertTrue(first["has_more"])
            self.assertEqual(1, sampled.call_count)
            self.service.close()

            self.service = ContentEngineService(self.data_dir)
            tasks = {
                item["task_id"]: item for item in self.service.list_tasks()["items"]
            }
            self.assertEqual("paused", tasks[first["task_id"]]["status"])
            resumed = self.service.resume_import_folder(
                first["task_id"], batch_size=10
            )

        self.assertFalse(resumed["has_more"])
        self.assertEqual("completed", resumed["status"])
        self.assertEqual(3, resumed["created_assets"])
        self.assertEqual(3, sampled.call_count)
        self.assertEqual(3, len(self.service.list_assets()["items"]))

    def test_data_directory_rejects_symlink_ancestor(self):
        target = self.root / "actual-data-root"
        target.mkdir()
        link = self.root / "linked-data-root"
        try:
            os.symlink(target, link, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"directory symlink unavailable: {error}")

        with self.assertRaisesRegex(ContentEngineError, "junction"):
            worker_module.validate_data_dir(str(link / "child"))

    def test_folder_checkpoint_survives_deletion_before_resume(self):
        sources = [
            self._make_video(f"stable-{name}.mp4", name.encode())
            for name in ("a", "b", "c")
        ]
        first = self.service.import_folder(str(self.source_dir), batch_size=1)
        self.assertTrue(first["has_more"])
        sources[0].unlink()
        self.service.close()

        self.service = ContentEngineService(self.data_dir)
        resumed = self.service.resume_import_folder(first["task_id"], batch_size=10)

        self.assertFalse(resumed["has_more"])
        self.assertEqual(3, resumed["processed_entries"])
        self.assertEqual(3, resumed["created_assets"])
        names = {item["display_name"] for item in self.service.list_assets()["items"]}
        self.assertTrue({"stable-b.mp4", "stable-c.mp4"}.issubset(names))

    def test_folder_checkpoint_distinguishes_casefold_collisions(self):
        names = ("strasse.mp4", "stra\N{LATIN SMALL LETTER SHARP S}e.mp4")
        sources = []
        for index, name in enumerate(names):
            try:
                sources.append(self._make_video(name, f"video-{index}".encode()))
            except OSError as error:
                self.skipTest(f"casefold-colliding filenames unavailable: {error}")
        if len({source.resolve() for source in sources}) != len(sources):
            self.skipTest("filesystem does not preserve casefold-colliding filenames")

        first = self.service.import_folder(str(self.source_dir), batch_size=1)
        self.assertTrue(first["has_more"])
        resumed = self.service.resume_import_folder(first["task_id"], batch_size=10)

        self.assertFalse(resumed["has_more"])
        self.assertEqual(2, resumed["created_assets"])
        imported_names = {
            item["display_name"] for item in self.service.list_assets()["items"]
        }
        self.assertEqual(set(names), imported_names)

    def test_asset_and_import_checkpoint_share_one_transaction(self):
        source = self._make_video("atomic.mp4")
        task = self.service.create_task("asset_import", {})

        def fail_progress_write(connection, _asset_created, _location_created):
            connection.execute(
                "UPDATE content_tasks SET result_json = ? WHERE id = ?",
                ('{"checkpoint_token":"atomic.mp4"}', task["task_id"]),
            )
            raise RuntimeError("simulated checkpoint failure")

        with self.assertRaisesRegex(RuntimeError, "checkpoint failure"):
            self.service._import_file(source, progress_writer=fail_progress_write)

        self.assertEqual([], self.service.list_assets()["items"])
        stored = self.service.connection.execute(
            "SELECT result_json FROM content_tasks WHERE id = ?", (task["task_id"],)
        ).fetchone()
        self.assertIsNone(stored["result_json"])

    def test_public_settings_redact_path_values(self):
        private_path = str((self.root / "private" / "cache").resolve())
        value = {
            "cache_path": private_path,
            "nested": {"note": f"stored under {private_path}"},
        }

        saved = self.service.set_setting("cache", value)
        loaded = self.service.get_setting("cache")

        assert_public_payload(self, saved, [private_path])
        assert_public_payload(self, loaded, [private_path])
        self.assertNotIn("cache_path", saved["value"])
        self.assertIn("[redacted path]", loaded["value"]["nested"]["note"])

    def test_paused_review_task_can_resume_to_review(self):
        task = self.service.create_task("course_clipping", {})
        self.service.update_task(task["task_id"], "analyzing")
        self.service.update_task(task["task_id"], "ready_for_review")
        paused = self.service.update_task(task["task_id"], "paused")

        self.assertEqual("ready_for_review", paused["resume_from_status"])
        resumed = self.service.update_task(task["task_id"], "ready_for_review")
        self.assertEqual("ready_for_review", resumed["status"])
        self.assertIsNone(resumed["resume_from_status"])
class WorkerProtocolTests(unittest.TestCase):
    def test_jsonl_protocol_emits_one_ready_and_echoes_request_ids(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(SIDECAR_ROOT / "worker.py"),
                    "--data-dir",
                    str(Path(temp_dir) / "data"),
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                bufsize=1,
            )
            self.addCleanup(lambda: process.kill() if process.poll() is None else None)

            ready = json.loads(process.stdout.readline())
            self.assertEqual("ready", ready["type"])

            process.stdin.write(json.dumps({"id": "health-1", "method": "health"}) + "\n")
            process.stdin.flush()
            health = json.loads(process.stdout.readline())
            self.assertEqual("health-1", health["id"])
            self.assertTrue(health["ok"])


            source = Path(temp_dir) / "protocol-source.mp4"
            source.write_bytes(b"protocol-video")
            process.stdin.write(
                json.dumps(
                    {
                        "id": "import-1",
                        "method": "import_files",
                        "params": {"paths": [str(source.resolve())]},
                    }
                )
                + "\n"
            )
            process.stdin.flush()
            imported = json.loads(process.stdout.readline())
            asset_id = imported["result"]["items"][0]["asset_id"]
            assert_public_payload(self, imported["result"], [source.resolve()])

            process.stdin.write(
                json.dumps(
                    {
                        "id": "resolve-asset-1",
                        "method": "resolve_asset_path",
                        "params": {"asset_id": asset_id},
                    }
                )
                + "\n"
            )
            process.stdin.flush()
            resolved_asset = json.loads(process.stdout.readline())
            self.assertEqual(
                str(source.resolve()), resolved_asset["result"]["absolute_path"]
            )

            process.stdin.write(
                json.dumps(
                    {
                        "id": "finished-1",
                        "method": "register_finished",
                        "params": {"output_path": str(source.resolve())},
                    }
                )
                + "\n"
            )
            process.stdin.flush()
            finished = json.loads(process.stdout.readline())
            finished_id = finished["result"]["finished_video_id"]
            assert_public_payload(self, finished["result"], [source.resolve()])

            process.stdin.write(
                json.dumps(
                    {
                        "id": "resolve-finished-1",
                        "method": "resolve_finished_path",
                        "params": {"finished_video_id": finished_id},
                    }
                )
                + "\n"
            )
            process.stdin.flush()
            resolved_finished = json.loads(process.stdout.readline())
            self.assertEqual(
                str(source.resolve()), resolved_finished["result"]["absolute_path"]
            )
            process.stdin.write(
                json.dumps({"id": "bad-1", "method": "missing_method"}) + "\n"
            )
            process.stdin.flush()
            error = json.loads(process.stdout.readline())
            self.assertEqual("bad-1", error["id"])
            self.assertFalse(error["ok"])


            unicode_value = "\u8bfe\u7a0b\U0001f3ac"
            unicode_request = {
                "id": "unicode-1",
                "method": "set_setting",
                "params": {"key": "protocol_probe", "value": unicode_value},
            }
            process.stdin.write(
                json.dumps(unicode_request, ensure_ascii=False) + "\n"
            )
            process.stdin.flush()
            unicode_response = json.loads(process.stdout.readline())
            self.assertEqual(unicode_value, unicode_response["result"]["value"])

            process.stdin.write(
                '{"id":"nan-1","method":"set_setting","params":{"key":"x","value":NaN}}\n'
            )
            process.stdin.flush()
            nan_response = json.loads(process.stdout.readline())
            self.assertEqual("nan-1", nan_response["id"])
            self.assertFalse(nan_response["ok"])
            self.assertEqual("invalid_json", nan_response["error"]["code"])

            process.stdin.write('{"id":NaN,"method":"health"}\n')
            process.stdin.flush()
            invalid_id_response = json.loads(process.stdout.readline())
            self.assertIsNone(invalid_id_response["id"])
            self.assertFalse(invalid_id_response["ok"])
            self.assertEqual("invalid_json", invalid_id_response["error"]["code"])

            process.stdin.write(
                json.dumps({"id": "health-after-invalid", "method": "health"}) + "\n"
            )
            process.stdin.flush()
            health_after_invalid = json.loads(process.stdout.readline())
            self.assertTrue(health_after_invalid["ok"])
            process.stdin.write(json.dumps({"id": "stop-1", "method": "shutdown"}) + "\n")
            process.stdin.flush()
            stopped = json.loads(process.stdout.readline())
            self.assertEqual("stop-1", stopped["id"])
            self.assertTrue(stopped["ok"])
            process.wait(timeout=10)

            remaining_stdout = process.stdout.read()
            self.assertNotIn('"type": "ready"', remaining_stdout)
            remaining_stderr = process.stderr.read()
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()
            self.assertEqual(0, process.returncode, remaining_stderr)


if __name__ == "__main__":
    unittest.main()
