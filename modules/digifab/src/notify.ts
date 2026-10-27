// Print-lifecycle notifications — the "post updates to Discord as a print runs"
// flow (the OctoEverywhere experience, done better). digifab fires these through
// the platform dispatcher, which fans out to each org member's enabled channels
// (in-app always; Discord/email when the user configures a subscription). A user
// routes `digifab.print.*` to a Discord server webhook at /me/notification-channels.
//
// For Discord we attach a RICH embed (title + colour + Progress/Remaining/Elapsed
// /Filament fields) and, when the printer has a camera URL, the live webcam
// SNAPSHOT image + a "Live view" link — one post that beats two side-by-side
// plugins. The plain `message` is what in-app / email show.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "./db.js";

export type PrintNotifyKind = "started" | "progress" | "completed" | "failed";

const COLOR: Record<PrintNotifyKind, number> = {
  started: 0x5865f2, // blurple
  progress: 0x4f86c6, // blue
  completed: 0x2ecc71, // green
  failed: 0xe74c3c, // red
};
const VERB: Record<PrintNotifyKind, string> = {
  started: "🖨️ Started",
  progress: "🖨️ Printing",
  completed: "✅ Finished",
  failed: "❌ Print failed",
};

function fmtDur(sec?: number | null): string | null {
  if (sec == null || sec < 0) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export async function notifyPrint(
  orgId: string,
  o: {
    kind: PrintNotifyKind;
    jobId: string;
    fileRef: string;
    device?: string | null;
    cameraUrl?: string | null;
    progress?: number | null; // 0..1
    etaSec?: number | null;
    elapsedSec?: number | null;
    gramsUsed?: number | null;
    error?: string | null;
  },
): Promise<void> {
  let machineName = o.device;
  try {
    const db = await platform().tenants.getDb(orgId) as Kysely<DigifabDB>;
    const job = await db.selectFrom("digifab_jobs").select(["linked_machine_id", "connection_id"]).where("id", "=", o.jobId).executeTakeFirst();
    const link = job?.connection_id && o.device
      ? await db.selectFrom("digifab_device_links").select(["machine_id", "machine_label"])
        .where("connection_id", "=", job.connection_id).where("remote_device_id", "=", o.device).executeTakeFirst()
      : null;
    const id = job?.linked_machine_id ?? link?.machine_id;
    const machine = id ? await platform().entities.lookup(orgId, "machines:machine", id) : null;
    // An unlinked printer is named as the fleet shows it, never by the
    // manager's device id ("p2", #8647).
    const listed = !machine?.title && !link?.machine_label && job?.connection_id && o.device
      ? await db.selectFrom("digifab_fleet_device_cache").select("devices").where("connection_id", "=", job.connection_id).executeTakeFirst()
      : null;
    const devices = typeof listed?.devices === "string" ? JSON.parse(listed.devices) : listed?.devices;
    const fleetName = Array.isArray(devices) ? (devices as Array<{ id?: unknown; name?: unknown }>).find((d) => d.id === o.device)?.name : null;
    machineName = machine?.title || link?.machine_label || (typeof fleetName === "string" && fleetName.trim() ? fleetName : o.device);
  } catch {
    // A name lookup must not suppress an update about the print itself.
  }
  // A milestone says how far along it is, so 25, 50 and 75 % are three different lines, not one repeated.
  const howFar = o.kind === "progress" && o.progress != null ? ` ${Math.round(o.progress * 100)}%` : "";
  const title = `${VERB[o.kind]}${howFar} · ${o.fileRef}${machineName ? ` · ${machineName}` : ""}`.slice(0, 256);
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  if (o.progress != null) fields.push({ name: "Progress", value: `${Math.round(o.progress * 100)}%` });
  const eta = fmtDur(o.etaSec);
  if (eta && o.kind !== "completed" && o.kind !== "failed") fields.push({ name: "Remaining", value: eta });
  const elapsed = fmtDur(o.elapsedSec);
  if (elapsed) fields.push({ name: "Elapsed", value: elapsed });
  if (o.gramsUsed) fields.push({ name: "Filament", value: `${o.gramsUsed} g` });
  if (o.kind === "failed" && o.error) fields.push({ name: "Error", value: o.error.slice(0, 300), inline: false });

  const links = o.cameraUrl ? [{ label: "📷 Live view", url: o.cameraUrl }] : undefined;
  const payload = {
    links,
    embed: {
      title,
      color: COLOR[o.kind],
      fields,
      ...(o.cameraUrl ? { image_url: o.cameraUrl } : {}),
    },
  };

  const eventType = `digifab.print.${o.kind}`;
  const members = await platform().notifications.orgMemberIds(orgId).catch(() => [] as string[]);
  // The job's own detail (its kind's detailRoute), in the workspace it is in.
  const link = await platform().entities.recordAddressForEntity(orgId, "digifab:job", o.jobId).catch(() => undefined);
  await Promise.all(
    members.map((userId) =>
      platform()
        .notifications.dispatch({
          orgId,
          userId,
          eventType,
          message: title,
          ...(link ? { link_url: link } : { no_link_reason: "the job's workspace address could not be read" }),
          module: "digifab",
          entityType: "digifab:job",
          entityId: o.jobId,
          payload,
        })
        .catch(() => {}),
    ),
  );
}

/** 25%/50%/75% milestone bucket from a 0..1 progress (0 below 25%, 3 at 75%+). */
export function progressBucket(p: number | null | undefined): number {
  return Math.floor(Math.min(0.999, Math.max(0, p ?? 0)) * 4);
}
