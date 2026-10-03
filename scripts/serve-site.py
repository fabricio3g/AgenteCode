#!/usr/bin/env python3
"""Static server for site/ with caching off, for local design iteration."""
import functools
import http.server
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8099


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


http.server.test(HandlerClass=functools.partial(Handler, directory="site"),
                 port=PORT, bind="0.0.0.0")