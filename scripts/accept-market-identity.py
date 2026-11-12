#!/usr/bin/env python3
"""Controlled ACI/TLS/Market integration. No hardware or external inference."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import socketserver
import ssl
import subprocess
import sys
import threading
import time
import urllib.request
from market_b_support import Market, http, run

ROOT = Path(__file__).resolve().parent.parent
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
COMPOSE = 'services:\n  market:\n    image: controlled-test-only\n'
COMPOSE_HASH = hashlib.sha256(COMPOSE.encode()).hexdigest()
EVENT = {"imr": 3, "event_type": 1, "event": "compose-hash", "event_payload": COMPOSE_HASH,
         "digest": hashlib.sha384(COMPOSE.encode()).hexdigest()}
RTMR3 = hashlib.sha384(bytes(48) + bytes.fromhex(EVENT['digest'])).hexdigest()


class RpcHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path == '/GetQuote':
            slot = bytes.fromhex(body['report_data'])
            quote = bytearray(636)
            quote[:2] = b'\x04\x00'
            quote[4:8] = b'\x81\x00\x00\x00'
            quote[520:568] = bytes.fromhex(RTMR3)
            quote[568:632] = slot
            result = {'quote': quote.hex(), 'report_data': slot.hex(), 'event_log': '[]', 'vm_config': '{}'}
            if self.server.bad_slot:
                result['report_data'] = '00' * 64
        elif self.path == '/Info':
            tcb = {k: '00' * 48 for k in ['mrtd', 'rtmr0', 'rtmr1', 'rtmr2']}
            tcb.update(rtmr3=RTMR3, compose_hash=COMPOSE_HASH, device_id='controlled',
                       app_compose=COMPOSE, event_log=[EVENT])
            result = {k: 'controlled' for k in ['app_id', 'instance_id', 'app_cert', 'app_name', 'device_id', 'key_provider_info']}
            result.update(compose_hash=COMPOSE_HASH, tcb_info=tcb)
        else:
            self.send_error(404)
            return
        raw = json.dumps(result).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(raw)


class ProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.server.sensitive_posts += 1
        self.forward()

    def forward(self):
        body = None if self.command == 'GET' else self.rfile.read(int(self.headers['Content-Length']))
        request = urllib.request.Request(self.server.market_url + self.path, data=body,
            headers={k: v for k, v in self.headers.items() if k.lower() not in ('host', 'connection', 'content-length')}, method=self.command)
        try:
            response = OPENER.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            self.send_response(response.status)
            self.send_header('Content-Type', response.headers.get('Content-Type', 'application/json'))
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)


def certificate(root, name):
    run('openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(root / f'{name}.key'),
        '-out', str(root / f'{name}.csr'), '-subj', '/CN=127.0.0.1')
    (root / 'ext.cnf').write_text('subjectAltName=IP:127.0.0.1\n')
    run('openssl', 'x509', '-req', '-in', str(root / f'{name}.csr'), '-CA', str(root / 'ca.crt'),
        '-CAkey', str(root / 'ca.key'), '-CAcreateserial', '-out', str(root / f'{name}.crt'),
        '-days', '1', '-extfile', str(root / 'ext.cnf'))


def file_digest(path):
    return 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()


def attestation(url):
    status, body = http(url + '/market/v1/aci/attestation?nonce=' + '11' * 32)
    assert status == 200
    return json.loads(body)


def other_sessions(market):
    return int(market.sql(
        "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid <> pg_backend_pid()"
    ))


def append_newline(path):
    temporary = path.with_name(path.name + '.swap')
    temporary.write_bytes(path.read_bytes() + b'\n')
    os.replace(temporary, path)


def main(binary):
    os.umask(0o077)
    with Market(binary) as market:
        root = market.root
        run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(root / 'ca.key'),
            '-out', str(root / 'ca.crt'), '-days', '1', '-subj', '/CN=controlled-test-ca')
        for name in ('bound', 'wrong'):
            certificate(root, name)
        rpc = socketserver.UnixStreamServer(str(root / 'dstack.sock'), RpcHandler)
        rpc.bad_slot = False
        threading.Thread(target=rpc.serve_forever, daemon=True).start()
        proxies = []
        try:
            config = {'dstack_socket': str(root / 'dstack.sock'), 'tls_certificate': str(root / 'bound.crt'),
                      'public_domain': '127.0.0.1', 'keyset_lifetime_seconds': 300}
            (root / 'attestation.json').write_text(json.dumps(config))
            market.env['PRIVATE_MARKET_ATTESTATION_CONFIG'] = str(root / 'attestation.json')
            market.start()
            catalog_path = market.state / 'catalog.json'
            catalog_digest = file_digest(catalog_path)
            first = attestation(market.url)
            first_subject = first['attestation']['workload_keyset']['subject']
            first_keyset = first['workload_keyset_digest']
            assert first_subject == 'market-policy:' + catalog_digest
            def proxy(name):
                server = ThreadingHTTPServer(('127.0.0.1', 0), ProxyHandler)
                server.market_url, server.sensitive_posts = market.url, 0
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                context.load_cert_chain(root / f'{name}.crt', root / f'{name}.key')
                server.socket = context.wrap_socket(server.socket, server_side=True)
                threading.Thread(target=server.serve_forever, daemon=True).start()
                proxies.append(server)
                return f'https://127.0.0.1:{server.server_address[1]}'
            origin, wrong_origin = proxy('bound'), proxy('wrong')
            policy = {'version': 1, 'baseURL': origin + '/market/v1', 'acceptedComposeHashes': [COMPOSE_HASH],
                'acceptedBootMeasurements': [{k: '00' * 48 for k in ['mrtd', 'rtmr0', 'rtmr1', 'rtmr2']}],
                'acceptedPolicyDigests': [catalog_digest]}
            (root / 'policy.json').write_text(json.dumps(policy))
            (root / 'credential').write_text(market.buyers[0]['token'])
            (root / 'request.json').write_text(json.dumps(market.body()))
            driver = {'policy': policy, 'caFile': str(root / 'ca.crt'), 'credentialFile': str(root / 'credential'),
                      'requestFile': str(root / 'request.json')}
            driver_file = root / 'driver.json'
            driver_file.write_text(json.dumps(driver))
            env = dict(os.environ, NODE_EXTRA_CA_CERTS=str(root / 'ca.crt'))
            script = str(ROOT / 'clients/market-buyer/test/controlled-channel.mjs')
            for scenario in ['tamper', 'expired', 'nonce', 'release', 'boot', 'policy']:
                print(run('node', script, str(driver_file), scenario, env=env))
                assert sum(p.sensitive_posts for p in proxies) == 0 and market.effects() == 0
            driver['policy']['baseURL'] = wrong_origin + '/market/v1'
            driver_file.write_text(json.dumps(driver))
            print(run('node', script, str(driver_file), 'spki', env=env))
            assert sum(p.sensitive_posts for p in proxies) == 0 and market.effects() == 0
            # The production entry point must reject our unsigned fake hardware
            # evidence, before even trying to read these nonexistent input files.
            checked = subprocess.run(['node', str(ROOT / 'clients/market-buyer/cli.mjs'), 'buy', '--policy', str(root / 'policy.json'),
                '--credential-file', str(root / 'missing-credential'), '--request-file', str(root / 'missing-request'),
                '--idempotency-key', 'never-send'], env=env, capture_output=True, timeout=45)
            assert checked.returncode != 0 and b'market_identity_verified' not in checked.stderr
            assert sum(p.sensitive_posts for p in proxies) == 0 and market.effects() == 0
            driver['policy']['baseURL'] = origin + '/market/v1'
            driver_file.write_text(json.dumps(driver))
            completed = subprocess.run(['node', script, str(driver_file), 'success'], env=env,
                capture_output=True, text=True, timeout=45)
            assert completed.returncode == 0, completed.stderr
            print(completed.stdout)
            assert sum(p.sensitive_posts for p in proxies) == 1 and market.effects() == 1
            assert market.balance() == 24963
            assert market.receipt('d-controlled')['settlement'] == 'committed'
            market.stop()
            rpc.bad_slot = True
            refused = subprocess.run([binary, 'serve', str(market.state)], env=market.env, capture_output=True, timeout=40)
            assert refused.returncode != 0
            rpc.bad_slot = False
            append_newline(catalog_path)
            market.start()
            resealed = attestation(market.url)
            resealed_digest = file_digest(catalog_path)
            assert resealed['attestation']['workload_keyset']['subject'] == 'market-policy:' + resealed_digest
            assert resealed_digest != catalog_digest
            assert resealed['workload_keyset_digest'] != first_keyset
            assert sum(p.sensitive_posts for p in proxies) == 1 and market.effects() == 1
            market.stop()
            quiet = time.monotonic() + 20
            while other_sessions(market) and time.monotonic() < quiet:
                time.sleep(0.05)
            assert other_sessions(market) == 0
            # The first catalog hash runs before the database connect, and launch
            # runs after it. Replacing the file on that first connection lands
            # between the sealed digest and Market load.
            gap_log = root / 'gap.log'
            changed = False
            log = gap_log.open('w')
            proc = subprocess.Popen([binary, 'serve', str(market.state)], env=market.env,
                stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 40
                while proc.poll() is None and time.monotonic() < deadline:
                    if not changed and other_sessions(market) > 0:
                        append_newline(catalog_path)
                        changed = True
                    time.sleep(0.05)
                if proc.poll() is None:
                    proc.send_signal(signal.SIGINT)
                    proc.wait(timeout=20)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=10)
                log.close()
            gap_text = gap_log.read_text(errors='replace')
            assert changed and proc.returncode not in (0, None)
            assert 'catalog identity changed during startup' in gap_text
            assert '"url"' not in gap_text
            assert market.buyers[0]['token'] not in gap_text
            assert market.effects() == 1
        finally:
            for server in proxies:
                server.shutdown()
                server.server_close()
            rpc.shutdown()
            rpc.server_close()
    print(json.dumps({'buyer_market_identity': 'controlled-pass', 'hardware_attestation': False,
        'real_provider': False, 'external_inference_calls': 0, 'refusal_cases': 10,
        'controlled_tls_purchases': 1, 'provider_micro_usd': 35, 'platform_micro_usd': 2, 'balance_micro_usd': 24963}))


if __name__ == '__main__':
    main(str(Path(sys.argv[1]).resolve()))
