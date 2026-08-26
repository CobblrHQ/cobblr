// The platform-operator console's sections — shared between the shell nav
// (AdminLayout) and the routed content dispatcher (AdminConsole). Each id is a
// URL segment: /admin/<id>. Keep this list as the single source of truth.

import {
  Activity,
  Gauge,
  Barcode,
  KeyRound,
  Boxes,
  FlaskConical,
  HeartPulse,
  Sparkles,
  LayoutGrid,
  Server,
  ShoppingBag,
  Users,
  UserPlus,
  ClipboardList,
  MessageSquare,
  Megaphone,
  Eye,
  ScanLine,
} from "lucide-react";

export type AdminSectionId =
  | "overview"
  | "workspaces"
  | "users"
  | "invites"
  | "waitlist"
  | "feedback"
  | "announce"
  | "modules"
  | "marketplace"
  | "activity"
  | "metrics"
  | "ai"
  | "barcodes"
  | "tokens"
  | "scaneval"
  | "scan-resolvers"
  | "impersonation"
  | "health";

/** Cluster labels for the operator nav (B5) — 18 flat tabs were unscannable.
 *  `overview` stays ungrouped at the front; everything else renders in these
 *  labeled clusters, in this order. */
export type AdminGroup = "workspaces" | "community" | "platform" | "ai & scan" | "ops";
export const ADMIN_GROUP_ORDER: AdminGroup[] = ["workspaces", "community", "platform", "ai & scan", "ops"];

export const ADMIN_SECTIONS: Array<{
  id: AdminSectionId;
  label: string;
  /** One line under the page title: what this section is FOR. Drawn by
   *  AdminLayout's shared header — pages never write their own (the two that
   *  did used two different styles and both restated the rail label). */
  description: string;
  icon: typeof Server;
  group?: AdminGroup;
}> = [
  { id: "overview", label: "Overview", description: "The instance at a glance - the counts that answer where to act next.", icon: Server },
  { id: "workspaces", label: "Workspaces", description: "Every workspace on this instance: plan, activity, and the operator switches.", icon: LayoutGrid, group: "workspaces" },
  { id: "users", label: "Users", description: "Every account across all workspaces - search, verify, unblock.", icon: Users, group: "workspaces" },
  { id: "invites", label: "Invites", description: "Mint and track the single-use signup links.", icon: UserPlus, group: "workspaces" },
  { id: "waitlist", label: "Waitlist", description: "Approve or dismiss signups from the marketing site.", icon: ClipboardList, group: "workspaces" },
  { id: "feedback", label: "Feedback", description: "Every report from every workspace - triage, reply, resolve.", icon: MessageSquare, group: "community" },
  { id: "announce", label: "Announcements", description: "Post a platform announcement to the community channels.", icon: Megaphone, group: "community" },
  { id: "modules", label: "Modules", description: "What this instance has loaded, and each module's version.", icon: Boxes, group: "platform" },
  { id: "marketplace", label: "Marketplace", description: "Sandboxed modules available to install at runtime.", icon: ShoppingBag, group: "platform" },
  { id: "activity", label: "Activity", description: "The cross-tenant audit trail: who did what, where, and when.", icon: Activity, group: "ops" },
  { id: "metrics", label: "Product Metrics", description: "What actually gets used, across the whole instance.", icon: Gauge, group: "ops" },
  { id: "ai", label: "AI", description: "Every AI call the platform made - cost, latency, and what was sent.", icon: Sparkles, group: "ai & scan" },
  { id: "barcodes", label: "Barcodes", description: "The barcode cache and its providers: what resolved, what missed.", icon: Barcode, group: "ai & scan" },
  { id: "tokens", label: "Tokens", description: "Restricted, deny-by-default tokens for daemons and bots.", icon: KeyRound, group: "platform" },
  { id: "scaneval", label: "Scan Eval", description: "Score the scanner's prompts against captured real cases.", icon: FlaskConical, group: "ai & scan" },
  { id: "scan-resolvers", label: "Scan Resolvers", description: "The vendor list the scanner consults: maker URLs matched, fetched and mapped to a product, no code per vendor.", icon: ScanLine, group: "ai & scan" },
  { id: "impersonation", label: "View-as Log", description: "Every view-as session an operator opened - the log the feature requires.", icon: Eye, group: "ops" },
  { id: "health", label: "Health", description: "Probes, queues and versions: is the instance healthy right now.", icon: HeartPulse, group: "ops" },
];

export const ADMIN_SECTION_IDS = ADMIN_SECTIONS.map((s) => s.id);

export function isAdminSection(x: string | undefined): x is AdminSectionId {
  return !!x && (ADMIN_SECTION_IDS as string[]).includes(x);
}
