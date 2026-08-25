// The ONE registry of workspace-configuration destinations — consumed by the
// /configuration hub (section cards), the section pages, the settings sidebar
// and the ⌘K feature index, so none of them can drift.
//
// 2026-07 revamp (docs/design-decisions/configuration-revamp.md). The previous
// pass grouped by AUDIENCE and split tiles into primary/advanced; the result
// was 34 flat destinations with 11 visible and two whole groups invisible on
// arrival. This registry replaces that with SECTIONS you navigate into, and
// every entry declares what it needs to be reachable:
//
//   section  — which of the five sections it lives under
//   module   — the owning module; the entry is hidden when it is disabled, so
//              a tile can never lead to a page whose API routes aren't mounted
//   minRole  — hidden below this role
//
// Four rules this file is held to (see the design doc for the mistake each one
// came from):
//   1. Group by the ACT, not the audience.
//   2. Leaves keep the product's existing nouns; only section names are new.
//   3. A destination is a place you GO. A button is a thing you DO — actions
//      like "+ New thing" belong on a section's `action`, never in this list.
//      What a section action must satisfy, and where it renders, is
//      docs/design-decisions/configuration-revamp.md § "Section actions".
//   4. Never merge two pages just to make a count look smaller.

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BookOpen,
  Blocks,
  Bot,
  Boxes,
  Cable,
  Cloud,
  CopyPlus,
  FileArchive,
  FileText,
  Globe,
  HeartPulse,
  Home,
  KeyRound,
  LayoutGrid,
  Link2,
  ListTodo,
  MousePointerClick,
  Package,
  Plug,
  Ruler,
  ScanLine,
  Shield,
  Sliders,
  Sparkles,
  Terminal,
  Users,
} from "lucide-react";

/** The five sections of workspace configuration. `cloud` is NOT here: it is a
 *  render-time section fed by the hosted overlay's panels, so open core never
 *  shows it (see HOSTED_SECTION). */
export type ConfigSection =
  | "workspace"
  | "build"
  | "people"
  | "connections"
  | "system";

/** The minimum org role that can use a destination. The API has exactly two
 *  tiers (verified by sweeping `requireRole` across api/src + modules): the
 *  admin tier `("owner","admin")` and the member tier
 *  `("owner","admin","member")`. Nothing in settings is owner-exclusive, so
 *  "admin" is the only meaningful value here — `owner` would hide pages the
 *  server happily serves to admins. */
// role-vocab: ok — a nav TIER, not the role vocabulary. It names the two
// thresholds settings pages are gated at; a sixth role would not add a third.
export type ConfigRole = "admin" | "member";

/** Width is a pair, not a flag: choosing the wide column obliges you to say what
 *  needs the room. Modelled as a union so TypeScript refuses `width: "wide"`
 *  without a reason, rather than a lint noticing later.
 *
 *  Why bother: "wide" started as a judgement call and decayed into a default.
 *  Five pages carried it. Two could not say why at all (a card list, a list of
 *  log lines) and two had reasons that sounded fine in isolation and still lost
 *  to the simpler rule — a settings page looks like the settings pages around
 *  it, and a matrix or a three-column editor is not enough to break that.
 *
 *  ONE page is wide: the bundle catalog, which is a browse surface people scan
 *  rather than a page they read. If you are adding a second, the bar is that
 *  high. A reason you have to type is a reason you have to have. */
type ConfigWidth =
  | { width?: undefined; wideBecause?: never }
  | {
      width: "wide";
      /** What specifically needs more than the reading column: a matrix, a
       *  multi-column layout, a browse grid. "It felt cramped" is not one. */
      wideBecause: string;
    };

export type ConfigDestination = ConfigDestinationBase & ConfigWidth;

