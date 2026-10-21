import base64
import io
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import json
import threading
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone
from local_acquisition import LocalAcquisition, parse_document, public_addresses, read_public


class AcquisitionTest(unittest.TestCase):
    def test_authenticated_http_routes_do_not_call_a_paid_provider(self):
        from service import GatewayConfig, GatewayServer, Handler
        folder = tempfile.TemporaryDirectory()
        with patch.dict('os.environ', {}, clear=True):
            config = GatewayConfig.from_environment({"XIAOXI_GATEWAY_SESSION_SECRET": "isolated-test-session-secret"})
            config.receipt_db_path = str(Path(folder.name) / 'receipts.db')
            server = GatewayServer(('127.0.0.1', 0), Handler, config)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        origin = f'http://127.0.0.1:{server.server_port}/v1/provider-gateway/local-acquisition/'
        try:
            with self.assertRaises(urllib.error.HTTPError) as rejected:
                urllib.request.urlopen(urllib.request.Request(origin + 'status', data=b'{}', method='POST'))
            self.assertEqual(rejected.exception.code, 401)
            token, _ = config.sessions.issue('fixture-license', datetime.now(timezone.utc) + timedelta(hours=1))
            def invoke(action, body):
                request = urllib.request.Request(origin + action, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token}, method='POST')
                with urllib.request.urlopen(request) as response:
                    return json.load(response)
            self.assertFalse(invoke('status', {})['search'])
            parsed = invoke('parse', {'kind': 'html', 'content': base64.b64encode(b'<p>Original evidence</p>').decode()})
            self.assertIn('Original evidence', parsed['text'])
        finally:
            server.shutdown(); server.server_close(); folder.cleanup()

    def test_independent_budget_cache_and_budget_exhaustion(self):
        with tempfile.TemporaryDirectory() as folder:
            calls = []
            env = {"XIAOXI_BOCHA_API_KEY": "fixture", "XIAOXI_MATERIAL_SEARCH_ENABLED": "1", "XIAOXI_PRECISE_PUBLIC_READ_ENABLED": "1", "XIAOXI_PRECISE_SOURCE_HOSTS": "example.com"}
            transport = lambda q: calls.append(q) or {"data": {"webPages": {"value": []}}}
            service = LocalAcquisition(str(Path(folder) / "disabled.db"), env, transport)
            self.assertFalse(service.status()["search"])
            self.assertEqual(calls, [])
            service.close()
            env.update(XIAOXI_PRECISE_SEARCH_ENABLED="1", XIAOXI_PRECISE_SEARCH_BUDGET_MICROS="1", XIAOXI_PRECISE_SEARCH_COST_MICROS="1", XIAOXI_PRECISE_SEARCH_DAILY_LIMIT="10")
            service = LocalAcquisition(str(Path(folder) / "paid.db"), env, transport)
            body = {"taskId": "11111111-1111-1111-1111-111111111111", "step": 0, "query": "fixture"}
            self.assertEqual(service.handle("search", "A", body)["status"], "completed")
            service.handle("search", "A", body)
            self.assertEqual(len(calls), 1)
            service.handle("search", "A", dict(body, step=1))
            self.assertEqual(len(calls), 1, 'new tasks must also reuse cached queries')
            denied = service.handle("search", "A", dict(body, step=1, query='different query'))
            self.assertEqual(denied["status"], "unavailable")
            self.assertFalse(denied["enabled"])
            service.close()

    def test_public_reader_rejects_internal_and_unauthorized_destinations(self):
        resolver = lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]
        with self.assertRaises(ValueError):
            public_addresses("example.com", 443, resolver)
        with patch("local_acquisition.socket.create_connection") as connect:
            with self.assertRaises(ValueError):
                read_public("https://not-approved.example/", {"example.com"})
            connect.assert_not_called()
        parsed = parse_document(b'<html><script>unsafe()</script><p>real evidence</p></html>', "html")
        self.assertIn("real evidence", parsed["text"])
        self.assertNotIn("unsafe", parsed["text"])

    def test_text_pdf_and_scanned_pdf_are_distinct(self):
        try:
            from pypdf import PdfWriter
            from pypdf.generic import DecodedStreamObject, NameObject, DictionaryObject
        except ImportError:
            self.skipTest("install requirements-precise.txt for text PDF acceptance")
        writer = PdfWriter()
        page = writer.add_blank_page(width=300, height=300)
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
        stream = DecodedStreamObject(); stream.set_data(b"BT /F1 12 Tf 20 200 Td (Fixture evidence) Tj ET")
        page[NameObject("/Contents")] = writer._add_object(stream)
        output = io.BytesIO(); writer.write(output)
        parsed = parse_document(output.getvalue(), "pdf")
        self.assertIn("Fixture evidence", parsed["text"])
        self.assertFalse(parsed["parseIncomplete"])
        blank = PdfWriter(); blank.add_blank_page(width=300, height=300); output = io.BytesIO(); blank.write(output)
        self.assertTrue(parse_document(output.getvalue(), "pdf")["parseIncomplete"])


if __name__ == "__main__":
    unittest.main()
