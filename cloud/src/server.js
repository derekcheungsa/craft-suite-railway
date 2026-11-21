// Craft Cloud: sign-in, a file library and version history for Craft Suite,
// backed by Neon (Postgres + Neon Auth).
//
// Served same-origin behind the site's nginx at /cloud/ (nginx strips the
// prefix), so the apps' strict cross-origin isolation headers never get in the
// way and the browser only ever talks to its own origin.
//
// Database, in order of preference:
//   1. DATABASE_URL (+ NEON_AUTH_URL) from the environment: your own Neon
//      project, or the claimed one after you copy its new connection string.
//   2. A claimable Neon project this service created on an earlier boot,
//      remembered in $DATA_DIR/craft-cloud.json (a Railway volume).
//   3. Otherwise it creates one now: no Neon account needed. It lasts 72 hours
//      and 100 MB until someone claims it into their Neon account.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { createRemoteJWKSet, jwtVerify } from "jose";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const STATE_FILE = path.join(DATA_DIR, "craft-cloud.json");
const CLAIMABLE = "https://claimable.neon.tech";
const CHUNK = 2 * 1024 * 1024; // bytes per row; one row per HTTP query
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB ?? "50", 10);
// An unclaimed project has 100 MB in all (tables, auth, indexes); leave headroom.
const UNCLAIMED_LIMIT_MB = parseInt(process.env.UNCLAIMED_LIMIT_MB ?? "80", 10);
const OWN_LIMIT_MB = parseInt(process.env.STORAGE_LIMIT_MB ?? "0", 10); // 0 = no limit
// Neon Auth checks the Origin of sign-in requests against the project's trusted
// domains, which can't be edited until the project is claimed; localhost is
// trusted by default. This server checks the browser's Origin itself (same
// origin only) and then calls Neon Auth server-side with this one.
const AUTH_ORIGIN = process.env.NEON_AUTH_ORIGIN ?? "http://localhost:3000";
const NEON_SESSION_COOKIE = "__Secure-neon-auth.session_token";
const COOKIE = "craft_cloud";
// Where visitors get their own copy (shown to anyone who isn't this cloud's owner).
const TEMPLATE_URL = process.env.TEMPLATE_URL ?? "https://railway.com/deploy/craft-suite";
const PRIVATE_MSG = "This is a private cloud: only its owner can sign in. You can get your own private copy, free, in one click.";

function log(ev, data) { console.log(JSON.stringify({ t: new Date().toISOString(), ev, ...data })); }

/* ---------------- state & provisioning ---------------- */

let state = null;  // { mode, databaseUrl, authUrl, jwksUrl, projectId, expiresAt, assertion, claim }
let sql = null;
let jwks = null;
let ready = null;  // Promise of the current setup attempt

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return null; }
}
function writeState(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

async function claimableToken(assertion) {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
    resource: CLAIMABLE + "/",
  });
  const r = await fetch(CLAIMABLE + "/v1/oauth2/token", { method: "POST", body });
  if (!r.ok) throw new Error("claimable token: HTTP " + r.status + " " + (await r.text()).slice(0, 200));
  return (await r.json()).access_token;
}

async function provision() {
  log("provision_start", {});
  const r = await fetch(CLAIMABLE + "/v1/agent/identity", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "anonymous",
      capabilities: ["postgres", "auth"],
      source: "craft-cloud",
      project_name: process.env.NEON_PROJECT_NAME ?? "craft-cloud",
      ...(process.env.NEON_REGION ? { region_id: process.env.NEON_REGION } : {}),
    }),
  });
  if (!r.ok) throw new Error("provision: HTTP " + r.status + " " + (await r.text()).slice(0, 300));
  const reg = await r.json();
  const assertion = reg.identity_assertion ?? reg.claim_token;
  const authCap = (reg.capabilities ?? []).find((c) => c.capability === "auth");
  if (!assertion || !reg.project?.id) throw new Error("provision: response missing assertion or project");
  if (!authCap?.granted) throw new Error("provision: Neon Auth was not granted");
  const token = await claimableToken(assertion);
  const c = await fetch(`${CLAIMABLE}/v1/projects/${reg.project.id}/credentials`, { headers: { Authorization: "Bearer " + token } });
  if (!c.ok) throw new Error("credentials: HTTP " + c.status);
  const cred = await c.json();
  const s = {
    mode: "unclaimed",
    projectId: reg.project.id,
    expiresAt: cred.expires_at ?? reg.project.expires_at,
    databaseUrl: cred.database_url,
    authUrl: cred.services?.auth?.base_url,
    jwksUrl: cred.services?.auth?.jwks_url,
    assertion,
    createdAt: new Date().toISOString(),
  };
  writeState(s);
  log("provision_done", { project: s.projectId, expiresAt: s.expiresAt });
  return s;
}

