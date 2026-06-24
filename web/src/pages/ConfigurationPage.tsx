// /configuration — the workspace control room. One tiled landing
// page for everything that configures or audits the active
// workspace: modules, bundles, wires, fields, members, activity,
// API tokens. Each tile is a deep-link or modal launcher; the
// page itself stays a minimal hub.
//
// Distinct from /settings (reserved for future user-level prefs —
// dark mode, language, profile). Configuration changes how the
// workspace operates; settings change how you personally see it.

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Activity,
  ArrowUpCircle,
  Boxes,
  ChevronRight,
  FileArchive,
  FileText,
  Files,
  Eye,
  Globe,
  HeartPulse,
  KeyRound,
  LayoutGrid,
  LayoutList,
  Library,
  CopyPlus,
  FolderPlus,
  Link2,
  ListTodo,
  MapPin,
  MousePointerClick,
  Package,
  Plug,
  Printer,
  QrCode,
  Ruler,
  Search,
  Sliders,
  Sparkles,
  Tag,
  Shield,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { ModulePickerModal } from "../components/ModulePickerModal";
import { MembersModal } from "../components/MembersModal";
import { NewThingFunnelModal } from "../components/NewThingFunnelModal";
import { NavCustomizeMenu } from "../components/NavCustomizeMenu";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { displaySlug } from "../lib/workspaceSlug";
import { usePageTitle, useToast } from "@cobblr/platform-web";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, setFocused, isFocused } from "../lib/api";
import { iconForName as iconForPanel } from "../lib/panel-icons";
import { useBundleUpdates } from "../lib/useBundleUpdates";

interface Tile {
  icon: typeof Wrench;
  label: string;
  description: string;
  to?: string;
  onClick?: () => void;
  /** Section the tile belongs to, used for the grouped layout. */
  group: "modules" | "data" | "access" | "extend" | "admin";
}

// The everyday handful most workspaces actually touch. Everything else is real
// but rarely-visited, so it's tucked behind "Show advanced settings" — the page
// reads as a short menu (~11 tiles), not a 35-card wall (feedback b746e0e4).
// Matched by label, so a tile lands in "advanced" simply by NOT being listed
// here. Search ignores the split and always searches every tile.
const PRIMARY_TILES = new Set<string>([
  "+ New thing in workspace",
  "Modules",
  "Bundles",
  "Saved views",
  "Tags",
  "Locations",
  "Custom fields",
  "Form builder",
  "Members + invites",
  "AI",
  "Integrations",
]);

const GROUP_LABELS: Record<Tile["group"], string> = {
  modules: "set up your workspace",
  data: "customize your data",
  access: "people & access",
  extend: "connect & automate",
  admin: "system & diagnostics",
};
const GROUP_ORDER: Tile["group"][] = ["modules", "data", "access", "extend", "admin"];
// Groups open on arrival — but each shows only its PRIMARY tiles (~11 total),
// so the page reads as a short, fully-visible menu rather than a 35-card wall.
// The other two dozen settings stay behind "Show advanced settings". (`admin`
// has no primary tiles, so it doesn't render at all until advanced is on.)
const DEFAULT_OPEN: Record<Tile["group"], boolean> = {
  modules: true,
  data: true,
  access: true,
  extend: true,
  admin: true,
};

/** Owner/admin control to flip the workspace into (or out of) FOCUSED mode —
 *  hides the builder chrome (marketplace / modules / this Configuration page /
 *  the AI builder / "+ New thing") so the workspace reads as a finished app.
 *  Reversible from here or the account menu ("Explore the full platform"). A
 *  full reload re-fetches /me so the whole shell re-renders in the new mode. */
