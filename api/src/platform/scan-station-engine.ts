import { randomUUID } from "node:crypto";
import {
  nfcUid, sameStationRef, stationControl, STATION_IDLE_MS,
  type ScanStation, type StationAction, type StationPlacement, type StationRef,
  type StationResult, type StationSession,
} from "@cobblr/platform-contract/scan-station";

export interface StationPorts {
  authenticated?: boolean;
  now(): Date;
  saveDevice(device: ScanStation): Promise<void>;
  session(id: string): Promise<StationSession>;
  saveSession(session: StationSession): Promise<void>;
  request(id: string): Promise<{ code: string; result: StationResult } | null>;
  journal(id: string): Promise<StationSession | null>;
  saveRequest(id: string, code: string, result: StationResult): Promise<void>;
  resolve(code: string): Promise<{ ref: StationRef; place: boolean; holder: boolean } | null>;
  placement(thing: StationRef): Promise<StationPlacement>;
  place(thing: StationRef, placement: StationPlacement, expected: StationPlacement): Promise<void>;
  intake(id: string, code: string, container: StationRef): Promise<StationRef>;
  undoIntake(thing: StationRef, container: StationRef): Promise<void>;
  route(code: string, mode: "navigate" | "print"): Promise<StationResult>;
  notify(session: StationSession): Promise<void>;
}

export class StationRefusal extends Error {}

function equalPlacement(a: StationPlacement, b: StationPlacement): boolean {
  return sameStationRef(a.container, b.container) && (a.slot ?? null) === (b.slot ?? null)
    && (a.position?.x_mm ?? null) === (b.position?.x_mm ?? null)
    && (a.position?.y_mm ?? null) === (b.position?.y_mm ?? null);
}

// The caller holds the device's database lock. Save the intent before touching
// a tenant, so a process exit leaves enough information to finish or undo it.
export class StationEngine {
  constructor(readonly device: ScanStation, readonly ports: StationPorts) {}

  async active(): Promise<StationSession> {
    if (this.device.session_id) return this.ports.session(this.device.session_id);
    const at = this.ports.now().toISOString();
    const session: StationSession = {
      id: randomUUID(), device_id: this.device.id, device_name: this.device.name,
      started_at: at, last_at: at, ended_at: null, notified: false, actions: [],
    };
    await this.ports.saveSession(session);
    this.device.session_id = session.id;
    await this.ports.saveDevice(this.device);
    return session;
  }

  async end(): Promise<void> {
    if (!this.device.session_id) return;
    const s = await this.ports.session(this.device.session_id);
    if (this.ports.authenticated !== false) for (const a of s.actions) if (a.status === "pending" || a.status === "undo_pending") await this.finish(s, a);
    s.ended_at ??= this.ports.now().toISOString();
    await this.ports.saveSession(s);
    this.device.session_id = null;
    this.device.context = null;
    this.device.last_thing = null;
    await this.ports.saveDevice(this.device);
    await this.digest(s);
  }

  async digest(s: StationSession): Promise<void> {
    if (!s.ended_at || s.notified) return;
    if (s.actions.length) await this.ports.notify(s);
    s.notified = true;
    await this.ports.saveSession(s);
  }

  async expire(): Promise<void> {
    if (this.device.last_at && this.ports.now().getTime() - Date.parse(this.device.last_at) >= STATION_IDLE_MS) await this.end();
  }