async function setup() {
  if (process.env.DATABASE_URL) {
    const saved = readState() ?? {};
    const authUrl = process.env.NEON_AUTH_URL ?? saved.authUrl;
    state = {
      ...saved,
      mode: "own",
      databaseUrl: process.env.DATABASE_URL,
      authUrl,
      jwksUrl: process.env.NEON_AUTH_JWKS_URL ?? saved.jwksUrl ?? (authUrl && authUrl.replace(/\/$/, "") + "/.well-known/jwks.json"),
    };
  } else {
    let s = readState();
    if (s && s.mode === "unclaimed" && s.expiresAt && Date.parse(s.expiresAt) < Date.now()) {
      log("project_expired", { project: s.projectId });
      s = null; // its data is gone with it: start a fresh one
    }
    if (s && s.mode === "claimed") {
      // Waiting for the owner to paste the claimed project's connection string
      // (POST /connect). Neon Auth moved with the project, so sign-in still works.
      state = s;
      jwks = createRemoteJWKSet(new URL(state.jwksUrl));
      log("ready", { mode: state.mode, project: state.projectId });
      return;
    }
    state = s ?? (await provision());
  }
  if (!state.authUrl) throw new Error("no Neon Auth URL: set NEON_AUTH_URL");
  sql = neon(state.databaseUrl);
  jwks = createRemoteJWKSet(new URL(state.jwksUrl));
  await migrate();
  if (state.claim && state.mode === "unclaimed") pollClaim();
  log("ready", { mode: state.mode, project: state.projectId });
}

function ensureReady() {
  if (!ready) ready = setup().catch((e) => { ready = null; throw e; });
  return ready;
}

async function migrate() {
  await sql`create table if not exists craft_meta (key text primary key, value text not null)`;
  await sql`create table if not exists craft_files (
    id bigserial primary key,
    user_id text not null,
    name text not null,
    app text,
    version int not null,
    size bigint not null,
    sha256 text not null,
    created_at timestamptz not null default now(),
    unique (user_id, name, version))`;
  await sql`create table if not exists craft_chunks (
    file_id bigint not null references craft_files(id) on delete cascade,
    seq int not null,
    data bytea not null,
    primary key (file_id, seq))`;
}

/* ---------------- claim ---------------- */

let polling = false;
async function pollClaim() {
  if (polling) return;
  polling = true;
  try {
    while (state.mode === "unclaimed" && state.claim) {
      await new Promise((r) => setTimeout(r, (state.claim.interval ?? 5) * 1000));
      let st;
      try {
        const token = await claimableToken(state.assertion);
        const r = await fetch(`${CLAIMABLE}/v1/projects/${state.projectId}/claim`, { headers: { Authorization: "Bearer " + token } });
        if (!r.ok) { log("claim_poll", { status: r.status }); continue; }
        st = await r.json();
      } catch (e) {
        // Once the human continues in Neon, the assertion can stop working before
        // the transfer is reconciled; keep trying until the claim window closes.
        log("claim_poll_error", { err: String(e.message ?? e).slice(0, 120) });
        if (Date.parse(state.claim.expiresAt) < Date.now() - 60 * 60 * 1000) break;
        continue;
      }
      if (st.reconciled) {
        // The pre-claim credentials are dead now; the owner pastes the new
        // connection string into the service's DATABASE_URL.
        state = { ...state, mode: "claimed", assertion: undefined, databaseUrl: undefined, claim: { ...state.claim, reconciledAt: new Date().toISOString() } };
        writeState(state);
        sql = null;
        log("claimed", { project: state.projectId });
      }
    }
  } finally { polling = false; }
}

/* ---------------- auth ---------------- */

