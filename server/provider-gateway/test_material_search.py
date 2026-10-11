import tempfile
import unittest
from pathlib import Path
from material_search import MaterialSearch


class MaterialSearchTest(unittest.TestCase):
    def test_disabled_no_transport_and_durable_unknown_reservation(self):
        with tempfile.TemporaryDirectory() as folder:
            database = str(Path(folder) / "search.sqlite3")
            calls = []
            def timeout(query):
                calls.append(query)
                raise TimeoutError()
            service = MaterialSearch(database, env={}, transport=timeout)
            body = {"taskId": "task-00001", "query": "工厂机器人", "round": 1}
            self.assertFalse(service.search("license", body)["enabled"])
            self.assertEqual(calls, [])
            service.db.close()
            env = {"XIAOXI_MATERIAL_SEARCH_ENABLED": "1", "XIAOXI_BOCHA_API_KEY": "fixture", "XIAOXI_MATERIAL_SEARCH_BUDGET_MICROS": "10000", "XIAOXI_MATERIAL_SEARCH_COST_MICROS": "10000"}
            service = MaterialSearch(database, env=env, transport=timeout)
            self.assertEqual(service.search("license", body)["status"], "failed")
            service.db.close()
            service = MaterialSearch(database, env=env, transport=timeout)
            self.assertIn("预算", service.search("other", dict(body, taskId="task-00002"))["message"])
            self.assertEqual(len(calls), 1)
            service.db.close()

    def test_results_cancel_and_bounded_rounds(self):
        with tempfile.TemporaryDirectory() as folder:
            env = {"XIAOXI_MATERIAL_SEARCH_ENABLED": "1", "XIAOXI_BOCHA_API_KEY": "fixture", "XIAOXI_MATERIAL_SEARCH_BUDGET_MICROS": "100000", "XIAOXI_MATERIAL_SEARCH_COST_MICROS": "10000"}
            service = MaterialSearch(str(Path(folder) / "search.sqlite3"), env=env, transport=lambda query: {"data": {"webPages": {"value": [{"name": "视频", "url": "https://example.com/video"}, {"name": "bad", "url": "http://127.0.0.1/private"}]}}})
            body = {"taskId": "task-00001", "query": "工厂", "round": 1}
            result = service.search("license", body)
            self.assertEqual(len(result["items"]), 1)
            self.assertEqual(result["items"][0]["usage"], "reference")
            service.cancel_request("license", body["taskId"])
            self.assertEqual(service.search("license", dict(body, round=2))["status"], "cancelled")
            with self.assertRaises(ValueError):
                service.search("license", dict(body, round=3))
            service.db.close()


if __name__ == "__main__":
    unittest.main()