  async scan(code: string, requestId: string): Promise<StationResult> {
    const cached = await this.ports.request(requestId);
    if (cached) {
      if (cached.code !== code) throw new Error("That scan identifier was already used for a different scan.");
      return cached.result;
    }
    const journal = await this.ports.journal(requestId);
    if (journal) {
      const prior = journal.actions.find((a) => a.request_id === requestId)!;
      if (prior.code !== code) throw new StationRefusal("That scan identifier was already used for a different scan.");
      if (prior.status === "pending" || prior.status === "undo_pending") await this.finish(journal, prior);
      return this.remember(requestId, code, this.result(journal, prior));
    }
    if (this.device.session_id) {
      const s = await this.ports.session(this.device.session_id);
      for (const a of s.actions) if (a.status === "pending" || a.status === "undo_pending") await this.finish(s, a);
      const prior = s.actions.find((a) => a.request_id === requestId);
      if (prior) return this.remember(requestId, code, this.result(s, prior));
    }
    await this.expire();
    const control = stationControl(code);
    if (control === "end") {
      await this.end();
      return this.remember(requestId, code, { driven: false, kind: "station", action: "end", feedback: "ok", message: "Session ended." });
    }
    if (control === "undo") {
      if (!this.device.session_id) return this.remember(requestId, code, this.refused("There is no active session to undo."));
      const s = await this.ports.session(this.device.session_id);
      const a = [...s.actions].reverse().find((a) => a.status === "done" && ["file", "inbox", "container", "open"].includes(a.type));
      if (!a) return this.remember(requestId, code, this.refused("There is no action left to undo."));
      await this.undo(s, a.id);
      if (a.status !== "undone") return this.remember(requestId, code, this.refused(a.undo_error || "This action could not be undone."));
      this.device.last_thing = null;
      await this.ports.saveDevice(this.device);
      return this.remember(requestId, code, { driven: false, kind: "station", action: "undo", feedback: "undone", session_id: s.id, message: "Last action undone." });
    }
    let s = await this.active();
    if (s.actions.length >= 500) { await this.end(); s = await this.active(); }
    const at = this.ports.now().toISOString();
    const a: StationAction = {
      id: randomUUID(), request_id: requestId, code, at, type: "refused", status: "done",
      context_before: this.device.context, context_after: this.device.context, message: "",
    };
    this.device.last_at = at;
    s.last_at = at;
    const uid = nfcUid(code);
    if (uid) this.device.last_tag = uid;
    if (control) {
      this.device.mode = control;
      this.device.last_thing = null;
      a.type = "mode";
      a.message = control === "navigate" ? "Scans open records." : control === "print" ? "Scans print labels." : "Scans file things.";
    } else if (this.device.mode !== "file") {
      a.type = this.device.mode;
      a.status = "pending";
      a.message = code;
    } else {
      let resolved: Awaited<ReturnType<StationPorts["resolve"]>> = null;
      let resolutionError: string | null = null;
      try { resolved = await this.ports.resolve(code); }
      catch (error) { if (!(error instanceof StationRefusal)) throw error; resolutionError = error.message; }
      if (resolutionError) {
        a.message = resolutionError;
        this.device.last_thing = null;
      } else if (resolved?.place) {
        a.type = "container";
        a.status = "pending";
        a.thing = resolved.ref;
        a.context_after = resolved.ref;
        a.message = `Next things go into ${resolved.ref.name}.`;
        this.device.last_thing = null;
      } else if (resolved?.holder && sameStationRef(resolved.ref, this.device.last_thing)) {
        a.type = "open";
        a.status = "pending";
        a.thing = resolved.ref;
        a.context_after = resolved.ref;
        a.message = `Next things go into ${resolved.ref.name}.`;
        this.device.last_thing = null;
      } else if (!this.device.context) {
        a.message = "Scan a place before filing a thing.";
        this.device.last_thing = null;
      } else if (resolved) {
        a.type = "file";
        a.thing = resolved.ref;
        a.before = await this.ports.placement(resolved.ref);
        a.after = sameStationRef(a.before.container, this.device.context) ? a.before : { container: this.device.context };
        a.status = "pending";
        a.message = `${resolved.ref.name} filed into ${this.device.context.name}.`;
        this.device.last_thing = resolved.holder ? resolved.ref : null;
      } else if (uid || /^nfc:|^https?:|^cobblr:/i.test(code)) {
        a.message = uid ? "This tag is not linked. Open a record and choose Tap to link." : "That label does not belong to a record in this workspace.";
        this.device.last_thing = null;
      } else {
        a.type = "inbox";
        a.status = "pending";
        a.thing = { kind: "core-scan:item", id: a.id, name: code, path: "/scan" };
        a.after = { container: this.device.context };
        a.message = `Added ${code} to the inbox for ${this.device.context.name}.`;
        this.device.last_thing = null;
      }
    }
    s.actions.push(a);
    await this.ports.saveSession(s);
    await this.ports.saveDevice(this.device);
    if (a.status === "pending") await this.finish(s, a, code);
    else {
      this.device.context = a.context_after;
      await this.ports.saveDevice(this.device);
    }
    return this.remember(requestId, code, this.result(s, a));
  }

