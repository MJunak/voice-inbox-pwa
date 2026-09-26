"""Tests für den Sync-Server: python3 -m unittest server/test_server.py"""
import importlib.util, json, os, tempfile, threading, unittest
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError

TMP = tempfile.mkdtemp()
os.environ["DB_PATH"] = os.path.join(TMP, "test.db")
os.environ["API_TOKEN"] = "secret"
_spec = importlib.util.spec_from_file_location("sync_server", os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.py"))
server = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(server)


class SyncServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def call(self, method, path, body=None, token="secret"):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data = json.dumps(body).encode() if body is not None else None
        try:
            with urlopen(Request(self.base + path, data=data, method=method, headers=headers)) as res:
                raw = res.read()
                return res.status, json.loads(raw) if raw else None, res.headers
        except HTTPError as error:
            return error.code, None, error.headers

    def test_health_ohne_token(self):
        status, body, _ = self.call("GET", "/health", token=None)
        self.assertEqual((status, body), (200, {"status": "ok"}))

    def test_token_pflicht(self):
        self.assertEqual(self.call("GET", "/v1/entries", token=None)[0], 401)
        self.assertEqual(self.call("GET", "/v1/entries", token="falsch")[0], 401)
        self.assertEqual(self.call("PUT", "/v1/entries", {"entries": []}, token="falsch")[0], 401)

    def test_last_writer_wins_und_tombstones(self):
        entry = {"id": "lww", "text": "alt", "updatedAt": "2026-09-01T00:00:00.000Z"}
        self.call("PUT", "/v1/entries", {"entries": [entry]})
        self.call("PUT", "/v1/entries", {"entries": [{**entry, "text": "neu", "updatedAt": "2026-09-02T00:00:00.000Z"}]})
        self.call("PUT", "/v1/entries", {"entries": [{**entry, "text": "veraltet"}]})
        self.call("PUT", "/v1/entries", {"entries": [{**entry, "text": "neu", "updatedAt": "2026-09-03T00:00:00.000Z", "deletedAt": "2026-09-03T00:00:00.000Z"}]})
        _, body, _ = self.call("GET", "/v1/entries")
        stored = next(e for e in body["entries"] if e["id"] == "lww")
        self.assertEqual(stored["text"], "neu")
        self.assertEqual(stored["deletedAt"], "2026-09-03T00:00:00.000Z")

    def test_ungueltige_eintraege_und_json(self):
        status, _, _ = self.call("PUT", "/v1/entries", {"entries": [{"text": "ohne id"}, "quatsch", None]})
        self.assertEqual(status, 200)
        self.assertEqual(self.call("PUT", "/v1/entries", [1, 2])[0], 400)
        self.assertEqual(self.call("PUT", "/v1/entries", {"entries": "x"})[0], 400)
        req = Request(self.base + "/v1/entries", data=b"{kaputt", method="PUT", headers={"Authorization": "Bearer secret"})
        with self.assertRaises(HTTPError) as ctx:
            urlopen(req)
        self.assertEqual(ctx.exception.code, 400)

    def test_cors_preflight(self):
        status, _, headers = self.call("OPTIONS", "/v1/entries", token=None)
        self.assertEqual(status, 204)
        self.assertIn("Authorization", headers["Access-Control-Allow-Headers"])
        self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")


if __name__ == "__main__":
    unittest.main()
