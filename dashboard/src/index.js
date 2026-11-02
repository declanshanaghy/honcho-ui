/*
 * Hermes Honcho — Dashboard Plugin
 *
 * Browser UI for a self-hosted Honcho memory server. All data flows through
 * the plugin's backend proxy at /api/plugins/honcho-ui/ (which injects the
 * dashboard session token and keeps the Honcho server address server-side).
 *
 * Plain IIFE, no build step. Uses window.__HERMES_PLUGIN_SDK__ for React +
 * shadcn primitives and fetchJSON for API calls.
 *
 * Layout: left sidebar (workspaces → sessions/peers under the selected
 * workspace) + main area that switches per selection:
 *   - Session view: message timeline (newest last) with Load More (size 50)
 *   - Peer view: card + representation, dialectic chat box, search-within-peer
 *   - Global (header): workspace search, conclusions feed, queue status chip,
 *     "Dream now" trigger, JSON inspector for any object
 */
(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK) return;
  const register = window.__HERMES_PLUGINS__ && window.__HERMES_PLUGINS__.register;
  if (!register) return;

  const { React } = SDK;
  const h = React.createElement;
  const {
    Card, CardHeader, CardTitle, CardContent,
    Badge, Button, Input,
  } = SDK.components;
  const { useState, useEffect, useCallback, useMemo, useRef } = SDK.hooks;
  const { cn, timeAgo } = SDK.utils;
  const fetchJSON = SDK.fetchJSON;

  const API = "/api/plugins/honcho-ui";
  const PAGE_SIZE = 50;

  // ---------------------------------------------------------------------
  // fetch helpers / error message parsing (same convention as kanban)
  // ---------------------------------------------------------------------

  function parseApiErrorMessage(err) {
    const raw = (err && err.message) ? String(err.message) : String(err || "");
    const m = raw.match(/^(\d{3}):\s*(.*)$/s);
    const body = m ? m[2] : raw;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.detail === "string") return parsed.detail;
    } catch (_e) { /* not JSON */ }
    return body || raw;
  }

  function apiGet(path) { return fetchJSON(`${API}${path}`); }
  function apiPost(path, body) {
    return fetchJSON(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body == null ? {} : body),
    });
  }

  function fmtTime(value) {
    if (!value) return "";
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleString();
  }

  // ---------------------------------------------------------------------
  // JSON inspector — collapsible pretty-print for any object
  // ---------------------------------------------------------------------

  function JsonInspector(props) {
    const [open, setOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const label = props.label || "JSON";
    const value = props.value;
    const text = useMemo(function () {
      try { return JSON.stringify(value, null, 2); }
      catch (_e) { return String(value); }
    }, [value]);
    return h("div", { className: "honcho-ui-inspector" },
      h(Button, {
        variant: "outline", size: "sm",
        onClick: function () { setOpen(!open); },
        className: cn("honcho-ui-inspector-toggle", open && "honcho-ui-inspector-open"),
      },
        `${open ? "▾" : "▸"} ${label}`),
      open && h("div", { className: "honcho-ui-inspector-body" },
        h(Button, {
          variant: "ghost", size: "sm", className: "honcho-ui-copy",
          onClick: function () {
            try {
              navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(function () { setCopied(false); }, 1200);
            } catch (_e) { /* clipboard unavailable */ }
          },
        }, copied ? "Copied" : "Copy"),
        h("pre", { className: "honcho-ui-pre" }, text)),
    );
  }

  function EmptyState(props) {
    return h("div", { className: "honcho-ui-empty" },
      props.icon ? h("div", { className: "honcho-ui-empty-icon" }, props.icon) : null,
      h("div", { className: "honcho-ui-empty-title" }, props.title),
      props.hint ? h("div", { className: "honcho-ui-empty-hint" }, props.hint) : null,
    );
  }

  // ---------------------------------------------------------------------
  // Queue status chip + dream trigger (workspace-scoped)
  // ---------------------------------------------------------------------

  function QueueChip(props) {
    const { workspaceId, onDreamed } = props;
    const [status, setStatus] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [dreaming, setDreaming] = useState(false);

    const refresh = useCallback(function () {
      if (!workspaceId) return;
      setLoading(true);
      apiGet(`/workspaces/${encodeURIComponent(workspaceId)}/queue/status`)
        .then(function (s) { setStatus(s); setError(null); })
        .catch(function (e) { setError(parseApiErrorMessage(e)); })
        .then(function () { setLoading(false); });
    }, [workspaceId]);

    useEffect(function () { refresh(); }, [refresh]);
    // Auto-refresh the chip every 15s while mounted.
    useEffect(function () {
      if (!workspaceId) return;
      const t = setInterval(refresh, 15000);
      return function () { clearInterval(t); };
    }, [workspaceId, refresh]);

    function dream() {
      if (!workspaceId) return;
      setDreaming(true);
      // Globally-scoped dream: observer "*" (all peers), type "representation".
      apiPost(`/workspaces/${encodeURIComponent(workspaceId)}/schedule_dream`, {
        observer: "*", dream_type: "representation",
      })
        .then(function () { onDreamed && onDreamed(); refresh(); })
        .catch(function (e) { setError(parseApiErrorMessage(e)); })
        .then(function () { setDreaming(false); });
    }

    return h("div", { className: "honcho-ui-queue" },
      error && h(Badge, { variant: "destructive", className: "honcho-ui-queue-err" }, "queue: " + error),
      status && h(Badge, {
        variant: "secondary",
        className: cn("honcho-ui-queue-chip", loading && "opacity-60"),
        title: `total=${status.total_work_units} in-progress=${status.in_progress_work_units}`,
      },
        `queue: ${status.pending_work_units} pending · ${status.completed_work_units} done`),
      !status && !error && h(Badge, { variant: "secondary", className: "opacity-60" }, "queue: …"),
      h(Button, {
        size: "sm", variant: "outline",
        onClick: refresh, disabled: loading || !workspaceId,
        title: "Refresh queue status",
      }, "↻"),
      h(Button, {
        size: "sm", variant: "outline",
        onClick: dream, disabled: dreaming || !workspaceId,
        title: "Schedule a dream (deriver pass) for this workspace now",
      }, dreaming ? "Dreaming…" : "Dream now"),
    );
  }

  // ---------------------------------------------------------------------
  // Session view — message timeline with Load More pagination
  // ---------------------------------------------------------------------

  function SessionView(props) {
    const { workspaceId, session } = props;
    const sessionId = session.id || session.name;
    const [messages, setMessages] = useState([]);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(null);
    const [hasMore, setHasMore] = useState(true);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const pagesRef = useRef(1);

    // Load pages 1..pagesRef.current newest-first upstream, then render newest-last.
    const load = useCallback(function (pages) {
      setLoading(true);
      const requests = [];
      for (let p = 1; p <= pages; p++) {
        requests.push(apiPost(
          `/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/messages/list?page=${p}&size=${PAGE_SIZE}`,
          {},
        ));
      }
      Promise.all(requests)
        .then(function (results) {
          const all = [];
          results.forEach(function (res) {
            (res.items || []).forEach(function (m) { all.push(m); });
            setTotal(res.total);
          });
          const last = results[results.length - 1];
          const lastItems = (last && last.items) || [];
          setHasMore(lastItems.length === PAGE_SIZE && (total == null || all.length < total));
          // Reverse upstream ordering (newest-first) → newest-last for reading.
          setMessages(all.slice().reverse());
          setError(null);
        })
        .catch(function (e) { setError(parseApiErrorMessage(e)); })
        .then(function () { setLoading(false); });
    }, [workspaceId, sessionId]);

    useEffect(function () {
      pagesRef.current = 1;
      setMessages([]); setHasMore(true); setError(null); setTotal(null);
      load(1);
    }, [load]);

    function loadMore() {
      pagesRef.current += 1;
      load(pagesRef.current);
    }

    return h("div", { className: "honcho-ui-main" },
      h("div", { className: "honcho-ui-main-head" },
        h("div", null,
          h("h2", { className: "honcho-ui-h2" }, sessionId),
          h("div", { className: "honcho-ui-muted" },
            `${total != null ? total : "…"} messages`)),
        h(JsonInspector, { label: "Session object", value: session })),
      error && h(Card, null, h(CardContent, { className: "p-3 text-sm text-red-400" }, error)),
      h("div", { className: "honcho-ui-timeline" },
        messages.length === 0 && !loading && !error &&
          h(EmptyState, { title: "No messages in this session yet", icon: "💬" }),
        messages.map(function (m, i) {
          return h("div", { key: m.id || i, className: "honcho-ui-msg" },
            h("div", { className: "honcho-ui-msg-meta" },
              h("span", { className: "honcho-ui-msg-peer" }, m.peer_id || m.peer || "unknown"),
              h("span", { className: "honcho-ui-msg-time" }, fmtTime(m.created_at || m.timestamp)),
            ),
            h("div", { className: "honcho-ui-msg-content honcho-ui-prewrap" }, String(m.content != null ? m.content : "")),
            h(JsonInspector, { label: "raw message", value: m }));
        })),
      h("div", { className: "honcho-ui-loadmore" },
        loading && h("span", { className: "honcho-ui-muted" }, "Loading…"),
        !loading && hasMore && h(Button, { onClick: loadMore, variant: "outline", size: "sm" },
          "Load More"),
        !loading && !hasMore && messages.length > 0 &&
          h("span", { className: "honcho-ui-muted" }, "Start of session"),
      ));
  }

  // ---------------------------------------------------------------------
  // Peer view — card, representation, dialectic chat, peer search
  // ---------------------------------------------------------------------

  function PeerView(props) {
    const { workspaceId, peer } = props;
    const peerId = peer.id || peer.name;
    const base = `/workspaces/${encodeURIComponent(workspaceId)}/peers/${encodeURIComponent(peerId)}`;

    const [card, setCard] = useState(null);
    const [cardLoading, setCardLoading] = useState(true);
    const [repr, setRepr] = useState(null);
    const [reprLoading, setReprLoading] = useState(true);

    const [chatInput, setChatInput] = useState("");
    const [chatBusy, setChatBusy] = useState(false);
    const [chatReply, setChatReply] = useState(null);
    const [chatError, setChatError] = useState(null);

    const [searchInput, setSearchInput] = useState("");
    const [peerSearchResults, setPeerSearchResults] = useState(null);
    const [peerSearchBusy, setPeerSearchBusy] = useState(false);

    useEffect(function () {
      setCardLoading(true);
      apiGet(`${base}/card`).then(setCard).catch(function () { setCard(null); })
        .then(function () { setCardLoading(false); });
      setReprLoading(true);
      apiPost(`${base}/representation`, {}).then(function (r) { setRepr(r.representation || null); })
        .catch(function () { setRepr(null); })
        .then(function () { setReprLoading(false); });
    }, [base]);

    function sendChat() {
      const query = chatInput.trim();
      if (!query) return;
      setChatBusy(true); setChatError(null); setChatReply(null);
      apiPost(`${base}/chat`, { query: query })
        .then(function (r) { setChatReply(r.content || "(empty response)"); })
        .catch(function (e) { setChatError(parseApiErrorMessage(e)); })
        .then(function () { setChatBusy(false); });
    }

    function runPeerSearch() {
      const q = searchInput.trim();
      if (!q) return;
      setPeerSearchBusy(true);
      // Search scoped to this peer via the peer search path (upstream: peer-scoped).
      apiPost(`/workspaces/${encodeURIComponent(workspaceId)}/search`, { query: q, limit: 10 })
        .then(function (results) { setPeerSearchResults(results || []); })
        .catch(function (e) { setPeerSearchResults({ error: parseApiErrorMessage(e) }); })
        .then(function () { setPeerSearchBusy(false); });
    }

    const cardLines = card && card.peer_card;

    return h("div", { className: "honcho-ui-main" },
      h("div", { className: "honcho-ui-main-head" },
        h("div", null,
          h("h2", { className: "honcho-ui-h2" }, peerId),
          h("div", { className: "honcho-ui-muted" }, "Peer")),
        h(JsonInspector, { label: "Peer object", value: peer })),

      // ---- Card ----
      h(Card, { className: "honcho-ui-card" },
        h(CardHeader, null, h(CardTitle, { className: "text-sm" }, "Peer card")),
        h(CardContent, { className: "text-sm" },
          cardLoading && h("span", { className: "honcho-ui-muted" }, "Loading…"),
          !cardLoading && !cardLines &&
            h(EmptyState, {
              title: "No distilled card yet",
              hint: "Honcho derives peer cards in the background (dreams / deriver passes). Trigger one with the Dream now button in the queue chip.",
            }),
          !cardLoading && cardLines && h("div", { className: "honcho-ui-prewrap" },
            Array.isArray(cardLines) ? cardLines.join("\n") : String(cardLines)))),

      // ---- Representation ----
      h(Card, { className: "honcho-ui-card" },
        h(CardHeader, null, h(CardTitle, { className: "text-sm" }, "Representation")),
        h(CardContent, { className: "text-sm" },
          reprLoading && h("span", { className: "honcho-ui-muted" }, "Loading…"),
          !reprLoading && !repr &&
            h(EmptyState, { title: "No representation yet", hint: "Nothing distilled for this peer so far." }),
          !reprLoading && repr && h("div", { className: "honcho-ui-prewrap" }, repr))),

      // ---- Dialectic chat ----
      h(Card, { className: "honcho-ui-card" },
        h(CardHeader, null, h(CardTitle, { className: "text-sm" }, "Chat with dialectic")),
        h(CardContent, { className: "text-sm" },
          h("div", { className: "honcho-ui-row" },
            h(Input, {
              placeholder: "Ask about this peer's memories…",
              value: chatInput,
              onChange: function (e) { setChatInput(e.target.value); },
              onKeyDown: function (e) { if (e.key === "Enter") sendChat(); },
            }),
            h(Button, { onClick: sendChat, disabled: chatBusy || !chatInput.trim() },
              chatBusy ? "Thinking…" : "Ask")),
          chatError && h("div", { className: "honcho-ui-error" }, chatError),
          chatReply && h("div", { className: "honcho-ui-reply honcho-ui-prewrap" }, chatReply),
          chatReply && h(JsonInspector, { label: "raw response", value: { content: chatReply } }))),

      // ---- Search within peer ----
      h(Card, { className: "honcho-ui-card" },
        h(CardHeader, null, h(CardTitle, { className: "text-sm" }, "Search messages")),
        h(CardContent, { className: "text-sm" },
          h("div", { className: "honcho-ui-row" },
            h(Input, {
              placeholder: "Semantic search across the workspace…",
              value: searchInput,
              onChange: function (e) { setSearchInput(e.target.value); },
              onKeyDown: function (e) { if (e.key === "Enter") runPeerSearch(); },
            }),
            h(Button, { onClick: runPeerSearch, disabled: peerSearchBusy || !searchInput.trim() },
              peerSearchBusy ? "…" : "Search")),
          peerSearchResults && !Array.isArray(peerSearchResults) &&
            h("div", { className: "honcho-ui-error" }, String(peerSearchResults.error)),
          Array.isArray(peerSearchResults) && peerSearchResults.length === 0 &&
            h("div", { className: "honcho-ui-muted honcho-ui-mt" }, "No matches."),
          Array.isArray(peerSearchResults) && peerSearchResults.map(function (m, i) {
            return h("div", { key: m.id || i, className: "honcho-ui-searchhit" },
              h("div", { className: "honcho-ui-msg-meta" },
                h("span", { className: "honcho-ui-msg-peer" }, m.peer_id || "—"),
                h("span", { className: "honcho-ui-msg-time" }, fmtTime(m.created_at)),
                m.session_id && h("span", { className: "honcho-ui-msg-time" }, "session: " + m.session_id)),
              h("div", { className: "honcho-ui-prewrap" }, String(m.content != null ? m.content : "")),
              h(JsonInspector, { label: "raw hit", value: m }));
          }))),
    );
  }

  // ---------------------------------------------------------------------
  // Conclusions feed (workspace-scoped)
  // ---------------------------------------------------------------------

  function ConclusionsFeed(props) {
    const { workspaceId, onInspect } = props;
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [observer, setObserver] = useState("");
    const [observed, setObserved] = useState("");

    const load = useCallback(function (obs, obsd) {
      if (!workspaceId) return;
      setLoading(true);
      const filters = {};
      if (obs) filters.observer = obs;
      if (obsd) filters.observed = obsd;
      apiPost(
        `/workspaces/${encodeURIComponent(workspaceId)}/conclusions/list?size=${PAGE_SIZE}`,
        Object.keys(filters).length ? { filters: filters } : {},
      )
        .then(function (res) { setItems(res.items || []); setError(null); })
        .catch(function (e) { setError(parseApiErrorMessage(e)); })
        .then(function () { setLoading(false); });
    }, [workspaceId]);

    useEffect(function () { load(observer, observed); }, [load, observer, observed]);

    return h(Card, { className: "honcho-ui-card" },
      h(CardHeader, null, h(CardTitle, { className: "text-sm" },
        `Conclusions${loading ? " …" : ""}`)),
      h(CardContent, { className: "text-sm" },
        h("div", { className: "honcho-ui-row honcho-ui-mb" },
          h(Input, {
            placeholder: "observer filter (peer id)", value: observer,
            onChange: function (e) { setObserver(e.target.value); },
          }),
          h(Input, {
            placeholder: "observed filter (peer id)", value: observed,
            onChange: function (e) { setObserved(e.target.value); },
          }),
          h(Button, {
            size: "sm", variant: "outline",
            onClick: function () { load(observer, observed); },
          }, "Apply")),
        error && h("div", { className: "honcho-ui-error" }, error),
        !error && items.length === 0 && !loading &&
          h("div", { className: "honcho-ui-muted" }, "No conclusions derived yet."),
        items.map(function (c, i) {
          return h("div", { key: c.id || i, className: "honcho-ui-conclusion" },
            h("div", { className: "honcho-ui-msg-meta" },
              c.observer && h("span", { className: "honcho-ui-msg-peer" }, c.observer),
              c.observed && h("span", { className: "honcho-ui-muted" }, "→ " + c.observed),
              h("span", { className: "honcho-ui-msg-time" }, fmtTime(c.created_at))),
            h("div", { className: "honcho-ui-prewrap" },
              String(c.content != null ? c.content : "")),
            h(JsonInspector, { label: "raw conclusion", value: c }));
        })));
  }

  // ---------------------------------------------------------------------
  // Sidebar — workspaces, then sessions + peers of selected workspace
  // ---------------------------------------------------------------------

  function Sidebar(props) {
    const {
      workspaces, selectedWorkspace, onSelectWorkspace,
      sessions, peers, selectedSession, onSelectSession, selectedPeer, onSelectPeer,
      sideLoading,
    } = props;

    return h("div", { className: "honcho-ui-sidebar" },
      h("div", { className: "honcho-ui-sidebar-section" },
        h("div", { className: "honcho-ui-sidebar-title" }, "Workspaces"),
        sideLoading && h("div", { className: "honcho-ui-muted" }, "Loading…"),
        workspaces.map(function (w) {
          const id = w.id || w.name;
          const active = id === selectedWorkspace;
          return h("button", {
            key: id,
            className: cn("honcho-ui-sidebar-item", active && "honcho-ui-sidebar-item--active"),
            onClick: function () { onSelectWorkspace(id); },
          }, id);
        }),
        workspaces.length === 0 && !sideLoading &&
          h("div", { className: "honcho-ui-muted" }, "No workspaces found")),

      selectedWorkspace && h("div", { className: "honcho-ui-sidebar-section" },
        h("div", { className: "honcho-ui-sidebar-title" }, "Sessions"),
        sessions.map(function (s) {
          const id = s.id || s.name;
          const active = id === selectedSession;
          return h("button", {
            key: id,
            className: cn("honcho-ui-sidebar-item", active && "honcho-ui-sidebar-item--active"),
            onClick: function () { onSelectSession(id, s); },
          }, id);
        }),
        sessions.length === 0 &&
          h("div", { className: "honcho-ui-muted" }, "(none)")),

      selectedWorkspace && h("div", { className: "honcho-ui-sidebar-section" },
        h("div", { className: "honcho-ui-sidebar-title" }, "Peers"),
        peers.map(function (p) {
          const id = p.id || p.name;
          const active = id === selectedPeer;
          return h("button", {
            key: id,
            className: cn("honcho-ui-sidebar-item", active && "honcho-ui-sidebar-item--active"),
            onClick: function () { onSelectPeer(id, p); },
          }, id);
        }),
        peers.length === 0 &&
          h("div", { className: "honcho-ui-muted" }, "(none)")),
    );
  }

  // ---------------------------------------------------------------------
  // Root page
  // ---------------------------------------------------------------------

  function HonchoPage() {
    const [status, setStatus] = useState(null);
    const [fatal, setFatal] = useState(null);

    const [workspaces, setWorkspaces] = useState([]);
    const [selectedWorkspace, setSelectedWorkspace] = useState(null);

    const [sessions, setSessions] = useState([]);
    const [peers, setPeers] = useState([]);
    const [sideLoading, setSideLoading] = useState(true);

    const [selectedSession, setSelectedSession] = useState(null);
    const [selectedPeer, setSelectedPeer] = useState(null);

    const [searchInput, setSearchInput] = useState("");
    const [searchResults, setSearchResults] = useState(null);
    const [searchBusy, setSearchBusy] = useState(false);
    const [showConclusions, setShowConclusions] = useState(false);

    // Plugin status + workspace list on mount.
    useEffect(function () {
      apiGet("/status")
        .then(function (s) {
          setStatus(s);
          if (!s.reachable) setFatal(`Honcho server unreachable at ${s.base_url}`);
        })
        .catch(function (e) { setFatal(parseApiErrorMessage(e)); });
      apiPost("/workspaces/list?page=1&size=100", {})
        .then(function (res) {
          const items = (res.items || []).map(function (w) {
            // Page_Workspace_ items may be {id: {..}}-wrapped objects.
            return (w.id && typeof w.id === "object") ? w.id : w;
          });
          setWorkspaces(items);
          setSideLoading(false);
        })
        .catch(function (e) { setFatal(parseApiErrorMessage(e)); setSideLoading(false); });
    }, []);

    // Sessions + peers refresh when workspace selection changes.
    useEffect(function () {
      if (!selectedWorkspace) { setSessions([]); setPeers([]); return; }
      setSelectedSession(null); setSelectedPeer(null);
      const ws = encodeURIComponent(selectedWorkspace);
      Promise.all([
        apiPost(`/workspaces/${ws}/sessions/list?page=1&size=100`, {}),
        apiPost(`/workspaces/${ws}/peers/list?page=1&size=100`, {}),
      ])
        .then(function (results) {
          const norm = function (res) {
            return (res.items || []).map(function (x) {
              return (x.id && typeof x.id === "object") ? x.id : x;
            });
          };
          setSessions(norm(results[0]));
          setPeers(norm(results[1]));
        })
        .catch(function (e) { setFatal(parseApiErrorMessage(e)); });
    }, [selectedWorkspace]);

    function runSearch() {
      const q = searchInput.trim();
      if (!q || !selectedWorkspace) return;
      setSearchBusy(true);
      apiPost(`/workspaces/${encodeURIComponent(selectedWorkspace)}/search`, { query: q, limit: 20 })
        .then(function (r) { setSearchResults(r || []); })
        .catch(function (e) { setSearchResults({ error: parseApiErrorMessage(e) }); })
        .then(function () { setSearchBusy(false); });
    }

    if (fatal && !status) {
      return h("div", { className: "honcho-ui p-6" },
        h("h2", { className: "honcho-ui-h2" }, "Honcho"),
        h("div", { className: "honcho-ui-error" }, fatal));
    }

    return h("div", { className: "honcho-ui" },
      // ---- Header ----
      h("div", { className: "honcho-ui-header" },
        h("div", { className: "honcho-ui-header-title" },
          h("h1", { className: "honcho-ui-h1" }, "Honcho"),
          status && h("span", { className: "honcho-ui-muted" },
            status.server_version ? `v${status.server_version} · ${status.base_url}` : status.base_url)),
        selectedWorkspace && h(QueueChip, { workspaceId: selectedWorkspace })),

      fatal && h("div", { className: "honcho-ui-error honcho-ui-mb" }, fatal),

      h("div", { className: "honcho-ui-body" },
        h(Sidebar, {
          workspaces: workspaces,
          selectedWorkspace: selectedWorkspace,
          onSelectWorkspace: setSelectedWorkspace,
          sessions: sessions,
          peers: peers,
          selectedSession: selectedSession,
          onSelectSession: function (id, s) { setSelectedSession(s); setSelectedPeer(null); },
          selectedPeer: selectedPeer,
          onSelectPeer: function (id, p) { setSelectedPeer(p); setSelectedSession(null); },
          sideLoading: sideLoading,
        }),

        h("div", { className: "honcho-ui-content" },
          // Global workspace search + conclusions toggle
          h("div", { className: "honcho-ui-row honcho-ui-mb" },
            h(Input, {
              placeholder: selectedWorkspace
                ? `Search messages in ${selectedWorkspace}…`
                : "Select a workspace to search…",
              value: searchInput,
              disabled: !selectedWorkspace,
              onChange: function (e) { setSearchInput(e.target.value); },
              onKeyDown: function (e) { if (e.key === "Enter") runSearch(); },
            }),
            h(Button, {
              onClick: runSearch,
              disabled: !selectedWorkspace || searchBusy || !searchInput.trim(),
            }, searchBusy ? "…" : "Search"),
            h(Button, {
              variant: "outline", size: "sm",
              disabled: !selectedWorkspace,
              onClick: function () { setShowConclusions(!showConclusions); },
            }, showConclusions ? "Hide conclusions" : "Conclusions")),

          searchResults && !Array.isArray(searchResults) &&
            h("div", { className: "honcho-ui-error honcho-ui-mb" }, String(searchResults.error)),
          Array.isArray(searchResults) && searchResults.length > 0 &&
            h(Card, { className: "honcho-ui-card" },
              h(CardHeader, null, h(CardTitle, { className: "text-sm" },
                `Search results (${searchResults.length})`)),
              h(CardContent, { className: "text-sm" },
                searchResults.map(function (m, i) {
                  return h("div", { key: m.id || i, className: "honcho-ui-searchhit" },
                    h("div", { className: "honcho-ui-msg-meta" },
                      h("span", { className: "honcho-ui-msg-peer" }, m.peer_id || "—"),
                      h("span", { className: "honcho-ui-msg-time" }, fmtTime(m.created_at))),
                    h("div", { className: "honcho-ui-prewrap" },
                      String(m.content != null ? m.content : "")));
                }))),

          showConclusions && selectedWorkspace &&
            h(ConclusionsFeed, { workspaceId: selectedWorkspace }),

          // Main area switches by selection
          selectedSession && selectedWorkspace &&
            h(SessionView, { workspaceId: selectedWorkspace, session: selectedSession }),

          selectedPeer && selectedWorkspace &&
            h(PeerView, { workspaceId: selectedWorkspace, peer: selectedPeer }),

          !selectedSession && !selectedPeer &&
            h(EmptyState, {
              title: selectedWorkspace
                ? "Pick a session or peer from the sidebar"
                : "Pick a workspace from the sidebar to browse its memories",
              icon: "🧠",
              hint: selectedWorkspace
                ? "Sessions show message timelines; peers show distilled cards, representations, and dialectic chat."
                : null,
            }),
        )));
  }

  register("honcho-ui", HonchoPage);
})();