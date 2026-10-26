"""Operator-published viral script library: session-gated, read-only, strict schema."""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from service import GatewayConfig, GatewayServer, Handler, VIRAL_LIBRARY_MAX_BYTES, _merge_viral_library, _viral_library
import test_service


TRANSCRIPT = "物业经理千万别再招保洁了，一台洗地机顶六个人，一年省下二十万人工，评论区都在问多少钱。"


def item(**patch):
    return {"id": "7400000000000000001", "platform": "douyin", "title": "物业经理别再招保洁了，一台洗地机顶六个人", "transcript": TRANSCRIPT,
            "source": {"likes": 83900, "tags": [{"id": "high_likes", "label": "高赞", "value": 83900}]}, **patch}


def library(**patch):
    return {"schema": 2, "updatedAt": "2026-10-24T08:00:00Z",
            "stats": {"collected": 64, "duplicates": 7, "final": 15, "ready": 1},
            "flow": {"strands": [{"id": "1", "title": "t", "source": "抖音", "group": "1", "outcome": "pass", "reason": "高赞"}]},
            "items": [item()], **patch}


class ViralLibraryTest(unittest.TestCase):
    post_json = test_service.GatewayTest.post_json
    session = test_service.GatewayTest.session

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "viral-library.json"
        expires = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
        self.config = GatewayConfig(keys={"deepseek": "k"}, session_secret="library-secret", receipt_db_path=self.directory.name + "/r.db",
                                    viral_library_path=str(self.path), license_validator=lambda _: {"license_id": "customer", "expires_at": expires})
        self.server = GatewayServer(("127.0.0.1", 0), Handler, self.config)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.origin = "http://127.0.0.1:" + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.directory.cleanup()

    def get(self, token=None):
        headers = {"Authorization": "Bearer " + token} if token else {}
        request = urllib.request.Request(self.origin + "/v1/provider-gateway/viral-library", headers=headers)
        try:
            response = urllib.request.urlopen(request)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def test_requires_session_and_reports_missing_library(self):
        self.assertEqual(self.get(), (401, {"error": "session_required"}))
        self.assertEqual(self.get(self.session()), (404, {"error": "viral_library_empty"}))

    def test_serves_published_library(self):
        self.path.write_text(json.dumps(library(), ensure_ascii=False), encoding="utf-8")
        status, body = self.get(self.session())
        self.assertEqual(status, 200)
        self.assertEqual(body["items"][0]["title"], "物业经理别再招保洁了，一台洗地机顶六个人")
        self.assertEqual(body["items"][0]["source"]["likes"], 83900)
        self.assertNotIn("transcript", body["items"][0], "原文案只留在云端")
        self.assertNotIn(TRANSCRIPT, json.dumps(body, ensure_ascii=False))
        self.assertEqual(body["stats"]["ready"], 1)

    def test_rejects_incomplete_or_oversized_documents(self):
        token = self.session()
        old = {"schema": 1, "items": [{"id": "1", "title": "t", "script": "s"}]}
        for bad in ("not json", json.dumps(old), json.dumps({"schema": 2, "items": []}), json.dumps(library(items=[])),
                    json.dumps(library(items=[item(title="x" * 61)])), json.dumps(library(items=[item(transcript="太短")])),
                    json.dumps(library(items=[item(platform="weibo")])), json.dumps(library(items=[item(id="../x")])), json.dumps([1, 2]),
                    json.dumps(library(items=[item()] * 2)), "[" * 100000):
            self.path.write_text(bad, encoding="utf-8")
            self.assertEqual(self.get(token), (503, {"error": "viral_library_invalid"}), bad[:40])
        self.path.write_bytes(b" " * (VIRAL_LIBRARY_MAX_BYTES + 1))
        self.assertEqual(self.get(token)[0], 503)
        with self.assertRaises(FileNotFoundError):
            _viral_library("")


TOKEN = "publish-token-" + "x" * 32
STRUCTURE = [{"part": "钩子", "method": "开头一句反常识的劝告"}, {"part": "行动号召", "method": "评论区问价引导私信"}]
TRANSCRIPT_2 = "洗地机到底是买还是租？今天把一年的账给你算清楚，算完你就知道哪种更划算了。"


