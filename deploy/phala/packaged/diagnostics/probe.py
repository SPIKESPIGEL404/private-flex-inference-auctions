"""Temporary diagnostic: count known TLS ClientHello names at the CVM boundary.

Only counts for three fixed public SNI names and public DNS answers are saved.
No packet bytes, client addresses, application bodies or credentials are saved.
The capture stops after 15 minutes and opens no public network listener.
"""
import argparse
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler
import json
from pathlib import Path
import socket
import struct
import socketserver
import threading
import time

APP = "e83279da3fa5b47453cc62317df738b70fedf08c"
HOSTS = ["demo.bitrouter.ai", "api.demo.bitrouter.ai",
         APP + "-443s.dstack-pha1-prod9.phala.network"]


def client_hello(payload):
    if len(payload) < 44 or payload[0] != 22 or payload[1] != 3 or payload[5] != 1:
        return None
    end = 5 + int.from_bytes(payload[3:5], "big")
    if len(payload) < end:
        return None
    p = 43
    p += 1 + payload[p]
    p += 2 + int.from_bytes(payload[p:p + 2], "big")
    p += 1 + payload[p]
    extensions_end = p + 2 + int.from_bytes(payload[p:p + 2], "big")
    p += 2
    hostname, protocols = None, []
    while p + 4 <= min(end, extensions_end):
        kind, size = struct.unpack("!HH", payload[p:p + 4]); p += 4
        data = payload[p:p + size]; p += size
        if len(data) != size:
            return None
        if kind == 0 and len(data) >= 5 and data[2] == 0:
            hostname = data[5:5 + int.from_bytes(data[3:5], "big")].decode("ascii").lower()
        if kind == 16:
            i = 2
            while i < len(data):
                n = data[i]; i += 1
                protocols.append(data[i:i + n].decode("ascii")); i += n
    if hostname not in HOSTS:
        return None
    return hostname, "acme" if "acme-tls/1" in protocols else "normal"


def dns_name(data, p):
    labels, after, seen = [], None, set()
    while p < len(data):
        if p in seen:
            raise ValueError("DNS compression loop")
        seen.add(p)
        n = data[p]
        if n & 0xC0 == 0xC0:
            if after is None:
                after = p + 2
            p = ((n & 0x3F) << 8) | data[p + 1]
            continue
        p += 1
        if n == 0:
            return ".".join(labels), after if after is not None else p
        labels.append(data[p:p + n].decode("ascii")); p += n
    raise ValueError("truncated DNS name")


