"""Native metrics contract tests in the Chutes SDK environment; no GPU calls."""
import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

import aiohttp
from fastapi import HTTPException

spec = importlib.util.spec_from_file_location("market_chute", Path(__file__).with_name("market_chute.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
cord = next(c for c in module.chute.chute.cords if c.public_api_path == "/metrics")


class MetricsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.engine = SimpleNamespace(passthrough_headers={"Authorization": "Bearer engine-only"})
        self.chunks = [b"# HELP vllm:num_requests_running Running requests\n", b"vllm:num_requests_running 0\n"]
        self.response = SimpleNamespace(status=200, headers={"Content-Type": "text/plain; version=0.0.4; charset=utf-8"})
        self.response.content = SimpleNamespace(iter_chunked=self.iter_chunks)
        self.session = MagicMock()
        self.session.get.return_value.__aenter__.return_value = self.response
        self.factory = MagicMock()
        self.factory.return_value.__aenter__.return_value = self.session

    async def iter_chunks(self, size):
        for chunk in self.chunks:
            yield chunk

    async def invoke(self, payload=None):
        with patch.object(module.aiohttp, "ClientSession", self.factory), patch.object(module.aiohttp, "TCPConnector") as connector:
            result = await cord._func(self.engine, payload)
            return result, connector

    def test_only_get_registered_and_native_chat_preserved(self):
        app = module.chute.chute
        self.assertEqual([(c.public_api_path, c._public_api_method) for c in app.cords if c.public_api_path == "/metrics"], [("/metrics", "GET")])
        self.assertEqual({c.public_api_path for c in app.cords}, {"/metrics", "/v1/models", "/v1/chat/completions", "/v1/completions", "/tokenize", "/detokenize"})
        self.assertTrue(app.tee and app.lock_modules)
        self.assertEqual(app.max_instances, 1)

    async def test_exact_bytes_fixed_read_target_and_engine_auth(self):
        result, connector = await self.invoke({"url": "https://attacker.invalid", "method": "POST", "params": {"reset": True}, "headers": {"Authorization": "caller"}})
        self.assertEqual(result.body, b"".join(self.chunks))
        self.assertEqual(result.headers["content-type"], self.response.headers["Content-Type"])
        # The Chutes encrypted relay rebuilds the public response from this
        # attribute, rather than forwarding our Content-Type header directly.
        self.assertEqual(result.media_type, self.response.headers["Content-Type"])
        self.assertEqual(result.headers["cache-control"], "no-store")
        self.assertEqual(result.headers["x-content-type-options"], "nosniff")
        self.session.get.assert_called_once_with("/metrics", allow_redirects=False)
        self.session.post.assert_not_called()
        options = self.factory.call_args.kwargs
        self.assertEqual(options["base_url"], "http://127.0.0.1:10101")
        self.assertEqual(options["headers"], {"Authorization": "Bearer engine-only", "Accept-Encoding": "identity"})
        self.assertFalse(options["trust_env"])
        self.assertEqual(options["timeout"].total, 10)
        connector.assert_called_once_with(ssl=None)

    async def test_mtls_engine_context_used(self):
        self.engine.passthrough_ssl_context = object()
        self.response.headers["Content-Type"] = "application/openmetrics-text; version=1.0.0"
        result, connector = await self.invoke()
        self.assertEqual(result.media_type, "application/openmetrics-text; version=1.0.0")
        self.assertEqual(self.factory.call_args.kwargs["base_url"], "https://127.0.0.1:10101")
        connector.assert_called_once_with(ssl=self.engine.passthrough_ssl_context)

    async def test_upstream_errors_redirects_and_non_metrics_content_rejected(self):
        for status, content_type in [(302, "text/plain"), (401, "text/plain"), (500, "text/plain"), (200, "application/json"), (200, "")]:
            with self.subTest(status=status, content_type=content_type):
                self.response.status = status
                self.response.headers["Content-Type"] = content_type
                with self.assertRaises(HTTPException) as error:
                    await self.invoke()
                self.assertEqual(error.exception.status_code, 502)

    async def test_response_size_bounded(self):
        self.chunks = [b"x" * 65536] * 65
        with self.assertRaises(HTTPException) as error:
            await self.invoke()
        self.assertEqual(error.exception.status_code, 502)

    async def test_transport_errors_are_generic(self):
        for failure in (aiohttp.ClientConnectionError("internal secret"), asyncio.TimeoutError()):
            self.session.get.return_value.__aenter__.side_effect = failure
            with self.assertRaises(HTTPException) as error:
                await self.invoke()
            self.assertEqual(error.exception.status_code, 502)
            self.assertEqual(error.exception.detail, "Native metrics unavailable")


if __name__ == "__main__":
    unittest.main()