interface ConfigDestinationBase {
  /** The product's existing noun for this page. Never a new coinage. */
  label: string;
  description: string;
  icon: LucideIcon;
  /** Route target. Entries OUTSIDE /configuration/* (e.g. /bundles, /wires)
   *  still list here — URLs did not move in this revamp; sections are a
   *  navigation layer, not a URL segment. */
  to: string;
  section: ConfigSection;
  /** Owning module. Hidden when that module is disabled for the workspace.
   *  Omit for kernel-level pages that always exist. */
  module?: string;
  /** Hidden below this role. Defaults to "admin" — every settings page in the
   *  registry is admin-gated server-side. */
  minRole?: ConfigRole;
  /** Search synonyms the label/description don't already contain. */
  keywords?: string[];
  // Width lives in ConfigWidth above: declared HERE, not in the page, because a
  // column set per-page is how the settings area ended up with six of them and
  // both alignments. The layout reads this and owns the column; pages render
  // their content and nothing else.
}

export interface ConfigSectionMeta {
  label: string;
  /** One line on the section card: what act this section serves. */
  blurb: string;
  icon: LucideIcon;
  /** Primary action rendered as a BUTTON on the section (rule 3). */
  action?: { label: string; to: string };
}

export const CONFIG_SECTIONS: Record<ConfigSection, ConfigSectionMeta> = {
  workspace: {
    label: "Workspace",
    blurb: "What this workspace is called, how it reads, and how you get a copy out.",
    icon: Home,
  },
  build: {
    label: "Build",
    blurb: "What this workspace is made of, and how the pieces connect.",
    icon: Blocks,
    action: { label: "+ New category", to: "/configuration/new-thing" },
  },
  people: {
    label: "People",
    blurb: "Who gets in, what they can do, and what they land on.",
    icon: Users,
    action: { label: "+ Invite someone", to: "/configuration/members/invite" },
  },
  connections: {
    label: "Connections",
    blurb: "Everything that talks to something outside this workspace.",
    icon: Plug,
  },
  system: {
    label: "System",
    blurb: "Is it healthy, what has it been doing, what did it change.",
    icon: Activity,
  },
};

/** The ONE content column for every settings page.
 *
 *  CENTRED, because that is what the rest of the app does: AppLayout wraps every
 *  page in `max-w-6xl mx-auto`. An earlier pass made this left-aligned to keep a
 *  constant distance from the sidebar, which sounded reasonable and was wrong —
 *  it pinned settings to the left of an already-centred region and left a void
 *  down the right on a wide screen, so settings became the one part of the app
 *  that did not sit where everything else sits. */
export const CONFIG_COLUMN = "w-full max-w-4xl mx-auto";
/** For a table or permission matrix that a reading column would squeeze. */
export const CONFIG_COLUMN_WIDE = "w-full max-w-6xl mx-auto";

export function columnFor(width: ConfigDestination["width"]): string {
  return width === "wide" ? CONFIG_COLUMN_WIDE : CONFIG_COLUMN;
}

export const CONFIG_SECTION_ORDER: ConfigSection[] = [
  "workspace",
  "build",
  "people",
  "connections",
  "system",
];

/** The hosted overlay's panels get their OWN section, rendered only when
 *  /hosted-panels returns any. Open core registers none, so a self-hosted
 *  instance shows exactly the five sections above.
 *
 *  Why a section rather than folding them into Connections: the overlay
 *  registers a dozen panels (billing + eleven managed connectors), which would
 *  take Connections from 8 leaves to ~20 on the hosted deployment. Hosted-only
 *  surface should also READ as hosted-only. */
export const HOSTED_SECTION = {
  id: "cloud" as const,
  label: "Cloud",
  blurb: "What we run for you: your plan, and connectors we manage.",
  icon: Cloud,
};
export type HostedSectionId = typeof HOSTED_SECTION.id;

/** Panels declare a pre-2026-07 `group` id ("extend", "access", …). Every one
 *  of them belongs in the Cloud section now regardless of which legacy group it
 *  names, so the overlay needs no lockstep release. A function rather than a
 *  map so an unknown future group id can't fall through to a wrong section. */
export function sectionForHostedPanel(): HostedSectionId {
  return HOSTED_SECTION.id;
}

