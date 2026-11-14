#!/usr/bin/env python3
"""Persistent, isolated P2 preview. Models, wallet and chain are local fixtures.

No live credentials are accepted. Existing CVM gateway volumes are never mounted.
"""
import hashlib
import http.client
import importlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from urllib.parse import urlsplit

p2 = importlib.import_module('accept-agent-mpp-p2')
ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get('AGENT_PREVIEW_DATA', '/data'))
BINARY = os.environ.get('AGENT_PREVIEW_BINARY', '/usr/local/bin/private-market-host-p2')
NODE = os.environ.get('P1_NODE', '/usr/local/bin/node')
DIRECT = 'postgres://preview@127.0.0.1:25432/private_market_agent_preview'
ORIGIN = os.environ['AGENT_PREVIEW_ORIGIN']
OWNER_HASH = os.environ['AGENT_PREVIEW_OWNER_HASH']
BIND_PORT = int(os.environ.get('AGENT_PREVIEW_PORT', '3000'))
TTL = 604_800_000
STOP = threading.Event()


class CommandFailed(RuntimeError):
    pass


def command(*args, env=None):
    result = subprocess.run(args, env=env, capture_output=True, text=True)
    if result.returncode:
        # Command arguments can contain private fixture tokens or SQL values.
        raise CommandFailed('preview command failed: ' + Path(args[0]).name)
    return result.stdout


