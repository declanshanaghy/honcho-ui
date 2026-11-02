"""Live smoke test for the honcho-ui dashboard plugin backend.

Exercises every plugin route through FastAPI's TestClient against a real
Honcho server (HONCHO_TEST_BASE_URL, default http://192.168.1.3:8020).

Run (from repo root):
    ~/.hermes/hermes-agent/venv/bin/python tests/test_routes_live.py

SKIP_SLOW=1 skips the dialectic chat route (it triggers upstream LLM
reasoning on the server and can take 30s+).
"""
import importlib.util
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
os.environ.setdefault(
    "HONCHO_UI_BASE_URL",
    os.environ.get("HONCHO_TEST_BASE_URL", "http://192.168.1.3:8020"),
)

spec = importlib.util.spec_from_file_location(
    "honcho_ui_api", REPO / "dashboard" / "plugin_api.py"
)
assert spec and spec.loader, "could not load dashboard/plugin_api.py"
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

from fastapi import FastAPI
from fastapi.testclient import TestClient

app = FastAPI()
app.include_router(mod.router, prefix="/api/plugins/honcho-ui")
client = TestClient(app)

WS = "corkbai"
PEER = "Declan-Shanaghy"
SESSION = "hermes-agent"
results = []


def check(name, method, path, body=None, expect=200):
    print(f"....  {name}", flush=True)
    try:
        r = client.request(method, path, json=body)
        ok = r.status_code == expect
        if ok:
            try:
                detail = str(r.json())[:90]
            except Exception:
                detail = r.text[:90]
        else:
            detail = f"got {r.status_code}: {r.text[:110]}"
        results.append((ok, name))
        print(f"{'PASS' if ok else 'FAIL'}  {name:45s} {detail}", flush=True)
    except Exception as e:
        results.append((False, name))
        print(f"FAIL  {name:45s} {e!r}", flush=True)


print(f"base_url resolved: {mod.resolve_base_url()}", flush=True)
check("status", "GET", "/api/plugins/honcho-ui/status")
check("workspaces/list", "POST", "/api/plugins/honcho-ui/workspaces/list", {"page": 1, "size": 50})
check("peers/list", "POST", f"/api/plugins/honcho-ui/workspaces/{WS}/peers/list", {"page": 1, "size": 50})
check("sessions/list", "POST", f"/api/plugins/honcho-ui/workspaces/{WS}/sessions/list", {"page": 1, "size": 50})
check("messages/list", "POST", f"/api/plugins/honcho-ui/workspaces/{WS}/sessions/{SESSION}/messages/list", {"page": 1, "size": 5})
check("workspace search", "POST", f"/api/plugins/honcho-ui/workspaces/{WS}/search", {"query": "docker"})
check("peer card", "GET", f"/api/plugins/honcho-ui/workspaces/{WS}/peers/{PEER}/card")
check("peer representation", "POST", f"/api/plugins/honcho-ui/workspaces/{WS}/peers/{PEER}/representation")
check("conclusions/list", "POST", f"/api/plugins/honcho-ui/workspaces/{WS}/conclusions/list", {"page": 1, "size": 10})
check("queue status", "GET", f"/api/plugins/honcho-ui/workspaces/{WS}/queue/status")
check("schedule dream (204)", "POST", f"/api/plugins/honcho-ui/workspaces/{WS}/schedule_dream", {"observer": PEER, "observed": "CorkBai", "dream_type": "omni"}, expect=204)
check("unknown workspace -> empty list (upstream is lenient)", "POST", "/api/plugins/honcho-ui/workspaces/nope/peers/list", {"page": 1, "size": 5}, expect=200)

if os.environ.get("SKIP_SLOW") != "1":
    check("peer chat (dialectic, SLOW)", "POST", f"/api/plugins/honcho-ui/workspaces/{WS}/peers/{PEER}/chat", {"query": "What is known about this peer in one sentence?"})
else:
    print("SKIP  peer chat (SKIP_SLOW=1)")

passed = sum(1 for ok, _ in results if ok)
print(f"\n{passed}/{len(results)} routes passed", flush=True)
sys.exit(0 if passed == len(results) else 1)
