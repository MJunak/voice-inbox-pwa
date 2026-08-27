import json, os, sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
DB_PATH=os.getenv("DB_PATH","/data/voice-inbox.db"); API_TOKEN=os.getenv("API_TOKEN",""); ALLOWED_ORIGIN=os.getenv("ALLOWED_ORIGIN","*")
def db():
 c=sqlite3.connect(DB_PATH); c.execute("CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)"); return c
class Handler(BaseHTTPRequestHandler):
 def reply(self,status=200):
  self.send_response(status); self.send_header("Content-Type","application/json; charset=utf-8"); self.send_header("Access-Control-Allow-Origin",ALLOWED_ORIGIN); self.send_header("Access-Control-Allow-Headers","Authorization, Content-Type"); self.send_header("Access-Control-Allow-Methods","GET, PUT, OPTIONS"); self.send_header("Access-Control-Allow-Private-Network","true"); self.send_header("Access-Control-Max-Age","600"); self.send_header("Vary","Origin, Access-Control-Request-Private-Network"); self.end_headers()
 def auth(self): return API_TOKEN and self.headers.get("Authorization")==f"Bearer {API_TOKEN}"
 def do_OPTIONS(self): self.reply(204)
 def do_GET(self):
  if urlparse(self.path).path=="/health": self.reply(); self.wfile.write(b'{"status":"ok"}'); return
  if urlparse(self.path).path!="/v1/entries": self.reply(404); return
  if not self.auth(): self.reply(401); return
  with db() as c: entries=[json.loads(r[0]) for r in c.execute("SELECT payload FROM entries ORDER BY updated_at DESC")]
  self.reply(); self.wfile.write(json.dumps({"entries":entries}).encode())
 def do_PUT(self):
  if urlparse(self.path).path!="/v1/entries": self.reply(404); return
  if not self.auth(): self.reply(401); return
  try:
   size=int(self.headers.get("Content-Length","0")); assert size<=5_000_000; entries=json.loads(self.rfile.read(size)).get("entries",[])
   with db() as c:
    for e in entries:
     if not e.get("id") or not e.get("updatedAt"): continue
     old=c.execute("SELECT updated_at FROM entries WHERE id=?",(e["id"],)).fetchone()
     if not old or e["updatedAt"]>old[0]: c.execute("INSERT OR REPLACE INTO entries VALUES (?,?,?)",(e["id"],json.dumps(e,ensure_ascii=False),e["updatedAt"]))
   self.reply(); self.wfile.write(b'{"ok":true}')
  except (ValueError,json.JSONDecodeError,AssertionError): self.reply(400)
 def log_message(self,*args): pass
if __name__=="__main__":
 if not API_TOKEN: raise SystemExit("API_TOKEN must be set")
 os.makedirs(os.path.dirname(DB_PATH),exist_ok=True); ThreadingHTTPServer(("0.0.0.0",8080),Handler).serve_forever()
