// The ONE registry of workspace-configuration destinations — consumed by the
// /configuration hub (tiles) AND the ConfigurationLayout sidebar, so the two
// can never drift. Mirrors the adminSections.ts pattern.
//
// 2026-07 settings rework (the author: "a disorganized trash heap even I can't
// navigate"): six audience-first groups replace the old five concept-muddled
// ones (Backup/QR/Edge lived under "customize your data"); every entry carries
// search `keywords` (synonyms the label doesn't say — "roles" must find
// Permissions); modal launchers are addressed by `modal` and deep-linked as
// /configuration?open=<modal> so the sidebar (and anyone's bookmarks) can
// reach them.

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Boxes,
  Cable,
  CopyPlus,
  FileArchive,
  FileText,
  Files,
  FolderPlus,
  Globe,
  HeartPulse,
  KeyRound,
  LayoutGrid,
  LayoutList,
  Library,
  Link2,
  ListTodo,
  MapPin,
  MousePointerClick,
  Package,
  Plug,
  Printer,
  QrCode,
  Ruler,
  Shield,
  Sliders,
  Sparkles,
  Tag,
  Users,
  Wrench,
} from "lucide-react";

export type ConfigGroup = "setup" | "data" | "access" | "automation" | "devices" | "system";

export interface ConfigDestination {
  label: string;
  description: string;
  icon: LucideIcon;
  /** Route target. Entries OUTSIDE /configuration/* (e.g. /views) still list
   *  here — the sidebar links out to them. */
  to?: string;
  /** Modal launcher id — rendered by the hub; the sidebar links to
   *  /configuration?open=<modal> so modals are deep-linkable. */
  modal?: "new-thing" | "modules" | "members";
  group: ConfigGroup;
  /** Search synonyms the label/description don't already contain. */
  keywords?: string[];
  /** Everyday tile — shown on the hub before "Show advanced settings". */
  primary?: boolean;
}

export const CONFIG_GROUPS: Record<ConfigGroup, { label: string; blurb: string }> = {
  setup: { label: "set up", blurb: "What this workspace is made of" },
  data: { label: "your data", blurb: "Shape the records — fields, views, vocabulary" },
  access: { label: "people & sharing", blurb: "Who gets in and what they see" },
  automation: { label: "automation & AI", blurb: "Things that happen on their own" },
  devices: { label: "machines & devices", blurb: "Bridges to the physical world" },
  system: { label: "safety & system", blurb: "Backups, audit, diagnostics" },
};
export const CONFIG_GROUP_ORDER: ConfigGroup[] = [
  "setup",
  "data",
  "access",
  "automation",
  "devices",
  "system",
];

/** Hosted-overlay panels still declare the pre-2026-07 group ids — map them
 *  onto the six new groups so the overlay needs no lockstep release. */
export const LEGACY_GROUP_MAP: Record<string, ConfigGroup> = {
  modules: "setup",
  data: "data",
  access: "access",
  extend: "automation",
  admin: "system",
};

