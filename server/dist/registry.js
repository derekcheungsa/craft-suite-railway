import { WebSocket } from "ws";
/** In-memory registry of connected browser tabs and in-flight tool calls.
 *  Stores no user content: requests/results live only in closures. */
export class TabRegistry {
    maxTabs;
    callTimeoutMs;
    tabs = new Map();
    pending = new Map(); // callId -> pending
    callSeq = 0;
    tabSeq = 0;
    constructor(maxTabs = 5, callTimeoutMs = 20_000) {
        this.maxTabs = maxTabs;
        this.callTimeoutMs = callTimeoutMs;
    }
    /** Register a tab after a valid hello. Returns the session id. */
    register(ws, app, version, tabId) {
        if (this.tabs.size >= this.maxTabs) {
            throw new Error(`relay already has the maximum of ${this.maxTabs} connected tabs`);
        }
        const sessionId = `s${++this.tabSeq}-${Math.random().toString(36).slice(2, 8)}`;
        const now = Date.now();
        this.tabs.set(sessionId, { ws, sessionId, app, version, tabId, connectedAt: now, lastSeen: now, lastActive: now, alive: true });
        return sessionId;
    }
    bindSessionToSocket(sessionId, ws) {
        const tab = this.tabs.get(sessionId);
        if (tab)
            tab.ws = ws;
    }
    drop(sessionId) {
        this.tabs.delete(sessionId);
        // In-flight calls for this tab are not failed silently: they time out
        // with a clear error naming the tab.
    }
    touchSeen(sessionId) {
        const tab = this.tabs.get(sessionId);
        if (tab)
            tab.lastSeen = Date.now();
    }
    listSessions() {
        return [...this.tabs.values()]
            .map(({ ws: _ws, alive: _alive, ...info }) => info)
            .sort((a, b) => b.lastActive - a.lastActive);
    }
    /** Pick the target tab: explicit session id or the most recently active. */
    resolveTarget(sessionId) {
        if (sessionId) {
            const tab = this.tabs.get(sessionId);
            if (!tab)
                throw new Error(`no connected tab with session ${sessionId}; use list_sessions`);
            return tab;
        }
        if (this.tabs.size === 0)
            throw new Error("no Craft Suite tab is connected; open an app and click Connect agent");
        let best;
        for (const tab of this.tabs.values())
            if (!best || tab.lastActive > best.lastActive)
                best = tab;
        return best;
    }
    /** Send a tool call to a tab and await the bridge's response. */
    call(sessionId, tool, args) {
        const tab = this.tabs.get(sessionId);
        if (!tab || tab.ws.readyState !== WebSocket.OPEN) {
            throw new Error(`tab ${sessionId} is not connected`);
        }
        const callId = `c${++this.callSeq}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(callId);
                reject(new Error(`tab ${sessionId} did not answer ${tool} within ${this.callTimeoutMs} ms (tab open? still rendering?)`));
            }, this.callTimeoutMs);
            this.pending.set(callId, { resolve, reject, timer, tool, startedAt: Date.now() });
            tab.ws.send(JSON.stringify({ type: "request", id: callId, tool, args }));
        });
    }
    /** Bridge answered a call. Returns duration ms (for logs) or null if unknown. */
    handleResponse(callId, ok, payload) {
        const p = this.pending.get(callId);
        if (!p)
            return null;
        this.pending.delete(callId);
        clearTimeout(p.timer);
        const ms = Date.now() - p.startedAt;
        if (ok)
            p.resolve(payload);
        else
            p.reject(new Error(typeof payload === "string" ? payload : JSON.stringify(payload ?? "bridge error")));
        return ms;
    }
    /** Mark a tab alive on pong. Drop tabs that missed two ping rounds. */
    markAlive(sessionId) {
        const tab = this.tabs.get(sessionId);
        if (tab) {
            tab.alive = true;
            tab.lastSeen = Date.now();
        }
    }
    sweepDeadTabs() {
        const dropped = [];
        for (const [id, tab] of this.tabs) {
            if (!tab.alive) {
                dropped.push(id);
                this.tabs.delete(id);
                tab.ws.terminate();
            }
            else {
                tab.alive = false;
                if (tab.ws.readyState === WebSocket.OPEN) {
                    try {
                        tab.ws.ping();
                    }
                    catch { /* closing */ }
                }
            }
        }
        return dropped;
    }
}
