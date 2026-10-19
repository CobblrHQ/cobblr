// "Download my data": a person's own copy of what Cobblr holds about them,
// whatever their role anywhere (#4185).
//
// A workspace backup is the workspace's (owners and admins, the whole thing).
// This is the person's: their profile and preferences, the workspaces they
// belong to and as what, their API tokens and connections (what they are,
// never the secret), their notification settings, the actions they took, and
// the feedback they sent. Records inside a workspace belong to the workspace
// and stay with its backup; the file names the workspaces they own and where
// to take that backup.
//
// Every file is built from a column ALLOWLIST, never "every column minus the
// secret ones": a column added to a table later stays out of the file until
// somebody decides it belongs, so a new secret can never leak by default.
//
// Asked for, it builds in the background (202), is kept for seven days, and
// only its owner can fetch it. One a day.
import { ZipArchive } from "archiver";
import { meta } from "../db/meta.js";
import { log as logActivity } from "./activity.js";
import { sendAuthEmail } from "./hosted-seams.js";
import { productName } from "./product-name.js";

export const PERSONAL_EXPORT_DAYS = 7;
const ONE_PER_MS = 24 * 3_600_000;
/** A build that has not finished in this long died with its process. */
const STALE_BUILD_MS = 15 * 60_000;

export type ExportRequest =
  | { ok: true; id: string; status: "building" }
  | { ok: false; reason: "too_soon"; retryAt: Date };

/** The files, each from its allowlist. Exported for the test that plants a
 *  secret and looks for it. */
export async function personalExportFiles(userId: string): Promise<Record<string, string>> {
  const user = await meta
    .selectFrom("users")
    .select(["id", "email", "display_name", "created_at", "last_login_at", "email_verified_at", "theme_pref", "nav_pref", "title_pref"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  const memberships = await meta
    .selectFrom("org_memberships as m")
    .innerJoin("orgs as o", "o.id", "m.org_id")
    .select(["o.name", "o.slug", "m.role", "m.joined_at"])
    .where("m.user_id", "=", userId)
    .orderBy("m.joined_at")
    .execute();
  const tokens = await meta
    .selectFrom("api_tokens")
    .select(["name", "token_prefix", "scopes", "created_at", "last_used_at", "expires_at", "revoked_at"])
    .where("user_id", "=", userId)
    .orderBy("created_at")
    .execute();
  const connections = await meta
    .selectFrom("user_credentials")
    .select(["kind", "provider_id", "label", "route_mode", "created_at", "updated_at"])
    .where("user_id", "=", userId)
    .orderBy("created_at")
    .execute();
  const subscriptions = await meta
    .selectFrom("notification_subscriptions as s")
    .innerJoin("orgs as o", "o.id", "s.org_id")
    .select(["o.slug as workspace", "s.event_type", "s.channel", "s.enabled", "s.min_priority"])
    .where("s.user_id", "=", userId)
    .execute();
  const accountPrefs = await meta
    .selectFrom("notification_account_prefs")
    .select(["notification_type", "channel", "enabled", "updated_at"])
    .where("user_id", "=", userId)
    .execute();
  const windows = await meta
    .selectFrom("notification_delivery_windows")
    .select(["channel", "mode", "deliver_at_minute", "timezone", "schedule_mode", "schedule_deliver_at_minute"])
    .where("user_id", "=", userId)
    .execute();
  const activity = await meta
    .selectFrom("activity_log as a")
    .leftJoin("orgs as o", "o.id", "a.org_id")
    .select(["a.occurred_at", "o.slug as workspace", "a.action", "a.module_name", "a.entity_type", "a.entity_id", "a.diff"])
    .where("a.user_id", "=", userId)
    .orderBy("a.occurred_at")
    .execute();
  const feedback = await meta
    .selectFrom("feedback")
    .select(["type", "message", "status", "created_at"])
    .where("user_id", "=", userId)
    .orderBy("created_at")
    .execute();

  const owned = memberships.filter((m) => m.role === "owner");
  const json = (v: unknown) => JSON.stringify(v, null, 2);
  const readme =
    `Your ${productName()} data, for ${user.email}, made ${new Date().toISOString()}.\n\n` +
    `account.json        your profile and preferences\n` +
    `workspaces.json     the ${memberships.length} workspace(s) you belong to, and your role in each\n` +
    `tokens.json         your API tokens: name, scopes and dates (never the token itself)\n` +
    `connections.json    your connections: provider and label (never the key)\n` +
    `notifications.json  what you are told about, where, and when\n` +
    `activity.jsonl      the ${activity.length} action(s) you took, one per line\n` +
    `feedback.json       the ${feedback.length} message(s) you sent us\n\n` +
    (owned.length
      ? `The records inside a workspace belong to the workspace. You own ${owned.length}; take each one's\n` +
        `backup from its Backup page (Configuration, Backup):\n\n` +
        // PATH-OK: the README names the Backup page in words beside the path; it is read next to the app
        owned.map((m) => `  ${m.name}: /w/${m.slug}/configuration/backup`).join("\n") +
        "\n"
      : `The records inside a workspace belong to the workspace, and its owners can back it up.\n`);
  return {
    "README.txt": readme,
    "account.json": json(user),
    // PATH-OK: data in workspaces.json, a path inside the app for a reader who knows the instance
    "workspaces.json": json(memberships.map((m) => ({ ...m, backup: m.role === "owner" ? `/w/${m.slug}/configuration/backup` : null }))),
    "tokens.json": json(tokens),
    "connections.json": json(connections),
    "notifications.json": json({ per_workspace: subscriptions, account: accountPrefs, delivery_windows: windows }),
    "activity.jsonl": activity.map((a) => JSON.stringify(a)).join("\n"),
    "feedback.json": json(feedback),
  };
}

async function zip(files: Record<string, string>): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", resolve);
    archive.on("error", reject);
  });
  for (const [name, body] of Object.entries(files)) archive.append(body, { name });
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

