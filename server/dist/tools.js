import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
const IMAGE_MAX_BYTES = 1_000_000; // PRD: cap previews at 1 MB
function textResult(text) {
    return { content: [{ type: "text", text }] };
}
function errResult(message) {
    return { content: [{ type: "text", text: `error: ${message}` }], isError: true };
}
/** JSON stringify with a size guard so a huge app payload cannot blow up the
 *  MCP response (images must go through get_image instead). */
function safeJson(value) {
    const s = JSON.stringify(value, null, 1) ?? String(value);
    if (s.length > 120_000) {
        return s.slice(0, 120_000) + `\n…(truncated ${s.length - 120_000} chars; narrow the command or use inspect)`;
    }
    return s;
}
export function buildServer(registry, denylist, log) {
    const server = new McpServer({ name: "craft-relay", version: "0.1.0" });
    server.registerTool("list_sessions", {
        title: "List connected Craft Suite tabs",
        description: "List connected app tabs (session id, app, version, last seen). The default target for other tools is the most recently active tab.",
        inputSchema: {},
    }, async () => {
        const sessions = registry.listSessions();
        return textResult(sessions.length === 0
            ? "No tabs connected. Open a Craft Suite app in Chrome/Edge, click the agent button and connect."
            : safeJson(sessions));
    });
    server.registerTool("list_commands", {
        title: "List an app's commands",
        description: "List the commands an app supports, with parameter hints. Optional text filter. LightCraft ships a static catalog; EffectCraft returns its live command registry.",
        inputSchema: { filter: z.string().optional(), session: z.string().optional() },
    }, async ({ filter, session }) => {
        const tab = registry.resolveTarget(session);
        const result = await registry.call(tab.sessionId, "list_commands", { filter: filter ?? null });
        log("tool", { tool: "list_commands", app: tab.app, tab: tab.sessionId, ok: true });
        return textResult(safeJson(result));
    });
    server.registerTool("run_command", {
        title: "Run one command in an app",
        description: "Run a single app command with JSON params and return its result. Destructive commands are denied by the relay's denylist; the page's read-only mode applies too.",
        inputSchema: {
            command: z.string().describe("Command id, e.g. develop.set (LightCraft) or comp.layer.add (EffectCraft)"),
            params: z.record(z.string(), z.unknown()).optional().describe("Command params as a JSON object"),
            session: z.string().optional(),
        },
    }, async ({ command, params, session }) => {
        const denied = denylist.check(command ?? "");
        if (denied)
            return errResult(`command "${command}" is on the denylist (${denied}); destructive commands are blocked by this relay`);
        const tab = registry.resolveTarget(session);
        try {
            const result = await registry.call(tab.sessionId, "run_command", { command, params: params ?? {} });
            log("tool", { tool: "run_command", command, app: tab.app, tab: tab.sessionId, ok: true });
            return textResult(safeJson(result));
        }
        catch (e) {
            log("tool", { tool: "run_command", command, app: tab.app, tab: tab.sessionId, ok: false });
            return errResult(String(e.message ?? e));
        }
    });
    server.registerTool("inspect", {
        title: "Inspect app state",
        description: "Return app state (active composition, selection, library info) for one tab.",
        inputSchema: { session: z.string().optional() },
    }, async ({ session }) => {
        const tab = registry.resolveTarget(session);
        const result = await registry.call(tab.sessionId, "inspect", {});
        log("tool", { tool: "inspect", app: tab.app, tab: tab.sessionId, ok: true });
        return textResult(safeJson(result));
    });
    server.registerTool("get_image", {
        title: "Get a preview image",
        description: "Return a rendered frame (EffectCraft) or the app's preview/screenshot as an image, downsized in the page and capped at 1 MB. Use it to check edits.",
        inputSchema: { mode: z.enum(["frame", "screenshot"]).optional(), session: z.string().optional() },
    }, async ({ mode, session }) => {
        const tab = registry.resolveTarget(session);
        const result = (await registry.call(tab.sessionId, "get_image", { mode: mode ?? "frame" }));
        log("tool", { tool: "get_image", app: tab.app, tab: tab.sessionId, ok: !("error" in result) });
        if ("error" in result)
            return errResult(result.error);
        const bytes = Math.floor((result.base64.length * 3) / 4);
        if (bytes > IMAGE_MAX_BYTES)
            return errResult(`preview is ${bytes} bytes after page-side downscaling; refusing to send over the 1 MB cap`);
        return { content: [{ type: "image", data: result.base64, mimeType: result.mime ?? "image/png" }] };
    });
    server.registerTool("run_batch", {
        title: "Run up to 20 commands in order",
        description: "Run a sequence of commands in one tab, stopping at the first error. Cuts round trips for multi-step edits. Each entry is {command, params}.",
        inputSchema: {
            commands: z.array(z.object({ command: z.string(), params: z.record(z.string(), z.unknown()).optional() })).min(1).max(20),
            session: z.string().optional(),
        },
    }, async ({ commands, session }) => {
        for (const c of commands) {
            const denied = denylist.check(c.command);
            if (denied)
                return errResult(`command "${c.command}" is on the denylist (${denied}); batch rejected without running`);
        }
        const tab = registry.resolveTarget(session);
        const t0 = Date.now();
        try {
            const result = await registry.call(tab.sessionId, "run_batch", { commands });
            log("tool", { tool: "run_batch", n: commands.length, app: tab.app, tab: tab.sessionId, ok: true, ms: Date.now() - t0 });
            return textResult(safeJson(result));
        }
        catch (e) {
            log("tool", { tool: "run_batch", n: commands.length, app: tab.app, tab: tab.sessionId, ok: false, ms: Date.now() - t0 });
            return errResult(String(e.message ?? e));
        }
    });
    return server;
}
