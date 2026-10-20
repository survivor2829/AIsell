import shutil
import sqlite3
import tempfile
from pathlib import Path
import unittest
from contextlib import closing

from content_engine.update_data_check import compare


class UpdateDataCheckTest(unittest.TestCase):
    def test_checkpoint_preserves_rows_and_corruption_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            live, old = root / "live.db", root / "old.db"
            connection = sqlite3.connect(live)
            try:
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("PRAGMA wal_autocheckpoint=0")
                connection.execute("CREATE TABLE receipts (id INTEGER PRIMARY KEY, result TEXT)")
                connection.execute("INSERT INTO receipts VALUES (1, 'outcome_unknown')")
                connection.commit()
                shutil.copyfile(live, old)
                shutil.copyfile(str(live) + "-wal", str(old) + "-wal")
                connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                self.assertTrue(compare(old, live, "business.db")["ok"])
                connection.execute("UPDATE receipts SET result='sent'")
                connection.commit()
                self.assertEqual(compare(old, live, "business.db")["reason"], "database_business_rows_changed")
            finally:
                connection.close()

    def test_only_verified_startup_fields_are_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            old, live = Path(directory) / "old.db", Path(directory) / "live.db"
            with closing(sqlite3.connect(old)) as db:
                db.execute("CREATE TABLE voice_personas_v1 (id INTEGER, voice TEXT, updated_at TEXT)")
                db.execute("INSERT INTO voice_personas_v1 VALUES (1, 'my-voice', 'before')")
                db.commit()
            shutil.copyfile(old, live)
            with closing(sqlite3.connect(live)) as db:
                db.execute("UPDATE voice_personas_v1 SET updated_at='after'")
                db.commit()
            self.assertTrue(compare(old, live, "content-engine.sqlite3")["ok"])
            self.assertFalse(compare(old, live, "unknown.db")["ok"])
            with closing(sqlite3.connect(live)) as db:
                db.execute("DELETE FROM voice_personas_v1")
                db.commit()
            self.assertFalse(compare(old, live, "content-engine.sqlite3")["ok"])
