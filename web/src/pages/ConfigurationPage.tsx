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
  ChevronRight,
  FileText,
  Files,
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
  Sliders,
  Sparkles,
  Tag,
  Shield,
  Users,
  Wrench,
} from "lucide-react";
import { ModulePickerModal } from "../components/ModulePickerModal";
import { MembersModal } from "../components/MembersModal";
import { NewThingFunnelModal } from "../components/NewThingFunnelModal";
import { NavCustomizeMenu } from "../components/NavCustomizeMenu";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { displaySlug } from "../lib/workspaceSlug";
import { usePageTitle, useToast } from "@cobblr/platform-web";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

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
  modules: "set up your workspace",
  data: "customize your data",
  access: "people & access",
  extend: "connect & automate",
  admin: "system & diagnostics",
};
const GROUP_ORDER: Tile["group"][] = ["modules", "data", "access", "extend", "admin"];
// Only the essential "set up" group is expanded on arrival; the rest start
// collapsed so the page reads as a short menu, not a 35-card wall.
const DEFAULT_OPEN: Record<Tile["group"], boolean> = {
  modules: true,
  data: false,
  access: false,
  extend: false,
  admin: false,
};

export function ConfigurationPage() {
  usePageTitle("Configuration");
  const { activeOrg, activeSlug } = useActiveOrg();
  const [modulesOpen, setModulesOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [newThingOpen, setNewThingOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(DEFAULT_OPEN);

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
      icon: QrCode,
      label: "QR codes",
      description:
        "Every QR token the workspace has minted — what each points at, whether it's public, when it expires. Copy a scan URL or revoke a token whose printed label walked off.",
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
      label: "Digital Fabrication",
      description:
        "Send a design file to the software that runs your machine — FDM Monster, OctoPrint + — and track the job to completion. Map its printers to your machines and route files to them. Sends files; never drives hardware.",
      to: "/configuration/digifab",
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

  const grouped = GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    items: tiles.filter((t) => t.group === group),
  }));

  return (
    <div className="space-y-5 max-w-4xl">
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

      <p className="text-sm text-content dark:text-mortar-200">
        Start with <span className="font-medium">Set up your workspace</span> — turn on the
        modules you want or install a starter pack. The rest is optional and opens when you
        need it.
      </p>

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

      {grouped.map(({ group, label, items }) => {
        const open = openGroups[group] ?? false;
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
