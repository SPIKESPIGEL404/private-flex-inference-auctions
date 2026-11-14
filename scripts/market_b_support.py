"""Owned, loopback-only infrastructure and native protocol fault fixtures."""
import contextlib
import importlib
import json
import os
from pathlib import Path
import signal
import socket
import socketserver
import struct
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import uuid

a = importlib.import_module("accept-market-a")
run, free_port, wait_for, http = a.run, a.free_port, a.wait_for, a.http
PROMPT = "Batch B public synthetic prompt " + "word " * 201


class Seller(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, credential):
        super().__init__(addr, SellerHandler)
        self.credential = credential
        self.mode = "success"
        self.schema_text = '{"values":[3]}'
        self.calls = []
        self.release = threading.Event()
        self.release.set()
        self.active = self.maximum = 0
        self.lock = threading.Lock()
        self.errors = []
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()


class SellerHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, status, content, media="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", media)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self):
        s = self.server
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/tokenize":
            self.send(200, b'{"tokenizer_ref":"controlled/tokenizer-v1","token_ids":[42,43]}')
            return
        try:
            assert self.path == "/v1/chat/completions"
            assert self.headers.get("Authorization") == "Bearer " + s.credential
            assert body["model"] == "native-a" and body["max_completion_tokens"] == 64
            assert body["stream"] and body["stream_options"]["include_usage"]
            assert not any(k.startswith("bitrouter_") or k == "background" for k in body)
            assert not any(k.lower().startswith("x-bitrouter-") for k in self.headers)
        except AssertionError:
            s.errors.append("native request isolation/identity check failed")
            self.send(400, b'{}')
            return
        with s.lock:
            s.calls.append(body)
            call = len(s.calls)
            s.active += 1
            s.maximum = max(s.maximum, s.active)
        try:
            if s.mode == "replace" and call == 1:
                self.send(503, b'{"error":{"code":"capacity_exceeded","message":"controlled unaccepted capacity failure"}}')
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()

            def chunk(choices, usage=None):
                return ("data: " + json.dumps({"id": "controlled-b", "object": "chat.completion.chunk", "created": 1,
                                              "model": "native-a", "choices": choices, "usage": usage}) + "\n\n").encode()

            delta = {"role": "assistant", "content": "verified"}
            if s.mode == "empty":
                delta = {}
            if s.mode == "refusal":
                delta = {"role": "assistant", "refusal": "controlled safety refusal"}
            if s.mode == "schema":
                delta = {"role": "assistant", "content": s.schema_text}
            self.wfile.write(chunk([{"index": 0, "delta": delta, "finish_reason": None}]))
            self.wfile.flush()
            assert s.release.wait(20), "test failed to release controlled seller"
            if s.mode == "disconnect":
                return  # No native terminator: must retain Unknown, never retry.
            output_tokens = 64 if s.mode == "cap" else 3
            reason = "length" if s.mode in ("cap", "early-cap") else "stop"
            self.wfile.write(chunk([{"index": 0, "delta": {}, "finish_reason": reason}]))
            if s.mode != "missing-usage":
                self.wfile.write(chunk([], {"prompt_tokens": 2, "completion_tokens": output_tokens, "total_tokens": output_tokens + 2}))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # Expected when a buyer/host disappears; not termination proof.
        finally:
            with s.lock:
                s.active -= 1


def exact(sock, count):
    data = bytearray()
    while len(data) < count:
        part = sock.recv(count - len(data))
        if not part:
            raise EOFError
        data.extend(part)
    return bytes(data)


class CommitProxy(socketserver.ThreadingTCPServer):
    """Drop a real PostgreSQL financial COMMIT acknowledgment, after COMMIT."""
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, upstream, financial_marker=b"UPDATE public.market_inference_cash SET receipt="):
        self.upstream = upstream
        self.financial_marker = financial_marker
        self.armed = threading.Event()
        self.fired = threading.Event()
        super().__init__(("127.0.0.1", 0), ProxyHandler)
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()


class ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self):
        client = self.request
        backend = socket.create_connection(self.server.upstream)
        financial = threading.Event()
        statements = {}
        try:
            # SSLRequest is refused by the owned plaintext test PG server.
            while True:
                size = exact(client, 4)
                startup = exact(client, struct.unpack("!I", size)[0] - 4)
                backend.sendall(size + startup)
                if startup == struct.pack("!I", 80877103):
                    assert exact(backend, 1) == b"N"
                    client.sendall(b"N")
                else:
                    break

            def responses():
                try:
                    while True:
                        tag = exact(backend, 1)
                        length = exact(backend, 4)
                        payload = exact(backend, struct.unpack("!I", length)[0] - 4)
                        if tag == b"C" and payload == b"COMMIT\0" and financial.is_set() and self.server.armed.is_set():
                            self.server.armed.clear()
                            self.server.fired.set()
                            return  # Database committed; client sees neither C nor ReadyForQuery.
                        client.sendall(tag + length + payload)
                        if tag == b"Z" and payload == b"I":
                            financial.clear()
                except (OSError, EOFError):
                    pass
                finally:
                    with contextlib.suppress(OSError):
                        client.shutdown(socket.SHUT_RDWR)

            thread = threading.Thread(target=responses, daemon=True)
            thread.start()
            while True:
                tag = exact(client, 1)
                length = exact(client, 4)
                payload = exact(client, struct.unpack("!I", length)[0] - 4)
                query = b""
                if tag == b"P":
                    name, query, _ = payload.split(b"\0", 2)
                    statements[name] = query
                if tag == b"B":
                    _, name, _ = payload.split(b"\0", 2)
                    query = statements.get(name, b"")
                if tag == b"Q":
                    query = payload
                if self.server.financial_marker in query:
                    financial.set()
                backend.sendall(tag + length + payload)
        except (OSError, EOFError):
            pass
        finally:
            backend.close()


