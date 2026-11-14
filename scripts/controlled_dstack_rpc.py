#!/usr/bin/env python3
"""Controlled dstack GetQuote/Info HTTP mock for local Market attestation."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import sys

COMPOSE = "services:\n  market:\n    image: controlled-test-only\n"
COMPOSE_HASH = hashlib.sha256(COMPOSE.encode()).hexdigest()
EVENT = {
    "imr": 3,
    "event_type": 1,
    "event": "compose-hash",
    "event_payload": COMPOSE_HASH,
    "digest": hashlib.sha384(COMPOSE.encode()).hexdigest(),
}
RTMR3 = hashlib.sha384(bytes(48) + bytes.fromhex(EVENT["digest"])).hexdigest()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path in ("/GetQuote", "GetQuote"):
            slot = bytes.fromhex(body["report_data"])
            quote = bytearray(636)
            quote[:2] = b"\x04\x00"
            quote[4:8] = b"\x81\x00\x00\x00"
            quote[520:568] = bytes.fromhex(RTMR3)
            quote[568:632] = slot
            result = {
                "quote": quote.hex(),
                "report_data": slot.hex(),
                "event_log": "[]",
                "vm_config": "{}",
            }
        elif self.path in ("/Info", "Info"):
            tcb = {k: "00" * 48 for k in ["mrtd", "rtmr0", "rtmr1", "rtmr2"]}
            tcb.update(
                rtmr3=RTMR3,
                compose_hash=COMPOSE_HASH,
                device_id="controlled",
                app_compose=COMPOSE,
                event_log=[EVENT],
            )
            result = {
                k: "controlled"
                for k in [
                    "app_id",
                    "instance_id",
                    "app_cert",
                    "app_name",
                    "device_id",
                    "key_provider_info",
                ]
            }
            result.update(compose_hash=COMPOSE_HASH, tcb_info=tcb)
        else:
            self.send_error(404)
            return
        raw = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(raw)


def main():
    host, port = "127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 19527
    server = ThreadingHTTPServer((host, port), Handler)
    print(json.dumps({"controlled_dstack_rpc": f"http://{host}:{port}/"}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
