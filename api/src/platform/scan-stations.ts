import { randomUUID } from "node:crypto";
import { canContain, platform, type EntityRef } from "@cobblr/platform-contract";
import { nfcUid, stationControl, type ScanStation, type StationCommand, type StationPlacement, type StationRef } from "@cobblr/platform-contract/scan-station";
import { actionActed } from "@cobblr/platform-contract/action-result";
import { qrTokenFromScan } from "@cobblr/platform-contract/qr-token";
import { StationEngine, StationRefusal, type StationPorts } from "./scan-station-engine.js";
import { stationStore } from "./scan-station-store.js";
import { resolveQrToken } from "../routes/qr-scan.js";
import { routeScanToDrive } from "./scan-drive.js";
import { apiFetch, selfOrigin } from "@cobblr/platform-contract/self-api";

export interface StationCaller { orgId: string; userId: string; orgSlug: string; token: string }
const INTERNAL_API = selfOrigin();

async function record(orgId: string, ref: EntityRef): Promise<StationRef> {
  const entity = await platform().entities.lookup(orgId, ref.kind, ref.id);
  if (!entity) throw new StationRefusal("That record no longer exists in this workspace.");
  return { ...ref, name: entity.title, path: (await platform().entities.recordAddressForEntity(orgId, ref.kind, ref.id)) ?? undefined };
}

export async function resolveStationCode(orgId: string, code: string) {
  const uid = nfcUid(code);
  let target = uid ? await stationStore.alias(orgId, uid) : null;
  if (!target) {
    const token = qrTokenFromScan(code);
    if (!token) return null;
    const qr = await resolveQrToken(token);
    if (!qr.ok || !qr.entity_kind || !qr.entity_id) return null;
    if (qr.org_id !== orgId) throw new StationRefusal("That label belongs to another workspace.");
    target = { kind: qr.entity_kind, id: qr.entity_id, name: "" };
  }
  const base = await platform().entities.baseKindOf(orgId, target.kind);
  const ref = await record(orgId, { ...target, kind: base });
  const kind = await platform().entities.getKind(ref.kind);
  const traits = kind?.traits as Record<string, unknown> | null;
  return { ref, place: traits?.containment === "container", holder: canContain(traits) };
}