export const CONFIG_DESTINATIONS: ConfigDestination[] = [
  // ── Workspace ─────────────────────────────────────────────────────
  {
    section: "workspace",
    icon: Sliders,
    label: "General",
    description:
      "How this workspace behaves day to day, including simple mode, which tucks the builder tools away for a calmer everyday view.",
    to: "/configuration/general",
    keywords: ["simple mode", "focused", "basics", "name"],
  },
  {
    section: "workspace",
    icon: LayoutGrid,
    label: "Presentation",
    description:
      "Rename, re-icon, hide and reorder any nav entry in your workspace. Workspace edits override module + bundle defaults.",
    to: "/configuration/presentation",
    keywords: ["nav", "sidebar", "rename", "icons", "reorder", "customize", "navigation"],
  },
  {
    section: "workspace",
    icon: Ruler,
    label: "Units",
    description:
      "The workspace unit vocabulary: built-in units (gram/g, meter/m, each/ea) plus your own. Pick whether quantities show the shorthand symbol, the full word, or both.",
    to: "/configuration/units",
    module: "core-units",
    keywords: ["measurements", "grams", "meters", "quantity"],
  },
  {
    section: "workspace",
    icon: CopyPlus,
    label: "Templates",
    description:
      "Per-workspace entity templates. Stamp out new records pre-filled with defaults + tags.",
    to: "/configuration/templates",
    module: "core-templates",
    keywords: ["defaults", "prefill", "stamp"],
  },
  {
    section: "workspace",
    icon: FileArchive,
    label: "Backup & blueprints",
    description:
      "Download a blueprint of your workspace SETUP to share, or a full BACKUP (setup + every row + every file) to keep in your Google Drive / NAS. Install a blueprint or restore a backup into a fresh workspace.",
    to: "/configuration/backup",
    keywords: ["restore", "export", "snapshot", "google drive", "s3"],
  },

  // ── Build ─────────────────────────────────────────────────────────
  {
    section: "build",
    icon: Boxes,
    label: "Modules",
    description: "Enable / disable modules and their categories for this workspace.",
    to: "/configuration/modules",
    keywords: ["enable", "disable", "install", "features"],
  },
  {
    section: "build",
    icon: Package,
    label: "Bundles",
    description:
      "One-click bundles that ship a set of custom fields and wires. Browse the featured catalog, paste a manifest, or export your own.",
    to: "/bundles",
    keywords: ["presets", "recipes", "trackers", "skins", "marketplace", "setups"],
    width: "wide",
    wideBecause:
      "the bundle catalog is a three-across browse grid, and it is the one settings surface people scan rather than read",
  },
  {
    section: "build",
    icon: Plug,
    label: "Wires",
    description:
      "Event-triggered or click-triggered actions that connect modules. The user-editable connector layer.",
    to: "/wires",
    keywords: ["automation", "triggers", "events", "bindings", "when this then that"],
  },
  {
    section: "build",
    icon: MousePointerClick,
    label: "Actions",
    description:
      "Tune which entities each cross-module action appears on. Broaden or narrow a trait predicate per-axis.",
    to: "/actions",
    keywords: ["buttons", "verbs", "automation"],
  },
  {
    section: "build",
    icon: BookOpen,
    label: "Catalogs",
    description:
      "Reference catalogs this workspace matches scanned items against - browse what is loaded, and see how a lookup resolved.",
    to: "/configuration/catalogs",
    module: "core-catalogs",
    keywords: ["reference", "lookup", "match", "library"],
  },
  {
    section: "build",
    icon: Sliders,
    label: "Fields & forms",
    description:
      "Define your custom fields (text, number, date, url, dropdown, or computed), then drag them into order and group them under section headings. The layout shows on every create/edit form.",
    to: "/fields",
    keywords: [
      "columns",
      "attributes",
      "schema",
      "computed",
      "form builder",
      "layout",
      "sections",
    ],
  },
  {
    section: "build",
    icon: LayoutGrid,
    label: "Apps",
    description:
      "Build structured worker apps (pages of views, stats, forms, actions) that members open in the portal. Capability-gated; members see only what they're allowed.",
    to: "/configuration/apps",
    module: "core-apps",
    keywords: ["custom app", "app player", "blocks", "portal"],
  },

  // ── People ────────────────────────────────────────────────────────
  {
    section: "people",
    icon: Users,
    label: "Members & invites",
    description: "Invite collaborators to this workspace, change roles, revoke access.",
    to: "/configuration/members",
    keywords: ["team", "collaborators", "invite"],
  },
  {
    section: "people",
    icon: Shield,
    label: "Permissions",
    description:
      "Who can do what: the capability overview + per-member grants, custom roles, and minted accounts.",
    to: "/configuration/permissions",
    keywords: [
      "roles",
      "grants",
      "capabilities",
      "access control",
      "users",
      "accounts",
      "custom roles",
      "password reset",
    ],
  },
  {
    section: "people",
    icon: LayoutGrid,
    label: "Member portal",
    description:
      "Branding + pinned views for the slimmed-down member portal at /portal/:slug. Members + guests land here by default; admins can preview.",
    to: "/configuration/portal",
    keywords: ["branding", "guests", "landing"],
  },

  // ── Connections ───────────────────────────────────────────────────
  {
    section: "connections",
    icon: Sparkles,
    label: "AI",
    description:
      "Configure AI providers (OpenAI, Anthropic, Ollama). Set per-capability defaults. Track spend. (Your PERSONAL AI connections live under your account menu → Connections.)",
    to: "/configuration/ai",
    module: "core-ai",
    keywords: ["llm", "provider", "ollama", "anthropic", "openai", "claude"],
  },
  {
    section: "connections",
    icon: Bot,
    label: "Assistant",
    description:
      "Teach Ask Cobb what to say when there's no AI connected: edit the built-in answers, turn them off, or add your own keyword-triggered replies. Includes a live \"try it\" tester.",
    to: "/configuration/assistant",
    module: "core-ai",
    keywords: ["cobb", "chat", "basic mode", "canned", "no ai", "answers", "faq"],
  },
  {
    section: "connections",
    icon: Plug,
    label: "Integrations",
    description:
      "Connect to Slack, Discord, email, or any webhook, outbound and inbound. Sync in from another service, or migrate in from another app.",
    to: "/configuration/integrations",
    module: "core-integrations",
    keywords: [
      "slack",
      "discord",
      "webhook",
      "email",
      "notifications",
      "migrate",
      "import",
      "csv",
      "move in",
      "switch",
    ],
  },
  {
    section: "connections",
    icon: ScanLine,
    label: "QR codes",
    description:
      "This workspace's QR label tokens, and the rules that teach the scanner to read labels printed by another app.",
    to: "/configuration/qr-tokens",
    module: "labels",
    keywords: ["qr", "label", "token", "sticker"],
  },
  {
    section: "connections",
    icon: ScanLine,
    label: "Scan rules",
    description:
      "Teach the scanner to read labels printed by another app, so an existing barcode resolves to the right record here.",
    to: "/configuration/scan-rules",
    module: "core-scan",
    keywords: ["external qr", "barcode", "resolver", "labels", "interop"],
  },
  {
    section: "connections",
    icon: Cable,
    label: "Devices",
    description:
      "Everything physical this workspace reaches: your on-site bridges, machine managers that run print jobs, and document printers.",
    to: "/configuration/devices",
    module: "core-devices",
    keywords: [
      "edge",
      "bridge",
      "lan",
      "local",
      "tunnel",
      "3d printer",
      "laser",
      "cnc",
      "print job",
      "fdm",
      "octoprint",
      "bambu",
      "cups",
      "label printer",
      "digifab",
      "digital fabrication",
    ],
  },
  {
    section: "connections",
    icon: Link2,
    label: "Workspace links",
    description:
      "Cross-workspace data sharing. Read selected entity kinds from another workspace you own (or invite-share). Accept / revoke per link.",
    to: "/configuration/links",
    keywords: ["sharing", "cross-workspace"],
  },
  {
    section: "connections",
    icon: Globe,
    label: "Public surfaces",
    description:
      "Token-gated URLs that share a saved view with anyone, no account needed.",
    to: "/configuration/surfaces",
    module: "core-public-surfaces",
    keywords: ["public", "share", "tv", "display", "no login"],
  },
  {
    section: "connections",
    icon: KeyRound,
    label: "API tokens",
    description: "Long-lived `cbt_*` tokens for CLI / AI / automation. Mint, list, revoke.",
    to: "/configuration/tokens",
    keywords: ["cli", "bearer", "automation", "keys"],
  },

  // ── System ────────────────────────────────────────────────────────
  {
    section: "system",
    icon: Activity,
    label: "Activity log",
    description:
      "Every mutation, attributed to who (UI / api token / system) and when. Filterable.",
    to: "/activity",
    module: "core-activity-log",
    keywords: ["audit", "history", "who changed"],
  },
  {
    section: "system",
    icon: ListTodo,
    label: "Background queue",
    description:
      "Persistent background work. View queued / running / done / failed jobs for this workspace.",
    to: "/configuration/queue",
    module: "core-queue",
    keywords: ["jobs", "workers", "retries"],
  },
  {
    section: "system",
    icon: HeartPulse,
    label: "Healthcheck",
    description:
      "Live status rollup of every module's probes. Polled every 30s; 503 on red.",
    to: "/configuration/health",
    module: "core-healthcheck",
    keywords: ["status", "probes", "diagnostics"],
  },
  {
    section: "system",
    icon: Terminal,
    label: "Scripting",
    description:
      "Ready-to-run curl / Python / Node / TypeScript for creating and reading records from a script, using your own kinds and fields. Mints a scoped token for you.",
    to: "/configuration/api-recipes",
    keywords: ["api", "script", "curl", "token", "automation", "use from a script", "integrate", "rest", "recipe"],
  },
  {
    section: "system",
    icon: FileText,
    label: "OpenAPI",
    description:
      "Auto-generated OpenAPI 3.1 spec: entity-kind schemas + platform paths. Drop into Swagger UI or Insomnia.",
    to: "/configuration/openapi",
    module: "core-openapi",
    keywords: ["api docs", "swagger", "spec", "rest"],
  },
];

