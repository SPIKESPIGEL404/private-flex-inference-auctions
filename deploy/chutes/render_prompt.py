"""Download only two pinned tokenizer files; verify against a live session.

No model weights, torch or GPU. Output is explicitly bound to the current epoch.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
from huggingface_hub import hf_hub_download
from transformers import PreTrainedTokenizerFast


def digest(domain, value):
    raw = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(domain.encode() + b"\0" + raw).hexdigest()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    session = json.loads(args.session.read_text())
    profile = session["profile"]
    paths = {name: Path(hf_hub_download(profile["served_model"], name, revision=profile["model_revision"])) for name in ("tokenizer.json", "tokenizer_config.json")}
    manifest = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in paths.items()}
    assert digest("flex-scheduler/tokenizer-files/v1", manifest) == profile["tokenizer_digest"]
    config = json.loads(paths["tokenizer_config.json"].read_text())
    template = config["chat_template"]
    assert digest("flex-scheduler/chat-template/v1", template) == profile["chat_template_digest"]
    tokenizer = PreTrainedTokenizerFast(tokenizer_file=str(paths["tokenizer.json"]), chat_template=template,
                                       **{k: config[k] for k in ("bos_token", "eos_token", "pad_token") if k in config})
    context = "This is a public synthetic scheduler validation context. Alpha beta gamma delta. " * 120
    messages = [{"role": "system", "content": "You are a helpful assistant. Answer directly without reasoning."},
                {"role": "user", "content": context + "\nWrite a very long tutorial with 100 numbered sections explaining scheduling and queues. Continue until the output limit; do not summarize early."}]
    ids = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=True, enable_thinking=False)
    assert 0 < len(ids) <= profile["max_prompt_tokens"] and all(0 <= t < profile["vocab_size"] for t in ids)
    result = {"engine_epoch": session["engine_epoch"], "profile_digest": session["profile_digest"], "token_ids": ids}
    with args.output.open("x") as file:
        json.dump(result, file, indent=2)
    with args.output.with_suffix(".provenance.json").open("x") as file:
        json.dump({"model_revision": profile["model_revision"], "tokenizer_files": manifest, "tokenizer_digest": profile["tokenizer_digest"],
                   "chat_template_digest": profile["chat_template_digest"], "enable_thinking": False, "add_generation_prompt": True,
                   "messages": messages, "prompt_tokens": len(ids)}, file, indent=2)
    print(json.dumps({"prompt_tokens": len(ids), "tokenizer_and_template_digests_verified": True}))


if __name__ == "__main__":
    main()