async function scanApi<T>(caller: StationCaller, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(`${INTERNAL_API}/api/v1/orgs/${encodeURIComponent(caller.orgSlug)}/modules/core-scan${path}`, {
    method, headers: { Authorization: `Bearer ${caller.token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const answer = await res.json() as T & { error?: { message?: string } };
  if (!res.ok) {
    const error = answer.error?.message || "The scan inbox could not accept this action.";
    if (res.status < 500) throw new StationRefusal(error);
    throw new Error(error);
  }
  return answer;
}

function ports(caller: StationCaller, device: ScanStation): StationPorts {
  const orgId = caller.orgId;
  return {
    authenticated: !!caller.token,
    now: () => new Date(), saveDevice: stationStore.saveDevice,
    session: (id) => stationStore.session(device.id, id), saveSession: stationStore.saveSession,
    request: (id) => stationStore.request(device.id, id),
    journal: (id) => stationStore.journal(device.id, id),
    saveRequest: (id, code, result) => stationStore.saveRequest(device.id, id, code, result),
    resolve: (code) => resolveStationCode(orgId, code),
    async placement(thing): Promise<StationPlacement> {
      const container = await platform().placement.containerOf({ orgId, containee: thing });
      if (!container) return { container: null };
      const entry = (await platform().placement.contents({ orgId, container })).find((r) => r.id === thing.id && r.kind === thing.kind);
      return { container: await record(orgId, container), slot: entry?.slot ?? null, position: entry?.position ?? null };
    },
    async place(thing, placement, expected) {
      try {
        if (placement.container) await platform().placement.place({
          orgId, containee: thing, container: placement.container, placedBy: caller.userId,
          slot: placement.slot ?? null, position: placement.position ?? null, via: device.name, preserveIdentity: true, expected,
        });
        else await platform().placement.remove({ orgId, containee: thing, expected });
      } catch (error) {
        if (/^placement:/.test((error as Error).message)) throw new StationRefusal((error as Error).message);
        throw error;
      }
    },
    async intake(id, code, container) {
      const row = await scanApi<{ id: string; suggested_name: string | null }>(caller, "POST", "/scan", {
        capture_id: id, barcode: code, source_kind: "barcode", enrich_ms: 1,
        target_container_kind: container.kind, target_container_id: container.id,
      });
      return { kind: "core-scan:item", id: row.id, name: row.suggested_name || code, path: "/scan" };
    },
    async undoIntake(thing, container) {
      const row = await scanApi<{ status: string; target_container_kind: string | null; target_container_id: string | null }>(caller, "GET", `/inbox/${thing.id}`);
      if (row.status === "discarded") return;
      if (row.status !== "pending" || row.target_container_kind !== container.kind || row.target_container_id !== container.id) throw new StationRefusal("This inbox item was filed or changed after the scan. Its later changes were kept.");
      await scanApi(caller, "POST", `/inbox/${thing.id}/discard`, { expected_container: { kind: container.kind, id: container.id } });
    },
    route: async (code, mode) => {
      const alias = nfcUid(code) ? await stationStore.alias(orgId, nfcUid(code)!) : null;
      if (nfcUid(code) && !alias) return { driven: false, kind: "station", action: "refused", feedback: "refused", message: "This tag is not linked. Open a record and choose Tap to link." };
      if (alias) {
        const ref = await record(orgId, alias);
        if (mode === "navigate") {
          const { driveHub } = await import("./drive-hub.js");
          return { driven: !!ref.path && driveHub.navigate(caller.userId, orgId, ref.path), kind: "qr", action: "navigate", path: ref.path };
        }
        const { invoke } = await import("./actions.js");
        const answer = await invoke("labels:print", { orgId, userId: caller.userId, entity: ref, event: {
          name: null, payload: {}, actor: { user_id: caller.userId, display_name: null, auth_method: "api_token" },
          timestamp: new Date().toISOString(), trigger_type: "user-invoked",
        } });
        if (!actionActed(answer)) throw new StationRefusal("The label could not be queued.");
        return { driven: false, kind: "qr", action: "print", queued: true, item_id: ref.id };
      }
      return routeScanToDrive({ ...caller, code, disposition: mode });
    },
    async notify(s) {
      const filed = s.actions.filter((a) => a.status === "done" && (a.type === "file" || a.type === "inbox"));
      const places = new Set(filed.map((a) => `${a.after?.container?.kind}:${a.after?.container?.id}`));
      const message = `${s.device_name}: ${filed.length} things filed into ${places.size} places. Review`;
      // OUTSIDE-RECORD-ADDRESS: a station session is an app review page, not an entity record; notification delivery qualifies it for the workspace
      await platform().notifications.dispatch({
        orgId, userId: caller.userId, eventType: "scan.station.review", priority: "normal", message,
        link_url: `/scan/stations/${device.id}/sessions/${s.id}`, idempotencyKey: `scan-station:${s.id}`,
      });
    },
  };
}

export async function withStation<T>(caller: StationCaller, id: string, work: (engine: StationEngine) => Promise<T>): Promise<T> {
  return stationStore.locked(caller.orgId, caller.userId, id, async (device) => work(new StationEngine(device, ports(caller, device))));
}

export async function stationCommand(caller: StationCaller, deviceId: string, type: "write" | "link", url: string): Promise<StationCommand> {
  const control = stationControl(url);
  if (control && type === "link") throw new StationRefusal("Write a control to a tag rather than linking it to a record.");
  const resolved = control ? { ref: { kind: "scan-station:control", id: control, name: control === "navigate" ? "Open" : control } } : await resolveStationCode(caller.orgId, url);
  if (!resolved) throw new StationRefusal("Choose a record’s label link from this workspace.");
  return withStation(caller, deviceId, async (engine) => {
    const old = engine.device.command;
    if (old?.status === "waiting" && Date.parse(old.expires_at) > Date.now()) throw new StationRefusal("Finish or cancel the tag already waiting at this station.");
    const command: StationCommand = { id: randomUUID(), type, target: resolved.ref, url, status: "waiting", expires_at: new Date(Date.now() + 5 * 60_000).toISOString() };
    engine.device.command = command;
    await stationStore.saveDevice(engine.device);
    return command;
  });
}

export async function acknowledgeStationCommand(caller: StationCaller, deviceId: string, commandId: string, code: string, success: boolean): Promise<StationCommand> {
  const uid = nfcUid(`nfc:${code}`);
  if (!uid) throw new StationRefusal("The station did not send a valid tag identifier.");
  return withStation(caller, deviceId, async (engine) => {
    const command = engine.device.command;
    if (!command || command.id !== commandId) throw new StationRefusal("That tag request is no longer waiting.");
    if (command.status !== "waiting") return command;
    if (Date.parse(command.expires_at) <= Date.now()) throw new StationRefusal("That tag request expired. Queue it again from the record.");
    if (success) {
      if (!stationControl(command.url)) await record(caller.orgId, command.target);
      if (command.type === "link") await stationStore.link(caller.orgId, uid, command.target);
    }
    command.status = success ? "done" : "failed";
    command.uid = uid;
    command.message = success ? command.type === "write" ? "Tag written and checked." : "Tag linked." : "The tag could not be written. Try an unlocked tag with more space.";
    const s = await engine.active();
    if (!s.actions.some((a) => a.request_id === command.id)) {
      const at = new Date().toISOString();
      s.actions.push({ id: command.id, request_id: command.id, code: `nfc:${uid}`, at, type: "tag", status: success ? "done" : "refused",
        thing: command.target, context_before: engine.device.context, context_after: engine.device.context, message: command.message });
      s.last_at = at;
      engine.device.last_at = at;
      await stationStore.saveSession(s);
    }
    await stationStore.saveDevice(engine.device);
    return command;
  });
}

export function registerStationSweep(): void {
  platform().sweeps.register({
    name: "scan-stations.idle", everyMs: 60_000,
    async candidates(ids) { return [...new Set((await stationStore.candidates(ids)).map((r) => r.org_id))]; },
    async visit({ orgId }) {
      for (const row of await stationStore.candidates([orgId])) {
        const org = await (await import("../db/meta.js")).meta.selectFrom("orgs").select("slug").where("id", "=", orgId).executeTakeFirst();
        if (!org) continue;
        const caller = { orgId, userId: row.user_id, orgSlug: org.slug, token: "" };
        await withStation(caller, row.id, async (engine) => {
          await engine.expire();
          for (const s of await stationStore.undelivered(row.id)) await engine.digest(s);
        });
      }
    },
  });
}
