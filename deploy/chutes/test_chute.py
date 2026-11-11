"""Local checks of deployment and frozen-input enforcement; no GPU/network calls."""
import copy
import importlib.util
from pathlib import Path
import unittest
import json
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
from unittest.mock import AsyncMock
from fastapi import HTTPException

spec = importlib.util.spec_from_file_location("scheduler_chute", Path(__file__).with_name("chute.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ChuteContractTests(unittest.TestCase):
    def setUp(self):
        self.session = {"engine_epoch": "fixture-epoch", "profile_digest": "11" * 32, "profile": {"vocab_size": 1024}}
        self.request = {"execution_id": "fixture-exec", "grant_id": "fixture-grant", "request_ref": "fixture-request", "owner_ref": "opaque-owner", "rank": 1, "prompt_token_ids": [1, 2, 3], "sampling_config": {"temperature_milli": 0, "top_p_millionths": 1000000, "top_k": 50, "seed": 42, "stop_token_ids": []}, "max_output_tokens": 8, "context_reservation": 11, "max_result_bytes": 1000, "cache_namespace": "fixture"}
        self.request["request_digest"] = module.digest("flex-scheduler/request/v1", self.request)
        self.binding = {"execution_id": "fixture-exec", "grant_id": "fixture-grant", "request_digest": self.request["request_digest"], "engine_epoch": "fixture-epoch", "plan_id": "fixture-plan", "plan_seq": 1, "manifest_hash": "22" * 32}
        self.body = {"stream": True, "request_id": self.request["execution_id"]}
        self.body["_flex"] = {"request": self.request, "binding": self.binding, "engine_epoch": "fixture-epoch", "profile_digest": "11" * 32}

    def test_bound_request_preserves_input_and_removes_only_control_envelope(self):
        wire, binding = module.validate_submission(self.body, self.session)
        self.assertEqual(wire, module.completion_body(self.request))
        self.assertEqual(wire["prompt"], [1, 2, 3])
        self.assertEqual(binding, self.binding)
        self.assertNotIn("_flex", wire)

    def test_wrong_epoch_and_profile_are_rejected(self):
        for key in ("engine_epoch", "profile_digest"):
            body = copy.deepcopy(self.body)
            body["_flex"][key] = "wrong"
            with self.assertRaises(HTTPException) as raised:
                module.validate_submission(body, self.session)
            self.assertEqual(raised.exception.status_code, 409)

    def test_modified_prompt_sampling_or_unknown_field_is_rejected(self):
        changes = {"prompt": [7], "temperature": 1.0, "model": "other", "ignore_eos": True, "return_token_ids": False}
        for key, value in changes.items():
            body = copy.deepcopy(self.body)
            body[key] = value
            with self.assertRaises(HTTPException):
                module.validate_submission(body, self.session)

    def test_changed_frozen_request_or_binding_is_rejected(self):
        for target, key in (("request", "max_output_tokens"), ("binding", "request_digest")):
            body = copy.deepcopy(self.body)
            body["_flex"][target][key] = 7
            with self.assertRaises(HTTPException):
                module.validate_submission(body, self.session)

    def test_gateway_envelope_is_supported_without_changing_content(self):
        plain = module.validate_submission(self.body, self.session)
        routed = {**self.body, "model": module.MODEL, "stream_options": {"include_usage": True, "continuous_usage_stats": True}}
        self.assertEqual(module.validate_submission({"json": routed, "params": {}}, self.session), plain)
        self.assertFalse(plain[0]["stream_options"]["continuous_usage_stats"])
        self.assertEqual(module.envelope({"json": {"messages": [], "model": module.MODEL}, "params": {}}), {"messages": []})

    def test_native_inference_endpoints_are_not_exposed(self):
        paths = {cord.public_api_path for cord in module.chute.chute.cords}
        self.assertIn("/scheduler/completions", paths)
        self.assertNotIn("/v1/completions", paths)
        self.assertNotIn("/v1/chat/completions", paths)
        self.assertEqual(module.chute.chute.max_instances, 1)
        self.assertEqual(module.chute.chute.node_selector.gpu_count, 1)
        self.assertEqual(module.chute.chute.standard_template, "vllm")
        self.assertTrue(module.chute.chute.lock_modules)


class NativeControlTests(unittest.IsolatedAsyncioTestCase):
    async def test_replacement_probe_accepts_same_instance_with_fresh_heartbeat(self):
        import restart
        old = {"engine_epoch": "old", "profile": {"fixed": "profile"}}
        prepared = {"old_instance_id": "old-instance", "old_engine_epoch": "old"}
        instance = {"instance_id": "new-instance", "active": True, "verified": True, "last_verified_at": "before"}
        current = {"public": False, "disabled": False, "max_instances": 1, "version": "fixed-version", "instances": [instance]}
        checked = {**current, "instances": [{**instance, "last_verified_at": "after"}]}
        fresh = {"engine_epoch": "new", "profile": old["profile"], "accepting": True}
        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(evidence=Path(directory) / "isolation.json")
            with patch.object(restart, "call", side_effect=[(200, current), (200, checked)]), patch.object(restart, "control_post", new=AsyncMock(return_value=fresh)):
                await restart.wait_replacement(args, "synthetic", old, prepared, None)
            self.assertEqual(json.loads(args.evidence.read_text())["new_instance_id"], "new-instance")

    async def test_native_client_supports_template_without_optional_mtls_attribute(self):
        app = SimpleNamespace(passthrough_headers={"Authorization": "Bearer synthetic"})
        async with module.native_session(app) as client:
            self.assertEqual(str(client._base_url), "http://127.0.0.1:10101")
            self.assertFalse(client.trust_env)

    async def test_native_tokenizer_reads_fragmented_body_and_preserves_fixed_rendering(self):
        class Reply:
            status, content_length = 200, None

            def __init__(self):
                self.content = self

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def iter_chunked(self, size):
                raw = json.dumps({"tokens": [1, 2, 3]}).encode()
                yield raw[:5]
                yield raw[5:]

        class Client(Reply):
            def post(self, path, json):
                self.captured = (path, json)
                return Reply()

        client = Client()
        app = SimpleNamespace(flex_session={"engine_epoch": "fixture", "profile_digest": "11" * 32, "profile": {"vocab_size": 10}})
        function = next(c._func for c in module.chute.chute.cords if c.public_api_path == "/scheduler/tokenize")
        messages = [{"role": "user", "content": "Synthetic"}]
        with patch.object(module, "native_session", return_value=client):
            reply = await function(app, {"messages": messages})
        self.assertEqual(reply["token_ids"], [1, 2, 3])
        self.assertEqual(reply["engine_epoch"], "fixture")
        self.assertEqual(client.captured, ("/tokenize", {"model": module.MODEL, "messages": messages,
                         "add_generation_prompt": True, "add_special_tokens": False,
                         "chat_template_kwargs": {"enable_thinking": False}}))


class ReplacementTests(unittest.TestCase):
    def test_recovery_refuses_multiple_pending_or_active_replacement_instances(self):
        from restart import replacement_candidate
        fresh = {"instance_id": "fresh", "active": True, "verified": True}
        policy = {"public": False, "disabled": False, "max_instances": 1}
        self.assertEqual(replacement_candidate({**policy, "instances": [fresh]}, "old"), fresh)
        for instances in ([], [{**fresh, "instance_id": "old"}], [{**fresh, "active": False}],
                          [fresh, {**fresh, "instance_id": "pending", "active": False}],
                          [fresh, {**fresh, "instance_id": "other"}]):
            self.assertIsNone(replacement_candidate({**policy, "instances": instances}, "old"))
        with self.assertRaises(RuntimeError):
            replacement_candidate({**policy, "max_instances": 2, "instances": [fresh]}, "old")


if __name__ == "__main__":
    unittest.main()
