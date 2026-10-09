/* Waits for a live bridge tab, then drives the full MCP tool surface at it.
 * Run in the background while a browser scenario connects the bridge. */
import { writeFileSync } from "node:fs";

const MCP_TOKEN = "test-mcp-token-0123456789abcdef0123456789abcdef";
const BASE = "http://127.0.0.1:8091";

async function mcp(id, method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json, text/event-stream", authorization: `Bearer ${MCP_TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch {
    const m = text.match(/^data: (.+)$/m);
    return m ? JSON.parse(m[1]) : { parse_error: text.slice(0, 200) };
  }
}
const call = (id, name, args) => mcp(id, "tools/call", { name, arguments: args });
const textOf = (r) => r?.result?.content?.[0]?.text ?? JSON.stringify(r).slice(0, 300);

const out = { steps: [] };
const step = (name, fn) => step.run(name, fn);
step.run = async (name, fn) => {
  try { out.steps.push({ name, ...(await fn()) }); }
  catch (e) { out.steps.push({ name, error: String(e && e.message || e) }); }
};

// 1. wait for a tab (up to 90 s)
let sessions = null;
for (let i = 0; i < 45; i++) {
  const r = await mcp(1000 + i, "tools/call", { name: "list_sessions", arguments: {} });
  const t = textOf(r);
  if (!t.includes("No tabs connected")) { sessions = t; break; }
  await new Promise((res) => setTimeout(res, 2000));
}
if (!sessions) { writeFileSync("/tmp/mcp-live.json", JSON.stringify({ fatal: "no tab appeared in 90s" }, null, 1)); process.exit(1); }
out.tab = sessions;

await step("list_sessions", async () => ({ result: sessions }));
await step("list_commands(develop)", async () => ({ result: textOf(await call(2001, "list_commands", { filter: "develop" })) }));
await step("run_command(library.info)", async () => ({ result: textOf(await call(2002, "run_command", { command: "library.info", params: {} })) }));
await step("run_command(develop.get exposure)", async () => ({ result: textOf(await call(2003, "run_command", { command: "develop.get", params: { control: "exposure" } })) }));
await step("run_command(develop.set exposure 0.42)", async () => ({ result: textOf(await call(2004, "run_command", { command: "develop.set", params: { control: "exposure", value: 0.42 } })) }));
await step("run_batch(get+set+get)", async () => ({ result: textOf(await call(2005, "run_batch", { commands: [
  { command: "develop.get", params: { control: "exposure" } },
  { command: "develop.set", params: { control: "contrast", value: 0.2 } },
  { command: "develop.get", params: { control: "contrast" } },
] })) }));
await step("inspect", async () => ({ result: textOf(await call(2006, "inspect", {})) }));
await step("get_image (frame)", async () => {
  const r = await call(2007, "get_image", {});
  const c = r?.result?.content?.[0];
  return { kind: c?.type, mime: c?.mimeType, bytes: c?.data ? Math.floor(c.data.length * 3 / 4) : 0, text: c?.type === "text" ? c.text?.slice(0, 200) : undefined };
});
await step("denylist(library.delete)", async () => ({ result: textOf(await call(2008, "run_command", { command: "library.delete", params: {} })) }));

writeFileSync("/tmp/mcp-live.json", JSON.stringify(out, null, 1));
console.log("done");