const jwtCache = new Map(); // neon session value -> { jwt, sub, email, exp }

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function neonAuth(pathname, { method = "POST", body, session } = {}) {
  const headers = { Origin: AUTH_ORIGIN };
  if (body) headers["Content-Type"] = "application/json";
  if (session) headers.Cookie = `${NEON_SESSION_COOKIE}=${session}`;
  const r = await fetch(state.authUrl.replace(/\/$/, "") + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  let set = null;
  for (const c of r.headers.getSetCookie?.() ?? []) {
    const m = new RegExp("^" + NEON_SESSION_COOKIE.replace(/[.]/g, "\\.") + "=([^;]*)").exec(c);
    if (m) set = decodeURIComponent(m[1]);
  }
  return { status: r.status, json, session: set };
}

async function currentUser(req) {
  const session = parseCookies(req)[COOKIE];
  if (!session) return null;
  const hit = jwtCache.get(session);
  if (hit && hit.exp * 1000 > Date.now() + 30_000) return hit;
  const r = await neonAuth("/token", { method: "GET", session });
  if (r.status !== 200 || !r.json?.token) { jwtCache.delete(session); return null; }
  const { payload } = await jwtVerify(r.json.token, jwks);
  const u = { sub: String(payload.sub), email: payload.email ?? null, name: payload.name ?? null, exp: payload.exp ?? Math.floor(Date.now() / 1000) + 300 };
  jwtCache.set(session, u);
  if (jwtCache.size > 5000) jwtCache.delete(jwtCache.keys().next().value);
  return u;
}

function sessionCookie(req, value, maxAge) {
  const secure = (req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/cloud; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

async function ownerId() {
  const r = await sql`select value from craft_meta where key = 'owner'`;
  return r[0]?.value ?? null;
}
async function claimOwner(sub) {
  if (!sql) return;
  // The first account becomes the owner: the only one who can claim the project.
  await sql`insert into craft_meta (key, value) values ('owner', ${sub}) on conflict (key) do nothing`;
}

/* ---------------- files ---------------- */

async function usageBytes() {
  const r = await sql`select coalesce(sum(size), 0)::bigint as n from craft_files`;
  return Number(r[0].n);
}
function limitBytes() {
  const mb = state.mode === "unclaimed" ? UNCLAIMED_LIMIT_MB : OWN_LIMIT_MB;
  return mb > 0 ? mb * 1024 * 1024 : null;
}

function cleanName(n) {
  n = String(n ?? "").replace(/[\\/]+/g, "_").replace(/[\u0000-\u001f]/g, "").trim();
  if (!n || n === "." || n === "..") throw httpError(400, "bad file name");
  if (n.length > 200) throw httpError(400, "file name too long");
  return n;
}

const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
  pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav",
  json: "application/json", txt: "text/plain", md: "text/markdown", csv: "text/csv",
};
function mimeFor(name) { return MIME[(name.split(".").pop() ?? "").toLowerCase()] ?? "application/octet-stream"; }

async function saveFile(user, name, app, req) {
  const max = MAX_FILE_MB * 1024 * 1024;
  const declared = parseInt(req.headers["content-length"] ?? "0", 10);
  if (declared > max) throw httpError(413, `file is larger than ${MAX_FILE_MB} MB`);
  const limit = limitBytes();
  const used = limit ? await usageBytes() : 0;
  if (limit && declared && used + declared > limit) throw httpError(507, storageFullMessage(used, limit));

  const hash = crypto.createHash("sha256");
  const [{ v }] = await sql`select coalesce(max(version), 0) + 1 as v from craft_files where user_id = ${user.sub} and name = ${name}`;
  const [{ id }] = await sql`insert into craft_files (user_id, name, app, version, size, sha256)
    values (${user.sub}, ${name}, ${app}, ${v}, 0, '') returning id`;
  let seq = 0, size = 0, buf = [], bufLen = 0;
  const flush = async () => {
    if (!bufLen) return;
    const data = Buffer.concat(buf, bufLen);
    buf = []; bufLen = 0;
    await sql`insert into craft_chunks (file_id, seq, data) values (${id}, ${seq++}, ${data})`;
  };
  try {
    for await (const piece of req) {
      size += piece.length;
      if (size > max) throw httpError(413, `file is larger than ${MAX_FILE_MB} MB`);
      if (limit && used + size > limit) throw httpError(507, storageFullMessage(used, limit));
      hash.update(piece);
      buf.push(piece); bufLen += piece.length;
      while (bufLen >= CHUNK) {
        const all = Buffer.concat(buf, bufLen);
        buf = [all.subarray(CHUNK)]; bufLen = all.length - CHUNK;
        await sql`insert into craft_chunks (file_id, seq, data) values (${id}, ${seq++}, ${all.subarray(0, CHUNK)})`;
      }
    }
    await flush();
    if (size === 0) throw httpError(400, "empty file");
    const sha = hash.digest("hex");
    await sql`update craft_files set size = ${size}, sha256 = ${sha} where id = ${id}`;
    return { name, version: Number(v), size, sha256: sha };
  } catch (e) {
    await sql`delete from craft_files where id = ${id}`.catch(() => {});
    throw e;
  }
}

function storageFullMessage(used, limit) {
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  return state.mode === "unclaimed"
    ? `cloud is full (${mb(used)} of ${mb(limit)} MB before the project is claimed). Claim it into a Neon account for more space, or delete old files.`
    : `cloud is full (${mb(used)} of ${mb(limit)} MB)`;
}

async function sendFileBytes(res, user, name, version) {
  const rows = version
    ? await sql`select id, size, version, sha256 from craft_files where user_id = ${user.sub} and name = ${name} and version = ${version} and sha256 <> ''`
    : await sql`select id, size, version, sha256 from craft_files where user_id = ${user.sub} and name = ${name} and sha256 <> '' order by version desc limit 1`;
  if (!rows.length) throw httpError(404, "no such file");
  const f = rows[0];
  res.writeHead(200, {
    "Content-Type": mimeFor(name),
    "Content-Length": String(f.size),
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    "Cache-Control": "private, no-store",
    "X-Craft-Version": String(f.version),
    ETag: `"${f.sha256}"`,
  });
  const n = await sql`select count(*)::int as n from craft_chunks where file_id = ${f.id}`;
  for (let i = 0; i < n[0].n; i++) {
    const [c] = await sql`select data from craft_chunks where file_id = ${f.id} and seq = ${i}`;
    if (!res.write(Buffer.from(c.data))) await new Promise((r) => res.once("drain", r));
  }
  res.end();
}

/* ---------------- http ---------------- */

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function json(res, status, body, extra = {}) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
  res.end(s);
}

async function readJson(req, max = 64 * 1024) {
  let n = 0; const parts = [];
  for await (const p of req) { n += p.length; if (n > max) throw httpError(413, "body too large"); parts.push(p); }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"); } catch { throw httpError(400, "bad JSON"); }
}

// Requests that change anything must come from a page on this same site.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const host = (req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0].trim();
  try { return new URL(origin).host === host; } catch { return false; }
}