def dns_query(server, name, kind):
    tid = 0x4D52
    question = b"".join(bytes([len(x)]) + x.encode() for x in name.split(".")) + b"\0"
    request = struct.pack("!HHHHHH", tid, 0x0100, 1, 0, 0, 0) + question + struct.pack("!HH", kind, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(2)
        sock.sendto(request, (server, 53)); data, _ = sock.recvfrom(8192)
    transaction, flags, qd, an, ns, ar = struct.unpack("!HHHHHH", data[:12])
    if transaction != tid:
        raise ValueError("DNS transaction mismatch")
    p, answers = 12, []
    for _ in range(qd):
        _, p = dns_name(data, p); p += 4
    for _ in range(an):
        owner, p = dns_name(data, p)
        typ, cls, ttl, size = struct.unpack("!HHIH", data[p:p + 10]); p += 10
        start = p; p += size
        if typ == 5:
            value, _ = dns_name(data, start)
        elif typ == 16:
            chunks, i = [], start
            while i < start + size:
                n = data[i]; i += 1; chunks.append(data[i:i + n].decode("ascii")); i += n
            value = "".join(chunks)
        elif typ == 1 and size == 4:
            value = socket.inet_ntoa(data[start:p])
        else:
            continue
        answers.append({"type": typ, "name": owner, "value": value, "ttl": ttl})
    return {"rcode": flags & 15, "answers": answers}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="/out/netdiag.json")
    parser.add_argument("--resolv-conf", default="/host-resolv.conf")
    parser.add_argument("--duration", type=int, default=900)
    parser.add_argument("--socket")
    parser.add_argument("--token-sha256")
    args = parser.parse_args()
    output = Path(args.output)
    state = {"capture_ready": False, "capture_finished": False,
             "client_hello_packets": {h: {"normal": 0, "acme": 0} for h in HOSTS},
             "proxy_protocol_frames": {"v1": 0, "v2": 0},
             "partial_client_hello_packets": 0,
             "system_dns": [], "started_at_unix": int(time.time())}

    server = None
    if args.socket:
        if not args.token_sha256 or len(args.token_sha256) != 64:
            raise ValueError("a scoped diagnostic token hash is required")

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                authorization = self.headers.get("Authorization", "")
                valid = authorization.startswith("Bearer ") and len(authorization) < 512
                digest = hashlib.sha256(authorization[7:].encode()).hexdigest()
                valid = valid and hmac.compare_digest(digest, args.token_sha256)
                status = 200 if valid else 401
                if valid and self.path != "/domain-network.json":
                    status = 404
                data = json.dumps(state if status == 200 else {"error": "unavailable"}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers(); self.wfile.write(data)

            def log_message(self, *args):
                pass

        path = Path(args.socket)
        path.unlink(missing_ok=True)
        server = socketserver.UnixStreamServer(str(path), Handler)
        path.chmod(0o666)
        threading.Thread(target=server.serve_forever, daemon=True).start()

    def save():
        temporary = output.with_suffix(".new")
        temporary.write_text(json.dumps(state, separators=(",", ":")))
        temporary.chmod(0o644); temporary.replace(output)

    save()
    resolvers = [l.split()[1] for l in Path(args.resolv_conf).read_text().splitlines()
                 if l.startswith("nameserver ")]
    for i, server in enumerate(resolvers[:2]):
        for host in HOSTS[:2]:
            for name, kind in [(host, 5), ("_dstack-app-address." + host, 16),
                               ("_tapp-address." + host, 16)]:
                result = {"resolver_index": i, "name": name, "requested_type": kind}
                try:
                    result.update(dns_query(server, name, kind))
                except (OSError, ValueError, IndexError, UnicodeError, struct.error):
                    result["error"] = "DNS query failed"
                state["system_dns"].append(result)
    save()
    with socket.socket(socket.AF_PACKET, socket.SOCK_DGRAM, socket.htons(0x0800)) as capture:
        capture.settimeout(1)
        state["capture_ready"] = True; save()
        deadline = time.monotonic() + args.duration
        last_save = time.monotonic()
        while time.monotonic() < deadline:
            if time.monotonic() - last_save >= 1:
                save(); last_save = time.monotonic()
            try:
                packet = capture.recv(65535)
                if len(packet) < 40 or packet[0] >> 4 != 4 or packet[9] != 6:
                    continue
                p = (packet[0] & 15) * 4
                if int.from_bytes(packet[p + 2:p + 4], "big") != 443:
                    continue
                p += (packet[p + 12] >> 4) * 4
                payload = packet[p:]
                if payload.startswith(b"\r\n\r\n\0\r\nQUIT\n") and len(payload) >= 16:
                    state["proxy_protocol_frames"]["v2"] += 1
                    payload = payload[16 + int.from_bytes(payload[14:16], "big"):]
                elif payload.startswith(b"PROXY "):
                    state["proxy_protocol_frames"]["v1"] += 1
                    payload = payload.split(b"\r\n", 1)[-1]
                if len(payload) >= 6 and payload[0] == 22 and payload[5] == 1:
                    if len(payload) < 5 + int.from_bytes(payload[3:5], "big"):
                        state["partial_client_hello_packets"] += 1
                found = client_hello(payload)
                if found:
                    host, protocol = found
                    state["client_hello_packets"][host][protocol] += 1
            except socket.timeout:
                pass
            except (ValueError, IndexError, UnicodeError, struct.error):
                continue
    state["capture_finished"] = True; save()
    if server:
        server.shutdown(); server.server_close()


if __name__ == "__main__":
    main()
