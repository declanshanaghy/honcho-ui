"""Honcho dashboard plugin — backend API routes.

Mounted at /api/plugins/honcho-ui/ by the dashboard plugin system.

A thin JSON proxy in front of a self-hosted Honcho v3 REST API
(https://honcho.dev). Every route maps 1:1 onto an upstream path,
forwarding bodies verbatim, passing through ``page``/``size`` pagination
query params, and surfacing upstream status codes on error so the browser
sees exactly what the Honcho server said.

Zero third-party dependencies: outbound HTTP uses ``urllib.request`` from
the stdlib so this file runs unchanged in any hermes venv (macOS or the
Linux server).

Configuration
-------------

Base URL resolution (first hit wins):

1. ``HONCHO_UI_BASE_URL`` env var
2. ``honcho.base_url`` in ``~/.hermes/config.yaml``
3. ``base_url`` in ``~/.hermes/honcho.json``
4. ``environmentUrl`` in ``~/.honcho/config.json`` (Honcho CLI config)
5. ``http://127.0.0.1:8020``

Optional API key resolution (first hit wins):

1. ``HONCHO_API_KEY`` env var
2. ``honcho.api_key`` in ``~/.hermes/config.yaml``
3. ``apiKey`` in ``~/.honcho/config.json``

If a key resolves to something other than empty / ``local`` / ``localonly``
(it is sent as ``Authorization: Bearer <key>`` upstream. The stock local
Honcho server needs no auth.

Security note
-------------

Plugin HTTP routes go through the dashboard's session-token auth
middleware (``web_server.auth_middleware``) just like core API routes —
every ``/api/plugins/honcho-ui/`` request must present the session bearer
token. The upstream Honcho server is reached server-side only; the browser
never talks to it directly.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, Request, Response

log = logging.getLogger(__name__)

router = APIRouter()

DEFAULT_BASE_URL = "http://127.0.0.1:8020"
# Sentinel values the Honcho CLI / localhoncho use for "no auth" keys.
_NO_AUTH_SENTINELS = ("", "local", "localonly")
_UPSTREAM_TIMEOUT_SECONDS = 120.0

_HOME = Path(os.path.expanduser("~"))
_HERMES_CONFIG = _HOME / ".hermes" / "config.yaml"
_HONCHO_JSON = _HOME / ".hermes" / "honcho.json"
_DOT_HONCHO_CONFIG = _HOME / ".honcho" / "config.json"


# ---------------------------------------------------------------------------
# Config resolution
# ---------------------------------------------------------------------------

def _yaml_section(path: Path, section: str) -> Dict[str, Any]:
    """Best-effort read of a top-level ``section:`` block from a YAML file.

    Uses PyYAML when importable (it always is inside a hermes venv);
    falls back to a naive two-space-indented key scan so the plugin still
    works in a bare interpreter without the dependency.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    try:
        import yaml  # type: ignore
        data = yaml.safe_load(text) or {}
        if isinstance(data, dict) and isinstance(data.get(section), dict):
            return data[section]
        return {}
    except Exception:
        pass
    # Naive fallback: find "honcho:" then read its indented "key: value" lines.
    out: Dict[str, Any] = {}
    lines = text.splitlines()
    in_section = False
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if not line.startswith((" ", "\t")):
            in_section = stripped.rstrip(":") == section
            continue
        if in_section and ":" in stripped:
            key, _, val = stripped.partition(":")
            val = val.strip().strip("'\"")
            if val:
                out[key.strip()] = val
    return out


def _read_json(path: Path) -> Dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def resolve_base_url() -> str:
    """Resolve the Honcho base URL (first hit wins, see module docstring)."""
    env = os.environ.get("HONCHO_UI_BASE_URL", "").strip()
    if env:
        return env.rstrip("/")
    cfg = _yaml_section(_HERMES_CONFIG, "honcho")
    val = str(cfg.get("base_url", "") or "").strip()
    if val:
        return val.rstrip("/")
    val = str(_read_json(_HONCHO_JSON).get("base_url", "") or "").strip()
    if val:
        return val.rstrip("/")
    val = str(_read_json(_DOT_HONCHO_CONFIG).get("environmentUrl", "") or "").strip()
    if val:
        return val.rstrip("/")
    return DEFAULT_BASE_URL


