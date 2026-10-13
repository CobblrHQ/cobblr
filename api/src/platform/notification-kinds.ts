// The kinds of notification this platform sends, by name: what a person reads
// instead of an id. Modules declare their own (`exposes.notifications` in the
// manifest); the kernel's are listed here; the account catalog
// (notification-catalog.ts) names the account-level ones with their
// preferences. `notificationLabel` reads all three, and every place that
// shows a notification type (the inbox, the Channels page's event picker, the
// audiences page) asks it. lint:notifications-are-named fails a type the code
// sends that none of them names: the inbox used to show "digifab.print.failed"
// and "platform.approval.requested" as the only line under a notification.
import { BRIDGE_NOTIFICATION_KINDS } from "./edge-outages.js";
import { NOTIFICATION_TYPES } from "./notification-catalog.js";
import { listEntries } from "../modules/registry.js";

export interface NotificationKindDecl {
  eventType: string;
  label: string;
  description?: string;
  /** Who it is about. "workspace" (the default): sent within a workspace,
   *  routable per channel. "account": a person's own (notifyAccount, their
   *  preferences decide). "operator": the deployment's own notices. */
  scope?: "workspace" | "account" | "operator";
  /** The group a picker lists it under (default: its first segment). */
  module?: string;
}

/** Sent by the kernel itself. */
export const KERNEL_NOTIFICATION_KINDS: readonly NotificationKindDecl[] = [
  { eventType: "scan.station.review", label: "Station scan review", description: "A scan station finished a session. Review its actions or undo them.", module: "scan" },
  { eventType: "platform.tidy.suggested", label: "Tidy-up suggestions", description: "Up to five overnight suggestions for the things you keep." },
  { eventType: "warranty.ending", label: "Warranty ending", description: "A warranty ends within 30 days.", module: "calendar" },
  ...BRIDGE_NOTIFICATION_KINDS.map((k) => ({ ...k, module: "bridges" })),
  { eventType: "test.notification", label: "Test notification", description: "The one you send yourself to check a channel." },
  { eventType: "platform.approval.requested", label: "Approval requested", description: "Someone asked to do something that needs an owner's or admin's yes." },
  { eventType: "platform.approval.decided", label: "Approval answered", description: "Your request was approved or declined." },
  { eventType: "share.edits.suggested", label: "Edits from someone you share with", description: "Someone you share with suggested edits to your things, or changed them on a share that lets them.", module: "sharing" },
  { eventType: "share.edits.decided", label: "Your suggested edits answered", description: "The person who shared with you accepted, turned down or undid your edits.", module: "sharing" },
  { eventType: "workspace.invited", label: "Invited to a workspace", description: "Someone invited you to their workspace." },
  { eventType: "workspace.join_link_paused", label: "Join link paused", description: "The workspace's join link stopped itself after too many joins at once." },
  { eventType: "platform.invite.accepted", label: "Invite accepted", description: "Someone you invited joined." },
  { eventType: "platform.mail_source.connected", label: "Mailbox connected", description: "A mailbox you connected started bringing receipts in." },
  { eventType: "platform.field.seller_upgrade", label: "Track sellers as a field?", description: "The same seller came up often enough, or through enough places, to be worth a field of its own." },
  { eventType: "platform.mail_source.stopped", label: "Mailbox stopped", description: "A connected mailbox stopped bringing receipts in, and why." },
  { eventType: "core-scan.email.forwarding_verification", scope: "account", label: "Confirm email forwarding", description: "Your mail provider wants you to confirm forwarding to Cobblr." },
  { eventType: "core-scan.email.received", scope: "account", label: "Receipt email received", description: "A receipt you emailed in arrived and is being read." },
  { eventType: "core-scan.email.imported", scope: "account", label: "Receipt imported", description: "The items on a receipt you emailed in are in your scan inbox." },
  { eventType: "core-scan.email.duplicate", scope: "account", label: "Receipt already imported", description: "A receipt you emailed in was one you had already imported." },
  { eventType: "core-scan.email.tracking_added", scope: "account", label: "Tracking added to an order", description: "A shipping notice you forwarded added its tracking number to the order, and which lines are in that parcel." },
  { eventType: "core-scan.email.shipment_unmatched", scope: "account", label: "Tracking number not added", description: "A shipping notice you forwarded named an order Cobblr could not match, so its tracking number was not added." },
  { eventType: "core-scan.email.no_receipt", scope: "account", label: "No receipt in that email", description: "An email you sent in had no receipt Cobblr could read." },
  { eventType: "platform.assistant.change_held", label: "Assistant wants to delete something", description: "An assistant asked to delete a record, and it waits for your yes." },
  { eventType: "platform.service.awaiting_confirm", label: "Service waiting for your yes", description: "An automation or a module asked for a service that runs only once someone says yes." },
  { eventType: "platform.service.stuck", label: "Service run stuck", description: "A service run stopped moving, and what you can do about it." },
  { eventType: "platform.external_messages.replied", label: "Reply to an automation's message", description: "Someone outside the workspace answered an automation's message: they got it, or bought it." },
  { eventType: "platform.external_messages.held", label: "Automation message held", description: "An automation's message to someone outside the workspace was held by the daily limit." },
  { eventType: "platform.service.waiting_long", label: "Service still waiting on you", description: "A service run has waited a long time for your yes or your answer." },
  // The operator's own notices, sent to the deployment's admins.
  { eventType: "platform.account.created", scope: "operator", label: "New account", description: "Somebody signed up (to the deployment's operators)." },
  { eventType: "platform.sandbox.started", scope: "operator", label: "Sandbox started", description: "A visitor started a sandbox (to the deployment's operators)." },
  { eventType: "platform.sandbox.kept", scope: "operator", label: "Sandbox kept", description: "A visitor kept their sandbox (to the deployment's operators)." },
];

