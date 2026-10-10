/* Craft Relay adapters: one per app, classic script (no modules, COEP-safe).
 * Each adapter talks ONLY to the app's documented in-page API — never eval,
 * never arbitrary JS. Register on window.CraftRelayAdapters. */
(function () {
  "use strict";
  var adapters = {};
  window.CraftRelayAdapters = adapters;

  /* File kit: bytes -> base64, mime sniffing by extension, and the shared
   * upload path for send_file (browser -> caller-supplied URL). */
  var MIME = {
    srt: "application/x-subrip", vtt: "text/vtt", json: "application/json",
    txt: "text/plain", csv: "text/csv", png: "image/png", jpg: "image/jpeg",
    jpeg: "image/jpeg", svg: "image/svg+xml", webp: "image/webp",
    wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac",
    ogg: "audio/ogg", flac: "audio/flac", mp4: "video/mp4", webm: "video/webm",
    mov: "video/quicktime", fcproj: "application/json", ecproj: "application/json",
    pdf: "application/pdf", zip: "application/zip"
  };
  function extOf(path) { var m = /\.([a-z0-9]+)$/i.exec(String(path || "")); return m ? m[1].toLowerCase() : ""; }
  function toBase64(bytes) {
    if (!bytes) throw new Error("no bytes returned");
    if (typeof bytes === "string") bytes = new TextEncoder().encode(bytes);
    var out = "", chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(out);
  }
  function uploadBytes(getBytes, path, url, method) {
    return getBytes(path).then(function (bytes) {
      if (typeof bytes === "string") bytes = new TextEncoder().encode(bytes);
      return fetch(url, {
        method: method || "PUT",
        headers: { "Content-Type": MIME[extOf(path)] || "application/octet-stream" },
        body: bytes
      }).then(function (resp) {
        if (!resp.ok) throw new Error("upload endpoint answered HTTP " + resp.status);
        return { ok: true, status: resp.status, bytes: bytes.length };
      });
    });
  }
  window.CraftRelayFileKit = { toBase64: toBase64, mimeFor: function (p) { return MIME[extOf(p)] || "application/octet-stream"; } };
  /* Denylist — local copy of the relay's patterns: defense in depth (the
   * page's read-only mode and the relay both re-check). */
  var DENY = [
    "app.quit", "quit", "project.close", "document.close", "close.project",
    "library.delete", "delete.library", "photo.delete", "photos.delete",
    "library.wipe", "library.clear", "catalog.delete", "file.delete",
    "history.clear", "undo.all", "library.remove", "reject.delete",
    "composition.delete.all", "project.new", "project.revert"
  ];
  function denied(cmd) {
    var c = String(cmd || "").toLowerCase();
    if (/(bulk|all)\.(overwrite|replace|delete)/.test(c)) return c;
    for (var i = 0; i < DENY.length; i++) if (c.indexOf(DENY[i]) !== -1) return DENY[i];
    return null;
  }

  /* Take whatever an image call returned and normalize to {mime, base64}. */
  function normalizeImage(result) {
    if (!result) throw new Error("image call returned nothing");
    if (typeof result === "string") {
      var s = result;
      var m = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(s);
      if (m) return { mime: m[1], base64: m[2] };
      if (s.length > 1000) return { mime: "image/png", base64: s };
      throw new Error("image call returned unexpected text: " + s.slice(0, 120));
    }
    var b = result.base64 || result.pngBase64 || result.png || result.data || (result.image && result.image.base64);
    if (!b) throw new Error("image call returned no image field: " + JSON.stringify(result).slice(0, 200));
    return { mime: result.mime || result.mimeType || result.contentType || "image/png", base64: b };
  }

  /* ---------------- LightCraft ----------------
   * In-page API (v0.4, verified): window.lightcraft.command(name, jsonString)
   * -> JSON text. No live command list, so the adapter ships a static catalog
   * of the confirmed commands. */
  adapters.lightcraft = {
    app: "lightcraft",
    versions: ["0.4"],
    detect: function () { return typeof window.lightcraft === "object" && typeof window.lightcraft.command === "function"; },
    readOnlyCommands: ["library.info", "develop.controls", "develop.get"],
    catalog: [
      { command: "library.info", params: {}, doc: "Library state: photo count, albums, cache and load stats" },
      { command: "develop.controls", params: {}, doc: "List develop controls with namespaced ids, ranges and defaults (verified: light.exposure -5..5, light.contrast -100..100, wb.temp, wb.tint, profile.amount)" },
      { command: "develop.get", params: { control: "light.exposure" }, doc: "Read develop controls (omit control for the full state dump)" },
      { command: "develop.set", params: { control: "light.exposure", value: 0.42 }, doc: "Set one control; use namespaced ids from develop.controls (light.*, color.*, wb.*, detail.*, effects.*, profile.*)" },
      { command: "library.select", params: { photo: 0 }, doc: "Select a photo by index" }
    ],
    runCommand: function (command, params) {
      return window.lightcraft.command(command, JSON.stringify(params || {})).then(function (text) {
        try { return JSON.parse(text); } catch (e) { return text; }
      });
    },
    listCommands: function (filter) {
      var f = (filter || "").toLowerCase();
      return this.catalog.filter(function (c) { return !f || c.command.indexOf(f) !== -1 || (c.doc || "").toLowerCase().indexOf(f) !== -1; });
    },
    inspect: function () { return this.runCommand("library.info", {}); },
    image: function () {
      var self = this;
      // LightCraft v0.4's web build has no screenshot command (verified live:
      // `unknown command ui.screenshot`). Return a clear error; EffectCraft is
      // the preview-capable app for now.
      return Promise.reject(new Error("LightCraft's web build has no image command yet; use get_image on an EffectCraft tab"));
    }
  };

  /* ---------------- EffectCraft ----------------
   * In-page API (v0.6, verified): window.effectcraft mirrors the desktop
   * control channel: execute, commands, inspect, screenshot, renderFrame.
   * window.effectcraft exists BEFORE the engine finishes booting, so guard
   * every call and fail fast with a retry hint instead of hanging. */
  adapters.effectcraft = {
    app: "effectcraft",
    versions: ["0.6"],
    detect: function () { return typeof window.effectcraft === "object" && typeof window.effectcraft.execute === "function"; },
    readOnlyCommands: [],
    notReady: function () {
      var load = window.effectcraftLoad || {};
      if (load.error) return "EffectCraft failed to start: " + load.error;
      if (!load.readyMs) return "EffectCraft is still loading (large WASM; usually ready within ~15 s of page load) — retry in a few seconds";
      return null;
    },
    listCommands: function (filter) {
      var nr = this.notReady(); if (nr) return Promise.reject(new Error(nr));
      return window.effectcraft.commands().then(function (cmds) {
        var f = (filter || "").toLowerCase();
        if (!f) return cmds;
        return cmds instanceof Array
          ? cmds.filter(function (c) { return JSON.stringify(c).toLowerCase().indexOf(f) !== -1; })
          : { note: "unfiltered catalog not an array; raw follows", raw: cmds, filter: filter };
      });
    },
    runCommand: function (command, params) {
      var nr = this.notReady(); if (nr) return Promise.reject(new Error(nr));
      return window.effectcraft.execute(command, params || {});
    },
    inspect: function () {
      var nr = this.notReady(); if (nr) return Promise.reject(new Error(nr));
      return window.effectcraft.inspect();
    },
    image: function (mode) {
      var nr = this.notReady(); if (nr) return Promise.reject(new Error(nr));
      var call = mode === "screenshot"
        ? window.effectcraft.screenshot({})
        : window.effectcraft.renderFrame({});
      return call.then(normalizeImage, function (e) {
        throw new Error("image call failed: " + (e && (e.message || e)));
      });
    },
    listFiles: function () {
      var nr = this.notReady(); if (nr) return Promise.reject(new Error(nr));
      return window.effectcraft.files();
    },
    file: function (path) {
      var nr = this.notReady(); if (nr) return Promise.reject(new Error(nr));
      return window.effectcraft.readFile(path);
    },
    sendFile: function (path, url, method) {
      var nr = this.notReady(); if (nr) return Promise.reject(new Error(nr));
      return uploadBytes(function (p) { return window.effectcraft.readFile(p); }, path, url, method);
    }
  };

  /* ---------------- FilmCraft ----------------
   * In-page API (main @ 7b6c134, post-v0.4.0; see docs/web.md): the desktop
   * control channel as promises. The stock v0.4.0 release has no in-page API
   * (detect() simply never fires there). Replies are polled on the UI frame
   * loop, so a stalled/hidden tab means calls hang until the relay timeout. */
  adapters.filmcraft = {
    app: "filmcraft",
    versions: ["0.4"],
    detect: function () { return typeof window.filmcraft === "object" && typeof window.filmcraft.execute === "function"; },
    readOnlyCommands: [],
    notReady: function () {
      var load = window.filmcraftLoad || {};
      if (load.fatal) return "FilmCraft crashed after startup: " + String(load.fatal).slice(0, 160);
      if (load.error) return "FilmCraft failed to start: " + String(load.error).slice(0, 160);
      if (!load.readyMs) return "FilmCraft is still loading — retry in a few seconds";
      return null;
    },
    listCommands: function (filter) {
      var nr = this.notReady(); if (nr) return Promise.reject(new Error(nr));
      return window.filmcraft.commands().then(function (cmds) {
        var f = (filter || "").toLowerCase();
        if (!f) return cmds;
        return cmds instanceof Array
          ? cmds.filter(function (c) { return JSON.stringify(c).toLowerCase().indexOf(f) !== -1; })
          : { note: "catalog not an array; raw follows", raw: cmds, filter: filter };
      });
    },
    runCommand: function (command, params) {
      var nr = this.notReady(); if (nr) return Promise.reject(new Error(nr));
      return window.filmcraft.execute(command, params || {});
    },
    inspect: function () {
      var nr = this.notReady(); if (nr) return Promise.reject(new Error(nr));
      return window.filmcraft.inspect();
    },
    image: function () {
      // canvas screenshot ({pngBase64,width,height}); "frame" and "screenshot"
      // are the same thing here — no separate renderFrame in the web API.
      var nr = this.notReady(); if (nr) return Promise.reject(new Error(nr));
      return window.filmcraft.screenshot({}).then(normalizeImage, function (e) {
        throw new Error("screenshot failed: " + (e && (e.message || e)));
      });
    },
    listFiles: function () {
      var nr = this.notReady(); if (nr) return Promise.reject(new Error(nr));
      return window.filmcraft.files();
    },
    file: function (path) {
      var nr = this.notReady(); if (nr) return Promise.reject(new Error(nr));
      return window.filmcraft.readFile(path);
    },
    sendFile: function (path, url, method) {
      var nr = this.notReady(); if (nr) return Promise.reject(new Error(nr));
      return uploadBytes(function (p) { return window.filmcraft.readFile(p); }, path, url, method);
    }
  };

  /* ---------------- PhotoCraft ----------------
   * In-page API (our fork of main, via PHOTOCRAFT_URL; stock v0.5.0 has no
   * in-page API — detect() simply never fires there): window.photocraft with
   * the desktop control methods as promises. Requests drain on the UI frame
   * loop like FilmCraft's. */
  adapters.photocraft = {
    app: "photocraft",
    versions: ["0.5"],
    detect: function () { return typeof window.photocraft === "object" && typeof window.photocraft.execute === "function"; },
    readOnlyCommands: [],
    listCommands: function (filter) {
      return window.photocraft.commands().then(function (cmds) {
        var f = (filter || "").toLowerCase();
        if (!f) return cmds;
        return cmds instanceof Array
          ? cmds.filter(function (c) { return JSON.stringify(c).toLowerCase().indexOf(f) !== -1; })
          : { note: "catalog not an array; raw follows", raw: cmds, filter: filter };
      });
    },
    runCommand: function (command, params) { return window.photocraft.execute(command, params || {}); },
    inspect: function () { return window.photocraft.inspect(); },
    image: function () {
      // {focus:false}: no window to raise in a browser tab.
      return window.photocraft.screenshot({ focus: false }).then(normalizeImage, function (e) {
        throw new Error("screenshot failed: " + (e && (e.message || e)));
      });
    }
  };

  window.CraftRelayDenied = denied;
})();