def _resolve_api_key() -> Optional[str]:
    env = os.environ.get("HONCHO_API_KEY", "").strip()
    if env:
        return env
    cfg = _yaml_section(_HERMES_CONFIG, "honcho")
    val = str(cfg.get("api_key", "") or "").strip()
    if val:
        return val
    val = str(_read_json(_DOT_HONCHO_CONFIG).get("apiKey", "") or "").strip()
    return val or None


# ---------------------------------------------------------------------------
# Upstream transport
# ---------------------------------------------------------------------------

def _upstream_request(
    method: str,
    path: str,
    *,
    query: Optional[str] = None,
    body: Optional[Any] = None,
    api_key: Optional[str] = None,
) -> Response:
    """Perform one upstream request and return a FastAPI ``Response``.

    Success and error responses alike surface the upstream status code and
    raw body (JSON content-type preserved when the upstream sent JSON).
    Network failures (connection refused / timeout) become a 502 with a
    human-readable detail.
    """
    base = resolve_base_url()
    url = base + path + (f"?{query}" if query else "")
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if api_key and api_key.strip().lower() not in _NO_AUTH_SENTINELS:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=_UPSTREAM_TIMEOUT_SECONDS) as resp:
            payload = resp.read()
            status = resp.status
            ctype = resp.headers.get("content-type", "application/json")
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        status = exc.code
        ctype = exc.headers.get("content-type", "application/json")
    except Exception as exc:  # connection refused, DNS, timeout, ...
        detail = json.dumps({"detail": f"Honcho unreachable at {base}: {exc}"})
        return Response(content=detail, status_code=502, media_type="application/json")
    if ctype.startswith("application/json"):
        media = "application/json"
    else:
        media = ctype or "application/json"
    return Response(content=payload, status_code=status, media_type=media)


async def _read_body(request: Request) -> Optional[Any]:
    """Read the request JSON body, returning None for an empty body."""
    raw = await request.body()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return raw


# ---------------------------------------------------------------------------
# GET /status — resolved base URL + upstream health + version
# ---------------------------------------------------------------------------

@router.get("/status")
async def plugin_status() -> Dict[str, Any]:
    """Report the resolved Honcho base URL and whether it's reachable."""
    base = resolve_base_url()
    api_key = _resolve_api_key()
    health: Any = None
    health_status: Optional[int] = None
    try:
        resp = _upstream_request("GET", "/health", api_key=api_key)
        health_status = resp.status_code
        try:
            health = json.loads(resp.body)
        except Exception:
            health = None
    except Exception:
        pass
    # Server version from the OpenAPI info block, if reachable.
    version: Optional[str] = None
    try:
        resp = _upstream_request("GET", "/openapi.json", api_key=api_key)
        if resp.status_code == 200:
            info = json.loads(resp.body).get("info", {})
            version = info.get("version")
    except Exception:
        pass
    return {
        "base_url": base,
        "api_key_configured": bool(api_key and api_key.strip().lower() not in _NO_AUTH_SENTINELS),
        "health": health,
        "health_status": health_status,
        "reachable": health_status == 200,
        "server_version": version,
    }


# ---------------------------------------------------------------------------
# Workspaces
# ---------------------------------------------------------------------------

@router.post("/workspaces/list")
async def list_workspaces(
    request: Request,
    page: int = 1,
    size: int = 50,
    reverse: bool = False,
) -> Response:
    """Proxy POST /v3/workspaces/list (pagination via query params)."""
    body = await _read_body(request)
    return _upstream_request(
        "POST",
        "/v3/workspaces/list",
        query=urllib.parse.urlencode({"page": page, "size": size, "reverse": str(reverse).lower()}),
        body=body,
        api_key=_resolve_api_key(),
    )


