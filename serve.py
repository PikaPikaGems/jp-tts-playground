"""Static file server for local development.

    python3 serve.py [port] [directory]        e.g.  python3 serve.py 8080   or   python3 serve.py 8090 deploy

Sends cache-busting and cross-origin-isolation headers (COOP/COEP; only needed if you experiment with threaded WASM).
"""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    directory = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.getcwd()
    print(f"Serving {directory} at http://localhost:{port}")
    ThreadingHTTPServer(("", port), partial(Handler, directory=directory)).serve_forever()
