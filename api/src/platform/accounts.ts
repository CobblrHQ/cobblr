// The ONE place an account row is born, so "somebody signed up" reaches the
// operator however they arrived.
//
// The nearest existing event, platform.invite.accepted, looks like the one to
// bind a Discord channel to and is a trap: it fires only when there IS an
// inviter. Open signup, a managed-app signup, a sign-in link, a central
// identity landing and a sandbox at a booth all emit it never, so a binding
// built on it misses most accounts while appearing to work (#1815). The first
// cut of this put the notice beside two of the inserts and asserted their
// count; by the time it was rebased the tree had seven doors, and the count
// caught it. A count that has to be kept in step is a door waiting to be
// missed, so every door now goes through createAccount(), which inserts the
// row and announces it, and api/tests holds `insertInto("users")` to this
// file alone.
//
// Who receives it: the OPERATOR, not the tenant. dispatch() is org+user
// scoped, right for "your print finished" and useless here, since the new
// account's own workspace is the one place this is not news. So the notice
// fans to every address in SUPERADMIN_EMAILS under each admin's first
// workspace (the rule the invite path already uses), and from there routes
// through the ordinary channel bindings: Me, Notification channels, bind
// platform.account.created, Discord, a #signups webhook. Nothing hardcoded
// for one deployment.
//
// A notice must never fail the signup it reports: it is fire-and-forget with
// its own catch, per admin, and no SUPERADMIN_EMAILS is a clean no-op.
//
// A sandbox is different, and deliberately on other event types. Its row is
// minted ahead of a visitor (inventory, never news), and at a booth every
// person who stops walking starts one: fifty visitors would be fifty notices
// burying the one signal that matters. So a hand-over says
// platform.sandbox.started (bind it for a pulse, or leave it), and the doors
// OUT of the sandbox (#3254: keep it, start fresh for real, convert it) are
// the moments worth interrupting somebody for: platform.sandbox.kept carries
// the door it came through, and the other two doors announce on it as they
// are built.
import type { Insertable, Kysely, Transaction } from "kysely";
import type { MetaDB, UsersTable } from "../db/schema.js";
import { notifyPlatformAdmins } from "./notifications.js";

/** The doors an account comes in through. Each is a fact the operator can
 *  read ("via an invite"), and a rule about whether it is news yet. */
export type AccountDoor =
  /** The signup form: open, by invite, or as a managed app. */
  | { via: "signup"; how?: "invite" | "app" | "open"; app?: string }
  /** A workspace invite accepted by somebody with no account yet. */
  | { via: "invite" }
  /** A sign-in link on an open deployment (or the operator's own bootstrap). */
  | { via: "magic-link" }
  /** A central identity landing here for the first time. */
  | { via: "identity" }
  /** The instance's own OIDC provider, when its operator lets it make accounts. */
  | { via: "oidc"; provider: string }
  /** A sandbox row, made ahead of a visitor: never platform.account.created.
   *  The hand-over says platform.sandbox.started (announceSandboxStarted),
   *  and a door out of it says platform.sandbox.kept. */
  | { via: "sandbox" }
  /** An admin minting a user by hand inside their workspace. */
  | { via: "admin"; byUserId: string }
  /** CI's pool of ready-made workspaces: never news. */
  | { via: "pool" };

export type UserInsert = Insertable<UsersTable>;

const said = (door: AccountDoor): string => {
  switch (door.via) {
    case "signup":
      return door.how === "invite" ? " via an invite" : door.how === "app" ? ` via the ${door.app ?? "app"} app` : "";
    case "invite":
      return " by accepting a workspace invite";
    case "magic-link":
      return " via a sign-in link";
    case "identity":
      return " via a central identity";
    case "oidc":
      return ` via ${door.provider}`;
    case "admin":
      return ", added by a workspace admin";
    default:
      return "";
  }
};

/** Doors whose row IS the arrival. A sandbox has its own, quieter events,
 *  and the CI pool never announces. */
const ANNOUNCED_AT_BIRTH = new Set<AccountDoor["via"]>(["signup", "invite", "magic-link", "identity", "oidc", "admin"]);

/** Tell the operator. Never throws. */
export function announceAccountCreated(p: { email: string; displayName: string; door: AccountDoor; slug?: string }): void {
  const where = p.slug ? ` (${p.slug})` : "";
  void notifyPlatformAdmins({
    eventType: "platform.account.created",
    message: `${p.displayName} (${p.email}) signed up${said(p.door)}${where}.`,
    // PAGE-LINK: the operator's account list, where a new account is acted on.
    link_url: "/admin/users",
    payload: { email: p.email, display_name: p.displayName, via: p.door.via, ...(p.slug ? { slug: p.slug } : {}) },
  }).catch((err) => console.error("[accounts] account-created notice failed:", (err as Error)?.message ?? err));
}

/** A sandbox handed to a visitor: somebody arrived, which at a booth is
 *  everybody who stops walking. Its own event, so it can be bound apart from
 *  real signups or left unbound. */
export function announceSandboxStarted(p: { slug: string }): void {
  void notifyPlatformAdmins({
    eventType: "platform.sandbox.started",
    message: `A visitor started a sandbox (${p.slug}).`,
    // PAGE-LINK: the operator's workspace list, where a sandbox is seen and acted on.
    link_url: "/admin/workspaces",
    payload: { via: "sandbox", door: "started", slug: p.slug },
  }).catch((err) => console.error("[accounts] sandbox notice failed:", (err as Error)?.message ?? err));
}

/** A door out of a sandbox: the visitor decided something. `door` says which
 *  of the three (#3254); only "keep" exists in code today. */
export function announceSandboxKept(p: { email: string; slug: string; days: number; door?: "keep" | "fresh" | "convert" }): void {
  const door = p.door ?? "keep";
  void notifyPlatformAdmins({
    eventType: "platform.sandbox.kept",
    message: `${p.email} kept their sandbox (${p.slug}) for ${p.days} day${p.days === 1 ? "" : "s"}.`,
    // PAGE-LINK: the workspace list is where the operator sees the kept
    // trial; the admin console has no per-workspace page to open.
    link_url: "/admin/workspaces",
    payload: { email: p.email, slug: p.slug, days: p.days, door },
  }).catch((err) => console.error("[accounts] sandbox-kept notice failed:", (err as Error)?.message ?? err));
}

/** Insert the account row and, for a door whose row is the arrival, tell the
 *  operator. `db` is the meta connection or a transaction on it, so a door
 *  that creates the membership in the same transaction keeps doing so. */
export async function createAccount(db: Kysely<MetaDB> | Transaction<MetaDB>, values: UserInsert, door: AccountDoor): Promise<string> {
  const row = await db.insertInto("users").values(values).returning("id").executeTakeFirstOrThrow();
  if (ANNOUNCED_AT_BIRTH.has(door.via)) announceAccountCreated({ email: values.email, displayName: values.display_name, door });
  return row.id;
}