@router.post("/workspaces/{workspace_id}/peers/list")
async def list_peers(
    workspace_id: str,
    request: Request,
    page: int = 1,
    size: int = 50,
    reverse: bool = False,
) -> Response:
    """Proxy POST /v3/workspaces/{id}/peers/list."""
    body = await _read_body(request)
    ws = urllib.parse.quote(workspace_id, safe="")
    return _upstream_request(
        "POST",
        f"/v3/workspaces/{ws}/peers/list",
        query=urllib.parse.urlencode({"page": page, "size": size, "reverse": str(reverse).lower()}),
        body=body,
        api_key=_resolve_api_key(),
    )


@router.post("/workspaces/{workspace_id}/sessions/list")
async def list_sessions(
    workspace_id: str,
    request: Request,
    page: int = 1,
    size: int = 50,
    reverse: bool = False,
) -> Response:
    """Proxy POST /v3/workspaces/{id}/sessions/list."""
    body = await _read_body(request)
    ws = urllib.parse.quote(workspace_id, safe="")
    return _upstream_request(
        "POST",
        f"/v3/workspaces/{ws}/sessions/list",
        query=urllib.parse.urlencode({"page": page, "size": size, "reverse": str(reverse).lower()}),
        body=body,
        api_key=_resolve_api_key(),
    )


# ---------------------------------------------------------------------------
# Messages / search
# ---------------------------------------------------------------------------

@router.post("/workspaces/{workspace_id}/sessions/{session_id}/messages/list")
async def list_messages(
    workspace_id: str,
    session_id: str,
    request: Request,
    page: int = 1,
    size: int = 50,
    reverse: Optional[bool] = None,
) -> Response:
    """Proxy POST /v3/.../sessions/{s}/messages/list (paginated)."""
    body = await _read_body(request)
    ws = urllib.parse.quote(workspace_id, safe="")
    ss = urllib.parse.quote(session_id, safe="")
    query: Dict[str, str] = {"page": str(page), "size": str(size)}
    if reverse is not None:
        query["reverse"] = str(reverse).lower()
    return _upstream_request(
        "POST",
        f"/v3/workspaces/{ws}/sessions/{ss}/messages/list",
        query=urllib.parse.urlencode(query),
        body=body,
        api_key=_resolve_api_key(),
    )


@router.post("/workspaces/{workspace_id}/search")
async def search_workspace(workspace_id: str, request: Request) -> Response:
    """Proxy POST /v3/workspaces/{id}/search — body {query, filters?, limit?}."""
    body = await _read_body(request)
    if body is None:
        body = {}
    ws = urllib.parse.quote(workspace_id, safe="")
    return _upstream_request(
        "POST", f"/v3/workspaces/{ws}/search", body=body, api_key=_resolve_api_key(),
    )


# ---------------------------------------------------------------------------
# Peers — card, representation, dialectic chat
# ---------------------------------------------------------------------------

@router.get("/workspaces/{workspace_id}/peers/{peer_id}/card")
async def get_peer_card(
    workspace_id: str,
    peer_id: str,
    target: Optional[str] = None,
) -> Response:
    """Proxy GET /v3/.../peers/{p}/card (optional ?target= observed peer)."""
    ws = urllib.parse.quote(workspace_id, safe="")
    pid = urllib.parse.quote(peer_id, safe="")
    query = urllib.parse.urlencode({"target": target}) if target else None
    return _upstream_request(
        "GET", f"/v3/workspaces/{ws}/peers/{pid}/card", query=query,
        api_key=_resolve_api_key(),
    )


@router.post("/workspaces/{workspace_id}/peers/{peer_id}/representation")
async def get_peer_representation(
    workspace_id: str,
    peer_id: str,
    request: Request,
) -> Response:
    """Proxy POST /v3/.../peers/{p}/representation.

    Body (PeerRepresentationGet): optional session_id / target /
    search_query / search_top_k / search_max_distance. An empty body is
    forwarded as ``{}`` (all fields optional).
    """
    body = await _read_body(request)
    if not isinstance(body, dict):
        body = {}
    ws = urllib.parse.quote(workspace_id, safe="")
    pid = urllib.parse.quote(peer_id, safe="")
    return _upstream_request(
        "POST", f"/v3/workspaces/{ws}/peers/{pid}/representation", body=body,
        api_key=_resolve_api_key(),
    )


