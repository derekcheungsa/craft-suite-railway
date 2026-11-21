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
    pdf: "application/pdf", zip: "application/zip",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12", ods: "application/vnd.oasis.opendocument.spreadsheet",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    odt: "application/vnd.oasis.opendocument.text", rtf: "application/rtf", tsv: "text/tab-separated-values"
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
      if (bytes instanceof Error) throw bytes;
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
  function fromBase64(b64) {
    var bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  function toFile(name, b64) {
    return new File([fromBase64(b64)], name);
  }
  window.CraftRelayFileKit = { toBase64: toBase64, fromBase64: fromBase64, mimeFor: function (p) { return MIME[extOf(p)] || "application/octet-stream"; }, toFile: toFile };
  /* Denylist — local copy of the relay's patterns: defense in depth (the
   * page's read-only mode and the relay both re-check). */
  var DENY = [
    "app.quit", "quit", "project.close", "document.close", "close.project", "file.close",
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
    var b = result.base64 || result.pngBase64 || result.png_base64 || result.png || result.data || (result.image && result.image.base64);
    if (!b) throw new Error("image call returned no image field: " + JSON.stringify(result).slice(0, 200));
    return { mime: result.mime || result.mimeType || result.contentType || "image/png", base64: b };
  }

  /* ---------------- LightCraft ----------------
   * In-page API (v0.4, verified): window.lightcraft.command(name, jsonString)
   * -> JSON text. No live command list, so the adapter ships a static catalog
   * of the confirmed commands. */
  adapters.lightcraft = {
    app: "lightcraft",
    versions: ["0.4", "0.18", "0.21"],
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
   * In-page API (v0.6; v0.22 keeps the same functions): window.effectcraft mirrors the desktop
   * control channel: execute, commands, inspect, screenshot, renderFrame.
   * window.effectcraft exists BEFORE the engine finishes booting, so guard
   * every call and fail fast with a retry hint instead of hanging. */
  adapters.effectcraft = {
    app: "effectcraft",
    // 0.22 fixes the Chrome-on-Windows load hang in 0.6 (storytold/effectcraft#1590).
    versions: ["0.6", "0.22"],
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
    },
    importFile: function (args) {
      // window.effectcraft.addFile accepts a URL string or a File (verified).
      var nr = this.notReady(); if (nr) return Promise.reject(new Error(nr));
      if (args.url) return window.effectcraft.addFile(args.url, args.name || undefined);
      return window.effectcraft.addFile(window.CraftRelayFileKit.toFile(args.name, args.base64));
    }
  };

  /* ---------------- FilmCraft ----------------
   * In-page API (window.filmcraft; first on main after v0.4.0, included in the
   * official releases since, e.g. v0.17.0): the desktop control channel as
   * promises. Builds without it simply never match detect(). Replies are polled
   * on the UI frame loop, so a stalled/hidden tab means calls hang until the
   * relay timeout. */
  adapters.filmcraft = {
    app: "filmcraft",
    versions: ["0.4", "0.17", "0.20"],
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
    },
    importFile: function (args) {
      // args: {name, base64, url}
      var nr = this.notReady(); if (nr) return Promise.reject(new Error(nr));
      var kit = window.CraftRelayFileKit;
      if (args.url) {
        return window.filmcraft.importUrl(args.url, args.name || undefined);
      }
      var file = kit.toFile(args.name, args.base64);
      if (/\.fcproj$/i.test(args.name)) return window.filmcraft.openProject(file);
      return window.filmcraft.importFiles([file]);
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
      // The engine renders the composite itself (document.render): full
      // flatten via the export pipeline, no screen/GPU capture, works in
      // background tabs. Auto-shrinks under 1MB engine-side; the bridge
      // downscaler is a second guard.
      return window.photocraft.execute("document.render", { format: "jpg", maxSize: 1280 }).then(function (r) {
        if (!r || !r.data) throw new Error("document.render returned no data");
        return { mime: r.format === "png" ? "image/png" : "image/jpeg", base64: r.data };
      }).then(normalizeImage, function (e) {
        throw new Error((e && e.message) ? e.message : "document.render failed");
      });
    },
    listFiles: function () {
      return window.photocraft.files();
    },
    file: function (path) {
      return window.photocraft.readFile(path).then(function (bytes) {
        if (bytes && bytes instanceof Error) throw bytes;
        if (!bytes) throw new Error(path + ": not found");
        return bytes;
      });
    },
    sendFile: function (path, url, method) {
      return uploadBytes(function (p) { return window.photocraft.readFile(p); }, path, url, method);
    },
    importFile: function (args) {
      // fork v2+: window.photocraft.importBytes(name, Uint8Array) delivers the
      // file through the same inbox as a drag-and-drop (opens as a document).
      if (typeof window.photocraft.importBytes !== "function") {
        return Promise.reject(new Error("this PhotoCraft build predates importBytes — redeploy the suite (PHOTOCRAFT_URL must point at the main2+ build)"));
      }
      var deliver = function (name, bytes) {
        var r = window.photocraft.importBytes(name, bytes);
        if (r instanceof Error) throw r;
        return r;
      };
      if (args.url) {
        // Fetch in the page so big files never enter the conversation. The
        // page is cross-origin isolated (COEP), so the URL must send CORS
        // headers (most image hosts and raw.githubusercontent do).
        var name = args.name || args.url.split(/[?#]/)[0].split("/").pop() || "download";
        return fetch(args.url, { mode: "cors" }).then(function (resp) {
          if (!resp.ok) throw new Error(args.url + ": HTTP " + resp.status);
          return resp.arrayBuffer();
        }).then(function (buf) {
          return deliver(name, new Uint8Array(buf));
        }, function (e) {
          throw new Error("fetch failed (does the URL send Access-Control-Allow-Origin? " + (e && e.message ? e.message : e) + ")");
        });
      }
      return deliver(args.name, window.CraftRelayFileKit.fromBase64(args.base64));
    }
  };

  /* ---------------- VectorCraft ----------------
   * In-page API (upstream v0.21+, installed from the wasm as window.vectorcraft):
   * execute(command, params) / commands() / inspect() / screenshot() mirror
   * the desktop control channel (engine.execute, engine.commands, ui.inspect,
   * ui.screenshot); files()/readFile(path) expose saves and exports;
   * openFile(...) imports. Calls reject with "VectorCraft is not running yet"
   * until the engine has booted. Older builds have no API (detect() never
   * fires). Command reference: docs/mcp.md in storytold/vectorcraft. */
  adapters.vectorcraft = {
    app: "vectorcraft",
    versions: ["0.21", "0.24"],
    detect: function () { return typeof window.vectorcraft === "object" && typeof window.vectorcraft.execute === "function"; },
    readOnlyCommands: ["document.formats", "document.info"],
    listCommands: function (filter) {
      return Promise.resolve(window.vectorcraft.commands()).then(function (cmds) {
        var list = cmds instanceof Array ? cmds : (cmds && cmds.commands instanceof Array ? cmds.commands : null);
        if (!list) return { note: "catalog not an array; raw follows", raw: cmds, filter: filter };
        var f = (filter || "").toLowerCase();
        return f ? list.filter(function (c) { return JSON.stringify(c).toLowerCase().indexOf(f) !== -1; }) : list;
      });
    },
    runCommand: function (command, params) { return window.vectorcraft.execute(command, params || {}); },
    inspect: function () { return window.vectorcraft.inspect(); },
    image: function () {
      // Prefer an engine-side render (document.export without a path returns
      // dataBase64): no GPU capture, so it works even when the canvas isn't
      // drawing. Fall back to a window screenshot.
      return window.vectorcraft.execute("document.export", { format: "png", scale: 1 }).then(function (r) {
        var b = r && (r.dataBase64 || r.data_base64 || r.data);
        if (!b) throw new Error("document.export returned no data");
        return { mime: "image/png", base64: b };
      }).catch(function () {
        return Promise.resolve(window.vectorcraft.screenshot({})).then(normalizeImage, function (e) {
          throw new Error("screenshot failed: " + (e && (e.message || e)));
        });
      });
    },
    listFiles: function () { return window.vectorcraft.files(); },
    file: function (path) {
      return Promise.resolve(window.vectorcraft.readFile(path)).then(function (bytes) {
        if (bytes && bytes instanceof Error) throw bytes;
        if (!bytes) throw new Error(path + ": not found");
        return bytes;
      });
    },
    sendFile: function (path, url, method) {
      return uploadBytes(function (p) { return Promise.resolve(window.vectorcraft.readFile(p)); }, path, url, method);
    },
    importFile: function (args) {
      if (typeof window.vectorcraft.openFile !== "function") {
        return Promise.reject(new Error("this VectorCraft build has no openFile"));
      }
      // openFile's exact signature isn't documented for the web build: try a
      // File (drop-style), then (name, bytes).
      var open = function (name, bytes) {
        return Promise.resolve().then(function () {
          return window.vectorcraft.openFile(new File([bytes], name));
        }).catch(function (first) {
          return Promise.resolve(window.vectorcraft.openFile(name, bytes)).catch(function () { throw first; });
        });
      };
      if (args.url) {
        var name = args.name || args.url.split(/[?#]/)[0].split("/").pop() || "download";
        return fetch(args.url, { mode: "cors" }).then(function (resp) {
          if (!resp.ok) throw new Error(args.url + ": HTTP " + resp.status);
          return resp.arrayBuffer();
        }).then(function (buf) {
          return open(name, new Uint8Array(buf));
        }, function (e) {
          throw new Error("fetch failed (does the URL send Access-Control-Allow-Origin? " + (e && e.message ? e.message : e) + ")");
        });
      }
      return open(args.name, window.CraftRelayFileKit.fromBase64(args.base64));
    }
  };

  /* ---------------- craft-web-api apps ----------------
   * GridCraft, WordCraft, FigCraft, DeckCraft, CADCraft, PdfCraft (official releases) and
   * DesignCraft, SoundCraft, MaterialCraft, TextureCraft (upstream main plus
   * .github/craft-web-patches): craft-web-api installs
   * window.<app> = { request, execute, commands, docInspect, uiInspect,
   * screenshot } over the app's control channel — the same one the desktop
   * control server drives. Builds: .github/workflows/build-craft-web.yml.
   * Reference: docs/control-protocol.md in each storytold/<app> repo.
   *
   * run_command: an engine command id goes through execute() (or, for apps
   * whose engine runs commands as command.run {id, params}, through that); a
   * control-protocol method (sheet.read, ui.render, session.inspect, …) goes
   * through request(). If one route answers "unknown", the other is tried.
   * Prefix a command with "control:" to force request().
   *
   * Files (apps with openExt): open and save are craft-web-host messages, not
   * control methods. On those app pages we run as the page host
   * (data-host="page" on the canvas, set here before the wasm starts): saves
   * and exports arrive as <app>:save events and go into a file table (and
   * still download, as they would without us), and put_file sends an
   * <app>:open event. */
  var UI_COMMON = ["ui.inspect", "ui.click", "ui.drag", "ui.move", "ui.key", "ui.text", "ui.screenshot", "ui.set", "ui.resize", "ui.focus"];
  var CRAFT_HOSTED = {
    gridcraft: {
      versions: ["0.16.0-main", "0.19"],
      control: ["window.list", "engine.journal", "document.inspect", "sheet.read", "cell.get",
        "ui.inspect", "ui.object.select", "ui.click", "ui.drag", "ui.move", "ui.cell.click",
        "ui.cell.drag", "ui.key", "ui.text", "ui.edit.begin", "ui.edit.text", "ui.edit.commit",
        "ui.edit.cancel", "ui.ribbon", "ui.dialog", "ui.dialog.set", "ui.dialog.confirm",
        "ui.dialog.cancel", "ui.screenshot", "ui.set", "ui.resize", "ui.focus"],
      readOnly: ["window.list", "engine.journal", "document.inspect", "sheet.read", "cell.get", "ui.inspect", "ui.screenshot"],
      openExt: /\.(xlsx|xlsm|xlsb|ods|csv|tsv)$/i
    },
    wordcraft: {
      versions: ["0.15.1-main", "0.18"],
      control: ["document.inspect", "ui.inspect", "ui.click", "ui.clickText", "ui.move", "ui.drag",
        "ui.press", "ui.release", "ui.wheel", "ui.key", "ui.text", "ui.screenshot", "ui.render",
        "ui.parity", "ui.resize", "ui.focus"],
      readOnly: ["document.inspect", "ui.inspect", "ui.screenshot", "ui.render", "ui.parity"],
      openExt: /\.(docx|dotx|doc|odt|rtf|txt|md|html?)$/i,
      renderPage: true,
      // WordCraft opens on File › Home; a document the agent creates or opens is left behind
      // that screen. Close it so the window shows the document, as a click would.
      afterOpen: function (api) { return api.execute("ui.backstage", { open: false }); },
      openCommands: /^file\.(new|open|newFromTemplate)$/
    },
    pdfcraft: {
      versions: ["0.21"],
      // PdfCraft installs window.pdfcraft only with ?control in the page URL (opt-in).
      // Its control channel is the desktop app's UI channel (ui.*); registry commands
      // (file.save, form.import_data, page.rotate_cw, ...) go through execute() = ui.command.
      // There are no field-level form commands: fill a form by clicking a field and typing.
      urlFlag: "control",
      canvasId: "pdfcraft",
      control: ["ui.state", "ui.inspect", "ui.click", "ui.drag", "ui.move", "ui.key", "ui.type", "ui.screenshot",
        "ui.set", "ui.resize", "ui.focus", "ui.panel", "ui.command", "ui.commands"],
      readOnly: ["ui.state", "ui.inspect", "ui.commands", "ui.screenshot"],
      openExt: /\.pdf$/i
    },
    figcraft: {
      versions: ["0.15.0-main", "0.18"],
      // FigCraft installs window.figcraft only with ?control in the page URL (opt-in).
      urlFlag: "control",
      control: UI_COMMON.concat(["document.inspect", "doc.list", "ui.input", "ui.pointer", "ui.menu.invoke", "ui.render", "command.batch"]),
      readOnly: ["document.inspect", "doc.list", "ui.inspect", "ui.screenshot", "ui.render"],
      openExt: /\.(fig|figcraft|svg|png|jpe?g)$/i
    },
    deckcraft: {
      versions: ["0.15.0-main", "0.18"],
      control: UI_COMMON.concat(["document.inspect", "app.open", "app.save", "app.export", "show.start", "show.end",
        "slide.actions", "ui.dialog.open", "ui.dialog.close", "ui.ime", "ui.menu.invoke", "ui.pointer", "ui.render", "ui.tool.select"]),
      readOnly: ["document.inspect", "ui.inspect", "ui.screenshot", "ui.render"],
      openExt: /\.(pptx|potx|odp)$/i
    },
    cadcraft: {
      versions: ["0.17.0-main", "0.20"],
      inspectMethod: "drawing.inspect",
      control: UI_COMMON.concat(["drawing.inspect", "app.open", "app.save", "cmdline.input", "cmdline.key", "cmdline.script",
        "cmdline.state", "control.methods", "ui.elements", "ui.menu.invoke", "ui.menu.list", "ui.pointer", "ui.render"]),
      readOnly: ["drawing.inspect", "cmdline.state", "control.methods", "ui.inspect", "ui.elements", "ui.menu.list", "ui.screenshot", "ui.render"],
      openExt: /\.(dwg|dxf)$/i
    },
    designcraft: {
      versions: ["0.17.0-main"],
      // DesignCraft's ui.screenshot returns pixels only when it can write a file (no inline
      // PNG on the web), so images come from ui.render, the current page rendered in the engine.
      renderAlways: true,
      control: UI_COMMON.concat(["document.inspect", "app.open", "app.save", "app.export", "ui.dialog.open", "ui.dialog.set",
        "ui.dialog.confirm", "ui.dialog.cancel", "ui.docking", "ui.ime", "ui.menu.invoke", "ui.menu.list", "ui.paste",
        "ui.pointer", "ui.render", "ui.tool.list", "ui.tool.select"]),
      readOnly: ["document.inspect", "ui.inspect", "ui.menu.list", "ui.tool.list", "ui.screenshot", "ui.render"]
    },
    soundcraft: {
      versions: ["0.17.0-main"],
      inspectMethod: "session.inspect",
      control: UI_COMMON.concat(["session.inspect", "document.inspect", "engine.parity", "ui.menu.invoke", "ui.menu.list", "ui.scroll", "ui.zoom"]),
      readOnly: ["session.inspect", "document.inspect", "engine.parity", "ui.inspect", "ui.menu.list", "ui.screenshot"]
    },
    materialcraft: {
      versions: ["0.1.3-main"],
      inspectMethod: "session.inspect",
      runVia: "command.run", listVia: "command.list",
      control: ["ping", "session.inspect", "ui.inspect", "ui.menu.list", "ui.screenshot", "library.list",
        "file.new", "file.open", "file.save", "file.exportMaterial", "file.sendToTextureCraft",
        "package.activate", "package.close", "package.closeAll",
        "graph.connect", "graph.disconnect", "graph.createFromSelection", "graph.exposed.add", "graph.exposed.set",
        "graph.input.bind", "graph.input.unbind", "graph.instance.add", "graph.node.add", "graph.node.base",
        "graph.node.edit", "graph.node.function", "graph.node.info", "graph.node.param", "graph.pattern.set",
        "graph.preset.save", "graph.wire.delete", "graph.wire.insertDot", "graph.wire.swap"],
      readOnly: ["ping", "session.inspect", "ui.inspect", "ui.menu.list", "ui.screenshot", "library.list", "graph.node.info"]
    },
    texturecraft: {
      versions: ["0.3.1-main"],
      inspectMethod: "session.inspect",
      runVia: "command.run", listVia: "command.list",
      control: ["ping", "session.inspect", "ui.inspect", "ui.menu.invoke", "ui.menu.list", "ui.resize", "ui.set", "ui.screenshot",
        "viewport.screenshot", "command.batch", "bake", "bake.mesh.add", "render", "resource.import",
        "material.load", "material.save", "material.link.cook", "material.link.preset", "material.link.saveSource",
        "material.link.set", "mesh.import", "mesh.reimport", "mesh.export", "project.open", "project.save", "textures.export"],
      readOnly: ["ping", "session.inspect", "ui.inspect", "ui.menu.list", "ui.screenshot", "viewport.screenshot"]
    }
  };

  /* The page-host shim: only on an app page whose spec has openExt, and only once. */
  var PAGE_APP = location.pathname.split("/").filter(Boolean)[0] || "";
  var hostState = { files: [], dirty: false, lastError: null, ready: false };
  function hostCanvas(app) {
    var spec = CRAFT_HOSTED[app];
    return document.getElementById(spec && spec.canvasId || app.replace(/-/g, "_") + "_canvas");
  }
  function startPageHost(app) {
    var canvas = hostCanvas(app);
    if (!canvas || canvas.getAttribute("data-host")) return;
    canvas.setAttribute("data-host", "page");
    function on(kind, fn) { canvas.addEventListener(app + ":" + kind, function (ev) { try { fn(ev.detail || {}); } catch (e) { dbgHost(e); } }); }
    on("ready", function () { hostState.ready = true; });
    on("save", function (d) {
      var raw = d.bytes, bytes = ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw || 0);
      var name = String(d.name || "document");
      hostState.files = hostState.files.filter(function (f) { return f.path !== name; });
      hostState.files.unshift({ path: name, size: bytes ? bytes.length : 0, kind: d.saveAs ? "save-as" : "save", savedAt: new Date().toISOString(), bytes: bytes });
      hostState.files = hostState.files.slice(0, 20);
      // Still hand the file to the user, as the app does when it isn't hosted.
      try {
        var a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([bytes], { type: MIME[extOf(name)] || "application/octet-stream" }));
        a.download = name.split("/").pop();
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
      } catch (e) { dbgHost(e); }
      if (d.id) canvas.dispatchEvent(new CustomEvent(app + ":saved", { detail: { id: d.id } }));
    });
    on("dirty", function (d) { hostState.dirty = !!d.dirty; });
    on("failed", function (d) { hostState.lastError = String(d.error || "failed"); });
    on("handoff", function (d) {
      hostState.lastError = (d.name || "a file") + " belongs to another app; it was downloaded instead";
    });
    // The hosted app leaves "unsaved changes?" to the host.
    window.addEventListener("beforeunload", function (ev) { if (hostState.dirty) { ev.preventDefault(); ev.returnValue = ""; } });
  }
  function dbgHost(e) { try { console.log("[craft-relay] host:", e); } catch (x) { /* ignore */ } }
  // An app that installs window.<app> only behind a URL flag gets it here, before its
  // wasm (a module script, which runs after this one) reads the address.
  if (CRAFT_HOSTED[PAGE_APP] && CRAFT_HOSTED[PAGE_APP].urlFlag) {
    var flag = CRAFT_HOSTED[PAGE_APP].urlFlag;
    var params = new URLSearchParams(location.search);
    if (!params.has(flag)) {
      params.append(flag, "");
      try { history.replaceState(history.state, "", location.pathname + "?" + params.toString().replace(new RegExp("(^|&)" + flag + "=($|&)"), "$1" + flag + "$2") + location.hash); } catch (e) { dbgHost(e); }
    }
  }
  if (CRAFT_HOSTED[PAGE_APP] && CRAFT_HOSTED[PAGE_APP].openExt) {
    // This script runs at the end of <body>, so the canvas is already there and the
    // app's wasm (a module script) hasn't started: set data-host now, not at
    // DOMContentLoaded, which would race the app's own startup.
    if (hostCanvas(PAGE_APP)) startPageHost(PAGE_APP);
    else document.addEventListener("DOMContentLoaded", function () { startPageHost(PAGE_APP); });
  }

  var UNKNOWN = /unknown|not found|no such|unsupported|not a (command|method)|no handler|unrecognized/i;
  function hostedAdapter(app) {
    var spec = CRAFT_HOSTED[app];
    function api() { return window[app]; }
    function viaControl(command, params) { return Promise.resolve(api().request(command, params)); }
    function viaEngine(command, params) {
      if (spec.runVia === "command.run") return viaControl("command.run", { id: command, params: params });
      return Promise.resolve(api().execute(command, params));
    }
    function call(command, params) {
      params = params || {};
      if (/^control:/.test(command)) return viaControl(command.slice(8), params);
      var isControl = spec.control.indexOf(command) !== -1;
      var first = isControl ? viaControl : viaEngine, second = isControl ? viaEngine : viaControl;
      // request() and execute() resolve with the reply's result and reject with its error.
      return first(command, params).catch(function (e) {
        if (!UNKNOWN.test(String(e && e.message || e))) throw e;
        return second(command, params).catch(function () { throw e; });
      }).then(function (r) {
        if (spec.afterOpen && spec.openCommands && spec.openCommands.test(command)) {
          return Promise.resolve(spec.afterOpen(api())).then(function () { return r; }, function () { return r; });
        }
        return r;
      });
    }
    var soft = function (p) { return Promise.resolve(p).catch(function (e) { return { error: String(e && e.message || e) }; }); };
    return {
      app: app,
      versions: spec.versions,
      detect: function () { return PAGE_APP === app && typeof api() === "object" && typeof api().request === "function"; },
      readOnlyCommands: spec.readOnly,
      listCommands: function (filter) {
        var listing = spec.listVia ? viaControl(spec.listVia, filter ? { filter: filter } : {}) : Promise.resolve(api().commands());
        return listing.then(function (cmds) {
          var list = Array.isArray(cmds) ? cmds : (cmds && Array.isArray(cmds.commands) ? cmds.commands : []);
          var f = (filter || "").toLowerCase();
          var match = function (c) { return !f || JSON.stringify(c).toLowerCase().indexOf(f) !== -1; };
          return {
            commands: list.filter(match),
            controlMethods: spec.control.filter(function (m) { return !f || m.indexOf(f) !== -1; }),
            note: "commands run through " + (spec.runVia || "engine.execute") + "; controlMethods are control-protocol methods, also accepted by run_command"
          };
        });
      },
      runCommand: call,
      inspect: function () {
        // A method that isn't available yet (WordCraft with no document open) is reported
        // beside the rest instead of failing the whole inspect.
        var doc = spec.inspectMethod ? viaControl(spec.inspectMethod, {}) : api().docInspect({});
        return Promise.all([soft(doc), soft(api().uiInspect({}))]).then(function (r) {
          var ui = r[1] || {};
          var out = {
            document: r[0],
            ui: { dialog: ui.dialog, tab: ui.tab || ui.ribbonTab, backstage: ui.backstage, windows: ui.windows || ui.documents, activeWindow: ui.activeWindow || ui.document }
          };
          if (spec.openExt) out.host = { hosted: !!hostCanvas(app) && hostCanvas(app).getAttribute("data-host") === "page", ready: hostState.ready, dirty: hostState.dirty, lastError: hostState.lastError, files: hostState.files.length };
          return out;
        });
      },
      image: function (mode) {
        var shot = function () {
          return Promise.resolve(api().screenshot({})).then(normalizeImage, function (e) {
            throw new Error("screenshot failed (is the tab visible?): " + (e && (e.message || e)));
          });
        };
        // mode "screenshot" (or "window"): what the window shows. Otherwise an app with an
        // engine page render (WordCraft) renders the page, which works even when the tab
        // isn't drawing.
        if (spec.renderAlways) {
          return call("ui.render", typeof mode === "number" ? { page: mode, scale: 1 } : { scale: 1 }).then(normalizeImage, function (e) {
            throw new Error("page render failed (is a document open?): " + (e && (e.message || e)));
          });
        }
        if (spec.renderPage && mode !== "screenshot" && mode !== "window") {
          return call("ui.render", { page: typeof mode === "number" ? mode : 1, scale: 1 }).then(normalizeImage).catch(shot);
        }
        return shot();
      },
      listFiles: spec.openExt ? function () {
        return hostState.files.map(function (f) { return { path: f.path, size: f.size, kind: f.kind, savedAt: f.savedAt }; });
      } : undefined,
      file: function (path) {
        for (var i = 0; i < hostState.files.length; i++) if (hostState.files[i].path === path) return hostState.files[i].bytes;
        throw new Error(path + ": not in the file table (save or export it in the app first; list_files shows what's there)");
      },
      sendFile: function (path, url, method) {
        var self = this;
        return uploadBytes(function (p) { return Promise.resolve().then(function () { return self.file(p); }); }, path, url, method);
      },
      importFile: spec.openExt ? function (args) {
        var canvas = hostCanvas(app);
        if (!canvas || canvas.getAttribute("data-host") !== "page") return Promise.reject(new Error("the page host isn't active on this tab; reload the page"));
        var open = function (name, bytes) {
          if (!spec.openExt.test(name)) throw new Error(name + ": not a file type " + app + " opens");
          canvas.dispatchEvent(new CustomEvent(app + ":open", { detail: { name: name, bytes: bytes } }));
          if (spec.afterOpen) setTimeout(function () { try { spec.afterOpen(api()); } catch (e) { /* ignore */ } }, 1500);
          return { ok: true, opened: name, bytes: bytes.length, note: "sent to the app; inspect shows the result once it loads" };
        };
        if (args.url) {
          var name = args.name || args.url.split(/[?#]/)[0].split("/").pop() || "download";
          return fetch(args.url, { mode: "cors" }).then(function (resp) {
            if (!resp.ok) throw new Error(args.url + ": HTTP " + resp.status);
            return resp.arrayBuffer();
          }).then(function (buf) { return open(name, new Uint8Array(buf)); }, function (e) {
            throw new Error("fetch failed (does the URL send Access-Control-Allow-Origin? " + (e && e.message ? e.message : e) + ")");
          });
        }
        return Promise.resolve().then(function () { return open(args.name, fromBase64(args.base64)); });
      } : undefined
    };
  }
  for (var hostedName in CRAFT_HOSTED) adapters[hostedName] = hostedAdapter(hostedName);

  window.CraftRelayDenied = denied;
})();
