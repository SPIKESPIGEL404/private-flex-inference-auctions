#!/usr/bin/env python3
"""Owned local edge checks: no databases, external service or credentials."""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import os
from pathlib import Path
import socket
import threading
import time
import unittest

os.environ.setdefault('AGENT_PREVIEW_ORIGIN', 'https://preview.example.com')
os.environ.setdefault('AGENT_PREVIEW_OWNER_HASH', '0' * 64)
spec = importlib.util.spec_from_file_location('preview', Path(__file__).with_name('serve-agent-mpp-preview.py'))
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        body = b'{"ready":true}'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Checks(unittest.TestCase):
    def setUp(self):
        self.upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        self.edge = preview.Edge(('127.0.0.1', 0), preview.Handler)
        self.edge.upstream_port = self.upstream.server_port
        self.edge.input_timeout = .5
        for server in [self.upstream, self.edge]:
            threading.Thread(target=server.serve_forever, daemon=True).start()

    def tearDown(self):
        for server in [self.edge, self.upstream]:
            server.shutdown()
            server.server_close()

    def health(self):
        c = http.client.HTTPConnection('127.0.0.1', self.edge.server_port, timeout=2)
        try:
            c.request('GET', '/healthz')
            r = c.getresponse()
            r.read()
            return r.status
        finally:
            c.close()

    def test_unfinished_headers_release_all_concurrency_slots(self):
        sockets = [socket.create_connection(('127.0.0.1', self.edge.server_port)) for _ in range(16)]
        try:
            for s in sockets:
                s.sendall(b'GET /healthz HTTP/1.1\r\nHost: localhost\r\n')
            end = time.monotonic() + .3
            while self.edge.slots._value and time.monotonic() < end:
                time.sleep(.01)
            self.assertEqual(self.health(), 503)
            time.sleep(.65)
            self.assertEqual(self.health(), 200)
        finally:
            for s in sockets:
                s.close()

    def test_slow_body_has_an_absolute_deadline(self):
        s = socket.create_connection(('127.0.0.1', self.edge.server_port))
        s.settimeout(2)
        try:
            s.sendall(b'POST /buyer-api/login HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{')
            time.sleep(.2)
            s.sendall(b' ')
            time.sleep(.2)
            s.sendall(b' ')
            self.assertEqual(s.recv(1), b'')
            self.assertEqual(self.health(), 200)
        finally:
            s.close()

    def test_readiness_retries_owned_command_failures(self):
        calls = []
        def readiness():
            calls.append(1)
            if len(calls) == 1:
                raise preview.CommandFailed('not ready')
            return True
        preview.wait(readiness, seconds=2)
        self.assertEqual(len(calls), 2)


if __name__ == '__main__':
    unittest.main()
