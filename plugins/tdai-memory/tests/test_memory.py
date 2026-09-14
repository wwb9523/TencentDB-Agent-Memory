import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "memory.py"
spec = importlib.util.spec_from_file_location("memory", SCRIPT)
memory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(memory)


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cfg = dict(endpoint="http://test/agent-memory/v1", service_id="default", user_key="test-key",
                        team_id="team", agent_id="agent", capture=True, state_dir=self.temp.name)
        self.start = dict(session_id="s", turn_id="t", hook_event_name="UserPromptSubmit", prompt="original prompt")
        self.stop = dict(session_id="s", turn_id="t", hook_event_name="Stop", last_assistant_message="final answer")

    def tearDown(self):
        self.temp.cleanup()

    def test_hook_context_and_original_capture_not_retrieved_context(self):
        with patch.object(memory, "api", return_value={"persona": "remote memory"}) as api:
            result = memory.hook(self.start, self.cfg)
            self.assertIn("remote memory", result["hookSpecificOutput"]["additionalContext"])
            memory.hook(self.stop, self.cfg)
            sent = api.call_args.args[2]
            self.assertEqual(sent["prompt"], "original prompt")
            self.assertEqual(sent["answer"], "final answer")
            memory.hook(self.stop, self.cfg)
            self.assertEqual(sum(c.args[1] == "capture" for c in api.call_args_list), 1)
        with memory.database(self.cfg) as db:
            row = db.execute("SELECT prompt,answer,sent FROM turns").fetchone()
            self.assertEqual(row, ("", "", 1))

    def test_failed_write_retries_exact_payload(self):
        with patch.object(memory, "api", return_value={}):
            memory.hook(self.start, self.cfg)
        with patch.object(memory, "api", side_effect=RuntimeError("network down")) as api:
            with self.assertRaises(RuntimeError):
                memory.hook(self.stop, self.cfg)
            payload = api.call_args.args[2]
        with patch.object(memory, "api", return_value={}) as api:
            memory.hook({**self.stop, "last_assistant_message": "different repeat"}, self.cfg)
            self.assertEqual(api.call_args.args[2], payload)

    def test_scope_change_does_not_upload_other_agents_pending_turns(self):
        with patch.object(memory, "api", return_value={}):
            memory.hook(self.start, self.cfg)
        with patch.object(memory, "api", side_effect=RuntimeError()):
            with self.assertRaises(RuntimeError): memory.hook(self.stop, self.cfg)
        with patch.object(memory, "api") as api:
            memory.capture_pending({**self.cfg, "agent_id": "different"})
            api.assert_not_called()

    def test_capture_opt_out_and_missing_prompt(self):
        with patch.object(memory, "api") as api:
            memory.hook(self.stop, {**self.cfg, "capture": False})
            memory.hook(self.stop, self.cfg)
            api.assert_not_called()

    def test_tools_reject_identity_override(self):
        with self.assertRaises(ValueError):
            memory.tool_call(self.cfg, "memory_search", {"query": "x", "layer": "atomic", "user_id": "victim"})

    def test_api_ignores_system_proxy_and_honors_explicit_environment(self):
        for proxies in ({}, {"http": "http://explicit-proxy:8080"}):
            with self.subTest(proxies=proxies), \
                 patch.object(memory.urllib.request, "getproxies_environment", return_value=proxies), \
                 patch.object(memory.urllib.request, "getproxies", side_effect=AssertionError("system proxy queried")), \
                 patch.object(memory.urllib.request, "build_opener") as build:
                build.return_value.open.return_value = io.StringIO('{"data":{"ok":true}}')
                self.assertEqual(memory.api(self.cfg, "status"), {"ok": True})
                self.assertEqual(build.call_args.args[0].proxies, proxies)
                self.assertIsInstance(build.call_args.args[1], memory.NoRedirect)

    def test_unicode_queries_fit_core_without_losing_capture(self):
        prompt = "x" * 2047 + "😀" * 20
        with patch.object(memory, "api", return_value={}) as api:
            memory.hook({**self.start, "prompt": prompt}, self.cfg)
            self.assertEqual(api.call_args.args[2]["query"], "x" * 2047)
            memory.hook(self.stop, self.cfg)
            self.assertEqual(api.call_args.args[2]["prompt"], prompt)
        with self.assertRaises(ValueError):
            memory.tool_call(self.cfg, "memory_recall", {"query": "😀" * 2048})

    def test_mcp_stdio_initialization_and_tools(self):
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        ]
        result = subprocess.run(["python3", str(SCRIPT), "mcp"], input="\n".join(map(json.dumps, messages)) + "\n", capture_output=True, text=True, check=True)
        replies = list(map(json.loads, result.stdout.splitlines()))
        self.assertEqual(len(replies), 2)
        self.assertEqual(replies[0]["result"]["protocolVersion"], "2025-06-18")
        self.assertEqual(len(replies[1]["result"]["tools"]), 5)


if __name__ == "__main__":
    unittest.main()
