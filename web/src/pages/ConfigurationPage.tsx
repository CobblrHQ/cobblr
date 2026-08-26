// /configuration — the workspace control room. Five section cards (plus a
// sixth, Cloud, where the hosted overlay registers panels), each opening a
// section page that holds its own settings.
//
// Before the 2026-07 revamp this was 34 flat tiles with 11 visible and the
// other 23 behind "Show advanced settings" — two whole groups vanished on
// arrival. See docs/design-decisions/configuration-revamp.md.
//
// Distinct from /me ("Your account"): configuration changes how the WORKSPACE
// operates; your account changes how you personally see it.

import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowUpCircle, ChevronRight, Search, UserCircle, X } from "lucide-react";
import {
  CONFIG_SECTIONS,
  CONFIG_SECTION_ORDER,
  HOSTED_SECTION,
  destinationMatches,
  visibleDestinations,
  type ConfigDestination,
} from "../lib/configuration-nav";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { displaySlug } from "../lib/workspaceSlug";
import { usePageTitle } from "@cobblr/platform-web";
import { useHostedPanels, type HostedPanel } from "../lib/useHostedPanels";
import { useConfigVisibility } from "../lib/useConfigVisibility";
import { isFocused } from "../lib/api";
import { useBundleUpdates } from "../lib/useBundleUpdates";
import { useBundleDetail } from "../components/useBundleDetail";