async function status(req) {
  const user = await currentUser(req).catch(() => null);
  const out = {
    mode: state.mode, // unclaimed | claimed (waiting for DATABASE_URL) | own
    project: state.projectId ?? null,
    expiresAt: state.mode === "unclaimed" ? state.expiresAt : null,
    user: user ? { id: user.sub, email: user.email, name: user.name } : null,
    templateUrl: TEMPLATE_URL,
  };
  if (state.mode === "claimed") {
    out.message = "Claimed. Paste the project's connection string from Neon to reconnect.";
    out.neonConsoleUrl = `https://console.neon.tech/app/projects/${state.projectId}`;
    return out;
  }
  const owner = await ownerId();
  out.hasOwner = !!owner;
  if (user && owner && owner !== user.sub) out.user = null; // an account from before the cloud went private
  if (!out.user) return out; // visitors learn nothing about the owner's storage
  out.usedBytes = await usageBytes();
  out.limitBytes = limitBytes();
  out.maxFileBytes = MAX_FILE_MB * 1024 * 1024;
  if (out.user) {
    out.user.owner = true;
    if (out.user.owner && state.mode === "unclaimed" && state.claim && Date.parse(state.claim.codeExpiresAt) > Date.now()) {
      out.claimUrl = state.claim.url;
    }
  }
  return out;
}

