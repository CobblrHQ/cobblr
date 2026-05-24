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
import { Link } from "react-router-dom";
import {
  Activity,
  Boxes,
  FileText,
  Files,
  Globe,
  HeartPulse,
  KeyRound,
  LayoutGrid,
  LayoutList,
  Library,
  FolderPlus,
  Link2,
  ListTodo,
  MapPin,
  MousePointerClick,
  Package,
  Plug,
  Sliders,
  Sparkles,
  Tag,
  Users,
  Wrench,
} from "lucide-react";
import { ModulePickerModal } from "../components/ModulePickerModal";
import { MembersModal } from "../components/MembersModal";
import { NewThingFunnelModal } from "../components/NewThingFunnelModal";
import { useActiveOrg } from "../auth/ActiveOrgContext";

interface Tile {
  icon: typeof Wrench;
  label: string;
  description: string;
  to?: string;
  onClick?: () => void;
  /** Section the tile belongs to, used for the grouped layout. */
  group: "modules" | "data" | "access" | "extend" | "admin";
}

const GROUP_LABELS: Record<Tile["group"], string> = {
  modules: "modules + bundles",
  data: "your data",
  access: "people + access",
  extend: "extend + integrate",
  admin: "ops + diagnostics",
};
const GROUP_ORDER: Tile["group"][] = ["modules", "data", "access", "extend", "admin"];

export function ConfigurationPage() {
  const { activeOrg, activeSlug } = useActiveOrg();
  const [modulesOpen, setModulesOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [newThingOpen, setNewThingOpen] = useState(false);

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
        "Per-entity-kind custom field defs — text, number, date, url, with optional dropdown choices.",
      to: "/fields",
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
      icon: FileText,
      label: "OpenAPI",
      description:
        "Auto-generated OpenAPI 3.1 spec — entity-kind schemas + platform paths. Drop into Swagger UI or Insomnia.",
      to: "/configuration/openapi",
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

  const grouped = GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    items: tiles.filter((t) => t.group === group),
  }));

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
          workspace configuration
        </h1>
        {activeOrg && (
          <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
            {activeOrg.name} · {activeSlug} · {activeOrg.role}
          </span>
        )}
      </div>

      <p className="text-sm text-slate-600 dark:text-mortar-200">
        Everything you can configure for this workspace lives here.
      </p>

      {grouped.map(({ group, label, items }) => (
        <section key={group} className="space-y-2">
          <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500">
            // {label}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {items.map((t) => {
              const Icon = t.icon;
              const inner = (
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 hover:border-cobble-300 dark:hover:border-cobble-700 transition flex items-start gap-3 h-full">
                  <Icon size={20} className="text-cobble-500 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-slate-700 dark:text-mortar-100">
                      {t.label}
                    </div>
                    <div className="text-xs text-slate-600 dark:text-mortar-200 mt-1">
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
        </section>
      ))}

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