  async finish(s: StationSession, a: StationAction, code?: string): Promise<void> {
    try {
      if (a.status === "undo_pending") {
        if (a.type === "file") {
          const current = await this.ports.placement(a.thing!);
          if (equalPlacement(current, a.after!)) await this.ports.place(a.thing!, a.before!, a.after!);
          else if (!equalPlacement(current, a.before!)) throw new StationRefusal("This thing moved after the scan. Its later move was kept.");
        } else if (a.type === "inbox") await this.ports.undoIntake(a.thing!, a.after!.container!);
        a.status = "undone";
        delete a.undo_error;
        if (this.device.session_id === s.id && sameStationRef(this.device.context, a.context_after)) this.device.context = a.context_before;
      } else {
        if (a.type === "file") {
          const current = await this.ports.placement(a.thing!);
          if (equalPlacement(current, a.before!)) await this.ports.place(a.thing!, a.after!, a.before!);
          else if (!equalPlacement(current, a.after!)) throw new StationRefusal("This thing moved while the scan was waiting. Its later move was kept.");
        } else if (a.type === "inbox") {
          a.thing = await this.ports.intake(a.id, a.thing!.name, a.after!.container!);
        } else if (code && (a.type === "print" || a.type === "navigate")) {
          const result = await this.ports.route(code, a.type);
          if (result.action === "refused") throw new StationRefusal(result.message || "This scan was refused.");
          a.result = result;
          a.thing = result.item_id ? { kind: "core-scan:item", id: result.item_id, name: code, path: result.path } : undefined;
          a.message = result.action === "print" ? "Label queued." : result.driven ? "Opened on the chosen screen." : "No screen is following this station. Check the scan inbox.";
        } else if (a.type === "print" || a.type === "navigate") throw new StationRefusal("The station restarted during this scan. Check the label queue or inbox before scanning again.");
        a.status = "done";
        if (!s.ended_at) this.device.context = a.context_after;
      }
    } catch (error) {
      if (!(error instanceof StationRefusal)) throw error;
      if (a.status === "undo_pending") { a.status = "done"; a.undo_error = error.message; }
      else { a.status = "refused"; a.message = error.message; }
      this.device.last_thing = null;
    }
    await this.ports.saveSession(s);
    await this.ports.saveDevice(this.device);
  }

  async undo(s: StationSession, actionId?: string): Promise<StationSession> {
    const chosen = actionId ? s.actions.filter((a) => a.id === actionId) : [...s.actions].reverse();
    if (actionId && !chosen.length) throw new Error("That action is not in this session.");
    for (const a of chosen) {
      if (a.status !== "done" || !["file", "inbox", "container", "open"].includes(a.type)) continue;
      a.status = "undo_pending";
      await this.ports.saveSession(s);
      await this.finish(s, a);
      const finished = s.actions.find((entry) => entry.id === a.id)!;
      if (finished.status === "undone" && this.device.session_id === s.id && sameStationRef(this.device.context, a.context_after)) this.device.context = a.context_before;
    }
    this.device.last_thing = null;
    await this.ports.saveDevice(this.device);
    return s;
  }

  private result(s: StationSession, a: StationAction): StationResult {
    const refused = a.type === "refused" || a.status === "refused";
    return {
      driven: a.result?.driven ?? false, kind: a.result?.kind ?? (a.type === "inbox" ? "barcode" : "station"), session_id: s.id,
      ...(a.result?.path ? { path: a.result.path } : {}), ...(a.result?.queued ? { queued: true } : {}),
      action: refused ? "refused" : a.type === "inbox" ? "file" : a.type === "tag" ? undefined : a.type,
      feedback: refused ? "refused" : a.type === "container" ? "container" : a.type === "open" ? "opened" : a.type === "file" || a.type === "inbox" ? "filed" : "ok",
      message: a.message, ...(a.thing ? { item_id: a.thing.id, path: a.thing.path } : {}),
    };
  }
  private refused(message: string): StationResult { return { driven: false, kind: "station", action: "refused", feedback: "refused", message }; }
  private async remember(id: string, code: string, result: StationResult): Promise<StationResult> {
    await this.ports.saveRequest(id, code, result);
    return result;
  }
}
