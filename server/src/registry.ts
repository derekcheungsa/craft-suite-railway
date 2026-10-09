import { WebSocket } from "ws";

export interface TabInfo {
  sessionId: string;
  app: string;
  version: string;
  tabId: string;
  connectedAt: number;
  lastSeen: number;   // any traffic (hello, pong)
  lastActive: number; // completed a tool call or sent hello
}

interface Tab extends TabInfo {
  ws: WebSocket;
  alive: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  tool: string;
  startedAt: number;
}

/** In-memory registry of connected browser tabs and in-flight tool calls.
 *  Stores no user content: requests/results live only in closures. */
export class TabRegistry {
  private tabs = new Map<string, Tab>();
  private pending = new Map<string, Pending>(); // callId -> pending
  private callSeq = 0;
  private tabSeq = 0;

  constructor(
    private maxTabs = 5,
    private callTimeoutMs = 20_000
  ) {}

  /** Register a tab after a valid hello. Returns the session id. */
  register(ws: WebSocket, app: string, version: string, tabId: string): string {
    if (this.tabs.size >= this.maxTabs) {
      throw new Error(`relay already has the maximum of ${this.maxTabs} connected tabs`);
    }
    const sessionId = `s${++this.tabSeq}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    this.tabs.set(sessionId, { ws, sessionId, app, version, tabId, connectedAt: now, lastSeen: now, lastActive: now, alive: true });
    return sessionId;
  }

  bindSessionToSocket(sessionId: string, ws: WebSocket) {
    const tab = this.tabs.get(sessionId);
    if (tab) tab.ws = ws;
  }

  drop(sessionId: string) {
    this.tabs.delete(sessionId);
    // In-flight calls for this tab are not failed silently: they time out
    // with a clear error naming the tab.
  }

  touchSeen(sessionId: string) {
    const tab = this.tabs.get(sessionId);
    if (tab) tab.lastSeen = Date.now();
  }

  listSessions(): TabInfo[] {
    return [...this.tabs.values()]
      .map(({ ws: _ws, alive: _alive, ...info }) => info)
      .sort((a, b) => b.lastActive - a.lastActive);
  }

  /** Pick the target tab: explicit session id or the most recently active. */
  resolveTarget(sessionId?: string): Tab {
    if (sessionId) {
      const tab = this.tabs.get(sessionId);
      if (!tab) throw new Error(`no connected tab with session ${sessionId}; use list_sessions`);
      return tab;
    }
    if (this.tabs.size === 0) throw new Error("no Craft Suite tab is connected; open an app and click Connect agent");
    let best: Tab | undefined;
    for (const tab of this.tabs.values()) if (!best || tab.lastActive > best.lastActive) best = tab;
    return best!;
  }

  /** Send a tool call to a tab and await the bridge's response. */
  call(sessionId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
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
  handleResponse(callId: string, ok: boolean, payload: unknown): number | null {
    const p = this.pending.get(callId);
    if (!p) return null;
    this.pending.delete(callId);
    clearTimeout(p.timer);
    const ms = Date.now() - p.startedAt;
    if (ok) p.resolve(payload);
    else p.reject(new Error(typeof payload === "string" ? payload : JSON.stringify(payload ?? "bridge error")));
    return ms;
  }

  /** Mark a tab alive on pong. Drop tabs that missed two ping rounds. */
  markAlive(sessionId: string) {
    const tab = this.tabs.get(sessionId);
    if (tab) { tab.alive = true; tab.lastSeen = Date.now(); }
  }

  sweepDeadTabs(): string[] {
    const dropped: string[] = [];
    for (const [id, tab] of this.tabs) {
      if (!tab.alive) {
        dropped.push(id);
        this.tabs.delete(id);
        tab.ws.terminate();
      } else {
        tab.alive = false;
        if (tab.ws.readyState === WebSocket.OPEN) {
          try { tab.ws.ping(); } catch { /* closing */ }
        }
      }
    }
    return dropped;
  }
}