/** Case-insensitive match over label + description + keywords. */
export function destinationMatches(
  d: Pick<ConfigDestination, "label" | "description" | "keywords">,
  q: string,
): boolean {
  const hay = `${d.label} ${d.description} ${(d.keywords ?? []).join(" ")}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

export interface VisibilityContext {
  /** Names of the modules enabled for the active workspace. Pass `null` while
   *  the list is still loading — nothing is hidden on a module basis then, so
   *  the settings area never flickers items in. */
  enabledModules: Set<string> | null;
  /** The viewer's role in the active workspace. */
  role?: string | null;
}

/** Is this destination usable by this viewer, in this workspace? A tile that
 *  fails this leads to a page whose API routes aren't mounted (409s) or that
 *  the server refuses — so it must not be shown at all. */
export function isDestinationVisible(
  d: ConfigDestination,
  ctx: VisibilityContext,
): boolean {
  if (d.module && ctx.enabledModules && !ctx.enabledModules.has(d.module)) return false;
  const min = d.minRole ?? "admin";
  const role = ctx.role ?? undefined;
  // Unknown role (still loading) → don't hide; the server is the real gate.
  if (!role) return true;
  if (min === "admin") return role === "owner" || role === "admin";
  return role === "owner" || role === "admin" || role === "member";
}

export function visibleDestinations(ctx: VisibilityContext): ConfigDestination[] {
  return CONFIG_DESTINATIONS.filter((d) => isDestinationVisible(d, ctx));
}

/** Is this route part of the configuration family? True for /configuration/*
 *  and every registry destination's own page (the family routes like /bundles,
 *  /fields, /wires that live outside the namespace). Drives the sidebar
 *  fold: in side-nav mode the MAIN sidebar becomes the configuration panel on
 *  these routes, so two sidebars never stack. */
export function isConfigurationPath(pathname: string): boolean {
  if (pathname === "/configuration" || pathname.startsWith("/configuration/")) return true;
  return CONFIG_DESTINATIONS.some(
    (d) =>
      !d.to.startsWith("/configuration") &&
      (pathname === d.to || pathname.startsWith(`${d.to}/`)),
  );
}

/** The section a route belongs to, for breadcrumbs + sidebar highlighting. */
export function sectionForPath(pathname: string): ConfigSection | null {
  const hit = CONFIG_DESTINATIONS.find(
    (d) => pathname === d.to || pathname.startsWith(`${d.to}/`),
  );
  return hit?.section ?? null;
}
