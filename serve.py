"""Dev server for the wall: no caching, threaded, serves this directory."""

import http.server
import os
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8099


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


http.server.ThreadingHTTPServer.allow_reuse_address = True
httpd = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), NoCacheHandler)
print(f"serving on http://0.0.0.0:{PORT}", flush=True)
httpd.serve_forever()