class Market:
    """Each scenario has a fresh owned PG cluster, Redis and market state."""
    def __init__(self, binary, proxy=False, initialize=True):
        self.binary, self.proxy_enabled = binary, proxy
        self.initialize = initialize
        self.host = self.redis = self.seller = self.proxy = None
        self.pg_started = False

    def __enter__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="private-market-b-")
        self.root = Path(self.temp.name)
        self.pg = self.root / "pg"
        self.state = self.root / "state"
        pg_port, redis_port = free_port(), free_port()
        user = os.environ.get("USER", "market")
        name = "private_market_" + uuid.uuid4().hex
        self.direct = f"postgres://{user}@127.0.0.1:{pg_port}/{name}"
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("RAILWAY_", "BITROUTER_", "DATABASE_", "REDIS_", "PRIVATE_MARKET_", "INFERENCE_MARKET_"))}
        self.env.update(DATABASE_URL=self.direct, REDIS_URL=f"redis://127.0.0.1:{redis_port}",
                        BITROUTER_PREVIEW_BOOTSTRAP_BINDING=name, REDIS_BALANCE_CUTOVER_TOKEN=uuid.uuid4().hex,
                        PRIVATE_MARKET_SELLER_KEY=uuid.uuid4().hex, PRIVATE_MARKET_EXTERNAL_FIXTURE="1",
                        DATABASE_MIN_CONNECTIONS="1", DATABASE_MAX_CONNECTIONS="12",
                        INFERENCE_MARKET_CONFIG_PATH=str(self.state / "catalog.json"))
        self.log = (self.root / "host.log").open("w+")
        try:
            run("initdb", "-D", str(self.pg), "-U", user, "-A", "trust", "--no-locale", "-E", "UTF8")
            run("pg_ctl", "-D", str(self.pg), "-l", str(self.root / "pg.log"), "-o", f"-h 127.0.0.1 -p {pg_port} -k {self.root}", "-w", "start")
            self.pg_started = True
            run("createdb", "-h", "127.0.0.1", "-p", str(pg_port), "-U", user, name)
            self.redis = subprocess.Popen(["redis-server", "--bind", "127.0.0.1", "--port", str(redis_port), "--save", "", "--appendonly", "no", "--maxmemory-policy", "noeviction"], stdout=subprocess.DEVNULL)
            wait_for(lambda: subprocess.run(["redis-cli", "-p", str(redis_port), "ping"], capture_output=True).stdout.strip() == b"PONG")
            if not self.initialize:
                return self
            run(self.binary, "init", str(self.state), env=self.env)
            self.data = json.loads((self.state / "state.json").read_text())
            self.buyers = self.data["buyers"]
            address = self.data["fixture_addr"].split(":")
            self.seller = Seller((address[0], int(address[1])), self.env["PRIVATE_MARKET_SELLER_KEY"])
            if self.proxy_enabled:
                self.proxy = CommitProxy(("127.0.0.1", pg_port))
                self.env["DATABASE_URL"] = f"postgres://{user}@127.0.0.1:{self.proxy.server_address[1]}/{name}"
                # Bind state to the test connection path before starting the writer.
                self.data["database"] = self.env["DATABASE_URL"]
                (self.state / "state.json").write_text(json.dumps(self.data))
            return self
        except Exception:
            self.__exit__(None, None, None)
            raise

    def sql(self, query):
        return run("psql", self.direct, "-XAt", "-v", "ON_ERROR_STOP=1", "-c", query).strip()

    def configure(self, change):
        path = self.state / "catalog.json"
        catalog = json.loads(path.read_text())
        change(catalog)
        path.write_text(json.dumps(catalog))

    def start(self):
        self.log.seek(0)
        self.log.truncate()
        self.host = subprocess.Popen([self.binary, "serve", str(self.state)], env=self.env, stdout=self.log, stderr=self.log)
        def ready():
            assert self.host.poll() is None, (self.root / "host.log").read_text()
            lines = (self.root / "host.log").read_text().splitlines()
            return next((json.loads(l)["url"] for l in lines if l.startswith('{') and '"url"' in l), None)
        self.url = wait_for(ready, 30)

    def stop(self, crash=False):
        if self.host is not None and self.host.poll() is None:
            self.host.send_signal(signal.SIGKILL if crash else signal.SIGINT)
            self.host.wait(timeout=15)
        self.host = None

    def body(self):
        return {"model": "m/external", "messages": [{"role": "user", "content": PROMPT}],
                "max_completion_tokens": 64, "stream": True, "background": True,
                "stream_options": {"include_usage": True},
                "bitrouter_purchase": {"service_type": "on_demand", "provider_cap_micro_usd": 4500, "total_cap_micro_usd": 4510},
                "bitrouter_delivery": {"auto_fallback": "off"}}

    def post(self, key, buyer=0, body=None):
        return http(self.url + "/market/v1/chat/completions", self.buyers[buyer]["token"], body or self.body(), key)

    def receipt(self, key):
        return json.loads(self.sql(f"SELECT coalesce((SELECT r.receipt FROM market_inference_requests s JOIN market_inference_receipts r USING(request_id,revision) WHERE s.idempotency_key='{key}'),'null'::jsonb)"))

    def balance(self, buyer=0):
        return int(self.sql(f"SELECT balance_micro_usd FROM credit_accounts WHERE user_id='{self.buyers[buyer]['user']}'"))

    def effects(self):
        return int(self.sql("SELECT count(*) FROM market_inference_outbox WHERE kind='submit'"))

    def __exit__(self, exc_type, *_):
        if exc_type:
            print((self.root / "host.log").read_text())
        if self.seller:
            self.seller.release.set()
        self.stop(crash=True)
        for server in (self.seller, self.proxy):
            if server:
                server.shutdown()
                server.server_close()
        if self.redis:
            self.redis.terminate()
            self.redis.wait(timeout=5)
        if self.pg_started:
            run("pg_ctl", "-D", str(self.pg), "-m", "immediate", "-w", "stop")
        self.log.close()
        self.temp.cleanup()
