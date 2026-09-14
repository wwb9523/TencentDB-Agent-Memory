#!/usr/bin/env python3
"""Write a synthetic turn ONLY to a dedicated QA Agent, then query it through MCP.
Usage: python3 remote_smoke.py --config /private/qa-config.json --allow-qa-write
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import uuid

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "memory.py"
spec = importlib.util.spec_from_file_location("memory", SCRIPT)
memory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(memory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--allow-qa-write", action="store_true", required=True)
    args = parser.parse_args()
    cfg = json.loads(Path(args.config).read_text())
    identity = memory.api(cfg, "status")
    assert "QA" in identity["agent_name"], "Use an explicitly named QA Agent, not production memory"
    env = {**os.environ, "TDAI_MEMORY_CONFIG": args.config}
    session, turn = str(uuid.uuid4()), str(uuid.uuid4())
    marker = "qamemory" + uuid.uuid4().hex[:12]
    prompt = "Integration test decision: use pytest for " + marker
    answer = "Confirmed. The integration test project uses pytest. " + marker
    event = dict(session_id=session, turn_id=turn, hook_event_name="UserPromptSubmit", prompt=prompt)
    def run_hook(event):
        result = subprocess.run(["python3", str(SCRIPT), "hook"], input=json.dumps(event), capture_output=True, text=True, env=env, check=True)
        value = json.loads(result.stdout)
        assert "systemMessage" not in value, value
        return value
    recalled = run_hook(event)
    assert "additionalContext" in recalled["hookSpecificOutput"]
    stop = dict(session_id=session, turn_id=turn, hook_event_name="Stop", last_assistant_message=answer)
    run_hook(stop)
    run_hook(stop)
    with memory.database(cfg) as db:
        timestamp, sent = db.execute("SELECT timestamp,sent FROM turns WHERE scope=? AND session=? AND turn=?", (memory.scope(cfg), session, turn)).fetchone()
        assert sent == 1
    duplicate = memory.api(cfg, "capture", dict(session_id=session, turn_id=turn, prompt=prompt, answer=answer, timestamp=timestamp))
    assert duplicate["duplicate"] is True
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "memory_search", "arguments": {"query": marker, "layer": "conversation", "limit": 20}}},
    ]
    result = subprocess.run(["python3", str(SCRIPT), "mcp"], input="\n".join(map(json.dumps, messages)) + "\n", capture_output=True, text=True, env=env, check=True)
    reply = list(map(json.loads, result.stdout.splitlines()))[-1]["result"]
    assert reply["isError"] is False, reply
    hits = json.loads(reply["content"][0]["text"])["messages"]
    exact = [m for m in hits if marker in m["content"]]
    assert len(exact) == 2, "Expected one user and one assistant record, without duplicates"
    print(json.dumps({"status": "passed", "agent_id": identity["agent_id"], "checks": ["authenticated identity", "UserPromptSubmit recall", "Stop capture", "repeat Stop", "server receipt replay", "MCP cross-session L0 search"], "matched_messages": len(exact), "receipt": duplicate["receipt"]}, indent=2))


if __name__ == "__main__":
    main()
