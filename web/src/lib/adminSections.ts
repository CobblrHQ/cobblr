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
  icon: typeof Server;
  group?: AdminGroup;
}> = [
  { id: "overview", label: "Overview", icon: Server },
  { id: "workspaces", label: "Workspaces", icon: LayoutGrid, group: "workspaces" },
  { id: "users", label: "Users", icon: Users, group: "workspaces" },
  { id: "invites", label: "Invites", icon: UserPlus, group: "workspaces" },
  { id: "waitlist", label: "Waitlist", icon: ClipboardList, group: "workspaces" },
  { id: "feedback", label: "Feedback", icon: MessageSquare, group: "community" },
  { id: "announce", label: "Announcements", icon: Megaphone, group: "community" },
  { id: "modules", label: "Modules", icon: Boxes, group: "platform" },
  { id: "marketplace", label: "Marketplace", icon: ShoppingBag, group: "platform" },
  { id: "activity", label: "Activity", icon: Activity, group: "ops" },
  { id: "metrics", label: "Product Metrics", icon: Gauge, group: "ops" },
  { id: "ai", label: "AI", icon: Sparkles, group: "ai & scan" },
  { id: "barcodes", label: "Barcodes", icon: Barcode, group: "ai & scan" },
  { id: "tokens", label: "Tokens", icon: KeyRound, group: "platform" },
  { id: "scaneval", label: "Scan Eval", icon: FlaskConical, group: "ai & scan" },
  { id: "scan-resolvers", label: "Scan Resolvers", icon: ScanLine, group: "ai & scan" },
  { id: "impersonation", label: "View-as Log", icon: Eye, group: "ops" },
  { id: "health", label: "Health", icon: HeartPulse, group: "ops" },
];

export const ADMIN_SECTION_IDS = ADMIN_SECTIONS.map((s) => s.id);

export function isAdminSection(x: string | undefined): x is AdminSectionId {
  return !!x && (ADMIN_SECTION_IDS as string[]).includes(x);
}
