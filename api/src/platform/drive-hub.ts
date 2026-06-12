// In-memory SSE relay for browser driving (Feature 3). A "room" keyed by
// `${userId}:${orgId}` connects a user's open TABS to a DRIVER (Claude, via the
// MCP server). Transport-only — the routes authenticate every participant and
// enforce the drive-mode grant BEFORE calling in here, so the hub never decides
// permission. Single API instance (same assumption as the detached authoring
// build loop); a process restart just drops live sessions, which clients
// reconnect. Nothing is persisted here — only the standing grant is (DB).
//
// We use SSE (server→client) + plain POST (client→server) rather than a
// WebSocket: no new dependency, trivially testable with fetch/curl, and the only
// real-time direction we need to PUSH is server→tab (navigate) / server→driver
// (telemetry). It can be swapped for ws later behind this same interface.

type Send = (event: string, data: unknown) => void;

interface Tab {
  browserId: string;
  sessionId: string;
  send: Send;
}
interface Room {
  tabs: Map<string, Tab>;
  driver: Send | null;
  /** The one tab the user chose to let the driver control. */
  activeBrowserId: string | null;
  /** Ring buffer of recent observed user actions, so a driver that polls
   *  (cobblr_drive_observe) gets the actions it missed between calls — the SSE
   *  push is fire-and-forget. Capped so a long session can't grow unbounded. */
  telemetry: unknown[];
}

const TELEMETRY_BUFFER = 200;

const rooms = new Map<string, Room>();
const roomKey = (userId: string, orgId: string) => `${userId}:${orgId}`;

function getRoom(userId: string, orgId: string): Room {
  const k = roomKey(userId, orgId);
  let r = rooms.get(k);
  if (!r) {
    r = { tabs: new Map(), driver: null, activeBrowserId: null, telemetry: [] };
    rooms.set(k, r);
  }
  return r;
}
function gc(userId: string, orgId: string): void {
  const k = roomKey(userId, orgId);
  const r = rooms.get(k);
  if (r && r.tabs.size === 0 && !r.driver) rooms.delete(k);
}

export interface DriveStatus {
  driver: boolean;
  tabs: number;
  active: string | null;
}

export const driveHub = {
  /** Register an open tab's SSE stream. Returns an unregister fn for on-close. */
  connectTab(userId: string, orgId: string, browserId: string, sessionId: string, send: Send): () => void {
    const r = getRoom(userId, orgId);
    r.tabs.set(browserId, { browserId, sessionId, send });
    // Tell the freshly-connected tab the current drive state so a reconnect of
    // the active tab re-shows the green indicator, and others show grey/red.
    if (r.driver) {
      send(r.activeBrowserId === browserId ? "drive-active" : "drive-available", { active: r.activeBrowserId });
    }
    return () => {
      r.tabs.delete(browserId);
      if (r.activeBrowserId === browserId) {
        r.activeBrowserId = null;
        r.driver?.("tab-closed", {});
      }
      gc(userId, orgId);
    };
  },

  /** Register the driver's SSE stream. Returns an unregister fn for on-close. */
  connectDriver(userId: string, orgId: string, send: Send): () => void {
    const r = getRoom(userId, orgId);
    r.driver = send;
    return () => {
      r.driver = null;
      r.activeBrowserId = null;
      for (const t of r.tabs.values()) t.send("driver-left", {});
      gc(userId, orgId);
    };
  },

  driverPresent(userId: string, orgId: string): boolean {
    return !!rooms.get(roomKey(userId, orgId))?.driver;
  },

  /** Push a "Claude wants to drive — use this window?" offer to every open tab. */
  requestDrive(userId: string, orgId: string): { tabs: number } {
    const r = getRoom(userId, orgId);
    for (const t of r.tabs.values()) t.send("drive-offer", {});
    return { tabs: r.tabs.size };
  },

  /** The chosen tab claims control. Greens that tab, reds the rest, binds driver. */
  acceptDrive(userId: string, orgId: string, browserId: string): boolean {
    const r = getRoom(userId, orgId);
    if (!r.tabs.has(browserId)) return false;
    r.activeBrowserId = browserId;
    r.driver?.("drive-bound", { browserId });
    for (const t of r.tabs.values()) {
      t.send(t.browserId === browserId ? "drive-active" : "drive-elsewhere", { active: browserId });
    }
    return true;
  },

  /** A tab (or the user) hands control back. */
  releaseDrive(userId: string, orgId: string, browserId: string): void {
    const r = getRoom(userId, orgId);
    if (r.activeBrowserId === browserId) {
      r.activeBrowserId = null;
      r.driver?.("drive-released", {});
      for (const t of r.tabs.values()) t.send("drive-available", { active: null });
    }
  },

  /** Driver → active tab: open a page/view. False when no tab is bound. */
  navigate(userId: string, orgId: string, path: string): boolean {
    const r = getRoom(userId, orgId);
    if (!r.activeBrowserId) return false;
    const tab = r.tabs.get(r.activeBrowserId);
    if (!tab) return false;
    tab.send("navigate", { path });
    return true;
  },

  /** Driver → active tab: a visual presence cue (a cursor at a point / element,
   *  an optional click ripple, an optional label). The tab renders an injected
   *  overlay. False when no tab is bound. */
  present(userId: string, orgId: string, payload: unknown): boolean {
    const r = getRoom(userId, orgId);
    if (!r.activeBrowserId) return false;
    const tab = r.tabs.get(r.activeBrowserId);
    if (!tab) return false;
    tab.send("present", payload);
    return true;
  },

  /** Active tab → driver: a batch of observed user actions. Only the bound tab
   *  counts (the route gates this on mode === navigate_observe). Pushed live to a
   *  connected SSE driver AND buffered for the poll-based drain (drive_observe). */
  telemetry(userId: string, orgId: string, browserId: string, events: unknown): void {
    const r = getRoom(userId, orgId);
    if (r.activeBrowserId !== browserId) return;
    if (Array.isArray(events) && events.length) {
      r.telemetry.push(...events);
      if (r.telemetry.length > TELEMETRY_BUFFER) r.telemetry = r.telemetry.slice(-TELEMETRY_BUFFER);
    }
    if (r.driver) r.driver("telemetry", { events });
  },

  /** Drain + return the buffered observed actions (the cobblr_drive_observe poll). */
  drainTelemetry(userId: string, orgId: string): unknown[] {
    const r = rooms.get(roomKey(userId, orgId));
    if (!r) return [];
    const out = r.telemetry;
    r.telemetry = [];
    return out;
  },

  status(userId: string, orgId: string): DriveStatus {
    const r = rooms.get(roomKey(userId, orgId));
    return { driver: !!r?.driver, tabs: r ? r.tabs.size : 0, active: r?.activeBrowserId ?? null };
  },
};