type Named = Map<string, { label: string; description: string | null; module: string }>;
let named: Named | null = null;

/** Every named kind this process knows: the kernel's, the account catalog's,
 *  and every loaded module's declarations (enabled or not). Built once the
 *  modules are loaded; they do not change while the process runs. */
function allNamed(): Named {
  if (named) return named;
  const m: Named = new Map();
  for (const k of KERNEL_NOTIFICATION_KINDS) m.set(k.eventType, { label: k.label, description: k.description ?? null, module: k.module ?? k.eventType.split(".")[0] ?? "" });
  for (const t of NOTIFICATION_TYPES) m.set(t.key, { label: t.label, description: t.description, module: "account" });
  for (const e of listEntries()) {
    for (const k of e.manifest.exposes.notifications) m.set(k.eventType, { label: k.label, description: k.description ?? null, module: e.manifest.name });
  }
  if (listEntries().length > 0) named = m;
  return m;
}

/** A notification type's name for a person, or null when nobody named it. */
export function notificationLabel(eventType: string): string | null {
  return allNamed().get(eventType)?.label ?? null;
}

/** The kinds a workspace can be told about, for a picker: the kernel's
 *  workspace-scoped ones and those of the modules it has on.
 *  - "channels" (which kinds a channel binding is for): every one.
 *  - "audience" (who in the workspace is told): not the platform's own
 *    (an approval request narrowed to nobody could never be answered), and
 *    not the test notification. */
export function notificationKindsFor(
  enabledModules: ReadonlySet<string>,
  purpose: "channels" | "audience" = "channels",
): Array<{ event_type: string; label: string; description: string | null; module: string; group: string }> {
  // `group` is what a picker titles a set of kinds with: the module's own
  // name, never its id.
  const out = new Map<string, { label: string; description: string | null; module: string; group: string }>();
  for (const k of KERNEL_NOTIFICATION_KINDS) {
    if ((k.scope ?? "workspace") !== "workspace") continue;
    if (purpose === "audience" && (k.eventType.startsWith("platform.") || k.eventType.startsWith("test."))) continue;
    const module = k.module ?? k.eventType.split(".")[0] ?? "";
    out.set(k.eventType, { label: k.label, description: k.description ?? null, module, group: module === "bridges" ? "Bridges" : "Your workspace" });
  }
  for (const e of listEntries()) {
    if (!enabledModules.has(e.manifest.name)) continue;
    for (const k of e.manifest.exposes.notifications) {
      out.set(k.eventType, { label: k.label, description: k.description ?? null, module: e.manifest.name, group: e.manifest.displayName });
    }
  }
  return [...out.entries()]
    .map(([event_type, d]) => ({ event_type, ...d }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
}
