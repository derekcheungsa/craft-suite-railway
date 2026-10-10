import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import crypto from "node:crypto";
import type { TabRegistry } from "./registry.js";
import type { Denylist } from "./denylist.js";

const IMAGE_MAX_BYTES = 1_000_000; // PRD: cap previews at 1 MB
const FILE_MAX_BYTES = 512 * 1024; // default cap for base64 file payloads
const FILE_MAX_BYTES_HARD = 2 * 1024 * 1024; // never inline more than this
const PUT_FILE_MAX_B64 = 8 * 1024 * 1024; // max encoded size for put_file imports

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errResult(message: string) {
  return { content: [{ type: "text" as const, text: `error: ${message}` }], isError: true };
}

/** JSON stringify with a size guard so a huge app payload cannot blow up the
 *  MCP response (images must go through get_image instead). */
function safeJson(value: unknown): string {
  const s = JSON.stringify(value, null, 1) ?? String(value);
  if (s.length > 120_000) {
    return s.slice(0, 120_000) + `\n…(truncated ${s.length - 120_000} chars; narrow the command or use inspect)`;
  }
  return s;
}

export function buildServer(registry: TabRegistry, denylist: Denylist, log: (ev: string, fields: Record<string, unknown>) => void): McpServer {
  const server = new McpServer({ name: "craft-relay", version: "0.1.0" });

  server.registerTool(
    "list_sessions",
    {
      title: "List connected Craft Suite tabs",
      description: "List connected app tabs (session id, app, version, last seen). The default target for other tools is the most recently active tab.",
      inputSchema: {},
    },
    async () => {
      const sessions = registry.listSessions();
      return textResult(sessions.length === 0
        ? "No tabs connected. Open a Craft Suite app in Chrome/Edge, click the agent button and connect."
        : safeJson(sessions));
    }
  );

  server.registerTool(
    "list_commands",
    {
      title: "List an app's commands",
      description: "List the commands an app supports, with parameter hints. Optional text filter. LightCraft ships a static catalog; EffectCraft returns its live command registry.",
      inputSchema: { filter: z.string().optional(), session: z.string().optional() },
    },
    async ({ filter, session }) => {
      const tab = registry.resolveTarget(session);
      const result = await registry.call(tab.sessionId, "list_commands", { filter: filter ?? null });
      log("tool", { tool: "list_commands", app: tab.app, tab: tab.sessionId, ok: true });
      return textResult(safeJson(result));
    }
  );

  server.registerTool(
    "run_command",
    {
      title: "Run one command in an app",
      description: "Run a single app command with JSON params and return its result. Destructive commands are denied by the relay's denylist; the page's read-only mode applies too.",
      inputSchema: {
        command: z.string().describe("Command id, e.g. develop.set (LightCraft) or comp.layer.add (EffectCraft)"),
        params: z.record(z.string(), z.unknown()).optional().describe("Command params as a JSON object"),
        session: z.string().optional(),
      },
    },
    async ({ command, params, session }) => {
      const denied = denylist.check(command ?? "");
      if (denied) return errResult(`command "${command}" is on the denylist (${denied}); destructive commands are blocked by this relay`);
      const tab = registry.resolveTarget(session);
      try {
        const result = await registry.call(tab.sessionId, "run_command", { command, params: params ?? {} });
        log("tool", { tool: "run_command", command, app: tab.app, tab: tab.sessionId, ok: true });
        return textResult(safeJson(result));
      } catch (e) {
        log("tool", { tool: "run_command", command, app: tab.app, tab: tab.sessionId, ok: false });
        return errResult(String((e as Error).message ?? e));
      }
    }
  );

  server.registerTool(
    "inspect",
    {
      title: "Inspect app state",
      description: "Return app state (active composition, selection, library info) for one tab.",
      inputSchema: { session: z.string().optional() },
    },
    async ({ session }) => {
      const tab = registry.resolveTarget(session);
      const result = await registry.call(tab.sessionId, "inspect", {});
      log("tool", { tool: "inspect", app: tab.app, tab: tab.sessionId, ok: true });
      return textResult(safeJson(result));
    }
  );

  server.registerTool(
    "get_image",
    {
      title: "Get a preview image",
      description: "Return a rendered frame (EffectCraft) or the app's preview/screenshot as an image, downsized in the page and capped at 1 MB. Use it to check edits.",
      inputSchema: { mode: z.enum(["frame", "screenshot"]).optional(), session: z.string().optional() },
    },
    async ({ mode, session }) => {
      const tab = registry.resolveTarget(session);
      const result = (await registry.call(tab.sessionId, "get_image", { mode: mode ?? "frame" })) as
        | { mime: string; base64: string }
        | { error: string };
      log("tool", { tool: "get_image", app: tab.app, tab: tab.sessionId, ok: !("error" in result) });
      if ("error" in result) return errResult(result.error);
      const bytes = Math.floor((result.base64.length * 3) / 4);
      if (bytes > IMAGE_MAX_BYTES) return errResult(`preview is ${bytes} bytes after page-side downscaling; refusing to send over the 1 MB cap`);
      return { content: [{ type: "image" as const, data: result.base64, mimeType: result.mime ?? "image/png" }] };
    }
  );

  server.registerTool(
    "run_batch",
    {
      title: "Run up to 20 commands in order",
      description: "Run a sequence of commands in one tab, stopping at the first error. Cuts round trips for multi-step edits. Each entry is {command, params}.",
      inputSchema: {
        commands: z.array(z.object({ command: z.string(), params: z.record(z.string(), z.unknown()).optional() })).min(1).max(20),
        session: z.string().optional(),
      },
    },
    async ({ commands, session }) => {
      for (const c of commands) {
        const denied = denylist.check(c.command);
        if (denied) return errResult(`command "${c.command}" is on the denylist (${denied}); batch rejected without running`);
      }
      const tab = registry.resolveTarget(session);
      const t0 = Date.now();
      try {
        const result = await registry.call(tab.sessionId, "run_batch", { commands });
        log("tool", { tool: "run_batch", n: commands.length, app: tab.app, tab: tab.sessionId, ok: true, ms: Date.now() - t0 });
        return textResult(safeJson(result));
      } catch (e) {
        log("tool", { tool: "run_batch", n: commands.length, app: tab.app, tab: tab.sessionId, ok: false, ms: Date.now() - t0 });
        return errResult(String((e as Error).message ?? e));
      }
    }
  );

  server.registerTool(
    "list_files",
    {
      title: "List files in an app tab",
      description: "List the app's in-browser file table (exports, imported media, saved projects) with paths, sizes and kinds. Use before get_file / send_file.",
      inputSchema: { session: z.string().optional() },
    },
    async ({ session }) => {
      const tab = registry.resolveTarget(session);
      const result = await registry.call(tab.sessionId, "list_files", {});
      log("tool", { tool: "list_files", app: tab.app, tab: tab.sessionId, ok: true });
      return textResult(safeJson(result));
    }
  );

  server.registerTool(
    "get_file",
    {
      title: "Read a small file into the conversation",
      description: "Return a file from the app's file table as base64 (with sha256). Small files only (captions, .srt, .json, settings); larger payloads should use send_file to a URL you control.",
      inputSchema: {
        path: z.string().describe("Path from list_files"),
        max_bytes: z.number().int().positive().max(FILE_MAX_BYTES_HARD).optional().describe(`Inline up to this many bytes (default ${FILE_MAX_BYTES}, hard max ${FILE_MAX_BYTES_HARD})`),
        session: z.string().optional(),
      },
    },
    async ({ path, max_bytes, session }) => {
      const cap = Math.min(max_bytes ?? FILE_MAX_BYTES, FILE_MAX_BYTES_HARD);
      const tab = registry.resolveTarget(session);
      const result = (await registry.call(tab.sessionId, "get_file", { path })) as
        | { base64: string; kind?: string }
        | { error: string };
      const ok = !("error" in result);
      log("tool", { tool: "get_file", path, app: tab.app, tab: tab.sessionId, ok });
      if (!ok) return errResult(result.error);
      const bytes = Math.floor((result.base64.length * 3) / 4);
      if (bytes > cap) {
        return errResult(`${path} is ${bytes} bytes (cap ${cap}). Use send_file to upload it to a URL you control instead of inlining it.`);
      }
      const buf = Buffer.from(result.base64, "base64");
      const sha256 = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
      return {
        content: [
          { type: "text" as const, text: `${path} — ${bytes} bytes, sha256:${sha256}` },
          { type: "resource" as const, resource: { uri: `craft-file:///${tab.app}${path.startsWith("/") ? "" : "/"}${path}`, mimeType: result.kind || "application/octet-stream", blob: result.base64 } },
        ],
      };
    }
  );

  server.registerTool(
    "send_file",
    {
      title: "Upload a file from the app to a URL",
      description: "Upload a file from the app's in-browser file table to a URL you supply (presigned PUT, upload endpoint, local receiver). Best for large media: bytes never enter the conversation. Blocked by the page's read-only mode.",
      inputSchema: {
        path: z.string().describe("Path from list_files"),
        url: z.string().describe("http(s) URL to upload to"),
        method: z.enum(["PUT", "POST"]).optional().describe("HTTP method (default PUT)"),
        session: z.string().optional(),
      },
    },
    async ({ path, url, method, session }) => {
      let parsed: URL;
      try { parsed = new URL(url); } catch { return errResult("url is not a valid absolute URL"); }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return errResult("only http(s) upload URLs are allowed");
      }
      const tab = registry.resolveTarget(session);
      try {
        const result = (await registry.call(tab.sessionId, "send_file", { path, url, method: method ?? "PUT" })) as
          | { ok: boolean; status?: number; bytes?: number }
          | { error: string };
        const ok = !("error" in result) && result.ok !== false;
        log("tool", { tool: "send_file", path, host: parsed.host, app: tab.app, tab: tab.sessionId, ok });
        if (!ok) return errResult("error" in result ? result.error : "upload failed");
        return textResult(`uploaded ${path} (${result.bytes ?? "?"} bytes) to ${parsed.host} — HTTP ${result.status ?? "?"}`);
      } catch (e) {
        log("tool", { tool: "send_file", path, host: parsed.host, app: tab.app, tab: tab.sessionId, ok: false });
        return errResult(String((e as Error).message ?? e));
      }
    }
  );

  server.registerTool(
    "put_file",
    {
      title: "Import a file into an app",
      description: "Put a file into the app tab: from base64 (name required) or from a URL the page fetches (no size limit through the conversation). Imports as a dropped file — PhotoCraft opens it as a document, FilmCraft/EffectCraft add it to the file table. Blocked by the page's read-only mode.",
      inputSchema: {
        name: z.string().optional().describe("File name (required with base64; derived from the URL otherwise)"),
        base64: z.string().optional().describe("File contents, base64 (max ~6 MB decoded)"),
        url: z.string().optional().describe("http(s) URL the page fetches directly"),
        session: z.string().optional(),
      },
    },
    async ({ name, base64, url, session }) => {
      if (!base64 && !url) return errResult("provide either base64 or url");
      if (base64 && url) return errResult("provide base64 or url, not both");
      if (base64 && !name) return errResult("name is required when importing from base64");
      if (base64 && base64.length > PUT_FILE_MAX_B64) {
        return errResult(`base64 payload is ${base64.length} chars (cap ${PUT_FILE_MAX_B64}); host the file and pass its url instead`);
      }
      if (url) {
        let parsed: URL;
        try { parsed = new URL(url); } catch { return errResult("url is not a valid absolute URL"); }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return errResult("only http(s) urls are allowed");
      }
      const tab = registry.resolveTarget(session);
      try {
        const result = (await registry.call(tab.sessionId, "put_file", {
          name: name ?? null, base64: base64 ?? null, url: url ?? null,
        })) as { error?: string } & Record<string, unknown>;
        const ok = !result.error;
        log("tool", { tool: "put_file", name: name ?? url ?? "", app: tab.app, tab: tab.sessionId, ok });
        if (!ok) return errResult(String(result.error));
        return textResult(safeJson(result));
      } catch (e) {
        log("tool", { tool: "put_file", app: tab.app, tab: tab.sessionId, ok: false });
        return errResult(String((e as Error).message ?? e));
      }
    }
  );

  return server;
}