/** Ask for one. Builds in the background; the caller answers 202. */
export async function requestPersonalExport(userId: string, opts: { origin: string; now?: number }): Promise<ExportRequest> {
  const now = opts.now ?? Date.now();
  const last = await meta
    .selectFrom("personal_exports")
    .select(["created_at", "status"])
    .where("user_id", "=", userId)
    .where("status", "!=", "failed")
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  if (last && now - last.created_at.getTime() < ONE_PER_MS) {
    return { ok: false, reason: "too_soon", retryAt: new Date(last.created_at.getTime() + ONE_PER_MS) };
  }
  const row = await meta
    .insertInto("personal_exports")
    .values({ user_id: userId, expires_at: new Date(now + PERSONAL_EXPORT_DAYS * 86_400_000) })
    .returning("id")
    .executeTakeFirstOrThrow();
  const first = await meta.selectFrom("org_memberships").select("org_id").where("user_id", "=", userId).limit(1).executeTakeFirst();
  if (first) {
    await logActivity({ orgId: first.org_id, userId, action: "personal_export_requested", ref: { module: null, entityType: "user", entityId: userId }, diff: {} }).catch(() => undefined);
  }
  void buildPersonalExport(row.id, userId, opts.origin);
  return { ok: true, id: row.id, status: "building" };
}

async function buildPersonalExport(id: string, userId: string, origin: string): Promise<void> {
  try {
    const bytes = await zip(await personalExportFiles(userId));
    await meta.updateTable("personal_exports").set({ status: "ready", bytes, size_bytes: bytes.length, ready_at: new Date() }).where("id", "=", id).execute();
    const user = await meta.selectFrom("users").select("email").where("id", "=", userId).executeTakeFirst();
    if (user) {
      await sendAuthEmail({
        to: user.email,
        subject: `Your ${productName()} data is ready`,
        text:
          `The copy of your ${productName()} data you asked for is ready. Sign in and download it from your account:\n\n` +
          // PATH-OK: after the instance's own address, which the caller gives from linkOrigin(req)
          `${origin}/me/identity\n\nIt is kept for ${PERSONAL_EXPORT_DAYS} days. If you did not ask for it, change your password.`,
        kind: "notification",
      });
    }
  } catch (err) {
    console.error(`[personal-export] ${id} failed:`, (err as Error).message);
    await meta.updateTable("personal_exports").set({ status: "failed", error: (err as Error).message.slice(0, 500) }).where("id", "=", id).execute();
  }
}

export interface ExportSummary {
  id: string;
  status: "building" | "ready" | "failed";
  created_at: string;
  ready_at: string | null;
  expires_at: string;
  size_bytes: number | null;
}

/** This person's exports that are still kept, newest first. A build that died
 *  with its process reads as failed, so asking again is never blocked by it. */
export async function personalExportsOf(userId: string, now: number = Date.now()): Promise<ExportSummary[]> {
  const rows = await meta
    .selectFrom("personal_exports")
    .select(["id", "status", "created_at", "ready_at", "expires_at", "size_bytes"])
    .where("user_id", "=", userId)
    .where("expires_at", ">", new Date(now))
    .orderBy("created_at", "desc")
    .execute();
  const stale = rows.filter((r) => r.status === "building" && now - r.created_at.getTime() > STALE_BUILD_MS).map((r) => r.id);
  if (stale.length) await meta.updateTable("personal_exports").set({ status: "failed", error: "stopped" }).where("id", "in", stale).execute();
  return rows.map((r) => ({
    id: r.id,
    status: stale.includes(r.id) ? "failed" : r.status,
    created_at: r.created_at.toISOString(),
    ready_at: r.ready_at?.toISOString() ?? null,
    expires_at: r.expires_at.toISOString(),
    size_bytes: r.size_bytes,
  }));
}

/** The file, for its owner only. Anyone else, or after seven days: null. */
export async function personalExportFile(id: string, userId: string, now: number = Date.now()): Promise<Buffer | null> {
  const row = await meta
    .selectFrom("personal_exports")
    .select(["bytes", "status"])
    .where("id", "=", id)
    .where("user_id", "=", userId)
    .where("expires_at", ">", new Date(now))
    .executeTakeFirst();
  return row?.status === "ready" && row.bytes ? row.bytes : null;
}