async function route(req, res) {
  const url = new URL(req.url, "http://x");
  // nginx strips /cloud; accept it too, so the service also works on its own.
  const p = url.pathname.replace(/^\/cloud(?=\/|$)/, "").replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (p === "/healthz") return json(res, 200, { ok: true });
  if (method !== "GET" && method !== "HEAD" && !sameOrigin(req)) throw httpError(403, "cross-site request refused");

  await ensureReady();
  if (p === "/status" && method === "GET") return json(res, 200, await status(req));
  const claimedOk = p === "/auth/sign-in" || p === "/auth/sign-out" || p === "/connect";
  if (state.mode === "claimed" && !claimedOk) throw httpError(503, "Craft Cloud was claimed: its owner needs to paste the project's connection string from Neon in the Craft Cloud panel");

  if (p === "/auth/sign-up" || p === "/auth/sign-in") {
    if (method !== "POST") throw httpError(405, "POST only");
    const b = await readJson(req);
    const email = String(b.email ?? "").trim(), password = String(b.password ?? "");
    if (!email || !password) throw httpError(400, "email and password are required");
    // One owner per cloud: the first account. After that, sign-ups are closed.
    if (p === "/auth/sign-up" && (await ownerId())) return json(res, 403, { error: PRIVATE_MSG, code: "PRIVATE_CLOUD", templateUrl: TEMPLATE_URL });
    const r = p === "/auth/sign-up"
      ? await neonAuth("/sign-up/email", { body: { email, password, name: String(b.name ?? "").trim() || email.split("@")[0] } })
      : await neonAuth("/sign-in/email", { body: { email, password } });
    if (r.status !== 200 || !r.session) {
      return json(res, r.status === 200 ? 502 : r.status, { error: r.json?.message ?? "sign-in failed", code: r.json?.code ?? null });
    }
    const user = await currentUser({ headers: { cookie: `${COOKIE}=${encodeURIComponent(r.session)}` } });
    if (!user) throw httpError(502, "signed in, but Neon Auth did not issue a token");
    await claimOwner(user.sub);
    const owner = sql ? await ownerId() : null; // claimed and not reconnected yet: /connect checks the owner
    if (owner && owner !== user.sub) {
      jwtCache.delete(r.session);
      await neonAuth("/sign-out", { session: r.session, body: {} }).catch(() => {});
      return json(res, 403, { error: PRIVATE_MSG, code: "PRIVATE_CLOUD", templateUrl: TEMPLATE_URL });
    }
    log(p === "/auth/sign-up" ? "sign_up" : "sign_in", { user: user.sub });
    return json(res, 200, { user: { id: user.sub, email: user.email, name: user.name } }, { "Set-Cookie": sessionCookie(req, r.session, 7 * 24 * 3600) });
  }
  if (p === "/auth/sign-out" && method === "POST") {
    const session = parseCookies(req)[COOKIE];
    if (session) { jwtCache.delete(session); await neonAuth("/sign-out", { session, body: {} }).catch(() => {}); }
    return json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
  }

  const user = await currentUser(req);
  if (!user) throw httpError(401, "sign in to Craft Cloud first");
  if (sql) {
    const owner = await ownerId();
    if (owner && owner !== user.sub) throw httpError(403, PRIVATE_MSG);
  }

  if (p === "/files" && method === "GET") {
    const rows = await sql`select name, max(version)::int as version, count(*)::int as versions,
        (array_agg(size order by version desc))[1] as size, (array_agg(app order by version desc))[1] as app,
        max(created_at) as updated_at
      from craft_files where user_id = ${user.sub} and sha256 <> '' group by name order by max(created_at) desc`;
    return json(res, 200, { files: rows.map((r) => ({ ...r, size: Number(r.size) })) });
  }

  const m = /^\/files\/([^/]+)(\/versions)?$/.exec(p);
  if (m) {
    const name = cleanName(decodeURIComponent(m[1]));
    if (m[2]) {
      if (method !== "GET") throw httpError(405, "GET only");
      const rows = await sql`select version, size, app, sha256, created_at from craft_files
        where user_id = ${user.sub} and name = ${name} and sha256 <> '' order by version desc`;
      return json(res, 200, { name, versions: rows.map((r) => ({ ...r, size: Number(r.size) })) });
    }
    if (method === "GET") {
      const v = url.searchParams.get("v");
      return sendFileBytes(res, user, name, v ? parseInt(v, 10) : null);
    }
    if (method === "PUT" || method === "POST") {
      const app = (url.searchParams.get("app") ?? "").replace(/[^a-z-]/g, "").slice(0, 40) || null;
      const r = await saveFile(user, name, app, req);
      log("saved", { user: user.sub, size: r.size, version: r.version });
      return json(res, 200, { ok: true, ...r });
    }
    if (method === "DELETE") {
      const r = await sql`delete from craft_files where user_id = ${user.sub} and name = ${name} returning id`;
      return json(res, 200, { ok: true, deletedVersions: r.length });
    }
  }

  if (p === "/connect" && method === "POST") {
    // After a claim Neon rotates the database password, so the owner pastes the
    // project's new connection string here once. It must be a Neon database that
    // already holds this cloud, owned by the signed-in user: having the string
    // and being its owner is what authorizes the switch.
    const b = await readJson(req);
    const url = String(b.databaseUrl ?? "").trim().replace(/^psql\s+/, "").replace(/^['"]|['"]$/g, "");
    let host;
    try { const u = new URL(url); if (!/^postgres(ql)?:$/.test(u.protocol)) throw 0; host = u.hostname; } catch {
      throw httpError(400, "that doesn't look like a connection string: it starts with postgresql://");
    }
    if (!/\.neon\.tech$/.test(host)) throw httpError(400, "that connection string isn't for a Neon database");
    const candidate = neon(url);
    let owner;
    try { owner = (await candidate`select value from craft_meta where key = 'owner'`)[0]?.value ?? null; }
    catch (e) {
      const m = String(e.message ?? e);
      if (/craft_meta.*does not exist/.test(m)) throw httpError(400, "that database doesn't hold this Craft Cloud: copy the connection string of the project you just claimed");
      throw httpError(400, "couldn't connect with that connection string: " + m.slice(0, 120));
    }
    if (!owner) throw httpError(400, "that database doesn't hold this Craft Cloud: copy the connection string of the project you just claimed");
    if (owner !== user.sub) throw httpError(403, "only the cloud's owner can reconnect it");
    if (state.mode === "unclaimed") throw httpError(409, "this cloud isn't claimed yet");
    state = { ...state, mode: "own", databaseUrl: url, assertion: undefined, claim: state.claim ? { ...state.claim, connectedAt: new Date().toISOString() } : undefined };
    writeState(state);
    sql = candidate;
    await migrate();
    log("connected", { project: state.projectId });
    return json(res, 200, { ok: true, mode: state.mode });
  }

  if (p === "/claim") {
    if ((await ownerId()) !== user.sub) throw httpError(403, "only the cloud's owner (its first account) can claim it");
    if (state.mode !== "unclaimed") throw httpError(409, "this cloud uses your own Neon project already");
    if (method === "POST") {
      const token = await claimableToken(state.assertion);
      const r = await fetch(`${CLAIMABLE}/v1/projects/${state.projectId}/claim`, { method: "POST", headers: { Authorization: "Bearer " + token } });
      if (!r.ok) throw httpError(502, "Neon claim: HTTP " + r.status + " " + (await r.text()).slice(0, 200));
      const c = await r.json();
      state.claim = {
        url: c.verification_uri_complete,
        userCode: c.user_code,
        interval: c.interval ?? 5,
        codeExpiresAt: new Date(Date.now() + (c.expires_in ?? 900) * 1000).toISOString(),
        expiresAt: state.expiresAt,
      };
      writeState(state);
      pollClaim();
      log("claim_started", { project: state.projectId });
      return json(res, 200, { url: state.claim.url, userCode: state.claim.userCode, expiresIn: c.expires_in ?? 900 });
    }
  }
  throw httpError(404, "not found");
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    const status = e.status ?? 500;
    if (status >= 500) log("error", { path: req.url?.split("?")[0], err: String(e.message ?? e).slice(0, 300) });
    if (res.headersSent) { res.destroy(); return; }
    // Refused before reading an upload: drain it so the proxy sees our answer, not a broken pipe.
    if (!req.complete) req.resume();
    json(res, status, { error: status >= 500 && !e.status ? "internal error" : e.message });
  });
});
server.requestTimeout = 15 * 60 * 1000;
server.listen(PORT, () => {
  log("listening", { port: PORT, dataDir: DATA_DIR });
  ensureReady().catch((e) => log("setup_failed", { err: String(e.message ?? e).slice(0, 300) }));
});
