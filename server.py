#!/usr/bin/env python3
"""Static file server + server-side proxy for Steam endpoints.

Browsers block cross-origin fetches to store.steampowered.com (CORS), which
previously forced the frontend through flaky public proxies (corsproxy.io —
rate limits, random exit-node currency). Server-side requests have no CORS,
so the frontend now calls /proxy?url=... on this server instead.

Run:  python3 server.py [port]   (default 8934)
"""

import sys
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8934

# Only forward to hosts the app actually needs — this is not an open proxy.
ALLOWED_HOSTS = {
    'store.steampowered.com',
    'steamcommunity.com',
    'api.steampowered.com',
}

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/proxy?'):
            self.handle_proxy()
        else:
            super().do_GET()

    def handle_proxy(self):
        query = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(query)
        target = (params.get('url') or [None])[0]
        if not target:
            self.send_error(400, 'missing url param')
            return

        parsed = urllib.parse.urlparse(target)
        if parsed.scheme != 'https' or parsed.hostname not in ALLOWED_HOSTS:
            self.send_error(403, 'host not allowed')
            return

        req = urllib.request.Request(target, headers={
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
            'Accept-Language': 'en-US,en;q=0.9',
            # Age-gate bypass: mature-rated store pages 302 to an age-check
            # wall without these; a birthdate cookie marks the check passed.
            'Cookie': 'birthtime=189302401; wants_mature_content=1; lastagecheckage=1-January-1976',
        })
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = resp.read()
                self.send_response(200)
                self.send_header('Content-Type', resp.headers.get('Content-Type', 'text/html'))
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except Exception as e:
            self.send_error(502, f'upstream error: {e}')

    def log_message(self, format, *args):
        pass  # keep the terminal quiet


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'serving on http://localhost:{PORT}')
    server.serve_forever()