export const CONFIG_DESTINATIONS: ConfigDestination[] = [
  // ── set up ────────────────────────────────────────────────────────
  {
    group: "setup",
    icon: FolderPlus,
    label: "+ New thing in workspace",
    description:
      "Add a new top-level entity to your workspace. Pick whether it's a sub-category of something existing or its own separate thing.",
    modal: "new-thing",
    keywords: ["add", "create", "instance", "category", "tracker"],
    primary: true,
  },
  {
    group: "setup",
    icon: Boxes,
    label: "Modules",
    description: "Enable / disable modules and their specialisations for this workspace.",
    modal: "modules",
    keywords: ["enable", "disable", "install", "features"],
    primary: true,
  },
  {
    group: "setup",
    icon: Package,
    label: "Bundles",
    description:
      "One-click presets that ship a set of custom fields and wires. Browse the featured catalog, paste a manifest, or export your own.",
    to: "/bundles",
    keywords: ["presets", "recipes", "trackers", "skins", "marketplace"],
    primary: true,
  },
  // ── your data ─────────────────────────────────────────────────────
  {
    group: "data",
    icon: Sliders,
    label: "Custom fields",
    description:
      "Per-entity-kind custom field defs — text, number, date, url, dropdown choices, or computed (a read-only {{ }} template over the entity's fields + related data).",
    to: "/fields",
    keywords: ["columns", "attributes", "schema", "computed"],
    primary: true,
  },
  {
    group: "data",
    icon: LayoutList,
    label: "Form builder",
    description:
      "Visually drag your custom fields into order and group them under section headings (Specs, Purchase info…). The layout shows on every create/edit form.",
    to: "/configuration/form-builder",
    keywords: ["layout", "sections", "edit form"],
    primary: true,
  },
  {
    group: "data",
    icon: LayoutList,
    label: "Saved views",
    description:
      "List / table / kanban views over your entities. Saved here, renderable from the dashboard, publishable as public surfaces.",
    to: "/views",
    keywords: ["kanban", "table", "list", "filters"],
    primary: true,
  },
  {
    group: "data",
    icon: Tag,
    label: "Tags",
    description:
      "Cross-cutting labels you can attach to anything. Filter by tag in saved views or searches.",
    to: "/tags",
    primary: true,
  },
  {
    group: "data",
    icon: MapPin,
    label: "Locations",
    description:
      "Hierarchical tree of physical places — rooms, shelves, bins. Everything tangible (machines, assets, parts) can point at a row here.",
    to: "/configuration/locations",
    keywords: ["rooms", "shelves", "bins", "places"],
    primary: true,
  },
  {
    group: "data",
    icon: Ruler,
    label: "Units",
    description:
      "The workspace unit vocabulary — built-in units (gram/g, meter/m, each/ea) plus your own. Pick whether quantities show the shorthand symbol, the full word, or both.",
    to: "/configuration/units",
    keywords: ["measurements", "grams", "meters", "quantity"],
  },
  {
    group: "data",
    icon: CopyPlus,
    label: "Templates",
    description:
      "Per-workspace entity templates — stamp out new parts / assets / machines pre-filled with defaults + tags. \"Household appliance template\" / \"new Voron printer\" / \"Lego set acquired\".",
    to: "/configuration/templates",
    keywords: ["defaults", "prefill", "stamp"],
  },
  {
    group: "data",
    icon: Library,
    label: "Catalogs",
    description:
      "Imported reference datasets (Rebrickable parts, McMaster, USDA, ISBN). Your own entities can be matched to entries inside a catalog so the catalog's photo + metadata appears alongside.",
    to: "/configuration/catalogs",
    keywords: ["reference", "datasets", "match", "rebrickable", "isbn"],
  },
  {
    group: "data",
    icon: Files,
    label: "Files",
    description:
      "Uploaded photos / docs. Files attach to entities via the Tags + Files panel on each detail page.",
    to: "/files",
    keywords: ["photos", "uploads", "attachments", "documents"],
  },
  {
    group: "data",
    icon: LayoutGrid,
    label: "Presentation",
    description:
      "Rename / re-icon / hide / reorder any nav entry in your workspace. Workspace edits override module + bundle defaults.",
    to: "/configuration/presentation",
    keywords: ["nav", "sidebar", "rename", "icons", "reorder"],
  },
  // ── people & sharing ──────────────────────────────────────────────
  {
    group: "access",
    icon: Users,
    label: "Members + invites",
    description: "Invite collaborators to this workspace, change roles, revoke access.",
    modal: "members",
    keywords: ["team", "collaborators", "invite"],
    primary: true,
  },
  {
    group: "access",
    icon: Shield,
    label: "Access & permissions",
    description:
      "One area, three tabs: the who-can-do-what overview + per-member grants, custom roles (bundle capabilities under a name), and minted accounts. Stock roles are set in Members + invites.",
    to: "/configuration/permissions",
    keywords: ["roles", "grants", "capabilities", "access control", "users", "accounts", "custom roles", "password reset"],
    primary: true,
  },
  {
    group: "access",
    icon: LayoutGrid,
    label: "Member portal",
    description:
      "Branding + pinned views for the slimmed-down member portal at /portal/:slug. Members + guests land here by default; admins can preview.",
    to: "/configuration/portal",
    keywords: ["branding", "guests", "landing"],
  },
  {
    group: "access",
    icon: LayoutGrid,
    label: "Apps",
    description:
      "Build structured worker apps (pages of views, stats, forms, actions) that members open in the portal. Capability-gated; members see only what they're allowed.",
    to: "/configuration/apps",
    keywords: ["custom app", "app player", "blocks", "portal"],
  },
  {
    group: "access",
    icon: Link2,
    label: "Workspace links",
    description:
      "Cross-workspace data sharing — read selected entity kinds from another workspace you own (or invite-share). Accept / revoke per link.",
    to: "/configuration/links",
    keywords: ["sharing", "cross-workspace"],
  },
  {
    group: "access",
    icon: Globe,
    label: "Public surfaces",
    description:
      "Token-gated URLs that share a saved view with anyone — no account needed.",
    to: "/configuration/surfaces",
    keywords: ["public", "share", "tv", "display", "no login"],
  },
  {
    group: "access",
    icon: KeyRound,
    label: "API tokens",
    description: "Long-lived `cbt_*` tokens for CLI / AI / automation. Mint, list, revoke.",
    to: "/configuration/tokens",
    keywords: ["cli", "bearer", "automation", "keys"],
  },
  // ── automation & AI ───────────────────────────────────────────────
  {
    group: "automation",
    icon: Plug,
    label: "Wires",
    description:
      "Event-triggered or click-triggered actions that connect modules. The user-editable connector layer.",
    to: "/bindings",
    keywords: ["automation", "triggers", "events", "bindings"],
  },
  {
    group: "automation",
    icon: MousePointerClick,
    label: "Actions",
    description:
      "Tune which entities each cross-module action appears on — broaden or narrow a trait predicate per-axis.",
    to: "/actions",
    keywords: ["buttons", "verbs"],
  },
  {
    group: "automation",
    icon: Sparkles,
    label: "AI",
    description:
      "Configure AI providers (OpenAI, Anthropic, Ollama). Set per-capability defaults. Track spend. Match user entities to catalogs with an LLM. (Your PERSONAL AI connections live under your account menu → Connections.)",
    to: "/configuration/ai",
    keywords: ["llm", "provider", "ollama", "anthropic", "openai", "claude"],
    primary: true,
  },
  {
    group: "automation",
    icon: Plug,
    label: "Integrations",
    description:
      "Connect to Slack, Discord, email, or any webhook — outbound and inbound. Wire entity events to messages, or accept external webhooks as platform events.",
    to: "/configuration/integrations",
    keywords: ["slack", "discord", "webhook", "email", "notifications"],
    primary: true,
  },
  {
    group: "automation",
    icon: Wrench,
    label: "Maintenance",
    description:
      "Workspace-wide service log — everything scheduled, what's overdue, and the full history across every machine / asset / part. Complete, edit, or delete entries in one place.",
    to: "/configuration/maintenance",
    keywords: ["service", "schedule", "overdue", "recurring"],
  },
  // ── machines & devices ────────────────────────────────────────────
  {
    group: "devices",
    icon: Cable,
    label: "Edge bridges",
    description:
      "Your on-site bridges — the small programs that connect Cobblr to printers, lasers, and local AI on your own network. Live status, health tests, and setup.",
    to: "/configuration/edge",
    keywords: ["lan", "local", "bridge", "agent", "tunnel"],
  },
  {
    group: "devices",
    icon: Printer,
    label: "Digital fabrication",
    description:
      "Machine-manager connections (FDM Monster, OctoPrint, Bambu, …) — where design files get sent and print jobs are tracked.",
    to: "/configuration/digifab",
    keywords: ["3d printer", "laser", "cnc", "print job", "fdm", "octoprint", "bambu"],
  },
  {
    group: "devices",
    icon: Printer,
    label: "Printers",
    description:
      "Send documents to a real printer through a print manager (CUPS) — a Rollo label printer, shipping labels, an office laser. Direct on your LAN, or via the edge-bridge from cloud.",
    to: "/configuration/print",
    keywords: ["cups", "label printer", "rollo", "paper"],
  },
  {
    group: "devices",
    icon: QrCode,
    label: "QR codes",
    description:
      "The QR tokens the workspace has minted (copy a scan URL, revoke a token whose label walked off), plus external-QR rules that teach the scanner to read labels printed by another app — two tabs in one window.",
    to: "/configuration/qr-tokens",
    keywords: ["scan", "labels", "tokens", "rules"],
  },
  // ── safety & system ───────────────────────────────────────────────
  {
    group: "system",
    icon: FileArchive,
    label: "Backup & blueprints",
    description:
      "Download a blueprint of your workspace SETUP to share, or a full BACKUP (setup + every row + every file) to keep in your Google Drive / NAS. Install a blueprint or restore a backup into a fresh workspace.",
    to: "/configuration/backup",
    keywords: ["restore", "export", "snapshot", "google drive", "s3"],
  },
  {
    group: "system",
    icon: Activity,
    label: "Activity log",
    description:
      "Every mutation, attributed to who (UI / api token / system) and when. Filterable.",
    to: "/activity",
    keywords: ["audit", "history", "who changed"],
  },
  {
    group: "system",
    icon: ListTodo,
    label: "Background queue",
    description:
      "Persistent background work — view queued / running / done / failed jobs for this workspace. Worker polls every 5s; failed jobs retry with exponential backoff.",
    to: "/configuration/queue",
    keywords: ["jobs", "workers", "retries"],
  },
  {
    group: "system",
    icon: HeartPulse,
    label: "Healthcheck",
    description:
      "Live status rollup of every module's probes. Polled every 30s; 503 on red.",
    to: "/configuration/health",
    keywords: ["status", "probes", "diagnostics"],
  },
  {
    group: "system",
    icon: FileText,
    label: "OpenAPI",
    description:
      "Auto-generated OpenAPI 3.1 spec — entity-kind schemas + platform paths. Drop into Swagger UI or Insomnia.",
    to: "/configuration/openapi",
    keywords: ["api docs", "swagger", "spec", "rest"],
  },
];

/** Case-insensitive match over label + description + keywords. */
export function destinationMatches(d: ConfigDestination, q: string): boolean {
  const hay = `${d.label} ${d.description} ${(d.keywords ?? []).join(" ")}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}
