# honcho-ui

A [Hermes Agent](https://hermes-agent.nousresearch.com/) dashboard plugin for
browsing a self-hosted [Honcho](https://honcho.dev/) memory server —
workspaces, peers, sessions, message timelines, peer cards, dialectic chat,
conclusions, semantic search, deriver queue status, and a manual "dream"
trigger.

Upstream Honcho (v3) ships no web UI — this plugin adds one as a tab in the
Hermes dashboard.

## Layout

```
dashboard/
  manifest.json     # plugin manifest (tab at /honcho, icon, entry points)
  plugin_api.py     # FastAPI APIRouter — thin JSON proxy to the Honcho v3 API
  src/index.js      # no-build browser IIFE frontend (uses the dashboard SDK)
  src/style.css     # minimal extra styling
tests/
  test_routes_live.py   # live smoke test against a real Honcho server
```

`dist/` stays in `.gitignore` (standard hygiene). The frontend has **no build
step** — `src/index.js` is the deliverable and the manifest points directly
at it.

## How it connects

The backend resolves the Honcho server URL at request time, first hit wins:

1. `HONCHO_UI_BASE_URL` env var
2. `honcho.base_url` in `~/.hermes/config.yaml`
3. `base_url` in `~/.hermes/honcho.json`
4. `environmentUrl` in `~/.honcho/config.json`
5. default `http://127.0.0.1:8020`

An optional API key (`HONCHO_API_KEY` env → `honcho.api_key` in config.yaml →
`apiKey` in `~/.honcho/config.json`) is sent as a Bearer token when set;
values `"local"`/`"localonly"`/empty mean no auth (typical self-hosted setup).

## Dev model (this repo)

Develop locally; the Honcho server lives wherever it lives (e.g. the
`corkbai-honcho` docker stack on cork, reachable on the LAN at
`192.168.1.3:8020`). Point the plugin at it with the env var:

```bash
# one-time: build the dashboard SPA
cd ~/.hermes/hermes-agent/web && npm install && npm run build

# run the local dashboard with the plugin pointed at cork
HONCHO_UI_BASE_URL=http://192.168.1.3:8020 \
  hermes dashboard --host 127.0.0.1 --port 9119 --no-open --skip-build
```

Install/sync the plugin (the dashboard scans `~/.hermes/plugins/<name>/dashboard/`):

```bash
rsync -a --delete --exclude '__pycache__' \
  ~/honcho-ui/dashboard/ ~/.hermes/plugins/honcho-ui/dashboard/
```

Then open http://127.0.0.1:9119/honcho. Plugin API routes mount at
`/api/plugins/honcho-ui/*` behind the dashboard's session token (the SPA
handles it transparently).

## Tests

```bash
# all proxy routes against the live server (fast, skips LLM-backed chat)
SKIP_SLOW=1 ~/.hermes/hermes-agent/venv/bin/python tests/test_routes_live.py

# including the dialectic chat route (slow — triggers server-side LLM)
~/.hermes/hermes-agent/venv/bin/python tests/test_routes_live.py
```

Notes from testing against cork's stack (Honcho v3.0.7):
- `schedule_dream` requires `{observer, observed, dream_type: "omni"}` and
  returns `204` on success.
- Unknown workspaces return empty lists (200), not 404 — v3 is lenient.
- `peers/{id}/chat` currently 500s server-side on cork (deriver/LLM issue
  there, not a plugin bug — the proxy relays it faithfully).
