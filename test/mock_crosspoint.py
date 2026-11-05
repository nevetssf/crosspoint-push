"""Minimal stand-in for the CrossPoint File Transfer server (endpoints per docs/webserver-endpoints.md)."""
import json, os, sys, shutil
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote

ROOT = sys.argv[1]
LOG = []
DROP = {"status": 0}  # number of upcoming /api/status requests to drop

def fs(p): return os.path.join(ROOT, unquote(p).lstrip("/"))

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body=b"", ctype="text/plain"):
        LOG.append(f"{self.command} {urlparse(self.path).path} -> {code}")
        with open(os.path.join(ROOT, "..", "requests.log"), "a") as f: f.write(LOG[-1] + "\n")
        if isinstance(body, str): body = body.encode()
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/__drop_status":
            DROP["status"] = int(parse_qs(u.query)["n"][0]); return self.send(200, "ok")
        if u.path == "/api/status" and DROP["status"] > 0:
            DROP["status"] -= 1
            self.close_connection = True
            self.connection.shutdown(2)  # simulate the reader's radio not answering
            return
        if u.path == "/api/status":
            return self.send(200, json.dumps({"version": "2.0.0", "ip": "127.0.0.1", "mode": "STA", "device": "X4"}), "application/json")
        if u.path == "/api/files":
            p = fs(parse_qs(u.query).get("path", ["/"])[0])
            if not os.path.isdir(p): return self.send(404, "Directory not found")
            out = [{"name": n, "size": os.path.getsize(os.path.join(p, n)) if os.path.isfile(os.path.join(p, n)) else 0,
                    "isDirectory": os.path.isdir(os.path.join(p, n)), "isEpub": n.endswith(".epub")} for n in sorted(os.listdir(p))]
            return self.send(200, json.dumps(out), "application/json")
        self.send(404)
    def do_MKCOL(self):
        p = fs(urlparse(self.path).path.rstrip("/"))
        if os.path.exists(p): return self.send(405, "exists")
        if not os.path.isdir(os.path.dirname(p)): return self.send(409, "no parent")
        os.mkdir(p); self.send(201)
    def do_PUT(self):
        p = fs(urlparse(self.path).path)
        if not os.path.isdir(os.path.dirname(p)): return self.send(409, "no parent")
        n = int(self.headers.get("Content-Length", 0)); data = self.rfile.read(n)
        tmp = p + ".davtmp"; open(tmp, "wb").write(data); os.replace(tmp, p); self.send(201)
    def do_DELETE(self):
        p = fs(urlparse(self.path).path)
        if not os.path.exists(p): return self.send(404)
        os.remove(p) if os.path.isfile(p) else os.rmdir(p); self.send(204)

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[2])), H).serve_forever()