function FocusedModeToggle({ slug, focused }: { slug: string; focused: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const flip = async () => {
    setBusy(true);
    try {
      const turningOn = !focused;
      await setFocused(slug, turningOn);
      // Turning ON hides the builder chrome — so land on the workspace HOME, not
      // back on this (now-hidden) Configuration page. Reloading here was the bug
      // behind "turn on simple mode did nothing": the page reloaded to the same
      // 35-card wall, so nothing looked different (feedback c1dbdf1b). Turning
      // OFF: reload in place so the full Configuration page returns.
      window.location.assign(turningOn ? "/" : window.location.pathname);
    } catch (e) {
      setBusy(false);
      toast.error(e instanceof Error ? e.message : "Couldn't change simple mode");
    }
  };
  return (
    <div className="rounded-lg border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/40 px-4 py-3 flex items-start gap-3">
      <Eye size={18} className="mt-0.5 shrink-0 text-accent dark:text-cobble-300" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-content dark:text-mortar-100">
          Simple mode {focused ? "is on" : "is off"}
        </div>
        <p className="mt-0.5 text-xs text-faint dark:text-slate-400">
          {focused
            ? "The platform's build-it chrome (marketplace, modules, this Configuration page, the AI builder) is hidden — a calm, everyday view of just your data. Turn it off whenever you want to tinker; it's all still here."
            : "Hide the platform's build-it chrome (marketplace, modules, this Configuration page, the AI builder) for a calmer, everyday view of just your data. Nothing is removed — flip it back anytime from the account menu when you want to add or configure things."}
        </p>
      </div>
      <button
        type="button"
        onClick={flip}
        disabled={busy}
        className={
          "shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 " +
          (focused
            ? "border border-line dark:border-slate-600 text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800"
            : "bg-cobble-600 text-white hover:bg-cobble-700")
        }
      >
        {busy ? "…" : focused ? "Turn off" : "Turn on simple mode"}
      </button>
    </div>
  );
}

export function ConfigurationPage() {
  usePageTitle("Configuration");
  const { activeOrg, activeSlug } = useActiveOrg();
  const [modulesOpen, setModulesOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [newThingOpen, setNewThingOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(DEFAULT_OPEN);
  const [query, setQuery] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const focused = isFocused(activeOrg);

  // Hosted-only settings panels (billing, Slack, …) contributed by the cloud
  // overlay. Open core registers none, so this is [] on a self-hosted instance
  // and no tiles appear — none of the panels' names/logic exist in core. Each
  // panel renders through the generic HostedPanelPage at /configuration/x/:id.
  const hostedPanelsQ = useQuery({
    queryKey: ["hosted-panels", activeSlug],
    queryFn: () =>
      api.request<{ panels: Array<{ id: string; label: string; icon?: string; group?: string }> }>(
        "GET",
        `/orgs/${activeSlug}/hosted-panels`,
      ),
    enabled: !!activeSlug,
    retry: false,
    staleTime: 5 * 60_000,
  });

  const tiles: Tile[] = [
    // ── modules + bundles ──────────────────────────────────────────
    {
      group: "modules",
      icon: FolderPlus,
      label: "+ New thing in workspace",
      description:
        "Add a new top-level entity to your workspace. Pick whether it's a sub-category of something existing or its own separate thing.",
      onClick: () => setNewThingOpen(true),
    },
    {
      group: "modules",
      icon: Boxes,
      label: "Modules",
      description:
        "Enable / disable modules and their specialisations for this workspace.",
      onClick: () => setModulesOpen(true),
    },
    {
      group: "modules",
      icon: Package,
      label: "Bundles",
      description:
        "One-click presets that ship a set of custom fields and wires. Browse the featured catalog, paste a manifest, or export your own.",
      to: "/bundles",
    },
    // ── your data ──────────────────────────────────────────────────
    {
      group: "data",
      icon: LayoutList,
      label: "Saved views",
      description:
        "List / table / kanban views over your entities. Saved here, renderable from the dashboard, publishable as public surfaces.",
      to: "/views",
    },
    {
      group: "data",
      icon: Tag,
      label: "Tags",
      description:
        "Cross-cutting labels you can attach to anything. Filter by tag in saved views or searches.",
      to: "/tags",
    },
    {
      group: "data",
      icon: LayoutGrid,
      label: "Presentation",
      description:
        "Rename / re-icon / hide / reorder any nav entry in your workspace. Workspace edits override module + bundle defaults.",
      to: "/configuration/presentation",
    },
    {
      group: "data",
      icon: MapPin,
      label: "Locations",
      description:
        "Hierarchical tree of physical places — rooms, shelves, bins. Everything tangible (machines, assets, parts) can point at a row here.",
      to: "/configuration/locations",
    },
    {
      group: "data",
      icon: Library,
      label: "Catalogs",
      description:
        "Imported reference datasets (Rebrickable parts, McMaster, USDA, ISBN). Your own entities can be matched to entries inside a catalog so the catalog's photo + metadata appears alongside.",
      to: "/configuration/catalogs",
    },
    {
      group: "data",
      icon: Files,
      label: "Files",
      description:
        "Uploaded photos / docs. Files attach to entities via the Tags + Files panel on each detail page.",
      to: "/files",
    },
    {
      group: "data",
      icon: Sliders,
      label: "Custom fields",
      description:
        "Per-entity-kind custom field defs — text, number, date, url, dropdown choices, or computed (a read-only {{ }} template over the entity's fields + related data).",
      to: "/fields",
    },
    {
      group: "data",
      icon: LayoutList,
      label: "Form builder",
      description:
        "Visually drag your custom fields into order and group them under section headings (Specs, Purchase info…). The layout shows on every create/edit form.",
      to: "/configuration/form-builder",
    },
    {
      group: "data",
      icon: Ruler,
      label: "Units",
      description:
        "The workspace unit vocabulary — built-in units (gram/g, meter/m, each/ea) plus your own. Pick whether quantities show the shorthand symbol, the full word, or both.",
      to: "/configuration/units",
    },
    {
      group: "data",
      icon: CopyPlus,
      label: "Templates",
      description:
        "Per-workspace entity templates — stamp out new parts / assets / machines pre-filled with defaults + tags. \"Household appliance template\" / \"new Voron printer\" / \"Lego set acquired\".",
      to: "/configuration/templates",
    },
    {
      group: "data",
      icon: Wrench,
      label: "Maintenance",
      description:
        "Workspace-wide service log — everything scheduled, what's overdue, and the full history across every machine / asset / part. Complete, edit, or delete entries in one place.",
      to: "/configuration/maintenance",
    },
    {
      group: "data",
      icon: FileArchive,
      label: "Backup & blueprints",
      description:
        "Download a blueprint of your workspace SETUP to share, or a full BACKUP (setup + every row + every file) to keep in your Google Drive / NAS. Install a blueprint or restore a backup into a fresh workspace.",
      to: "/configuration/backup",
    },
    {
      group: "data",
      icon: QrCode,
      label: "QR codes",
      description:
        "The QR tokens the workspace has minted (copy a scan URL, revoke a token whose label walked off), plus external-QR rules that teach the scanner to read labels printed by another app — two tabs in one window.",
      to: "/configuration/qr-tokens",
    },
    // ── people + access ────────────────────────────────────────────
    {
      group: "access",
      icon: Users,
      label: "Members + invites",
      description:
        "Invite collaborators to this workspace, change roles, revoke access.",
      onClick: () => setMembersOpen(true),
    },
    {
      group: "access",
      icon: KeyRound,
      label: "API tokens",
      description:
        "Long-lived `cbt_*` tokens for CLI / AI / automation. Mint, list, revoke.",
      to: "/configuration/tokens",
    },
    {
      group: "access",
      icon: Link2,
      label: "Workspace links",
      description:
        "Cross-workspace data sharing — read selected entity kinds from another workspace you own (or invite-share). Accept / revoke per link.",
      to: "/configuration/links",
    },
    {
      group: "access",
      icon: Globe,
      label: "Public surfaces",
      description:
        "Token-gated URLs that share a saved view with anyone — no account needed.",
      to: "/configuration/surfaces",
    },
    // ── extend + integrate ─────────────────────────────────────────
    {
      group: "extend",
      icon: Plug,
      label: "Wires",
      description:
        "Event-triggered or click-triggered actions that connect modules. The user-editable connector layer.",
      to: "/bindings",
    },
    {
      group: "extend",
      icon: MousePointerClick,
      label: "Actions",
      description:
        "Tune which entities each cross-module action appears on — broaden or narrow a trait predicate per-axis.",
      to: "/actions",
    },
    {
      group: "extend",
      icon: Sparkles,
      label: "AI",
      description:
        "Configure AI providers (OpenAI, Anthropic, Ollama). Set per-capability defaults. Track spend. Match user entities to catalogs with an LLM.",
      to: "/configuration/ai",
    },
    {
      group: "extend",
      icon: Plug,
      label: "Integrations",
      description:
        "Connect to Slack, Discord, email, or any webhook — outbound and inbound. Wire entity events to messages, or accept external webhooks as platform events.",
      to: "/configuration/integrations",
    },
    {
      group: "extend",
      icon: Printer,
      label: "Printers",
      description:
        "Send documents to a real printer through a print manager (CUPS) — a Rollo label printer, shipping labels, an office laser. Direct on your LAN, or via the edge-bridge from cloud.",
      to: "/configuration/print",
    },
    {
      group: "extend",
      icon: FileText,
      label: "OpenAPI",
      description:
        "Auto-generated OpenAPI 3.1 spec — entity-kind schemas + platform paths. Drop into Swagger UI or Insomnia.",
      to: "/configuration/openapi",
    },
    {
      group: "access",
      icon: Users,
      label: "Users",
      description:
        "Mint workspace accounts with a temp password (no email required). The user resets on first login. Also: reset a forgotten password for an existing member.",
      to: "/configuration/users",
    },
    {
      group: "access",
      icon: LayoutGrid,
      label: "Member portal",
      description:
        "Branding + pinned views for the slimmed-down member portal at /portal/:slug. Members + guests land here by default; admins can preview.",
      to: "/configuration/portal",
    },
    {
      group: "access",
      icon: LayoutGrid,
      label: "Apps",
      description:
        "Build structured worker apps (pages of views, stats, forms, actions) that members open in the portal. Capability-gated; members see only what they're allowed.",
      to: "/configuration/apps",
    },
    {
      group: "access",
      icon: Users,
      label: "Custom roles",
      description:
        "Bundle multiple capabilities under a name (e.g. \"Sorter\" = create-part + assign-location). Assign roles to members in addition to their stock role.",
      to: "/configuration/roles",
    },
    {
      group: "access",
      icon: Shield,
      label: "Permissions",
      description:
        "Per-member capability grants. Admins implicitly have everything; members can be granted specific verbs like 'create parts' or 'receive orders'.",
      to: "/configuration/permissions",
    },
    // ── ops + diagnostics ──────────────────────────────────────────
    {
      group: "admin",
      icon: Activity,
      label: "Activity log",
      description:
        "Every mutation, attributed to who (UI / api token / system) and when. Filterable.",
      to: "/activity",
    },
    {
      group: "admin",
      icon: ListTodo,
      label: "Background queue",
      description:
        "Persistent background work — view queued / running / done / failed jobs for this workspace. Worker polls every 5s; failed jobs retry with exponential backoff.",
      to: "/configuration/queue",
    },
    {
      group: "admin",
      icon: HeartPulse,
      label: "Healthcheck",
      description:
        "Live status rollup of every module's probes. Polled every 30s; 503 on red.",
      to: "/configuration/health",
    },
  ];

  // Hosted-only panels (billing/Slack/…) — one tile each, only when the overlay
  // registers them. Label/icon/group come from the overlay at runtime.
  for (const p of hostedPanelsQ.data?.panels ?? []) {
    const group = (p.group ?? "access") as Tile["group"];
    tiles.push({
      group,
      icon: iconForPanel(p.icon),
      label: p.label,
      description: "",
      to: `/configuration/x/${p.id}`,
    });
  }

  // A search bar over every tile so the dense control room is navigable by
  // name instead of by hunting through five collapsed sections (feedback
  // b746e0e4: "nightmare of complexity… and a search bar at the top").
  const q = query.trim().toLowerCase();
  const matches = (t: Tile) =>
    !q ||
    t.label.toLowerCase().includes(q) ||
    t.description.toLowerCase().includes(q) ||
    GROUP_LABELS[t.group].toLowerCase().includes(q);

  const grouped = GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    items: tiles.filter(
      (t) =>
        t.group === group &&
        matches(t) &&
        // Advanced tiles only show while searching or when explicitly revealed.
        (q || showAdvanced || PRIMARY_TILES.has(t.label)),
    ),
  })).filter((g) => g.items.length > 0);

  const advancedCount = tiles.filter((t) => !PRIMARY_TILES.has(t.label)).length;

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100">
          Workspace configuration
        </h1>
        {activeOrg && (
          <span className="text-[10px] font-mono text-faint dark:text-slate-500">
            {activeOrg.name} · {displaySlug(activeSlug)} · {activeOrg.role}
          </span>
        )}
      </div>

      {(activeOrg?.role === "owner" || activeOrg?.role === "admin") && (
        <FocusedModeToggle slug={activeSlug} focused={!!activeOrg?.focused} />
      )}

      {focused ? (
        // Simple mode hides the builder chrome, so the Configuration page itself
        // becomes a calm one-card state rather than the 35-tile control room.
        // (The toggle normally lands you on Home; this covers a direct visit.)
        <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 text-sm text-content dark:text-mortar-200 space-y-2">
          <p className="font-medium text-content dark:text-mortar-100">
            Simple mode is on — builder tools are tucked away.
          </p>
          <p>
            Modules, bundles, custom fields, integrations and the rest of the
            control room are hidden for a calm, everyday workspace. Turn simple
            mode off above whenever you want to configure or extend things —
            nothing was removed.
          </p>
        </div>
      ) : (
      <>
      <div className="relative">
        <Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-faint dark:text-slate-500"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search configuration…"
          aria-label="Search configuration"
          className="input !pl-9 !pr-9"
        />
        {q && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-faint hover:text-content dark:hover:text-mortar-100"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Helper chrome and alerts only get in the way of a filtered list, so
          they collapse away while a search is active. */}
      {!q && (
        <>
          <p className="text-sm text-content dark:text-mortar-200">
            Start with <span className="font-medium">Set up your workspace</span> — turn on the
            modules you want or install a starter pack. The rest is optional and opens when you
            need it.
          </p>

          {/* What the nav badge points at — spell out the pending bundle updates
              here so the amber dot on "Configuration" has somewhere that explains
              itself, rather than leaving the user hunting (feedback f22a7620). */}
          <BundleUpdatesCallout slug={activeSlug} />

          {activeOrg?.role === "owner" && <WorkspaceAiSharing slug={activeSlug} />}

          {/* Nav-customize control — relocated out of the navbar (it's a
              per-device preference, not a nav heading). */}
          <div className="flex items-center gap-3 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-4 py-3">
            <NavCustomizeMenu />
            <span className="text-sm text-content dark:text-mortar-200">
              Customize navigation — show, hide &amp; reorder your navbar items
              (saved on this device).
            </span>
          </div>
        </>
      )}

      {q && grouped.length === 0 && (
        <p className="text-sm text-faint dark:text-slate-500">
          No configuration matches “{query.trim()}”.
        </p>
      )}

      {grouped.map(({ group, label, items }) => {
        // While searching — or while "show advanced" is on — every section is
        // expanded; the point is to see the hits, not to re-open groups by hand.
        const open = q || showAdvanced ? true : (openGroups[group] ?? false);
        return (
        <section key={group} className="space-y-2">
          <button
            type="button"
            onClick={() => setOpenGroups((p) => ({ ...p, [group]: !open }))}
            className="w-full flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-accent hover:text-content dark:hover:text-mortar-100 transition"
          >
            <ChevronRight
              size={12}
              className={`transition-transform ${open ? "rotate-90" : ""}`}
            />
            // {label}
            <span className="text-faint dark:text-slate-500 normal-case tracking-normal">
              ({items.length})
            </span>
          </button>
          {open && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {items.map((t) => {
              const Icon = t.icon;
              const inner = (
                <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 hover:border-cobble-300 dark:hover:border-cobble-700 transition flex items-start gap-3 h-full">
                  <Icon size={20} className="text-accent mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-content dark:text-mortar-100">
                      {t.label}
                    </div>
                    <div className="text-xs text-content dark:text-mortar-200 mt-1">
                      {t.description}
                    </div>
                  </div>
                </div>
              );
              if (t.to) {
                return (
                  <Link key={t.label} to={t.to}>
                    {inner}
                  </Link>
                );
              }
              return (
                <button
                  key={t.label}
                  onClick={t.onClick}
                  className="text-left"
                  type="button"
                >
                  {inner}
                </button>
              );
            })}
          </div>
          )}
        </section>
        );
      })}

      {/* The everyday page is ~11 tiles; the other two dozen settings live
          behind this so the page reads as a short menu, not a wall (feedback
          b746e0e4). Search still finds every tile regardless of this toggle. */}
      {!q && advancedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="w-full flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-line dark:border-slate-700 px-4 py-3 text-sm text-faint dark:text-slate-400 hover:text-content dark:hover:text-mortar-100 hover:border-cobble-300 dark:hover:border-cobble-700 transition"
        >
          <ChevronRight
            size={14}
            className={`transition-transform ${showAdvanced ? "rotate-90" : ""}`}
          />
          {showAdvanced
            ? "Hide advanced settings"
            : `Show advanced settings (${advancedCount})`}
        </button>
      )}
      </>
      )}

      <ModulePickerModal
        open={modulesOpen}
        onClose={() => setModulesOpen(false)}
      />
      <MembersModal
        open={membersOpen}
        onClose={() => setMembersOpen(false)}
        slug={activeSlug}
      />
      <NewThingFunnelModal
        open={newThingOpen}
        onClose={() => setNewThingOpen(false)}
      />
    </div>
  );
}