export function ConfigurationPage() {
  usePageTitle("Configuration");
  const { activeOrg, activeSlug } = useActiveOrg();
  const [query, setQuery] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const focused = isFocused(activeOrg);
  const ctx = useConfigVisibility();
  const { panels } = useHostedPanels();

  // Legacy deep links: /configuration?open=modules|members|new-thing.
  useEffect(() => {
    const open = searchParams.get("open");
    if (!open) return;
    const dest: Record<string, string> = {
      modules: "/configuration/modules",
      members: "/configuration/members",
      "new-thing": "/configuration/new-thing",
    };
    const to = dest[open];
    if (to) navigate(to, { replace: true });
    else {
      const next = new URLSearchParams(searchParams);
      next.delete("open");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const q = query.trim();
  const all = visibleDestinations(ctx);

  // Searching bypasses the sections and lists matches flat — when you know the
  // name, the hierarchy is in the way.
  const hits = q ? all.filter((d) => destinationMatches(d, q)) : [];
  const hostedHits = q
    ? panels.filter((p) => p.label.toLowerCase().includes(q.toLowerCase()))
    : [];

  const sections = CONFIG_SECTION_ORDER.map((id) => ({
    id,
    meta: CONFIG_SECTIONS[id],
    items: all.filter((d) => d.section === id),
  })).filter((s) => s.items.length > 0);

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100">
          Configuration
        </h1>
        {activeOrg && (
          <span className="text-[10px] font-mono text-faint dark:text-slate-500">
            {activeOrg.name} · {displaySlug(activeSlug)} · {activeOrg.role}
          </span>
        )}
      </div>

      {focused ? (
        <SimpleModeCard />
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

          {q ? (
            <SearchResults hits={hits} hosted={hostedHits} query={q} />
          ) : (
            <>
              <BundleUpdatesCallout slug={activeSlug} />

              {/* Every destination is admin-gated, so a member's filtered view
                  is empty — and an empty grid with no words reads as a broken
                  page, not a permissions boundary. Say what this area is and
                  where THEIR settings live instead. */}
              {sections.length === 0 && panels.length === 0 && (
                <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-6 text-center space-y-2">
                  <div className="font-medium text-content dark:text-mortar-100">
                    Workspace configuration is managed by this workspace's admins.
                  </div>
                  <p className="text-sm text-muted dark:text-slate-400">
                    Your own settings - appearance, notifications, connections - live under{" "}
                    <Link to="/me" className="text-accent hover:underline">
                      Your account
                    </Link>
                    .
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {sections.map(({ id, meta, items }) => (
                  <SectionCard
                    key={id}
                    to={`/configuration/s/${id}`}
                    icon={<meta.icon size={18} />}
                    label={meta.label}
                    blurb={meta.blurb}
                    count={items.length}
                    leaves={items}
                    action={meta.action}
                  />
                ))}
                {panels.length > 0 && (
                  <SectionCard
                    to={`/configuration/s/${HOSTED_SECTION.id}`}
                    icon={<HOSTED_SECTION.icon size={18} />}
                    label={HOSTED_SECTION.label}
                    blurb={HOSTED_SECTION.blurb}
                    count={panels.length}
                    leaves={panels.map((p) => ({
                      label: p.label,
                      to: `/configuration/x/${p.id}`,
                    }))}
                  />
                )}
              </div>

              {/* The recurring "where do I change MY stuff" dead-end. The
                  rename shipped and the pair (this card + /me's mirror) still
                  earns its keep - kept deliberately, not pending anything. */}
              <Link
                to="/me"
                className="flex items-center gap-3 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-4 py-3 hover:border-cobble-300 dark:hover:border-cobble-700 transition"
              >
                <UserCircle size={18} className="text-accent shrink-0" />
                <span className="text-sm text-content dark:text-mortar-200">
                  Looking for <span className="font-medium">your account</span> - profile,
                  appearance, notifications, your own AI connections?
                </span>
                <ChevronRight size={14} className="ml-auto shrink-0 text-faint dark:text-slate-500" />
              </Link>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** A section card. The leaf names are LINKS, not decoration: a frequent
 *  destination stays one click from the hub instead of becoming
 *  hub → section → leaf. */
/** Exported for ConfigurationPage.render.test.tsx, which renders the REAL card
 *  to prove the action is a link. A test that mirrors the call site instead
 *  would assert only its own markup. */
export function SectionCard({
  to,
  icon,
  label,
  blurb,
  count,
  leaves,
  action,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  blurb: string;
  count: number;
  leaves: Array<{ label: string; to: string }>;
  /** This section's one primary DO. Rendered as a real link in the header,
   *  opposite the count — never in the leaf line below, which is a list of
   *  places you GO (rule 3 in configuration-nav.ts). */
  action?: { label: string; to: string };
}) {
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 hover:border-cobble-300 dark:hover:border-cobble-700 transition">
      <div className="flex items-center gap-2.5">
        <Link to={to} className="flex items-center gap-2.5 min-w-0">
          <span className="w-8 h-8 rounded-lg bg-accent/10 text-accent grid place-items-center shrink-0">
            {icon}
          </span>
          <div className="font-medium text-content dark:text-mortar-100 truncate">{label}</div>
        </Link>
        {/* Beside the TITLE, not out at the right edge. It acts on this
            section, so it reads as "Build → new category"; floated right it
            competed with the count for the same corner and belonged to
            neither. Amber fill because it is the one thing on this card you
            DO — the border-only version sat back far enough to be missed. */}
        {action && (
          <Link
            to={action.to}
            className="inline-flex items-center rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-2.5 py-1 transition"
          >
            {action.label}
          </Link>
        )}
        <span className="ml-auto text-[11px] font-mono text-faint dark:text-slate-500 shrink-0">
          {count}
        </span>
      </div>
      <Link to={to} className="block">
        <p className="mt-2 text-sm text-content dark:text-mortar-200">{blurb}</p>
      </Link>
      <div className="mt-2.5 text-xs text-faint dark:text-slate-500 leading-relaxed">
        {leaves.map((l, i) => (
          <span key={l.to}>
            {i > 0 && " · "}
            <Link to={l.to} className="hover:text-accent hover:underline">
              {l.label}
            </Link>
          </span>
        ))}
      </div>
    </div>
  );
}

function SearchResults({
  hits,
  hosted,
  query,
}: {
  hits: ConfigDestination[];
  hosted: HostedPanel[];
  query: string;
}) {
  if (hits.length === 0 && hosted.length === 0) {
    return (
      <p className="text-sm text-faint dark:text-slate-500">
        No configuration matches “{query}”.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {hits.map((d) => (
        <Link
          key={d.to}
          to={d.to}
          className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 hover:border-cobble-300 dark:hover:border-cobble-700 transition flex items-start gap-3"
        >
          <d.icon size={20} className="text-accent mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium text-content dark:text-mortar-100">{d.label}</div>
            <div className="text-xs text-content dark:text-mortar-200 mt-1">
              {d.description}
            </div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-faint mt-1.5">
              {CONFIG_SECTIONS[d.section].label}
            </div>
          </div>
        </Link>
      ))}
      {hosted.map((p) => (
        <Link
          key={p.id}
          to={`/configuration/x/${p.id}`}
          className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 hover:border-cobble-300 dark:hover:border-cobble-700 transition flex items-start gap-3"
        >
          <HOSTED_SECTION.icon size={20} className="text-accent mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium text-content dark:text-mortar-100">{p.label}</div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-faint mt-1.5">
              {HOSTED_SECTION.label}
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

function SimpleModeCard() {
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 text-sm text-content dark:text-mortar-200 space-y-2">
      <p className="font-medium text-content dark:text-mortar-100">
        Simple mode is on - builder tools are tucked away.
      </p>
      <p>
        Modules, bundles, custom fields, connections and the rest of the control room are
        hidden for a calm, everyday workspace. Turn simple mode off in{" "}
        <Link to="/configuration/general" className="text-accent underline">
          Workspace → General
        </Link>{" "}
        whenever you want to configure or extend things - nothing was removed.
      </p>
    </div>
  );
}

// ─────────────── "Needs your attention" — pending bundle updates ───────────────
// The nav shows an amber badge on Configuration when an installed bundle has a
// newer catalog version; this names each pending update and links straight to
// the place to apply it. Renders nothing when everything is up to date.
function BundleUpdatesCallout({ slug }: { slug: string }) {
  const updates = useBundleUpdates(slug);
  // Opens right here, not by navigating to the bundles page (house rule: a
  // modal shows up on the page it was invoked from).
  const bundleDetail = useBundleDetail(slug);
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
              onClick={() => bundleDetail.open(u.externalId)}
              className="shrink-0 rounded bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium px-2.5 py-1"
            >
              Update
            </button>
          </div>
        ))}
        {bundleDetail.element}
      </div>
    </section>
  );
}
