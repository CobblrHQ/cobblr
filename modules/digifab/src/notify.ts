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

export type PrintNotifyKind = "started" | "progress" | "completed" | "failed";

const COLOR: Record<PrintNotifyKind, number> = {
  started: 0x5865f2, // blurple
  progress: 0x4f86c6, // blue
  completed: 0x2ecc71, // green
  failed: 0xe74c3c, // red
};
const VERB: Record<PrintNotifyKind, string> = {
  started: "🖨️ Printing",
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
  const title = `${VERB[o.kind]} · ${o.fileRef}${o.device ? ` · ${o.device}` : ""}`.slice(0, 256);
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
  await Promise.all(
    members.map((userId) =>
      platform()
        .notifications.dispatch({
          orgId,
          userId,
          eventType,
          message: title,
          link_url: "/configuration/farm",
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
