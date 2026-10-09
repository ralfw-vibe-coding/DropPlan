# Lokaler Testserver ohne Browser-Cache, damit Änderungen an den Skripten sofort ankommen.
# Aufruf: python3 dev-server.py  ->  http://localhost:8080/
import http.server
import os

os.chdir(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


http.server.ThreadingHTTPServer(("", 8080), NoCacheHandler).serve_forever()
