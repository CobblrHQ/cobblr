// The platform-operator console's sections — shared between the shell nav
// (AdminLayout) and the routed content dispatcher (AdminConsole). Each id is a
// URL segment: /admin/<id>. Keep this list as the single source of truth.

import {
  Activity,
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
  | "ai"
  | "barcodes"
  | "tokens"
  | "scaneval"
  | "scan-resolvers"
  | "impersonation"
  | "health";

export const ADMIN_SECTIONS: Array<{
  id: AdminSectionId;
  label: string;
  icon: typeof Server;
}> = [
  { id: "overview", label: "Overview", icon: Server },
  { id: "workspaces", label: "Workspaces", icon: LayoutGrid },
  { id: "users", label: "Users", icon: Users },
  { id: "invites", label: "Invites", icon: UserPlus },
  { id: "waitlist", label: "Waitlist", icon: ClipboardList },
  { id: "feedback", label: "Feedback", icon: MessageSquare },
  { id: "announce", label: "Announcements", icon: Megaphone },
  { id: "modules", label: "Modules", icon: Boxes },
  { id: "marketplace", label: "Marketplace", icon: ShoppingBag },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "ai", label: "AI", icon: Sparkles },
  { id: "barcodes", label: "Barcodes", icon: Barcode },
  { id: "tokens", label: "Tokens", icon: KeyRound },
  { id: "scaneval", label: "Scan Eval", icon: FlaskConical },
  { id: "scan-resolvers", label: "Scan Resolvers", icon: ScanLine },
  { id: "impersonation", label: "View-as Log", icon: Eye },
  { id: "health", label: "Health", icon: HeartPulse },
];

export const ADMIN_SECTION_IDS = ADMIN_SECTIONS.map((s) => s.id);

export function isAdminSection(x: string | undefined): x is AdminSectionId {
  return !!x && (ADMIN_SECTION_IDS as string[]).includes(x);
}