// ─────────────── "Needs your attention" — pending bundle updates ───────────────
// The nav shows an amber badge on Configuration when an installed bundle has a
// newer catalog version, but the destination page never said WHAT (feedback
// f22a7620). This callout names each pending update and links straight to the
// place to apply it. Renders nothing when everything is up to date.
function BundleUpdatesCallout({ slug }: { slug: string }) {
  const updates = useBundleUpdates(slug);
  const navigate = useNavigate();
  if (updates.length === 0) return null;
  return (
    <section className="rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-4 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-300">
        <ArrowUpCircle size={16} className="shrink-0" />
        {updates.length} bundle update{updates.length === 1 ? "" : "s"} available
      </div>
      <div className="space-y-1.5">
        {updates.map((u) => (
          <div key={u.externalId} className="flex items-center gap-2 text-sm">
            <span className="flex-1 min-w-0 truncate text-content dark:text-mortar-200">
              {u.glyph} <strong>{u.name}</strong>{" "}
              <span className="text-faint dark:text-slate-500">
                v{u.installedV} → v{u.latestV}
              </span>
            </span>
            <button
              type="button"
              onClick={() =>
                navigate(
                  `/bundles?open=${encodeURIComponent(u.externalId)}&returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`,
                )
              }
              className="shrink-0 rounded bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium px-2.5 py-1"
            >
              Update
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─────────────── Owner: review members' AI-share offers ───────────────
// A member can OFFER their personal AI to this workspace (so everyone here can
// use it). The owner approves, picks which is the active workspace AI, or
// declines. Renders nothing until there's at least one offer.
function WorkspaceAiSharing({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const shares = useQuery({
    queryKey: ["ai-shares", slug],
    queryFn: () => api.listAiShares(slug),
    enabled: !!slug,
  });
  const items = shares.data?.items ?? [];
  const onItems = (r: { items: import("../lib/api").WorkspaceAiOffer[] }) =>
    qc.setQueryData(["ai-shares", slug], r);

  const approve = useMutation({
    mutationFn: (cid: string) => api.approveAiShare(slug, cid),
    onSuccess: (r) => {
      onItems(r);
      toast.success("Approved — this AI is now available in the workspace.");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const reject = useMutation({
    mutationFn: (cid: string) => api.rejectAiShare(slug, cid),
    onSuccess: (r) => {
      onItems(r);
      toast.success("Offer declined.");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const activate = useMutation({
    mutationFn: (cid: string | null) => api.setActiveAiShare(slug, cid),
    onSuccess: (r) => onItems(r),
    onError: (e) => toast.error((e as Error).message),
  });

  if (items.length === 0) return null;
  const pending = items.filter((i) => i.status === "pending");
  const approved = items.filter((i) => i.status === "approved");

  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
      <div className="text-sm font-medium text-content dark:text-mortar-100">AI sharing</div>

      {pending.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] font-mono uppercase tracking-widest text-amber-600 dark:text-amber-500">
            Pending offers
          </div>
          {pending.map((o) => (
            <div key={o.credential_id} className="flex items-center gap-2 text-sm">
              <div className="flex-1 min-w-0">
                <span className="text-content dark:text-mortar-200">{o.offered_by_name}</span>
                <span className="text-faint"> wants to share their AI ({o.label || o.provider_id})</span>
              </div>
              <button
                type="button"
                disabled={approve.isPending}
                onClick={() => approve.mutate(o.credential_id)}
                className="rounded bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-2.5 py-1 disabled:opacity-50"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={reject.isPending}
                onClick={() => reject.mutate(o.credential_id)}
                className="rounded border border-line dark:border-slate-600 text-muted hover:text-ember-500 text-xs font-medium px-2.5 py-1"
              >
                Decline
              </button>
            </div>
          ))}
        </div>
      )}

      {approved.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-mono uppercase tracking-widest text-faint">
            Workspace AI {approved.length > 1 && "— pick the active one"}
          </div>
          {approved.map((o) => (
            <label key={o.credential_id} className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name={`active-ai-${slug}`}
                checked={o.active}
                onChange={() => activate.mutate(o.credential_id)}
                className="accent-cobble-600"
              />
              <span className="text-content dark:text-mortar-200">{o.label || o.provider_id}</span>
              <span className="text-[10px] text-faint">
                {o.is_own ? "yours" : `shared by ${o.offered_by_name}`}
              </span>
              {o.active && <span className="text-[10px] text-accent">active</span>}
            </label>
          ))}
          {approved.some((o) => o.active) && (
            <button
              type="button"
              onClick={() => activate.mutate(null)}
              className="text-[11px] text-faint hover:text-ember-500"
            >
              Turn off the shared workspace AI
            </button>
          )}
        </div>
      )}
    </section>
  );
}