def sql(text):
    return command('psql', DIRECT, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', text).strip()


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def private(path, value):
    tmp = path.with_suffix('.new')
    tmp.write_text(json.dumps(value))
    tmp.chmod(0o600)
    tmp.replace(path)


def wait(check, seconds=90):
    end = time.monotonic() + seconds
    while time.monotonic() < end and not STOP.is_set():
        try:
            if check():
                return
        except (OSError, ValueError, CommandFailed, subprocess.SubprocessError, http.client.HTTPException):
            pass
        time.sleep(.2)
    raise RuntimeError('preview readiness timed out')


class Edge(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32
    slots = threading.BoundedSemaphore(16)

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(getattr(self, 'input_timeout', 15))
        return request, address

    def handle_error(self, *_):
        # Public malformed/abandoned requests must not produce stack-trace logs.
        pass

    def process_request(self, request, address):
        if not self.slots.acquire(False):
            request.sendall(b'HTTP/1.1 503 Busy\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def abort_input(self):
        self.close_connection = True
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def handle_one_request(self):
        # Socket inactivity alone does not bound slow clients that drip bytes.
        self.header_deadline = threading.Timer(getattr(self.server, 'input_timeout', 15), self.abort_input)
        self.header_deadline.start()
        try:
            super().handle_one_request()
        finally:
            self.header_deadline.cancel()

    def parse_request(self):
        try:
            return super().parse_request()
        finally:
            self.header_deadline.cancel()

    def forward(self):
        self.connection.settimeout(15)
        if not self.path.startswith('/') or self.path.startswith('//'):
            self.send_error(400)
            return
        path = urlsplit(self.path).path
        if not (path in ['/', '/proposal', '/proposal/', '/healthz', '/v1/chat/completions']
                or path.startswith(('/assets/', '/buyer-api/'))):
            self.send_error(404)
            return
        length = self.headers.get('Content-Length', '0')
        if not re.fullmatch(r'[0-9]{1,8}', length) or int(length) > 6 * 1024 * 1024:
            self.send_error(413)
            return
        if self.headers.get('Transfer-Encoding'):
            self.send_error(400)
            return
        # Native server validates the original public Origin. Do not rewrite it
        # to localhost or trust caller-provided Forwarded/X-Forwarded headers.
        headers = {k: v for k, v in self.headers.items() if k.lower() not in
                   ['host', 'connection', 'content-length', 'transfer-encoding']
                   and not k.lower().startswith(('forwarded', 'x-forwarded'))}
        body_deadline = threading.Timer(getattr(self.server, 'input_timeout', 15), self.abort_input)
        body_deadline.start()
        try:
            body = self.rfile.read(int(length)) if int(length) else None
        finally:
            body_deadline.cancel()
        if body is not None and len(body) != int(length):
            self.close_connection = True
            return
        connection = http.client.HTTPConnection('127.0.0.1', getattr(self.server, 'upstream_port', 28081), timeout=180)
        try:
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            data = response.read(16 * 1024 * 1024 + 1)
            if len(data) > 16 * 1024 * 1024:
                raise RuntimeError('preview response too large')
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in ['connection', 'content-length', 'transfer-encoding', 'server', 'date']:
                    self.send_header(key, value)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Frame-Options', 'SAMEORIGIN')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()
            self.wfile.write(data)
        except (OSError, RuntimeError, http.client.HTTPException):
            self.close_connection = True
        finally:
            connection.close()

    do_GET = do_POST = do_PATCH = forward


def main():
    os.umask(0o077)
    origin = urlsplit(ORIGIN)
    if not (origin.geturl() == origin.scheme + '://' + origin.netloc and not origin.username and not origin.password
            and (origin.scheme == 'https' or (origin.scheme == 'http' and origin.hostname == '127.0.0.1'))
            and re.fullmatch('[0-9a-f]{64}', OWNER_HASH) and 1 <= BIND_PORT <= 65535
            and BIND_PORT not in [25432, 26379, 28081, 28082, 28083, 28084]):
        raise RuntimeError('invalid preview public configuration')
    # Never adopt an unrelated PG/Redis service when invoked outside Docker.
    for port in [25432, 26379, 28081, 28082, 28083, 28084, BIND_PORT]:
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', port))
    DATA.mkdir(parents=True, exist_ok=True)
    DATA.chmod(0o700)
    processes, logs, seller, edge, pg_started = [], [], None, None, False
    for name in ['SIGTERM', 'SIGINT']:
        signal.signal(getattr(signal, name), lambda *_: STOP.set())

    def launch(args, name, env=None):
        log = (DATA / (name + '.log')).open('a')
        logs.append(log)
        process = subprocess.Popen(args, env=env, stdout=log, stderr=log)
        processes.append(process)
        return process

    try:
        pgdir = DATA / 'pg'
        if not (pgdir / 'PG_VERSION').exists():
            command('initdb', '-D', str(pgdir), '--username=preview', '--auth=trust', '--no-locale', '--encoding=UTF8')
        command('pg_ctl', '-D', str(pgdir), '-l', str(DATA / 'postgres.log'), '-o',
                '-h 127.0.0.1 -p 25432 -k /tmp -c shared_buffers=32MB -c max_connections=64', '-w', 'start')
        pg_started = True
        found = command('psql', '-h', '127.0.0.1', '-p', '25432', '-U', 'preview', '-d', 'postgres', '-At',
                        '-c', "SELECT 1 FROM pg_database WHERE datname='private_market_agent_preview'").strip()
        if not found:
            command('createdb', '-h', '127.0.0.1', '-p', '25432', '-U', 'preview', 'private_market_agent_preview')
        redis = DATA / 'redis'
        redis.mkdir(exist_ok=True)
        launch(['redis-server', '--bind', '127.0.0.1', '--port', '26379', '--dir', str(redis), '--save', '',
                '--appendonly', 'yes', '--appendfsync', 'always', '--maxmemory', '128mb', '--maxmemory-policy', 'noeviction'], 'redis')
        wait(lambda: command('redis-cli', '-p', '26379', 'ping').strip() == 'PONG')
        secrets_path = DATA / 'configuration.json'
        if not secrets_path.exists():
            private(secrets_path, {**{k: secrets.token_hex(32) for k in ['binding', 'cutover', 'seller', 'buyer', 'merchant', 'control', 'mppSecret']},
                                  'ownerHash': OWNER_HASH, 'origin': ORIGIN})
        config = json.loads(secrets_path.read_text())
        if config['ownerHash'] != OWNER_HASH or config['origin'] != ORIGIN:
            raise RuntimeError('preview ownership/configuration changed')
        state = DATA / 'market'
        env = {**os.environ, 'DATABASE_URL': DIRECT, 'REDIS_URL': 'redis://127.0.0.1:26379',
               'BITROUTER_PREVIEW_BOOTSTRAP_BINDING': config['binding'], 'REDIS_BALANCE_CUTOVER_TOKEN': config['cutover'],
               'PRIVATE_MARKET_SELLER_KEY': config['seller'], 'PRIVATE_MARKET_LISTEN': '127.0.0.1:28084',
               'PRIVATE_MARKET_NEAR_DIRECT_P1': 'controlled', 'PRIVATE_MARKET_AGENT_P2': 'controlled',
               'PRIVATE_MARKET_EXTERNAL_FIXTURE': '1',
               'PRIVATE_MARKET_P2_PREVIEW_TTL_MS': str(TTL), 'INFERENCE_MARKET_CONFIG_PATH': str(state / 'catalog.json'),
               'DATABASE_MIN_CONNECTIONS': '1', 'DATABASE_MAX_CONNECTIONS': '12'}
        initial = not (state / 'state.json').exists()
        if initial:
            command(BINARY, 'init', str(state), env=env)
        data = json.loads((state / 'state.json').read_text())
        seed_count = sql('SELECT count(*) FROM mpp_direct_p2_owners')
        if seed_count == '0':
            if sql('SELECT (SELECT count(*) FROM mpp_direct_tasks)+(SELECT count(*) FROM mpp_direct_orders)') != '0':
                raise RuntimeError('refusing to seed an occupied preview')
            # All additions commit together. Never refills or resets on restart.
            statements = ['BEGIN', 'INSERT INTO mpp_direct_p2_owners VALUES(' + literal(OWNER_HASH) + ",'preview-owner')"]
            for index, payer in enumerate(['agent.testnet', 'agent2.testnet']):
                buyer = data['buyers'][index]
                user, token = buyer['user'], buyer['token']
                task, session = 'task-' + str(index + 1), 'session-' + str(index + 1)
                statements.append('INSERT INTO mpp_direct_agents(user_id,token_hash,agent_id,payer,binding_version,native_balance,owner_id) VALUES(' +
                                  ','.join(map(literal, [user, hashlib.sha256(token.encode()).hexdigest(), 'agent-' + str(index + 1), payer, 'binding-1', '{}', 'preview-owner'])) + ')')
                statements.append('INSERT INTO mpp_direct_p2_agent_limits(user_id,budget_nano) VALUES(' + literal(user) + ',20000000)')
                statements.append('INSERT INTO mpp_direct_tasks(id,user_id,budget_nano,hard_bid_nano,call_cap_nano,deadline_ms) VALUES(' +
                                  ','.join(map(literal, [task, user, 10000000, 3000000, 3000000, int(time.time() * 1000) + TTL])) + ')')
                workspace = {'/workspace/task.txt': 'Compute the sum of numbers.txt, write result.txt, and verify the result.',
                             '/workspace/numbers.txt': '3\n7\n32\n' if index == 0 else '5\n5\n9\n'}
                statements.append('INSERT INTO mpp_direct_p2_sessions(id,user_id,task_id,prompt,workspace,created_ms) VALUES(' +
                                  ','.join(map(literal, [session, user, task, workspace['/workspace/task.txt'], json.dumps(workspace), int(time.time() * 1000)])) + ')')
            statements += ['INSERT INTO mpp_direct_project_budget(id,budget_yocto) VALUES(1,10000000000000000000000)',
                           'INSERT INTO mpp_direct_p2_market(singleton,observed_ms,usable_ms) VALUES(true,' + str(int(time.time() * 1000)) + ',500)',
                           'CREATE TABLE p2_fixture_seller_claims(order_id text PRIMARY KEY,body jsonb NOT NULL)', 'COMMIT']
            sql(';'.join(statements))
        if sql('SELECT count(*) FROM mpp_direct_p2_owners WHERE token_hash=' + literal(OWNER_HASH)) != '1':
            raise RuntimeError('preview owner binding missing')
        host, port = data['fixture_addr'].split(':')
        seller = ThreadingHTTPServer((host, int(port)), p2.SellerHandler)
        seller.daemon_threads = True
        seller.market = SimpleNamespace(sql=sql)
        seller.credential, seller.mode, seller.calls = config['seller'], 'normal', []
        seller.release = threading.Event()
        seller.release.set()
        threading.Thread(target=seller.serve_forever, daemon=True).start()
        launch([BINARY, 'serve', str(state)], 'market', env)
        def healthy(port):
            c = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
            try:
                c.request('GET', '/healthz')
                r = c.getresponse()
                return r.status == 200 and json.loads(r.read())['ready']
            finally:
                c.close()
        wait(lambda: healthy(28084))
        wallet = {'databaseUrl': DIRECT, 'buyerWalletKey': config['buyer'], 'walletFixtureKey': config['merchant'],
                  'faultControlKey': config['control'], 'port': 28083}
        private(DATA / 'wallet.json', wallet)
        launch([NODE, str(ROOT / 'services/mpp-near-direct/p2/test/wallet-fixture.mjs'), str(DATA / 'wallet.json')], 'wallet')
        def wallet_ready():
            with socket.create_connection(('127.0.0.1', 28083), timeout=1):
                return True
        wait(wallet_ready)
        payments = {'mode': 'controlled', 'phase2': True, 'network': 'testnet', 'realBroadcastEnabled': False,
                    'databaseUrl': DIRECT, 'upstream': 'http://127.0.0.1:28084', 'rpcUrl': 'http://127.0.0.1:28083/rpc',
                    'walletFixtureUrl': 'http://127.0.0.1:28083', 'buyerWalletKey': config['buyer'], 'walletFixtureKey': config['merchant'],
                    'faultControlKey': config['control'], 'gasSponsor': 'sponsor.testnet', 'hostBinary': BINARY,
                    'realm': 'payments.example.com', 'merchant': 'merchant.testnet', 'secret': config['mppSecret'],
                    'rateNanoPerNear': '2000000000', 'storagePriceYocto': '10000000000000000000',
                    'gasEstimateYocto': '100000000000000000000', 'paymentWindowMs': 60000, 'leaseTailMs': 15000,
                    'paymentEstimateMs': 100, 'estimatedTerminalMs': 500, 'refundAuto': True, 'port': 28082}
        app = {'port': 28081, 'publicOrigin': ORIGIN, 'buildRevision': os.environ.get('AGENT_PREVIEW_REVISION'),
               'agentCredentials': [{'userId': b['user'], 'token': b['token']} for b in data['buyers'][:2]], 'payments': payments}
        private(DATA / 'app.json', app)
        launch([NODE, str(ROOT / 'services/mpp-near-direct/p2/server.mjs'), str(DATA / 'app.json')], 'app')
        wait(lambda: healthy(28081))
        edge = Edge(('0.0.0.0', BIND_PORT), Handler)
        threading.Thread(target=edge.serve_forever, daemon=True).start()
        print(json.dumps({'ready': True, 'mode': 'controlled', 'origin': ORIGIN, 'realPayment': False}), flush=True)
        while not STOP.wait(2):
            if any(p.poll() is not None for p in processes):
                raise RuntimeError('preview child exited; persistent state retained')
            sql('UPDATE mpp_direct_p2_market SET observed_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint WHERE singleton')
    finally:
        if edge:
            edge.shutdown()
            edge.server_close()
        if seller:
            seller.shutdown()
            seller.server_close()
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
        for process in reversed(processes):
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if pg_started:
            command('pg_ctl', '-D', str(DATA / 'pg'), '-m', 'fast', '-w', 'stop')
        for log in logs:
            log.close()


if __name__ == '__main__':
    main()
