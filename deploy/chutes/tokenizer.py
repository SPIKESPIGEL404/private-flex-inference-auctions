"""Pinned local Qwen tokenizer. No model weights, remote code, or network calls."""
import hashlib
import http.server
import json
from pathlib import Path
import threading

from transformers import PreTrainedTokenizerFast
from gateway import PUBLIC_MODEL, canonical, require


class Tokenizer:
    def __init__(self, plan):
        files = {name: Path(path) for name, path in plan["tokenizer_files"].items()}
        require(all(hashlib.sha256(p.read_bytes()).hexdigest() == plan["tokenizer_files_sha256"][name]
            for name, p in files.items()), "tokenizer artifacts changed")
        config = json.loads(files["tokenizer_config.json"].read_bytes())
        template = config.get("chat_template") or files["chat_template.jinja"].read_text()
        self.tokenizer = PreTrainedTokenizerFast(tokenizer_file=str(files["tokenizer.json"]), chat_template=template,
            **{k: config[k] for k in ("bos_token", "eos_token", "pad_token") if k in config})
        self.reference = plan["tokenizer_ref"]

    def tokenize(self, request):
        require(request.get("model") == PUBLIC_MODEL and isinstance(request.get("messages"), list), "wrong tokenizer model")
        require(all(set(m) == {"role", "content"} and m["role"] in ("system", "user", "assistant")
            and isinstance(m["content"], str) for m in request["messages"]), "only qualified text Chat is supported")
        require(not any(request.get(k) is not None for k in ("tools", "tool_choice", "response_format", "chat_template_kwargs")),
            "unqualified tokenizer/template extension")
        tokens = self.tokenizer.apply_chat_template(request["messages"], tokenize=True, add_generation_prompt=True)
        require(0 < len(tokens) <= 8192, "prompt exceeds qualification bound")
        return tokens


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, plan, address):
        require(address[0] == "127.0.0.1", "tokenizer must bind loopback")
        self.qualifier = Tokenizer(plan)
        super().__init__(address, Handler)
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        try:
            size = int(self.headers["Content-Length"])
            require(self.path == "/tokenize" and 0 < size <= 128 * 1024, "invalid tokenization request")
            body = json.loads(self.rfile.read(size))
            require(body["model"] == PUBLIC_MODEL and body["protocol"] == "chat_completions"
                and body["tokenizer_ref"] == self.server.qualifier.reference, "tokenizer identity mismatch")
            raw = canonical({"tokenizer_ref": self.server.qualifier.reference,
                "token_ids": self.server.qualifier.tokenize(body["request"])})
            self.send_response(200)
        except Exception:
            self.send_response(400); raw = b"{}"
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers(); self.wfile.write(raw)
