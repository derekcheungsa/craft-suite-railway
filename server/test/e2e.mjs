/* Relay end-to-end test: spawns the relay, then exercises
 *  1. /healthz
 *  2. MCP auth: missing token, wrong token → 401
 *  3. MCP: initialize → tools/list → list_sessions (no tabs)
 *  4. WS bridge: wrong origin rejected, wrong token rejected
 *  5. Full chain: fake tab connects, MCP run_command reaches it and returns
 *  6. run_command denylist enforcement
 *  7. get_image size cap enforcement
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const MCP_TOKEN = "test-mcp-token-0123456789abcdef0123456789abcdef";
const BRIDGE_TOKEN = "test-bridge-token-456789abcdef";
const PORT = 8091;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "http://localhost:8090";

let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

const relay = spawn(process.execPath, ["dist/index.js"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, PORT: String(PORT), MCP_TOKEN, BRIDGE_TOKEN, ALLOWED_ORIGINS: ORIGIN, CALL_TIMEOUT_MS: "3000" },
  stdio: ["ignore", "pipe", "pipe"],
});
relay.stdout.on("data", (d) => { if (process.env.VERBOSE) process.stdout.write(d); });
relay.stderr.on("data", (d) => process.stderr.write(d));
await new Promise((r) => setTimeout(r, 1500));

async function mcp(body, token = MCP_TOKEN) {
  const headers = { "content-type": "application/json", "accept": "application/json, text/event-stream" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {
    const m = text.match(/^data: (.+)$/m); if (m) json = JSON.parse(m[1]);
  }
  return { status: res.status, json, text };
}

try {
  // 1. healthz
  let r = await fetch(`${BASE}/healthz`);
  ok("healthz 200", r.status === 200);

  // 2. auth
  r = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } }, null);
  ok("missing token rejected 401", r.status === 401);
  r = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } }, "wrong-token-wrong-token-wrong-token");
  ok("wrong token rejected 401", r.status === 401);

  // 3. initialize + tools
  r = await mcp({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  ok("initialize ok", r.status === 200 && r.json?.result?.serverInfo?.name === "craft-relay", JSON.stringify(r.json).slice(0, 200));
  r = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  const tools = (r.json?.result?.tools ?? []).map((t) => t.name);
  ok("ten tools listed", tools.length === 10 && ["list_sessions", "list_commands", "run_command", "inspect", "get_image", "run_batch", "list_files", "get_file", "send_file", "put_file"].every((t) => tools.includes(t)), tools.join(","));
  r = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_sessions", arguments: {} } });
  ok("list_sessions with no tabs gives guidance", r.json?.result?.content?.[0]?.text?.includes("No tabs connected"), r.text.slice(0, 120));

  // 4. bridge auth
  const wsBadOrigin = new WebSocket(`${BASE.replace("http", "ws")}/bridge?token=${BRIDGE_TOKEN}`, { origin: "https://evil.example" });
  await new Promise((res) => { wsBadOrigin.on("error", () => res()); wsBadOrigin.on("open", () => { ok("wrong origin connected — SHOULD NOT", false); res(); }); setTimeout(res, 2000); });
  ok("wrong origin rejected", wsBadOrigin.readyState >= WebSocket.CLOSING);

  const wsBadToken = new WebSocket(`${BASE.replace("http", "ws")}/bridge?token=nope`, { origin: ORIGIN });
  await new Promise((res) => { wsBadToken.on("error", () => res()); wsBadToken.on("open", () => { ok("wrong token connected — SHOULD NOT", false); res(); }); setTimeout(res, 2000); });
  ok("wrong bridge token rejected", wsBadToken.readyState >= WebSocket.CLOSING);

  // 5. full chain with a fake tab
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/bridge?token=${BRIDGE_TOKEN}`, { origin: ORIGIN });
  const requests = [];
  let welcome = null;
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === "welcome") welcome = m;
    if (m.type === "request") requests.push(m);
  });
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); setTimeout(() => rej(new Error("ws open timeout")), 3000); });
  ws.send(JSON.stringify({ type: "hello", app: "lightcraft", version: "v0.4.0", tabId: "test-tab" }));
  await new Promise((res) => { if (welcome) res(); else setTimeout(res, 1500); });
  ok("tab hello -> welcome with session", !!welcome?.sessionId, JSON.stringify(welcome));

  r = await mcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_sessions", arguments: {} } });
  ok("list_sessions shows the tab", r.json?.result?.content?.[0]?.text?.includes("lightcraft"), r.text.slice(0, 150));

  // routed call: MCP -> relay -> tab -> reply
  const callP = mcp({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "run_command", arguments: { command: "develop.set", params: { control: "exposure", value: 0.4 } } } });
  await new Promise((res) => { const iv = setInterval(() => { if (requests.length) { clearInterval(iv); res(); } }, 20); setTimeout(() => res(), 3000); });
  ok("request reached the tab", requests.length === 1 && requests[0].tool === "run_command" && requests[0].args.command === "develop.set", JSON.stringify(requests[0]));
  ws.send(JSON.stringify({ type: "response", id: requests[0].id, ok: true, result: { set: true, control: "exposure", value: 0.4 } }));
  r = await callP;
  ok("run_command returns tab result", r.json?.result?.content?.[0]?.text?.includes("exposure"), r.text.slice(0, 200));

  // 6. denylist
  r = await mcp({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "run_command", arguments: { command: "library.delete", params: {} } } });
  ok("denylisted command refused by relay", r.json?.result?.isError === true && (r.json?.result?.content?.[0]?.text ?? "").includes("denylist"), r.text.slice(0, 150));

  // 7. image cap
  const imgCall = mcp({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "get_image", arguments: {} } });
  await new Promise((res) => { const iv = setInterval(() => { if (requests.length >= 2) { clearInterval(iv); res(); } }, 20); setTimeout(res, 3000); });
  ws.send(JSON.stringify({ type: "response", id: requests[1].id, ok: true, result: { mime: "image/png", base64: "A".repeat(1_500_000) } }));
  r = await imgCall;
  ok("oversized image refused", r.json?.result?.isError === true && (r.json?.result?.content?.[0]?.text ?? "").includes("1 MB"), r.text.slice(0, 150));

  // 7b. get_file cap + send_file validation
  const smallCall = mcp({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "get_file", arguments: { path: "/captions.srt" } } });
  await new Promise((res) => { const iv = setInterval(() => { if (requests.length >= 3) { clearInterval(iv); res(); } }, 20); setTimeout(res, 3000); });
  ws.send(JSON.stringify({ type: "response", id: requests[2].id, ok: true, result: { base64: Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nhello captions\n").toString("base64"), kind: "application/x-subrip" } }));
  r = await smallCall;
  const contents = r.json?.result?.content ?? [];
  ok("get_file returns summary + resource blob", contents.length === 2 && contents[0]?.type === "text" && contents[1]?.type === "resource" && contents[1]?.resource?.blob, JSON.stringify(contents).slice(0, 150));
  const bigCall = mcp({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "get_file", arguments: { path: "/big.wav" } } });
  await new Promise((res) => { const iv = setInterval(() => { if (requests.length >= 4) { clearInterval(iv); res(); } }, 20); setTimeout(res, 3000); });
  ws.send(JSON.stringify({ type: "response", id: requests[3].id, ok: true, result: { base64: "A".repeat(1_400_000) } }));
  r = await bigCall;
  ok("oversized get_file refused with send_file hint", r.json?.result?.isError === true && (r.json?.result?.content?.[0]?.text ?? "").includes("send_file"), r.text.slice(0, 150));
  r = await mcp({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "send_file", arguments: { path: "/x", url: "ftp://evil" } } });
  ok("send_file rejects non-http url", r.json?.result?.isError === true, r.text.slice(0, 100));

  // 9. put_file validation + happy path
  r = await mcp({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "put_file", arguments: { name: "a.png" } } });
  ok("put_file requires base64 or url", r.json?.result?.isError === true && (r.json?.result?.content?.[0]?.text ?? "").includes("base64 or url"), r.text.slice(0, 100));
  r = await mcp({ jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "put_file", arguments: { base64: "AAA", url: "https://x/y.png" } } });
  ok("put_file rejects base64+url", r.json?.result?.isError === true, r.text.slice(0, 100));
  r = await mcp({ jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: "put_file", arguments: { base64: "AAA" } } });
  ok("put_file requires name with base64", r.json?.result?.isError === true, r.text.slice(0, 100));
  r = await mcp({ jsonrpc: "2.0", id: 16, method: "tools/call", params: { name: "put_file", arguments: { url: "ftp://evil/a.png" } } });
  ok("put_file rejects non-http url", r.json?.result?.isError === true, r.text.slice(0, 100));
  const putCall = mcp({ jsonrpc: "2.0", id: 17, method: "tools/call", params: { name: "put_file", arguments: { name: "gen.png", base64: Buffer.from("fakepng").toString("base64") } } });
  await new Promise((res) => { const iv = setInterval(() => { if (requests.length >= 5) { clearInterval(iv); res(); } }, 20); setTimeout(res, 3000); });
  ok("put_file reaches the tab", requests.length >= 5 && requests[4].tool === "put_file" && requests[4].args.name === "gen.png", JSON.stringify(requests[4] || {}));
  ws.send(JSON.stringify({ type: "response", id: requests[4].id, ok: true, result: { ok: true, items: [{ path: "/gen.png" }] } }));
  r = await putCall;
  ok("put_file returns import result", (r.json?.result?.content?.[0]?.text ?? "").includes("gen.png"), r.text.slice(0, 150));

  // 8. timeout behavior
  const slowCall = mcp({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "run_command", arguments: { command: "develop.get", params: {} } } });
  await new Promise((res) => { const iv = setInterval(() => { if (requests.length >= 3) { clearInterval(iv); res(); } }, 20); setTimeout(res, 3000); });
  r = await slowCall; // never answered
  ok("unanswered call times out with clear error", r.json?.result?.isError === true && (r.json?.result?.content?.[0]?.text ?? "").includes("did not answer"), r.text.slice(0, 200));

  ws.close();
} finally {
  relay.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
