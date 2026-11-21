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

  /* ---------- the shelf: files shared between app tabs ----------
   * Every Craft Suite app is served from the same origin, so they share one
   * IndexedDB. The shelf is a small store there: an agent puts a file from
   * one app's file table on it (send_file to https://shelf/<name>) and takes
   * it into another app (put_file with url https://shelf/<name>). Bytes stay
   * in this browser — they never go to the relay or the conversation. The
   * user can see and clear the shelf from the bridge panel. */
  var SHELF_HOST = "shelf";
  var shelfDbPromise = null;
  function shelfDb() {
    if (shelfDbPromise) return shelfDbPromise;
    shelfDbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open("craft-shelf", 1);
      req.onupgradeneeded = function () { req.result.createObjectStore("files", { keyPath: "name" }); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { shelfDbPromise = null; reject(new Error("shelf storage unavailable: " + (req.error && req.error.message))); };
    });
    return shelfDbPromise;
  }
  function shelfTx(mode, fn) {
    return shelfDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction("files", mode), store = tx.objectStore("files"), out;
        var r = fn(store);
        if (r) r.onsuccess = function () { out = r.result; };
        tx.oncomplete = function () { resolve(out); };
        tx.onerror = tx.onabort = function () { reject(new Error("shelf: " + (tx.error && tx.error.message))); };
      });
    });
  }
  /* "https://shelf/name.png" (or "shelf:name.png") -> "name.png"; anything else -> null */
  function shelfName(url) {
    if (typeof url !== "string") return null;
    var m = /^shelf:\/*(.*)$/i.exec(url);
    if (m) return decodeURIComponent(m[1]);
    try {
      var u = new URL(url);
      if (u.hostname === SHELF_HOST) return decodeURIComponent(u.pathname.slice(1));
    } catch (e) { /* not a URL */ }
    return null;
  }
  function baseName(p) { return String(p || "file").split(/[\\/]/).pop() || "file"; }
  function toBytes(b) {
    if (b instanceof Error) throw b;
    if (typeof b === "string") return new TextEncoder().encode(b);
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
    if (b && b.buffer instanceof ArrayBuffer && !(b instanceof Uint8Array)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (!b || typeof b.length !== "number") throw new Error("no bytes returned");
    return b;
  }
  var shelf = {
    put: function (name, bytes) {
      bytes = toBytes(bytes);
      var rec = { name: name, bytes: new Blob([bytes]), size: bytes.length, from: APP, savedAt: Date.now() };
      return shelfTx("readwrite", function (s) { return s.put(rec); }).then(function () {
        shelfChanged();
        return { ok: true, status: 200, bytes: bytes.length, shelf: "https://" + SHELF_HOST + "/" + encodeURIComponent(name) };
      });
    },
    get: function (name) {
      return shelfTx("readonly", function (s) { return s.get(name); }).then(function (rec) {
        if (!rec) throw new Error("shelf: no file named " + name + " (list_files shows what's on the shelf)");
        return rec.bytes.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
      });
    },
    list: function () {
      return shelfTx("readonly", function (s) { return s.getAll(); }).then(function (all) {
        return (all || []).map(function (r) {
          return { path: "https://" + SHELF_HOST + "/" + encodeURIComponent(r.name), size: r.size, kind: "shelf", from: r.from, savedAt: r.savedAt };
        });
      });
    },
    clear: function () { return shelfTx("readwrite", function (s) { return s.clear(); }).then(shelfChanged); }
  };
  window.CraftShelf = { list: shelf.list, clear: shelf.clear };

  /* ---------- optional: download every new export to this PC ---------- */
  var AUTO_DL_KEY = "craftAutoDownload";
  var autoDl = { on: false, seen: null, timer: null, pending: {} };
  // Files the app downloaded by itself (some apps, e.g. EffectCraft, already
  // download finished renders): remember their names so we don't save them twice.
  var appDownloads = {};
  // Files Claude imports (put_file, including from the shelf) are inputs, not
  // exports: when one shows up in the file table, note it as seen instead of
  // downloading it. A later save of the same file (new size) still downloads.
  var importedNames = {};
  function noteImport(name) { if (name) importedNames[baseName(name)] = Date.now(); }
  var ourClick = false;
  function noteAppDownload(a) {
    if (ourClick || !a || !a.hasAttribute || !a.hasAttribute("download")) return;
    var n = baseName(a.getAttribute("download") || (a.href || "").split(/[?#]/)[0].split("/").pop() || "");
    if (n) appDownloads[n] = Date.now();
  }
  try {
    var origAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { noteAppDownload(this); return origAnchorClick.apply(this, arguments); };
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a[download]") : null;
      if (a) noteAppDownload(a);
    }, true);
  } catch (e) { /* ignore */ }
  function appAlreadyDownloaded(name) {
    var t = appDownloads[baseName(name)];
    return !!t && Date.now() - t < 5 * 60 * 1000;
  }
  function saveBlob(name, bytes) {
    var url = URL.createObjectURL(new Blob([bytes], { type: (window.CraftRelayFileKit && window.CraftRelayFileKit.mimeFor(name)) || "application/octet-stream" }));
    var a = document.createElement("a");
    a.href = url; a.download = baseName(name); a.style.display = "none";
    document.body.appendChild(a);
    ourClick = true;
    try { a.click(); } finally { ourClick = false; }
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }
  function autoDlTick() {
    var ad = state.adapter;
    if (!autoDl.on || !ad || !ad.listFiles || !ad.file) return;
    Promise.resolve(ad.listFiles()).then(function (files) {
      files = (files || []).filter(function (f) { return f && f.path && f.kind !== "shelf" && f.kind !== "import" && f.kind !== "imported"; });
      var sig = function (f) { return (f.size || "") + "|" + (f.savedAt || ""); };
      // seen: path -> the signature last downloaded (or present when the box was ticked)
      if (!autoDl.seen) { autoDl.seen = {}; files.forEach(function (f) { autoDl.seen[f.path] = sig(f); }); return; }
      files.forEach(function (f) {
        var s = sig(f);
        if (autoDl.seen[f.path] === s) { delete autoDl.pending[f.path]; return; }
        var imp = importedNames[baseName(f.path)];
        if (imp && autoDl.seen[f.path] === undefined && Date.now() - imp < 10 * 60 * 1000) {
          delete importedNames[baseName(f.path)]; delete autoDl.pending[f.path];
          autoDl.seen[f.path] = s; return;
        }
        // A file still being written (a render in progress) changes size between
        // ticks: wait until it reads the same twice in a row, then save it once.
        if (autoDl.pending[f.path] !== s) { autoDl.pending[f.path] = s; return; }
        delete autoDl.pending[f.path];
        autoDl.seen[f.path] = s;
        if (appAlreadyDownloaded(f.path)) { pushLog({ t: Date.now(), tool: "skipped " + baseName(f.path) + " (the app downloaded it)" }); return; }
        Promise.resolve(ad.file(f.path)).then(function (b) { saveBlob(f.path, toBytes(b)); pushLog({ t: Date.now(), tool: "downloaded " + baseName(f.path) }); },
          function (e) { pushLog({ t: Date.now(), tool: "download " + baseName(f.path), err: (e && e.message || "failed").slice(0, 60) }); });
      });
    }).catch(function () { /* app not ready yet */ });
  }
  function setAutoDownload(on) {
    autoDl.on = !!on;
    autoDl.seen = null; // only exports made from now on are downloaded
    autoDl.pending = {};
    try { localStorage.setItem(AUTO_DL_KEY, on ? "1" : "0"); } catch (e) { /* ignore */ }
    if (autoDl.timer) { clearInterval(autoDl.timer); autoDl.timer = null; }
    if (on) { autoDlTick(); autoDl.timer = setInterval(autoDlTick, 2000); }
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
      // A relative RELAY_URL ("/relay") is same-origin: nginx proxies /relay/
      // to craft-relay, so deployments work without knowing its public domain.
      if (/^\/[^/]/.test(url)) url = location.origin + url;
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
        showRelayNotice(typeof m.relayVersion === "number" ? m.relayVersion : 1);
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

    if (!adapter) { reply(m.id, false, "this app build has no agent API yet (reload the tab after a deploy; supported apps: " + Object.keys(window.CraftRelayAdapters || {}).join(", ") + ")"); return; }
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
    var shelfIn = tool === "put_file" ? shelfName(args.url) : null;          // shelf -> app
    var shelfOut = tool === "send_file" ? shelfName(args.url) : null;        // app -> shelf
    var shelfRead = tool === "get_file" ? shelfName(args.path) : null;       // shelf -> conversation
    if (((tool === "get_file" && shelfRead == null) || tool === "send_file") && !adapter.listFiles) {
      reply(m.id, false, "this app's adapter has no file API; use its own save/export commands");
      return;
    }
    if (tool === "put_file" && !adapter.importFile) {
      reply(m.id, false, "this app's adapter cannot import files; use its own open command");
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
      else if (tool === "list_files") Promise.all([
        adapter.listFiles ? Promise.resolve(adapter.listFiles()) : Promise.resolve([]),
        shelf.list().catch(function () { return []; })
      ]).then(function (r) { return (r[0] || []).concat(r[1]); }).then(done, fail);
      else if (tool === "get_file") Promise.resolve(shelfRead != null ? shelf.get(shelfRead) : adapter.file(args.path)).then(function (bytes) {
        var kit = window.CraftRelayFileKit;
        return { base64: kit.toBase64(toBytes(bytes)), kind: kit.mimeFor(shelfRead != null ? shelfRead : args.path) };
      }).then(done, fail);
      else if (tool === "send_file" && shelfOut != null) Promise.resolve(adapter.file(args.path)).then(function (bytes) {
        return shelf.put(shelfOut || baseName(args.path), bytes);
      }).then(function (r) {
        pushLog({ t: Date.now(), tool: "shelf ← " + baseName(args.path), ms: Math.round(performance.now() - t0) });
        reply(m.id, true, r);
      }, fail);
      else if (tool === "put_file" && shelfIn != null) shelf.get(shelfIn).then(function (bytes) {
        var name = args.name || baseName(shelfIn);
        noteImport(name);
        return adapter.importFile({ name: name, base64: window.CraftRelayFileKit.toBase64(bytes), url: null });
      }).then(function (r) {
        if (r instanceof Error) throw r;
        pushLog({ t: Date.now(), tool: "shelf → " + baseName(shelfIn), ms: Math.round(performance.now() - t0) });
        reply(m.id, true, r === undefined ? { ok: true, imported: args.name || baseName(shelfIn) } : r);
      }, fail);
      else if (tool === "send_file") adapter.sendFile(args.path, args.url, args.method || "PUT").then(function (r) {
        pushLog({ t: Date.now(), tool: "send_file:" + (args.path || ""), ms: Math.round(performance.now() - t0) });
        reply(m.id, true, r);
      }, fail);
      else if (tool === "put_file") Promise.resolve((noteImport(args.name || (args.url ? String(args.url).split(/[?#]/)[0].split("/").pop() : "")), adapter.importFile(args))).then(function (r) {
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

  /* ---------- Relay version check ----------
   * The relay sends relayVersion in its welcome (server/src/index.ts, RELAY_VERSION);
   * relays from before that send none, which counts as 1. This file is served by
   * the site, so it always knows the newest relay. Bump RELAY_LATEST with every
   * relay change; raise RELAY_REQUIRED only when an older relay would actually fail. */
  var RELAY_LATEST = 2, RELAY_REQUIRED = 1;
  var relayEl, fabEl;
  function showRelayNotice(v) {
    if (!relayEl) return;
    var level = v < RELAY_REQUIRED ? "required" : v < RELAY_LATEST ? "available" : "";
    relayEl.className = "relay " + level;
    relayEl.style.display = level ? "block" : "none";
    if (fabEl) fabEl.classList.toggle("flag", !!level);
    if (!level) return;
    relayEl.textContent = "";
    relayEl.appendChild(el("b", { text: level === "required" ? "Your relay needs an update" : "Relay update available" }));
    relayEl.appendChild(el("div", { text: level === "required"
      ? "Some features won't work until you update it."
      : "Everything still works; the update adds improvements." }));
    relayEl.appendChild(el("div", { text: "On GitHub, open your copy of the Craft Suite project → Sync fork → Update branch. Railway rebuilds your relay in a few minutes; then reconnect here." }));
    var how = el("a", { text: "How to update", href: "/guide/#claude", target: "_blank", rel: "noopener" });
    relayEl.appendChild(how);
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

  var shelfEl;
  function renderShelf() {
    if (!shelfEl) return;
    shelf.list().then(function (items) {
      var total = items.reduce(function (n, f) { return n + (f.size || 0); }, 0);
      shelfEl.firstChild.textContent = items.length
        ? "Shelf: " + items.length + " file" + (items.length === 1 ? "" : "s") + " (" + (total / 1048576).toFixed(1) + " MB) — " + items.map(function (f) { return decodeURIComponent(f.path.split("/").pop()); }).join(", ")
        : "Shelf: empty";
      shelfEl.title = "Files any Craft app tab can pick up. They stay in this browser until you clear them.";
    }, function () { shelfEl.firstChild.textContent = "Shelf: unavailable in this browser"; });
  }
  // Another tab changed the shelf: refresh now (BroadcastChannel) and whenever
  // this tab is looked at again.
  var shelfChannel = null;
  try { shelfChannel = new BroadcastChannel("craft-shelf"); shelfChannel.onmessage = function () { renderShelf(); }; } catch (e) { /* older browser */ }
  function shelfChanged() { renderShelf(); try { if (shelfChannel) shelfChannel.postMessage("changed"); } catch (e) { /* ignore */ } }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) renderShelf(); });

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
      ".relay { font-size:11.5px; line-height:1.45; border-radius:8px; padding:8px 10px; margin-bottom:8px; }",
      ".relay b { display:block; font-size:12px; margin-bottom:2px; }",
      ".relay div { margin-bottom:4px; color:#c9ccd6; }",
      ".relay a { color:#b7aefb; }",
      ".relay.available { background:rgba(224,178,94,.1); border:1px solid rgba(224,178,94,.4); color:#e0b25e; }",
      ".relay.required { background:rgba(224,122,94,.12); border:1px solid rgba(224,122,94,.5); color:#e07a5e; }",
      ".fab.flag::after { content:''; position:absolute; top:2px; right:2px; width:10px; height:10px; border-radius:50%; background:#e0b25e; border:2px solid #1d1f27; }",
      ".fab { position:relative; }",
      "input[type=text],input[type=password] { width:100%; background:#14151a; color:#e8e9ee; border:1px solid #3a3d48; border-radius:7px; padding:6px 8px; font:12px ui-monospace,monospace; margin:3px 0 8px; }",
      "label { font-size:11.5px; color:#9a9daa; display:block; }",
      ".row { display:flex; gap:8px; margin-bottom:8px; }",
      "button.act { flex:1; border:0; border-radius:8px; padding:8px 0; font-weight:600; cursor:pointer; background:#6d5df6; color:#fff; }",
      "button.act.ghost { background:#2a2d38; color:#c9ccd6; }",
      "button.act:disabled { opacity:.45; cursor:default; }",
      ".priv { font-size:11px; color:#9a9daa; background:#14151a; border-radius:8px; padding:8px; margin-bottom:8px; }",
      ".ro { display:flex; align-items:center; gap:6px; font-size:12px; margin-bottom:8px; color:#c9ccd6; }",
      ".shelf { display:flex; align-items:center; gap:8px; font-size:11.5px; color:#c9ccd6; background:#14151a; border-radius:8px; padding:6px 8px; margin-bottom:8px; }",
      ".shelf span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
      "button.mini { border:0; border-radius:6px; padding:3px 8px; font-size:11px; cursor:pointer; background:#2a2d38; color:#c9ccd6; }",
      ".log { background:#14151a; border-radius:8px; padding:8px; max-height:150px; overflow:auto; font:11px ui-monospace,monospace; color:#b9bcc7; }",
      ".log div { margin:1px 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }"
    ].join("\n") });
    root.appendChild(style);

    var fab = el("button", { class: "fab", title: "Agent bridge", text: "⦿", onclick: function () { panelOpen = !panelOpen; panel.style.display = panelOpen ? "block" : "none"; } });
    fabEl = fab;
    root.appendChild(fab);

    var saved = getSaved();
    panel = el("div", { class: "panel", style: "display:none;" });

    statusEl = el("div", { class: "status" });
    noteEl = el("div", { class: "note", style: "display:none;" });
    var setNoteOrig = setNote;
    setNote = function (t) { noteEl.textContent = t || ""; noteEl.style.display = t ? "block" : "none"; };

    urlInput = el("input", { type: "text", value: saved.url || "", placeholder: "/relay (same-origin default) or https://relay.example", spellcheck: "false" });
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
    relayEl = el("div", { class: "relay", style: "display:none;" });
    panel.appendChild(relayEl);
    panel.appendChild(el("label", { text: "Relay URL" }));
    panel.appendChild(urlInput);
    panel.appendChild(el("label", { text: "Bridge token" }));
    panel.appendChild(tokenInput);
    panel.appendChild(el("div", { class: "row" }, [connectBtn, disconnectBtn]));
    panel.appendChild(el("label", { class: "ro" }, [roInput, document.createTextNode("read-only mode (block edits)")]));
    var dlInput = el("input", { type: "checkbox", onchange: function () { setAutoDownload(dlInput.checked); } });
    try { if (localStorage.getItem(AUTO_DL_KEY) === "1") { dlInput.checked = true; setAutoDownload(true); } } catch (e) { /* ignore */ }
    panel.appendChild(el("label", { class: "ro" }, [dlInput, document.createTextNode("also download new exports to this PC")]));
    shelfEl = el("div", { class: "shelf" }, [
      el("span", { text: "Shelf: …" }),
      el("button", { class: "mini", text: "Clear", title: "Empty the shelf (files stay in each app's own file list)", onclick: function () { shelf.clear(); } })
    ]);
    panel.appendChild(shelfEl);
    renderShelf();
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