@router.post("/workspaces/{workspace_id}/peers/{peer_id}/chat")
async def peer_chat(workspace_id: str, peer_id: str, request: Request) -> Response:
    """Proxy POST /v3/.../peers/{p}/chat (dialectic).

    Body (DialecticOptions): required ``query``, optional session_id /
    target / stream / reasoning_level. ``stream: true`` is not supported by
    this proxy — responses are awaited and returned whole.
    """
    body = await _read_body(request)
    if not isinstance(body, dict):
        body = {}
    body.pop("stream", None)  # non-streaming proxy
    ws = urllib.parse.quote(workspace_id, safe="")
    pid = urllib.parse.quote(peer_id, safe="")
    return _upstream_request(
        "POST", f"/v3/workspaces/{ws}/peers/{pid}/chat", body=body,
        api_key=_resolve_api_key(),
    )


# ---------------------------------------------------------------------------
# Conclusions
# ---------------------------------------------------------------------------

@router.post("/workspaces/{workspace_id}/conclusions/list")
async def list_conclusions(
    workspace_id: str,
    request: Request,
    page: int = 1,
    size: int = 50,
    reverse: Optional[bool] = None,
) -> Response:
    """Proxy POST /v3/workspaces/{id}/conclusions/list.

    Body (ConclusionGet): optional ``filters`` — supports observer /
    observed / session scoping via filters, passed through verbatim.
    """
    body = await _read_body(request)
    ws = urllib.parse.quote(workspace_id, safe="")
    query: Dict[str, str] = {"page": str(page), "size": str(size)}
    if reverse is not None:
        query["reverse"] = str(reverse).lower()
    return _upstream_request(
        "POST",
        f"/v3/workspaces/{ws}/conclusions/list",
        query=urllib.parse.urlencode(query),
        body=body,
        api_key=_resolve_api_key(),
    )


# ---------------------------------------------------------------------------
# Deriver queue + dreams
# ---------------------------------------------------------------------------

@router.get("/workspaces/{workspace_id}/queue/status")
async def queue_status(
    workspace_id: str,
    observer_id: Optional[str] = None,
    sender_id: Optional[str] = None,
    session_id: Optional[str] = None,
) -> Response:
    """Proxy GET /v3/workspaces/{id}/queue/status."""
    ws = urllib.parse.quote(workspace_id, safe="")
    query = {
        k: v for k, v in {
            "observer_id": observer_id,
            "sender_id": sender_id,
            "session_id": session_id,
        }.items() if v
    }
    return _upstream_request(
        "GET", f"/v3/workspaces/{ws}/queue/status",
        query=urllib.parse.urlencode(query) if query else None,
        api_key=_resolve_api_key(),
    )


@router.post("/workspaces/{workspace_id}/schedule_dream")
async def schedule_dream(workspace_id: str, request: Request) -> Response:
    """Proxy POST /v3/workspaces/{id}/schedule_dream.

    Body (ScheduleDreamRequest): required ``observer`` + ``dream_type``
    (globally-scoped dreams use a "*" observer), optional observed /
    session_id. Returns 204 upstream on success.
    """
    body = await _read_body(request)
    if not isinstance(body, dict):
        body = {}
    ws = urllib.parse.quote(workspace_id, safe="")
    return _upstream_request(
        "POST", f"/v3/workspaces/{ws}/schedule_dream", body=body,
        api_key=_resolve_api_key(),
    )


# ---------------------------------------------------------------------------
# Health (raw upstream)
# ---------------------------------------------------------------------------

@router.get("/health")
async def honcho_health() -> Response:
    """Proxy GET /health (raw upstream health)."""
    return _upstream_request("GET", "/health", api_key=_resolve_api_key())