class ViralLibraryPublishTest(ViralLibraryTest):
    """Operator publishing: token-gated, merges batches newest-first, structures extracted a few per call."""

    def setUp(self):
        super().setUp()
        self.config.viral_library_publish_token = TOKEN
        self.calls, self.replies = [], []
        self.config.upstream_open = self.upstream

    def upstream(self, request, timeout):
        self.calls.append(json.loads(request.data))
        reply = self.replies.pop(0) if self.replies else {"talkingHead": True, "reason": "", "structure": STRUCTURE}
        if isinstance(reply, Exception):
            raise reply
        return test_service.FakeResponse(body=json.dumps({"choices": [{"finish_reason": "stop", "message": {
            "content": json.dumps(reply, ensure_ascii=False)}}]}).encode())

    def operator(self, action, body, token=TOKEN):
        request = urllib.request.Request(self.origin + "/v1/provider-gateway/viral-library/" + action, data=json.dumps(body, ensure_ascii=False).encode(),
                                         headers={"Content-Type": "application/json", "Authorization": "Bearer " + token}, method="POST")
        try:
            response = urllib.request.urlopen(request)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def stored(self):
        return json.loads(self.path.read_text(encoding="utf-8"))

    def test_publish_requires_the_operator_token_and_a_valid_document(self):
        self.assertEqual(self.operator("publish", library(), token="wrong")[0], 401)
        self.assertEqual(self.operator("publish", library(), token=self.session())[0], 401, "客户会话不能发布")
        self.assertEqual(self.operator("publish", library(items=[item(transcript="太短")]))[0], 400)
        self.assertFalse(self.path.exists())
        self.config.viral_library_publish_token = ""
        self.assertEqual(self.operator("publish", library())[0], 404, "没配置密钥时没有发布接口")

    def test_batches_merge_newest_first_and_keep_old_items(self):
        self.assertEqual(self.operator("publish", library()), (200, {"ok": True, "added": 1, "updated": 0, "skipped": 0, "total": 1, "missingStructure": 1}))
        second = library(updatedAt="2026-11-24T08:00:00Z", stats={"collected": 100, "duplicates": 3, "final": 20, "byPlatform": {"douyin": 100}},
                         flow={"strands": [{"id": "2", "title": "t2", "source": "抖音", "group": "1", "outcome": "drop", "reason": "搬运"}]},
                         items=[item(id="2", title="买还是租", transcript=TRANSCRIPT_2), item(title="改过的标题")])
        self.assertEqual(self.operator("publish", second)[1]["added"], 1)
        doc = self.stored()
        self.assertEqual([entry["id"] for entry in doc["items"]], ["2", "7400000000000000001"], "新一批在前")
        self.assertEqual(doc["items"][1]["title"], "改过的标题")
        self.assertEqual(doc["stats"]["collected"], 164, "两次扒取的条数累加")
        self.assertEqual(doc["stats"]["ready"], 2)
        self.assertEqual([strand["id"] for strand in doc["flow"]["strands"]], ["2", "1"])
        self.assertEqual(doc["updatedAt"], "2026-11-24T08:00:00Z")
        self.assertEqual(len(list(self.path.parent.glob("viral-library.json.bak-*"))), 1, "旧文件留了备份")
        status, body = self.get(self.session())
        self.assertEqual((status, len(body["items"])), (200, 2), "客户马上读到合并后的库")

    def test_the_same_scan_published_again_is_counted_once(self):
        scan_a = library(scanId="a" * 32, stats={"collected": 557, "final": 21, "byPlatform": {"douyin": 418, "xiaohongshu": 139}})
        self.operator("publish", scan_a)
        self.operator("publish", {**scan_a, "items": [item(), item(id="2", transcript=TRANSCRIPT_2)]})
        self.assertEqual(self.stored()["stats"]["collected"], 557, "同一次扒取发布两次只算一次")
        self.operator("publish", library(scanId="b" * 32, stats={"collected": 100, "byPlatform": {"douyin": 100}}))
        stats = self.stored()["stats"]
        self.assertEqual((stats["collected"], stats["byPlatform"]), (657, {"douyin": 518, "xiaohongshu": 139}), "不同扒取才累加")
        status, body = self.get(self.session())
        self.assertNotIn("batches", body)
        self.assertNotIn("scanId", body)
        self.assertEqual(self.operator("publish", library(scanId="../x"))[0], 400)

    def test_inflated_counts_from_before_scan_ids_are_replaced(self):
        self.path.write_text(json.dumps(library(stats={"collected": 1671, "final": 63}), ensure_ascii=False), encoding="utf-8")
        self.operator("publish", library(scanId="a" * 32, stats={"collected": 557, "final": 21}))
        self.assertEqual((self.stored()["stats"]["collected"], self.stored()["stats"]["final"]), (557, 21))

    def test_old_format_library_is_replaced_not_merged(self):
        self.path.write_text(json.dumps({"schema": 1, "items": [{"id": "1", "title": "t", "script": "s"}]}), encoding="utf-8")
        self.assertEqual(self.operator("publish", library())[1]["total"], 1)
        self.assertEqual(self.stored()["schema"], 2)

    def test_structures_are_extracted_a_few_per_call_and_never_twice(self):
        self.operator("publish", library(items=[item(), item(id="2", transcript=TRANSCRIPT_2)]))
        self.replies = [{"talkingHead": True, "reason": "", "structure": STRUCTURE}, RuntimeError("provider down")]
        status, body = self.operator("structure", {"limit": 2})
        self.assertEqual((status, body["structured"], body["failed"], body["missingStructure"]), (200, 1, 1, 1), "一条失败不影响另一条")
        self.assertIn(TRANSCRIPT, json.dumps(self.calls, ensure_ascii=False), "拆结构时 AI 看得到原文")
        self.assertEqual(self.operator("structure", {"limit": 8})[1], {"ok": True, "structured": 1, "rejected": 0, "rejectedReasons": [], "failed": 0, "missingStructure": 0})
        self.assertEqual(len(self.calls), 3, "已拆过的不再调用 AI")
        self.assertEqual(self.operator("structure", {"limit": 8})[1]["structured"], 0)
        self.assertEqual(len(self.calls), 3)
        self.assertTrue(all(entry["structure"] == STRUCTURE for entry in self.stored()["items"]))
        # 重新发布同一条（原文没变）保留已拆好的结构；原文变了就要重新拆
        self.operator("publish", library(items=[item(), item(id="2", transcript=TRANSCRIPT_2 + "补一句。")]))
        self.assertEqual([("structure" in entry) for entry in self.stored()["items"]], [True, False])
        status, body = self.get(self.session())
        self.assertNotIn("structure", json.dumps(body, ensure_ascii=False), "客户看不到拆出的结构")
        self.assertNotIn(TRANSCRIPT, json.dumps(body, ensure_ascii=False))

    def test_not_a_talking_head_script_is_taken_out_and_stays_out(self):
        lyrics = item(id="6", title="山峰等等我", transcript="我想要个潇洒的以后。山峰山峰等等我，带我去山那头，看看外面的世界。")
        doc = library(flow={"strands": [{"id": "6", "title": "t", "source": "抖音", "group": "6", "outcome": "pass", "reason": "进了文案库 · 高赞 2759"}]},
                      items=[item(), lyrics], scanId="a" * 32)
        self.operator("publish", doc)
        self.replies = [{"talkingHead": True, "reason": "", "structure": STRUCTURE}, {"talkingHead": False, "reason": "是歌词不是口播", "structure": []}]
        body = self.operator("structure", {"limit": 8})[1]
        self.assertEqual((body["structured"], body["rejected"], body["rejectedReasons"], body["missingStructure"]), (1, 1, ["是歌词不是口播"], 0))
        stored = self.stored()
        self.assertEqual([entry["id"] for entry in stored["items"]], ["7400000000000000001"])
        self.assertEqual(stored["stats"]["ready"], 1)
        self.assertEqual(stored["flow"]["strands"][0]["reason"], "高赞 2759", "流图上不再说它进了文案库")
        self.assertEqual(stored["rejected"], [{"id": "6", "reason": "是歌词不是口播"}])
        self.assertEqual(self.operator("publish", doc)[1]["skipped"], 1, "重新发布同一次扒取也不会再加回来")
        self.assertEqual(len(self.stored()["items"]), 1)
        status, public = self.get(self.session())
        self.assertNotIn("rejected", public)
        self.assertEqual(len(public["items"]), 1)

    def test_operator_removes_items_by_id(self):
        self.operator("publish", library(items=[item(), item(id="2", transcript=TRANSCRIPT_2), item(id="3", transcript=TRANSCRIPT_2)]))
        self.assertEqual(self.operator("remove", {"ids": ["2", "999"]}, token="wrong")[0], 401)
        self.assertEqual(self.operator("remove", {"ids": ["2", "999"]})[1], {"ok": True, "removed": 1, "total": 2})
        self.assertEqual(self.operator("remove", {"ids": ["../x"]})[0], 400)
        self.assertEqual(self.operator("remove", {"ids": ["3", "7400000000000000001"]})[0], 422, "不能把客户看的库删空")
        self.assertEqual(len(self.stored()["items"]), 2)
        self.operator("publish", library(items=[item(id="2", transcript=TRANSCRIPT_2)] + [item(id="4", transcript=TRANSCRIPT_2)]))
        self.assertNotIn("2", [entry["id"] for entry in self.stored()["items"]], "删掉的不会被重新发布加回来")

    def test_bad_structure_output_is_not_stored(self):
        self.operator("publish", library())
        self.replies = [{"talkingHead": True, "structure": [{"part": "乱写", "method": "x"}]}]
        self.assertEqual(self.operator("structure", {"limit": 1})[1]["structured"], 0)
        self.assertNotIn("structure", self.stored()["items"][0])
        self.assertEqual(self.operator("structure", {"limit": 99})[0], 400)


class ViralLibraryMergeTest(unittest.TestCase):
    def test_cap_drops_the_oldest_and_regroups_orphaned_strands(self):
        old = library(items=[item(id=str(n)) for n in range(1, 801)], flow={"strands": [{"id": str(n), "group": "240", "outcome": "drop"} for n in range(1, 241)]})
        new = library(items=[item(id=f"n{n}") for n in range(300)], flow={"strands": [{"id": "x", "group": "kind-likes", "outcome": "pass"}]})
        merged = _merge_viral_library(old, new)
        self.assertEqual(len(merged["items"]), 1000)
        self.assertEqual(merged["items"][0]["id"], "n0")
        self.assertEqual(merged["items"][-1]["id"], "700", "超出上限时去掉最旧一批末尾的")
        self.assertEqual(len(merged["flow"]["strands"]), 240)
        self.assertEqual(merged["flow"]["strands"][1], {"id": "1", "group": "1", "outcome": "drop"}, "归到的那束被裁掉了就自成一束")
        self.assertEqual(_merge_viral_library(None, new)["stats"]["ready"], 300)


if __name__ == "__main__":
    unittest.main()
