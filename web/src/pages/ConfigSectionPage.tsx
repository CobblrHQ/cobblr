// /configuration/s/:section — one section of workspace configuration. Lists the
// destinations that belong to it, plus the section's primary ACTION as a button
// (rule 3 of the revamp: a destination is a place you go, a button is a thing
// you do — "+ New thing" is a create wizard, not a page).
//
// The Cloud section is fed by the hosted overlay's panels rather than the
// registry, so a self-hosted instance never renders it.

import { Link, Navigate, useParams } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { usePageTitle } from "@cobblr/platform-web";
import {
  CONFIG_SECTIONS,
  CONFIG_SECTION_ORDER,
  HOSTED_SECTION,
  visibleDestinations,
  type ConfigSection,
} from "../lib/configuration-nav";
import { useConfigVisibility } from "../lib/useConfigVisibility";
import { useHostedPanels } from "../lib/useHostedPanels";
import { iconForName as iconForPanel } from "../lib/panel-icons";

interface Row {
  label: string;
  description: string;
  to: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

export function ConfigSectionPage() {
  const { section } = useParams<{ section: string }>();
  const ctx = useConfigVisibility();
  const { panels, isLoading: panelsLoading } = useHostedPanels();

  const isHosted = section === HOSTED_SECTION.id;
  const known =
    isHosted || CONFIG_SECTION_ORDER.includes(section as ConfigSection);

  const meta = isHosted
    ? { label: HOSTED_SECTION.label, blurb: HOSTED_SECTION.blurb, icon: HOSTED_SECTION.icon, action: undefined }
    : known
      ? CONFIG_SECTIONS[section as ConfigSection]
      : undefined;

  usePageTitle(meta?.label ?? "Configuration");

  if (!known) return <Navigate to="/configuration" replace />;

  const rows: Row[] = isHosted
    ? panels.map((p) => ({
        label: p.label,
        description: "",
        to: `/configuration/x/${p.id}`,
        icon: iconForPanel(p.icon),
      }))
    : visibleDestinations(ctx)
        .filter((d) => d.section === section)
        .map((d) => ({ label: d.label, description: d.description, to: d.to, icon: d.icon }));

  // A hosted section with no panels means this isn't the hosted deployment.
  if (isHosted && !panelsLoading && panels.length === 0) {
    return <Navigate to="/configuration" replace />;
  }

  const Icon = meta!.icon;
  const action = !isHosted ? CONFIG_SECTIONS[section as ConfigSection].action : undefined;

  return (
    <div className="space-y-5">
      <Link
        to="/configuration"
        className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400 hover:text-accent"
      >
        <ChevronLeft size={13} /> all of configuration
      </Link>

      <div className="flex items-center gap-3 border-b border-line dark:border-slate-700 pb-3">
        <span className="w-9 h-9 rounded-lg bg-accent/10 text-accent grid place-items-center shrink-0">
          <Icon size={19} />
        </span>
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100">
            {meta!.label}
          </h1>
          <p className="text-xs text-faint dark:text-slate-500 mt-0.5">{meta!.blurb}</p>
        </div>
        {action && (
          <Link
            to={action.to}
            className="ml-auto shrink-0 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5"
          >
            {action.label}
          </Link>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-faint dark:text-slate-500">
          Nothing here for this workspace yet.
        </p>
      ) : (
        <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 divide-y divide-line dark:divide-slate-700 overflow-hidden">
          {rows.map((r) => (
            <Link
              key={r.to}
              to={r.to}
              className="flex items-start gap-3 px-4 py-3.5 hover:bg-subtle dark:hover:bg-slate-800/60 transition"
            >
              <r.icon size={18} className="text-accent mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm text-content dark:text-mortar-100">
                  {r.label}
                </div>
                {r.description && (
                  <div className="text-xs text-content dark:text-mortar-200 mt-0.5">
                    {r.description}
                  </div>
                )}
              </div>
              <ChevronRight size={14} className="shrink-0 text-faint dark:text-slate-500 mt-1" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
