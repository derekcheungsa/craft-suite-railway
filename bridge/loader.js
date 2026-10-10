/* Craft Relay bridge loader. Injected into Craft Suite app pages by the suite
 * image. Waits for the app's in-page API, then offers a "Connect agent"
 * control that opens a WebSocket to the relay and executes MCP tool calls
 * through the app's adapter. Everything is opt-in: nothing connects until the
 * user clicks Connect and pastes the bridge token. */
(function () {
  "use strict";
  if (window.__craftRelayLoaded) return;
  window.__craftRelayLoaded = true;

  function dbg() {
    try { console.log.apply(console, ["[craft-relay]"].concat([].slice.call(arguments))); } catch (e) { /* ignore */ }
  }
  window.addEventListener("error", function (ev) { dbg("page error:", ev.message, ev.filename, ev.lineno); });
  window.addEventListener("unhandledrejection", function (ev) { dbg("unhandled rejection:", ev.reason); });

  var RELAY_URL_DEFAULT = (window.CRAFT_RELAY && window.CRAFT_RELAY.url) || "";
  var APP = location.pathname.split("/").filter(Boolean)[0] || ""; // e.g. "lightcraft"

  var state = {
    ws: null,
    sessionId: null,
    status: "idle",           // idle | waiting | connecting | connected | reconnecting
    readOnly: false,
    adapter: null,
    version: "?",
    versionOk: null,
    tabId: (function () {
      var t = sessionStorage.getItem("craftRelayTabId");
      if (!t) { t = "t" + Math.random().toString(36).slice(2, 9); sessionStorage.setItem("craftRelayTabId", t); }
      return t;
    })(),
    manualClose: false,
    backoff: 1000,
    log: []
  };

  /* ---------- tiny helpers ---------- */
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "style") e.style.cssText = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  function pushLog(entry) {
    state.log.unshift(entry);
    state.log = state.log.slice(0, 12);
    renderLog();
  }

  /* ---------- downscale images before sending (PRD: cap 1 MB) ---------- */
  function loadImage(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("could not decode preview image")); };
      img.src = dataUrl;
    });
  }
  function downscaleImage(mime, base64, attempt) {
    var dataUrl = "data:" + (mime || "image/png") + ";base64," + base64;
    var maxBytes = 950 * 1024;
    if (Math.floor(base64.length * 3 / 4) <= maxBytes) {
      return Promise.resolve({ mime: mime || "image/png", base64: base64 });
    }
    var cfg = [
      { dim: 1024, type: "image/png", q: undefined },
      { dim: 1024, type: "image/jpeg", q: 0.85 },
      { dim: 768, type: "image/jpeg", q: 0.75 },
      { dim: 512, type: "image/jpeg", q: 0.7 }
    ][attempt];
    if (!cfg) return Promise.reject(new Error("preview cannot be compressed under the 1 MB cap"));
    return loadImage(dataUrl).then(function (img) {
      var scale = Math.min(1, cfg.dim / Math.max(img.width, img.height));
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      var out = canvas.toDataURL(cfg.type, cfg.q);
      return downscaleImage(cfg.type, out.slice(out.indexOf(",") + 1), attempt + 1);
    });
  }

  /* ---------- adapter discovery ---------- */
  function detectAdapter() {
    var adapters = window.CraftRelayAdapters || {};
    for (var name in adapters) {
      try { if (adapters[name].detect()) return adapters[name]; } catch (e) { /* keep looking */ }
    }
    return null;
  }
  function fetchVersion() {
    return fetch("/versions.json").then(function (r) { return r.json(); }).catch(function () { return {}; }).then(function (v) {
      state.version = v[APP] || "?";
      var adapter = state.adapter;
      if (adapter) {
        var prefix = adapter.versions.some(function (want) {
          return state.version.indexOf("v" + want) === 0 || state.version.indexOf(want) === 0;
        });
        state.versionOk = prefix;
      }
    });
  }

  /* ---------- websocket ---------- */
  function connect(url, token) {
    dbg("connect requested, url:", url, "token length:", token.length);
    closeSocket(false);
    setStatus("connecting");
    var ws;
    try {
      var wsUrl = url.replace(/^http(s?):\/\//, "ws$1://").replace(/\/+$/, "") + "/bridge?token=" + encodeURIComponent(token);
      dbg("opening websocket:", wsUrl.replace(/token=[^&]*/, "token=***"));
      ws = new WebSocket(wsUrl);
    } catch (e) {
      dbg("websocket constructor failed:", e && e.message);
      setStatus("idle");
      setNote("bad relay URL: " + (e && e.message ? e.message : e));
      return;
    }
    state.ws = ws;
    ws.onopen = function () {
      dbg("socket open, sending hello", { app: APP, version: state.version, tabId: state.tabId });
      state.backoff = 1000;
      ws.send(JSON.stringify({ type: "hello", app: APP, version: state.version, tabId: state.tabId }));
    };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === "welcome") {
        state.sessionId = m.sessionId;
        setStatus("connected");
        setNote("session " + m.sessionId + (state.versionOk === false ? " · adapter version mismatch (tools disabled)" : ""));
      } else if (m.type === "request") {
        handleRequest(m);
      } else if (m.type === "error") {
        setNote(m.message);
      }
    };
    ws.onclose = function (ev) {
      dbg("socket closed:", ev.code, ev.reason);
      state.sessionId = null;
      if (state.manualClose) { setStatus("idle"); return; }
      setStatus("reconnecting");
      setTimeout(function () {
        if (state.status === "reconnecting") {
          var saved = getSaved();
          if (saved.url && saved.token) connect(saved.url, saved.token);
        }
      }, state.backoff);
      state.backoff = Math.min(state.backoff * 2, 15000);
    };
    ws.onerror = function (e) { dbg("socket error event"); /* onclose follows */ };
  }
  function closeSocket(manual) {
    state.manualClose = manual;
    if (state.ws) { try { state.ws.close(); } catch (e) { /* ignore */ } }
    state.ws = null;
    if (manual) { state.sessionId = null; setStatus("idle"); }
  }
  function send(obj) {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
  }

  function getSaved() {
    return {
      url: localStorage.getItem("craftRelayUrl") || RELAY_URL_DEFAULT,
      token: sessionStorage.getItem("craftRelayToken") || ""
    };
  }

  /* ---------- request dispatch ---------- */
  function reply(id, ok, payload, kind) {
    var msg = { type: "response", id: id, ok: ok };
    if (ok) msg.result = payload; else { msg.error = payload; if (kind) msg.kind = kind; }
    send(msg);
  }
  function handleRequest(m) {
    var adapter = state.adapter;
    var tool = m.tool, args = m.args || {};
    var t0 = performance.now();

    if (!adapter) { reply(m.id, false, "this app build has no agent adapter (supported: lightcraft, effectcraft)"); return; }
    if (state.versionOk === false) {
      reply(m.id, false, "adapter built for " + adapter.app + " v" + adapter.versions.join("/") + " but page runs " + state.version + " — tools disabled until the adapter is updated");
      return;
    }
    if (state.status !== "connected") { reply(m.id, false, "bridge is not connected"); return; }

    if (tool === "run_command" || tool === "run_batch") {
      if (state.readOnly) {
        var allow = tool === "run_command" && adapter.readOnlyCommands && adapter.readOnlyCommands.indexOf(args.command) !== -1;
        if (!allow) { pushLog({ t: Date.now(), tool: tool + ":" + (args.command || ""), err: "read-only mode" }); reply(m.id, false, "read-only mode is on: only listing/inspect/get_image work"); return; }
      }
      var cmds = tool === "run_batch" ? (args.commands || []).map(function (c) { return c.command; }) : [args.command];
      for (var i = 0; i < cmds.length; i++) {
        var hit = window.CraftRelayDenied && window.CraftRelayDenied(cmds[i]);
        if (hit) { pushLog({ t: Date.now(), tool: tool + ":" + cmds[i], err: "denylist" }); reply(m.id, false, 'command "' + cmds[i] + '" is on the denylist (' + hit + ") and was blocked in the page"); return; }
      }
    }
    if (tool === "send_file" && state.readOnly) {
      pushLog({ t: Date.now(), tool: "send_file:" + (args.path || ""), err: "read-only mode" });
      reply(m.id, false, "read-only mode is on: file uploads are blocked");
      return;
    }
    if (tool === "put_file" && state.readOnly) {
      pushLog({ t: Date.now(), tool: "put_file:" + (args.name || ""), err: "read-only mode" });
      reply(m.id, false, "read-only mode is on: imports are blocked");
      return;
    }
    if ((tool === "list_files" || tool === "get_file" || tool === "send_file") && !adapter.listFiles) {
      reply(m.id, false, "this app's adapter has no file API (filmcraft, effectcraft and photocraft do)");
      return;
    }
    if (tool === "put_file" && !adapter.importFile) {
      reply(m.id, false, "this app's adapter cannot import files (filmcraft, effectcraft and photocraft can)");
      return;
    }

    var done = function (result) {
      pushLog({ t: Date.now(), tool: tool + (args.command ? ":" + args.command : ""), ms: Math.round(performance.now() - t0) });
      reply(m.id, true, result);
    };
    var fail = function (e) {
      var msg = e && (e.message || String(e));
      var kind = /device (was )?lost|GPUDevice/i.test(msg || "") ? "gpu-lost" : undefined;
      pushLog({ t: Date.now(), tool: tool + (args.command ? ":" + args.command : ""), err: (msg || "error").slice(0, 80) });
      reply(m.id, false, msg || "error", kind);
    };

    try {
      if (tool === "list_commands") Promise.resolve(adapter.listCommands(args.filter || null)).then(done, fail);
      else if (tool === "run_command") Promise.resolve(adapter.runCommand(args.command, args.params || {})).then(done, fail);
      else if (tool === "run_batch") runBatch(adapter, args.commands || []).then(done, fail);
      else if (tool === "inspect") Promise.resolve(adapter.inspect()).then(done, fail);
      else if (tool === "get_image") adapter.image(args.mode).then(function (img) {
        return downscaleImage(img.mime, img.base64, 0);
      }).then(done, fail);
      else if (tool === "list_files") Promise.resolve(adapter.listFiles()).then(done, fail);
      else if (tool === "get_file") Promise.resolve(adapter.file(args.path)).then(function (bytes) {
        var kit = window.CraftRelayFileKit;
        return { base64: kit.toBase64(bytes), kind: kit.mimeFor(args.path) };
      }).then(done, fail);
      else if (tool === "send_file") adapter.sendFile(args.path, args.url, args.method || "PUT").then(function (r) {
        pushLog({ t: Date.now(), tool: "send_file:" + (args.path || ""), ms: Math.round(performance.now() - t0) });
        reply(m.id, true, r);
      }, fail);
      else if (tool === "put_file") Promise.resolve(adapter.importFile(args)).then(function (r) {
        if (r instanceof Error) throw r;
        return r;
      }).then(done, fail);
      else reply(m.id, false, "unknown tool " + tool);
    } catch (e) { fail(e); }
  }
  function runBatch(adapter, commands) {
    var results = [];
    var step = function (i) {
      if (i >= commands.length) return results;
      return Promise.resolve(adapter.runCommand(commands[i].command, commands[i].params || {})).then(function (r) {
        results.push({ command: commands[i].command, ok: true, result: r });
        return step(i + 1);
      }, function (e) {
        results.push({ command: commands[i].command, ok: false, error: e && (e.message || String(e)) });
        throw { batch: results, message: "command " + commands[i].command + " failed; batch stopped" };
      });
    };
    return step(0);
  }

  /* ---------- UI (shadow DOM so app CSS cannot touch it) ---------- */
  var root, host, statusEl, noteEl, logEl, urlInput, tokenInput, connectBtn, disconnectBtn, roInput, panelOpen = false;

  function setStatus(s) { state.status = s; if (statusEl) renderStatus(); }
  function setNote(t) { if (noteEl) noteEl.textContent = t || ""; }

  function renderStatus() {
    if (!statusEl) return;
    var map = {
      idle: ["○", "not connected"],
      connecting: ["◐", "connecting…"],
      connected: ["●", "agent connected"],
      reconnecting: ["◑", "reconnecting…"],
      waiting: ["◌", "waiting for app…"]
    };
    var m = map[state.status] || map.idle;
    statusEl.textContent = m[0] + " " + m[1];
    statusEl.style.color = state.status === "connected" ? "#7ee08a" : state.status === "reconnecting" ? "#e0b25e" : "#9a9daa";
  }
  function renderLog() {
    if (!logEl) return;
    logEl.textContent = "";
    state.log.forEach(function (entry) {
      var line = new Date(entry.t).toLocaleTimeString() + "  " + entry.tool + (entry.ms != null ? "  " + entry.ms + "ms" : "") + (entry.err ? "  ✗ " + entry.err : "");
      var d = el("div", { text: line, style: entry.err ? "color:#e07a5e;" : "" });
      logEl.appendChild(d);
    });
    if (!state.log.length) logEl.appendChild(el("div", { text: "no commands yet", style: "color:#6a6d78;" }));
  }

  function buildUI() {
    host = el("div", { style: "position:fixed;right:16px;bottom:16px;z-index:2147483646;" });
    document.body.appendChild(host);
    root = host.attachShadow({ mode: "open" });

    var style = el("style", { text: [
      ":host { display:block; font:13px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }",
      "* { box-sizing: border-box; }",
      ".fab { width:40px; height:40px; border-radius:50%; border:1px solid #3a3d48; background:#1d1f27; color:#e8e9ee; cursor:pointer; font-size:17px; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 14px rgba(0,0,0,.5); margin-left:auto; }",
      ".fab:hover { border-color:#6d5df6; }",
      ".panel { position:absolute; right:0; bottom:52px; width:320px; background:#1d1f27; border:1px solid #3a3d48; border-radius:12px; padding:14px; color:#e8e9ee; box-shadow:0 8px 30px rgba(0,0,0,.55); }",
      ".panel h3 { margin:0 0 2px; font-size:14px; }",
      ".status { font-size:12px; margin-bottom:8px; }",
      ".note { font-size:11.5px; color:#e0b25e; margin-bottom:6px; min-height:0; }",
      "input[type=text],input[type=password] { width:100%; background:#14151a; color:#e8e9ee; border:1px solid #3a3d48; border-radius:7px; padding:6px 8px; font:12px ui-monospace,monospace; margin:3px 0 8px; }",
      "label { font-size:11.5px; color:#9a9daa; display:block; }",
      ".row { display:flex; gap:8px; margin-bottom:8px; }",
      "button.act { flex:1; border:0; border-radius:8px; padding:8px 0; font-weight:600; cursor:pointer; background:#6d5df6; color:#fff; }",
      "button.act.ghost { background:#2a2d38; color:#c9ccd6; }",
      "button.act:disabled { opacity:.45; cursor:default; }",
      ".priv { font-size:11px; color:#9a9daa; background:#14151a; border-radius:8px; padding:8px; margin-bottom:8px; }",
      ".ro { display:flex; align-items:center; gap:6px; font-size:12px; margin-bottom:8px; color:#c9ccd6; }",
      ".log { background:#14151a; border-radius:8px; padding:8px; max-height:150px; overflow:auto; font:11px ui-monospace,monospace; color:#b9bcc7; }",
      ".log div { margin:1px 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }"
    ].join("\n") });
    root.appendChild(style);

    var fab = el("button", { class: "fab", title: "Agent bridge", text: "⦿", onclick: function () { panelOpen = !panelOpen; panel.style.display = panelOpen ? "block" : "none"; } });
    root.appendChild(fab);

    var saved = getSaved();
    panel = el("div", { class: "panel", style: "display:none;" });

    statusEl = el("div", { class: "status" });
    noteEl = el("div", { class: "note", style: "display:none;" });
    var setNoteOrig = setNote;
    setNote = function (t) { noteEl.textContent = t || ""; noteEl.style.display = t ? "block" : "none"; };

    urlInput = el("input", { type: "text", value: saved.url || "", placeholder: "https://your-relay.up.railway.app", spellcheck: "false" });
    tokenInput = el("input", { type: "password", value: saved.token || "", placeholder: "bridge token", spellcheck: "false" });
    roInput = el("input", { type: "checkbox", onchange: function () { state.readOnly = roInput.checked; } });

    function doConnect() {
      var url = urlInput.value.trim(), token = tokenInput.value.trim();
      if (!url || !token) { setNote("relay URL and bridge token are both required"); return; }
      localStorage.setItem("craftRelayUrl", url);
      sessionStorage.setItem("craftRelayToken", token);
      connect(url, token);
    }
    [urlInput, tokenInput].forEach(function (input) {
      input.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); doConnect(); } });
    });

    connectBtn = el("button", { class: "act", text: "Connect agent", onclick: doConnect });
    disconnectBtn = el("button", { class: "act ghost", text: "Disconnect", onclick: function () {
      sessionStorage.removeItem("craftRelayToken");
      closeSocket(true);
      setNote("");
    } });

    panel.appendChild(el("h3", { text: "Agent bridge" }));
    panel.appendChild(statusEl);
    panel.appendChild(noteEl);
    panel.appendChild(el("label", { text: "Relay URL" }));
    panel.appendChild(urlInput);
    panel.appendChild(el("label", { text: "Bridge token" }));
    panel.appendChild(tokenInput);
    panel.appendChild(el("div", { class: "row" }, [connectBtn, disconnectBtn]));
    panel.appendChild(el("label", { class: "ro" }, [roInput, document.createTextNode("read-only mode (block edits)")])); 
    panel.appendChild(el("div", { class: "priv", text: "While connected, an agent can run commands in this tab and request previews of what you are editing. Nothing is stored on the relay. Disconnect at any time." }));
    logEl = el("div", { class: "log" });
    panel.appendChild(logEl);
    root.appendChild(panel);

    renderStatus();
    renderLog();
    // Deep link: /lightcraft/?agent=1 opens the panel (connecting still needs
    // an explicit Connect with the token).
    if (new URLSearchParams(location.search).has("agent")) {
      panelOpen = true;
      panel.style.display = "block";
    }
  }
  var panel;

  /* ---------- boot: wait for the app's API, then show the button ---------- */
  function boot(attempt) {
    state.adapter = detectAdapter();
    if (!state.adapter && attempt < 120) { setTimeout(function () { boot(attempt + 1); }, 1000); return; }
    dbg("boot: app =", APP, "adapter =", state.adapter && state.adapter.app);
    if (!state.adapter) { state.versionOk = null; }
    fetchVersion().then(function () {
      dbg("version:", state.version, "versionOk:", state.versionOk, "body:", !!document.body);
      if (document.body) buildUI();
      else window.addEventListener("DOMContentLoaded", buildUI);
      if (state.adapter) setStatus("idle");
    });
  }
  boot(0);
})();
