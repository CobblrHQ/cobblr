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
  LayoutList,
  Link2,
  MousePointerClick,
  Package,
  Plug,
  Sliders,
  Tag,
  Users,
  Wrench,
} from "lucide-react";
import { ModulePickerModal } from "../components/ModulePickerModal";
import { MembersModal } from "../components/MembersModal";
import { useActiveOrg } from "../auth/ActiveOrgContext";

interface Tile {
  icon: typeof Wrench;
  label: string;
  description: string;
  to?: string;
  onClick?: () => void;
}

export function ConfigurationPage() {
  const { activeOrg, activeSlug } = useActiveOrg();
  const [modulesOpen, setModulesOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);

  const tiles: Tile[] = [
    {
      icon: Boxes,
      label: "Modules",
      description:
        "Enable / disable modules and their specialisations for this workspace.",
      onClick: () => setModulesOpen(true),
    },
    {
      icon: Package,
      label: "Bundles",
      description:
        "One-click presets that ship a set of custom fields and wires. Browse the featured catalog, paste a manifest, or export your own.",
      to: "/bundles",
    },
    {
      icon: Plug,
      label: "Wires",
      description:
        "Event-triggered or click-triggered actions that connect modules. The user-editable connector layer.",
      to: "/bindings",
    },
    {
      icon: MousePointerClick,
      label: "Actions",
      description:
        "Tune which entities each cross-module action appears on — broaden or narrow a trait predicate per-axis.",
      to: "/actions",
    },
    {
      icon: Sliders,
      label: "Custom fields",
      description:
        "Per-entity-kind custom field defs — text, number, date, url, with optional dropdown choices.",
      to: "/fields",
    },
    {
      icon: Users,
      label: "Members + invites",
      description:
        "Invite collaborators to this workspace, change roles, revoke access.",
      onClick: () => setMembersOpen(true),
    },
    {
      icon: Activity,
      label: "Activity log",
      description:
        "Every mutation, attributed to who (UI / api token / system) and when. Filterable.",
      to: "/activity",
    },
    {
      icon: KeyRound,
      label: "API tokens",
      description:
        "Long-lived `cbt_*` tokens for CLI / AI / automation. Mint, list, revoke.",
      to: "/configuration/tokens",
    },
    {
      icon: Globe,
      label: "Public surfaces",
      description:
        "Token-gated URLs that share a saved view with anyone — no account needed.",
      to: "/configuration/surfaces",
    },
    {
      icon: HeartPulse,
      label: "Healthcheck",
      description:
        "Live status rollup of every module's probes. Polled every 30s; 503 on red.",
      to: "/configuration/health",
    },
    {
      icon: Link2,
      label: "Workspace links",
      description:
        "Cross-workspace data sharing — read selected entity kinds from another workspace you own (or invite-share). Accept / revoke per link.",
      to: "/configuration/links",
    },
    {
      icon: LayoutList,
      label: "Saved views",
      description:
        "List / table / kanban views over your entities. Saved here, renderable from the dashboard, publishable as public surfaces.",
      to: "/views",
    },
    {
      icon: Tag,
      label: "Tags",
      description:
        "Cross-cutting labels you can attach to anything. Filter by tag in saved views or searches.",
      to: "/tags",
    },
    {
      icon: Files,
      label: "Files",
      description:
        "Uploaded photos / docs. Files attach to entities via the Tags + Files panel on each detail page.",
      to: "/files",
    },
    {
      icon: FileText,
      label: "OpenAPI",
      description:
        "Auto-generated OpenAPI 3.1 spec — entity-kind schemas + platform paths. Drop into Swagger UI or Insomnia.",
      to: "/configuration/openapi",
    },
  ];

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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {tiles.map((t) => {
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

      <ModulePickerModal
        open={modulesOpen}
        onClose={() => setModulesOpen(false)}
      />
      <MembersModal
        open={membersOpen}
        onClose={() => setMembersOpen(false)}
        slug={activeSlug}
      />
    </div>
  );
}
