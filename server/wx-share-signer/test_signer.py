import json
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

from signer import Tickets, allowed_page, make_handler, signature


class SignerTest(unittest.TestCase):
    def test_signature_matches_the_wechat_documentation_example(self):
        ticket = "sM4AOVdWfPE4DxkXGEs8VMCPGGVi4C3VM0P37wVUCFvkVAy_90u5h9nbSlYy3-Sl-HhTdfl2fzFy1AOcHKP7qg"
        self.assertEqual("0f9de62fce790f9a083d5c99e95740ceb90c27ed",
                         signature(ticket, "Wm3WZYTPz0wzccnW", 1414587457, "http://mp.weixin.qq.com?params=value"))

    def test_only_official_site_pages_are_signed(self):
        self.assertEqual("https://www.xilianhui.cn/huoke/", allowed_page("https://www.xilianhui.cn/huoke/#download"))
        self.assertEqual("https://www.xilianhui.cn/huoke/?from=wx", allowed_page("https://www.xilianhui.cn/huoke/?from=wx"))
        self.assertEqual("https://www.xilianhui.cn/huoke", allowed_page("https://www.xilianhui.cn/huoke"))
        for bad in ["http://www.xilianhui.cn/huoke/", "https://evil.example/huoke/", "https://www.xilianhui.cn.evil.example/huoke/",
                    "https://www.xilianhui.cn/other/", "https://www.xilianhui.cn:8443/huoke/", "", None, "x" * 3000]:
            self.assertIsNone(allowed_page(bad), bad)

    def test_ticket_is_cached_and_refreshed_before_expiry(self):
        calls, now = [], [1000.0]

        def fetch(url):
            calls.append(url)
            return {"access_token": "AT"} if "/token?" in url else {"errcode": 0, "ticket": f"T{len(calls)}", "expires_in": 7200}

        tickets = Tickets("wxapp", "secret", fetch=fetch, clock=lambda: now[0])
        self.assertEqual("T2", tickets.current())
        self.assertEqual("T2", tickets.current())
        self.assertEqual(2, len(calls), "one token and one ticket request")
        now[0] += 7200 - 300 + 1
        self.assertEqual("T4", tickets.current())

    def test_service_answers_the_page_and_never_the_secret(self):
        tickets = Tickets("wxapp", "the-secret", fetch=lambda url: {"access_token": "AT"} if "/token?" in url else {"errcode": 0, "ticket": "TK"})
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(tickets))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            page = "https://www.xilianhui.cn/huoke/"
            with urllib.request.urlopen(base + "/huoke/api/wx-sign?url=" + urllib.parse.quote(page)) as response:
                body = json.loads(response.read())
            self.assertEqual("wxapp", body["appId"])
            self.assertEqual(signature("TK", body["nonceStr"], body["timestamp"], page), body["signature"])
            self.assertNotIn("the-secret", json.dumps(body))
            with urllib.request.urlopen(base + "/api/wx-sign?url=" + urllib.parse.quote(page)) as response:
                self.assertEqual("wxapp", json.loads(response.read())["appId"], "the path the site's nginx forwards")
            with self.assertRaises(urllib.error.HTTPError) as refused:
                urllib.request.urlopen(base + "/huoke/api/wx-sign?url=" + urllib.parse.quote("https://evil.example/"))
            self.assertEqual(400, refused.exception.code)
        finally:
            server.shutdown()


if __name__ == "__main__":
    unittest.main()
