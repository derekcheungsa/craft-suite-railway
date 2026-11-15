// Craft Suite on Cloudflare: a Worker serving the site from an R2 bucket.
//
// Since Nov 15, 2026 every file under 25 MiB is also deployed as a static asset
// (cloudflare/split_assets.py, headers in its _headers file). Cloudflare serves
// those without running this Worker, so they are free and don't count toward
// the free plan's 100,000 requests a day. This Worker now runs only for the big
// .wasm files, /relay/, /healthz and paths that match no asset.
//
// Why not Cloudflare Pages: Pages caps each file at 25 MiB, and ten of the apps'
// .wasm files are bigger (up to ~85 MB). R2 has no such cap and its downloads
// are free. This Worker does what nginx/templates/default.conf.template does on
// Railway: MIME types, the cross-origin isolation headers the apps need
// (COOP/COEP/CORP), caching, precompressed .gz copies, directory index pages,
// and the same-origin /relay/ proxy for the Craft Relay.
//
// The bucket holds the site as built by .github/workflows/cloudflare.yml:
// every file under its own path, plus "<path>.gz" for .wasm/.js/.html/.css/
// .json/.svg/.txt files (the Worker sends those with Content-Encoding: gzip).

const TYPES = {
  wasm: "application/wasm",
  js: "text/javascript",
  mjs: "text/javascript",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css",
  svg: "image/svg+xml",
  webmanifest: "application/manifest+json",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};
const GZ = new Set(["wasm", "js", "mjs", "html", "htm", "css", "json", "svg", "txt", "webmanifest"]);
// Apps whose files are not content-hashed: always revalidate (as nginx does).
const UNHASHED = /^(lightcraft|effectcraft|filmcraft)\//;
// Apps whose .wasm/.js names carry a content hash: cache for a year.
const HASHED = /^(photocraft|pdfcraft|vectorcraft|cadcraft|deckcraft|gridcraft|soundcraft|craft-anything|designcraft|figcraft|materialcraft|texturecraft|wordcraft)\/.*\.(wasm|js)$/;
// Files a visitor never needs.
const HIDDEN = /(^|\/)(\.htaccess|_headers|_redirects|_manifest\.json|[^/]*\.trunk-lock)$/;

function baseHeaders(h) {
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Embedder-Policy", "require-corp");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  h.set("X-Content-Type-Options", "nosniff");
  return h;
}

function notFound() {
  return new Response("Not found\n", { status: 404, headers: baseHeaders(new Headers({ "Content-Type": "text/plain" })) });
}

async function relay(request, env, url) {
  // /relay/<path> -> <RELAY_ORIGIN>/<path>, WebSocket upgrades included.
  if (!env.RELAY_ORIGIN) return notFound();
  const target = new URL(url.pathname.replace(/^\/relay/, "") + url.search, env.RELAY_ORIGIN);
  return fetch(new Request(target, request));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
    if (url.pathname.startsWith("/relay/")) return relay(request, env, url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed\n", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    let key;
    try { key = decodeURIComponent(url.pathname).replace(/^\/+/, ""); } catch { return notFound(); }
    if (key.includes("..") || HIDDEN.test(key)) return notFound();
    if (key === "" || key.endsWith("/")) key += "index.html";

    const ext = (key.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || "";
    const wantsGz = GZ.has(ext) && /\bgzip\b/.test(request.headers.get("Accept-Encoding") || "");

    let obj = null, gz = false;
    if (wantsGz) { obj = await env.SITE.get(key + ".gz"); gz = !!obj; }
    if (!obj) obj = await env.SITE.get(key);
    if (!obj) {
      // "/photocraft" (no slash) -> "/photocraft/", like nginx's try_files $uri/.
      if (!ext && !url.pathname.endsWith("/") && (await env.SITE.head(key + "/index.html"))) {
        return Response.redirect(url.origin + url.pathname + "/" + url.search, 301);
      }
      return notFound();
    }

    const h = baseHeaders(new Headers());
    h.set("Content-Type", TYPES[ext] || "application/octet-stream");
    h.set("Cache-Control", HASHED.test(key) && !UNHASHED.test(key)
      ? "public, max-age=31536000, immutable" : "no-cache");
    h.set("ETag", obj.httpEtag);
    if (GZ.has(ext)) h.set("Vary", "Accept-Encoding");
    if (gz) h.set("Content-Encoding", "gzip");

    const inm = request.headers.get("If-None-Match");
    if (inm && inm === obj.httpEtag) return new Response(null, { status: 304, headers: h });
    return new Response(request.method === "HEAD" ? null : obj.body, {
      headers: h,
      // The body is already gzip: pass it through untouched.
      encodeBody: gz ? "manual" : "automatic",
    });
  },
};
