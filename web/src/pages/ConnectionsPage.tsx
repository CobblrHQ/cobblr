// /me/connections — personal (user-scoped) connections manager.
//
// Configure a BYO AI provider (your own Ollama / OpenAI / Anthropic key, or the
// local-AI edge bridge) ONCE, then route it to chosen workspaces so it follows
// you instead of being re-added per workspace. Secrets are write-only — the
// list shows which keys are set, never the values.

import { aiAvailabilityKeys } from "../lib/ai-availability-keys";
import { useEffect, useMemo, useState } from "react";
import { ServiceSetup } from "../components/ServiceSetup";
import { WorkspaceIntegrations } from "../components/WorkspaceIntegrations";
import { useActiveOrgOptional } from "../auth/ActiveOrgContext";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { useSearchParams } from "react-router-dom";
import { incumbentConnection, routedConnectionsOfKind } from "../lib/incumbent-connection";
import { initialPick } from "../lib/connection-pick";
import { MailSourceRow, OAuthConnectPanel } from "../components/MailSourceCard";
import { CredentialFields } from "../components/CredentialFields";
import { ProviderSetupSteps } from "../components/ProviderSetupSteps";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { backupOffers, backupSummary, type BackupOffer } from "../lib/connection-backup";
import { Pencil, Plug, Plus, Trash2, X } from "lucide-react";
import { useStillAsking, useToast, useConfirm, usePageTitle, SegmentedChoice } from "@cobblr/platform-web";
import { YourAiDefaults } from "../components/YourAiDefaults";
import { TestConnectionButton, VerificationBadge, VerificationLine } from "../components/ConnectionState";
import { keyRefusedBy, refusalDialog, verificationToast } from "../lib/connection-state";
import { connectionRemovalPlan } from "../lib/connection-removal";
import {
  ApiError,
  api,
  type AiProviderDef,
  CONNECTION_KIND_LABELS,
  type ConnRoute, type ConnRouteMode,
  type ConnRouteScope,
  type ConnectionVerification,
  type UserConnection,
  type UserConnectionInput,
} from "../lib/api";
import { isEdgeBridgeConnection } from "../lib/useMyEdgeBridge";

/** Kinds whose connections carry a verification: tested on save and from the
 *  card's Test button. */
const TESTABLE_KINDS = new Set(["ai-provider", "service"]);

const MODE_LABEL: Record<ConnRouteMode, string> = {
  "my-calls": "Only calls I personally make",
  "workspace-default": "Everyone + automations in the workspace",
};
const SCOPE_LABEL: Record<ConnRouteScope, string> = {
  sole_member: "Workspaces where I'm the only member",
  owner: "Workspaces I own",
  all_mine: "All my workspaces",
  explicit: "Specific workspaces",
};

/** `startAdding` opens the add form on arrival — the "+ Add a connection"
 *  action on the account hub lands here, and landing on the list you were
 *  already one click from would make the button a second link to a page rather
 *  than a thing you do (configuration-revamp.md § Section actions). */
export function ConnectionsPage({ startAdding = false }: { startAdding?: boolean } = {}) {
  usePageTitle("Connections");
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const workspace = useActiveOrgOptional();
  const conns = useQuery({ queryKey: aiAvailabilityKeys.connections(), queryFn: api.listConnections });
  // Where each AI connection could stand behind another you already route.
  const offers = backupOffers(conns.data?.items ?? [], (c) => c.label || providerLabel(c.provider_id));
  const addBackup = useMutation({
    mutationFn: ({ id, routes }: { id: string; routes: ConnRoute[] }) => api.updateConnection(id, { routes }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: aiAvailabilityKeys.connections() }),
    onError: (e: unknown) => toast.error(`Couldn't add it as a backup: ${e instanceof Error ? e.message : "try again"}`),
  });
  const catalogue = useQuery({ queryKey: ["conn-catalogue"], queryFn: api.connectionCatalogue });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const hasAi = (conns.data?.items ?? []).some((c) => c.kind === "ai-provider");
  // The same read YourAiDefaults makes, so the page can wait for it.
  const aiDefaults = useQuery({ queryKey: aiAvailabilityKeys.myDefaults(), queryFn: () => api.getMyAiDefaults(), enabled: hasAi });
  const asking = useStillAsking(conns, catalogue, me, ...(hasAi ? [aiDefaults] : []));
  // Which kind the add form opens on: Add a service starts on the service
  // kind, Add a connection on whatever leads the list.
  // Another page can send a person here to connect a service for one job
  // ("Connect a slicer" on a Make): ?add=service&capability=slice.model opens
  // Add a service already asking for that job.
  const [initialParams] = useSearchParams();
  // Reconnect on a record's library sends ?add=service&provider=adapter:<id>
  // &label=&address=: the form opens on that same library, its name and
  // address filled, asking only for the token again (#5876).
  const [adding, setAdding] = useState<false | { provider: string | null; capability?: string | null; label?: string | null; address?: string | null }>(() =>
    initialParams.get("add") === "service"
      ? {
          provider: /^adapter:[a-z0-9-]+$/.test(initialParams.get("provider") ?? "") ? initialParams.get("provider") : "service",
          capability: initialParams.get("capability"),
          label: initialParams.get("label"),
          address: initialParams.get("address"),
        }
      : startAdding
        ? { provider: null }
        : false,
  );
  const [editing, setEditing] = useState<UserConnection | null>(null);
  // Google sends the browser back here with one word in the query; say it
  // once and take it out of the address bar so a reload does not say it again.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const word = params.get("gmail");
    if (!word) return;
    const said: Record<string, () => void> = {
      connected: () => toast.success("Gmail connected. Reading store mail from the last 7 days, then as it arrives."),
      reconnected: () => toast.success("Gmail reconnected."),
      denied: () => toast.error("Gmail was not connected: access was declined on Google's screen."),
      error: () => toast.error("Gmail could not be connected. Try again; if it keeps failing, the server's Google client may be misconfigured."),
    };
    (said[word] ?? said.error)!();
    const next = new URLSearchParams(params);
    next.delete("gmail");
    setParams(next, { replace: true });
    // toast is stable; params is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const orgs = me.data?.orgs ?? [];
  const providers = catalogue.data?.items ?? [];
  const providerLabel = (id: string) => providers.find((p) => p.id === id)?.label ?? id;
  const orgName = (id: string) => orgs.find((o) => o.id === id)?.name ?? id;

  const del = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => {
      toast.success("Connection removed.");
      void qc.invalidateQueries({ queryKey: aiAvailabilityKeys.connections() });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const removeConnection = async (c: UserConnection) => {
    const provider = providers.find((p) => p.id === c.provider_id);
    const plan = connectionRemovalPlan(c, provider);
    if (await confirm({
      ...plan,
      confirmLabel: "Remove",
      destructive: true,
    })) del.mutate(c.id);
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted dark:text-slate-400">
        Set up a service of your own once - an AI provider, a parcel-tracking account,
        a slicer you installed - and route it to the workspaces you choose. It follows you instead of being
        re-added per workspace. Secrets are stored encrypted and never shown again.
      </p>

      {/* The page draws once its reads answer: drawn as each came, the AI
          defaults and Add a service arrived above and beside Add a connection
          and moved it 100 to 250 px under a finger (#7795). */}
      {asking && <div className="text-sm text-faint">loading…</div>}
      {!asking && <>
      {!conns.isLoading && (conns.data?.items.length ?? 0) === 0 && !adding && (
        <div className="rounded-md border border-dashed border-line dark:border-slate-700 p-8 text-center">
          <Plug size={26} className="mx-auto text-faint dark:text-slate-600 mb-2" />
          <div className="text-sm text-muted dark:text-slate-400">No personal connections yet.</div>
        </div>
      )}

      <div className="space-y-2">
        {(conns.data?.items ?? []).map((c) => (
          // An accordion, not a form that opens somewhere else. Editing used to
          // append a panel at the FOOT of the page, so the thing you pressed
          // stayed where it was and the thing that answered appeared past the
          // end of the list — with several connections you had to scroll away
          // from the one you were editing to edit it.
          <div
            key={c.id}
            className={
              "rounded-xl border bg-surface dark:bg-slate-900 " +
              (editing?.id === c.id
                ? "border-cobble-500 dark:border-cobble-600"
                : "border-line dark:border-slate-700")
            }
          >
          <div className="p-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="font-medium text-content dark:text-mortar-100 flex items-center gap-2 flex-wrap">
                <span>{c.label || providerLabel(c.provider_id)}</span>
                <span className="text-[11px] font-mono text-faint">{c.provider_id}</span>
                {TESTABLE_KINDS.has(c.kind) && <VerificationBadge verification={c.verification} />}
              </div>
              {TESTABLE_KINDS.has(c.kind) && <VerificationLine verification={c.verification} />}
              <div className="text-[11px] text-muted mt-0.5">
                {c.routes.length === 0 ? (
                  c.route_scope === "explicit" ? (
                    <span className={c.kind === "ai-provider" ? "text-amber-600 dark:text-amber-500" : undefined}>
                      Not used in any workspace{c.kind === "ai-provider" ? ", so it never answers there, not even as a backup" : ""}
                    </span>
                  ) : (
                    `${MODE_LABEL[c.route_mode]} · ${SCOPE_LABEL[c.route_scope]}`
                  )
                ) : (
                  <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
                    {c.routes.map((r) => {
                      const shared = r.mode === "workspace-default";
                      // Only 'shared' routes carry an approval state; 'just me'
                      // always works for the owner so it needs no badge.
                      const status = shared ? c.share_status[r.org_id] : undefined;
                      return (
                        <span key={r.org_id} className="inline-flex items-center gap-1">
                          {orgName(r.org_id)} ({shared ? "shared" : "just me"})
                          {status === "pending" && (
                            <span className="text-amber-600 dark:text-amber-500">
                              · awaiting owner approval
                            </span>
                          )}
                          {status === "approved" && <span className="text-faint">· approved</span>}
                          {status === "active" && (
                            <span className="text-emerald-600 dark:text-emerald-500">· active</span>
                          )}
                        </span>
                      );
                    })}
                  </span>
                )}
              </div>
              <BackupOffersRow
                offers={offers.get(c.id) ?? []}
                orgName={orgName}
                pending={addBackup.isPending}
                onAdd={(picked) => addBackup.mutate({ id: c.id, routes: [...c.routes, ...picked.map((o) => ({ org_id: o.org_id, mode: o.mode }))] })}
              />
              {c.credential_keys.length > 0 && (
                <div className="text-[11px] text-faint mt-0.5">
                  set: {c.credential_keys.join(", ")}
                </div>
              )}
              {isEdgeBridgeConnection(c) && <EdgeBridgeStatusRow verified={c.verification?.state === "verified"} />}
              {c.kind === "mail-source" && <MailSourceRow connection={c} orgName={orgName} />}
            </div>
            <div className="flex items-center shrink-0">
              <button
                aria-label={editing?.id === c.id ? "Close" : "Edit connection"}
                type="button"
                onClick={() => {
                  setEditing((cur) => (cur?.id === c.id ? null : c));
                  setAdding(false);
                }}
                className={
                  "p-1.5 transition " +
                  (editing?.id === c.id ? "text-accent" : "text-faint hover:text-accent")
                }
                title={editing?.id === c.id ? "Close" : "Edit connection"}
                aria-expanded={editing?.id === c.id}
              >
                <Pencil size={14} />
              </button>
              {TESTABLE_KINDS.has(c.kind) && (
                <TestConnectionButton test={() => api.testStoredConnection(c.id)} invalidate={[aiAvailabilityKeys.connections()]} className="text-[11px] px-2 py-1 rounded border border-line dark:border-slate-700 text-faint hover:text-accent" />
              )}
              <button
                aria-label="Remove"
                type="button"
                onClick={() => void removeConnection(c)}
                className="text-faint hover:text-ember-500 p-1.5"
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          {editing?.id === c.id && (
            <div className="border-t border-line dark:border-slate-700 p-3">
              <ConnectionForm
                key={c.id}
                providers={providers}
                orgs={orgs}
                others={(conns.data?.items ?? []).filter((o) => o.id !== c.id)}
                existing={c}
                onDone={() => {
                  setEditing(null);
                  void qc.invalidateQueries({ queryKey: aiAvailabilityKeys.connections() });
                }}
                onCancel={() => setEditing(null)}
              />
            </div>
          )}
          </div>
        ))}
      </div>

      {(conns.data?.items ?? []).some((c) => c.kind === "ai-provider") && <YourAiDefaults connections={conns.data?.items ?? []} />}

      {adding ? (
        <ConnectionForm
          key={`new-${adding.provider ?? ""}`}
          initialProviderId={adding.provider}
          initialLabel={adding.label ?? null}
          initialAddress={adding.address ?? null}
          wantCapability={adding.capability ?? null}
          providers={providers}
          orgs={orgs}
          others={conns.data?.items ?? []}
          existing={null}
          onDone={() => {
            setAdding(false);
            void qc.invalidateQueries({ queryKey: aiAvailabilityKeys.connections() });
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setAdding({ provider: null })}
            className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5"
          >
            <Plus size={15} /> Add a connection
          </button>
          {providers.some((p) => p.kind === "service") && (
            <button
              type="button"
              onClick={() => setAdding({ provider: "service" })}
              className="inline-flex items-center gap-2 rounded border border-cobble-600 text-cobble-700 dark:text-cobble-300 hover:bg-cobble-50 dark:hover:bg-cobble-900/30 text-sm font-medium px-3 py-1.5"
            >
              <Plus size={15} /> Add a service
            </button>
          )}
        </div>
      )}
      {workspace?.activeOrg && <WorkspaceIntegrations
        slug={workspace.activeSlug}
        name={workspace.activeOrg.name}
        canEnable={roleSatisfies(workspace.activeOrg.role, ["owner", "admin"])}
        offers={!!adding && adding.provider === "service"}
      />}
      </>}
    </div>
  );
}

/** A worked example for the "Label" box, in terms of the provider you picked.
 *
 *  It was the literal string "e.g. My home Ollama" for every provider, so
 *  choosing Google AI Studio suggested you name it after a different product
 *  entirely. A field that names one vendor while you are configuring another is
 *  the hardcoded-example smell: it reads as a leftover, because it is one.
 *
 *  The parenthetical is dropped: a provider is labelled "Ollama (local)" or
 *  "Google AI Studio (free tier)" so the PICKER can tell them apart, and
 *  "My Google AI Studio (free tier)" is not a name anyone would type.
 *
 *  With nothing picked yet there is no honest example, so there is no
 *  placeholder rather than a made-up one. */
export function labelPlaceholder(providerLabel: string | undefined): string {
  const name = (providerLabel ?? "").replace(/\s*\([^)]*\)\s*/g, " ").trim();
  return name ? `e.g. My ${name}` : "";
}

function ConnectionForm({
  providers,
  orgs,
  others,
  existing,
  initialProviderId = null,
  initialLabel = null,
  initialAddress = null,
  wantCapability = null,
  onDone,
  onCancel,
}: {
  /** The provider the add form opens on (Add a service: "service"). */
  initialProviderId?: string | null;
  /** A library connected again: its name and address, never its token. */
  initialLabel?: string | null;
  initialAddress?: string | null;
  /** The job a service is being connected for, when a page sent the person here. */
  wantCapability?: string | null;
  providers: AiProviderDef[];
  orgs: Array<{ id: string; name: string; role: string }>;
  /** My OTHER connections, so a workspace that already has one can say so
   *  BEFORE this one silently takes over by being the more recently saved. */
  others: UserConnection[];
  existing: UserConnection | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const isEdit = !!existing;
  // DERIVED from the list, not captured from it once.
  //
  // `useState(providers[0]?.id ?? "")` reads the catalogue on the FIRST render,
  // and on that render the query has not resolved, so `providers` is empty and
  // the state is "". useState never re-runs its initialiser, so the state stays
  // "" after the list arrives.
  //
  // The bug that made visible is subtle, because the <select> LOOKS right: a
  // value matching no <option> makes the browser display option 0 and report
  // ITS value from `select.value`. So the control showed "Google AI Studio",
  // and reading the DOM agreed — while React still held "", so
  // `providers.find(p => p.id === "")` was undefined and the form rendered
  // "This provider needs no credentials" with no API-key field. Picking ANY
  // provider, even the one already displayed, fixed it (2026-08-22).
  //
  // Holding only the user's CHOICE and deriving the rest means the two cannot
  // disagree: before a choice, the value IS whatever leads the list.
  const [picked, setPicked] = useState<string | null>(initialPick(existing, initialProviderId));
  const providerId = picked ?? providers[0]?.id ?? "";
  const setProviderId = setPicked;
  const [label, setLabel] = useState(existing?.label ?? initialLabel ?? "");
  // Pre-fill the NON-SECRET fields (base_url, choices like transit / mcp_relay,
  // model) from the saved connection so the form shows what's actually stored —
  // a dropdown especially must reflect its saved value, not snap to the default.
  // Secrets aren't returned; they stay blank ("unchanged").
  const [creds, setCreds] = useState<Record<string, string>>(existing?.credential_values ?? (initialAddress ? { base_url: initialAddress } : {}));
  // Per-workspace routing: org_id → mode. Absence = "Off". Seeded from the
  // connection's saved routes; a dynamic-scope (legacy) connection seeds from
  // its global mode applied to whichever workspaces it currently reaches.
  // Workspaces where THIS connection should be the one that serves. Only asked
  // about when another of mine is already routed there — otherwise there is
  // nothing to choose between and no question worth putting on screen.
  const [takeOver, setTakeOver] = useState<Record<string, boolean>>({});
  // Yours and other people's are different decisions: routing a key into a
  // workspace you own is between you and yourself; offering it to someone
  // else's is a share they have to accept. The workspace switcher splits them
  // with these exact words, so this uses them rather than inventing a second
  // vocabulary for the same distinction.
  const orgSections = [
    { label: "your workspaces", items: orgs.filter((o) => o.role === "owner") },
    { label: "shared with you", items: orgs.filter((o) => o.role !== "owner") },
  ].filter((g) => g.items.length > 0);
  const [perWs, setPerWs] = useState<Record<string, ConnRouteMode>>(() => {
    if (existing?.routes?.length) return Object.fromEntries(existing.routes.map((r) => [r.org_id, r.mode]));
    if (!existing) return {};
    // Legacy dynamic-scope connection: reconstruct which workspaces it currently
    // reaches from its scope, so editing doesn't silently drop the routing.
    const m = existing.route_mode;
    if (existing.route_scope === "all_mine") return Object.fromEntries(orgs.map((o) => [o.id, m]));
    if (existing.route_scope === "owner")
      return Object.fromEntries(orgs.filter((o) => o.role === "owner").map((o) => [o.id, m]));
    return Object.fromEntries(existing.org_ids.map((id) => [id, m]));
  });

  const provider = useMemo(() => providers.find((p) => p.id === providerId), [providers, providerId]);
  const connectionKind = provider?.kind ?? existing?.kind ?? null;
  const incumbentFor = (orgId: string) =>
    connectionKind ? incumbentConnection(others, orgId, connectionKind) : null;
  // A service at an address has its own panel (where it is, what it offers,
  // its key). An adapter (a third-party API Cobblr speaks itself) is kind
  // service too, but is configured by its own fields like any provider.
  const isService = provider?.id === "service";
  const serviceKindOnly = initialProviderId === "service" || existing?.kind === "service";
  // The service's own name, once its manifest is read: the label's default.
  const [serviceName, setServiceName] = useState<string | null>(null);
  const credFields = Object.entries(provider?.credentials ?? {});

  const confirm = useConfirm();
  // The server tests a new or replaced key before the connection is
  // presented as ready (#2895). A key the provider rejects answers 409
  // key_invalid and is saved only when the person says so, as unverified;
  // a refused replacement leaves the working key in place.
  const save = useMutation({
    mutationFn: async (confirmUnverified?: boolean) => {
      // NON-secret fields (base_url, choices, model) always ride — their current
      // value fully represents the desired state (a choice's "" is a real pick,
      // e.g. "standard", not "keep"). SECRETS only ride when re-typed (blank =
      // keep); the server MERGES, so a blank secret keeps its stored value.
      const cleanCreds: Record<string, unknown> = {};
      for (const [key, def] of credFields) {
        const v = creds[key] ?? "";
        if (def.secret) {
          if (v.trim() !== "") cleanCreds[key] = v;
        } else {
          cleanCreds[key] = v;
        }
      }
      const routes = Object.entries(perWs).map(([org_id, mode]) => ({ org_id, mode }));
      // Workspaces where you said "use this one" over the connection already
      // serving them. Applied after the save, because a new connection has no
      // id until then.
      const claiming = Object.entries(takeOver)
        .filter(([orgId, yes]) => yes && perWs[orgId])
        .map(([orgId]) => orgId);
      const claimAll = async (credentialId: string) => {
        // One failure must not lose the save that already succeeded, so each is
        // reported and the rest continue.
        for (const org_id of claiming) {
          try {
            // This one first, then whatever else of mine is already here.
            const rest = connectionKind
              ? routedConnectionsOfKind(others, org_id, connectionKind)
                  .map((c) => c.id)
              : [];
            await api.setConnectionOrder({ org_id, credential_ids: [credentialId, ...rest] });
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : String(e));
          }
        }
      };
      if (isEdit) {
        // On edit, only send credentials the user actually re-entered (blank = keep).
        const secretsRetyped = credFields.some(([key, def]) => def.secret && (creds[key] ?? "").trim() !== "");
        const updated = await api.updateConnection(existing!.id, {
          label: label.trim(),
          ...(Object.keys(cleanCreds).length ? { credentials: cleanCreds } : {}),
          routes,
          ...(confirmUnverified ? { confirm_unverified: true } : {}),
        });
        await claimAll(existing!.id);
        return { kind: "updated" as const, verification: secretsRetyped ? (updated as { verification?: ConnectionVerification } | undefined)?.verification : undefined };
      }
      const body: UserConnectionInput = {
        provider_id: providerId,
        label: label.trim() || undefined,
        credentials: cleanCreds,
        routes,
        ...(confirmUnverified ? { confirm_unverified: true } : {}),
      };
      const made = await api.addConnection(body);
      if (made?.id) await claimAll(made.id);
      return { kind: "added" as const, verification: made?.verification };
    },
    onSuccess: (out) => {
      // A connection that is not an AI provider was never probed: "updated" is
      // the whole truth for it. For a key, the verdict is the sentence.
      const t = provider?.kind === "ai-provider" || out.verification ? verificationToast(out.verification, out.kind) : { kind: "success" as const, message: out.kind === "added" ? "Connection added." : "Connection updated." };
      toast[t.kind](t.message);
      onDone();
    },
    onError: async (e) => {
      const refused = keyRefusedBy(e);
      if (!refused) {
        toast.error(e instanceof ApiError ? e.message : String(e));
        return;
      }
      const anyway = await confirm(refusalDialog(refused, isEdit));
      if (anyway) save.mutate(true);
    },
  });

  // A consent-screen provider has no form to fill: the panel picks the
  // workspace and sends the browser to the provider. Editing one afterwards
  // is the ordinary form, minus the grant (write-only, never re-typed) and
  // the address (read from the grant, not editable).
  const oauth = provider?.connect?.kind === "oauth" ? provider.connect : null;
  const editableFields = oauth ? credFields.filter(([k, d]) => !d.secret && k !== "email") : credFields;

  return (
    <section className="rounded-xl border border-cobble-300 dark:border-cobble-700 bg-cobble-50/40 dark:bg-cobble-900/15 p-5 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-content dark:text-slate-300 flex-1">
          {isEdit ? "Edit connection" : isService ? "Add a service" : "Add a connection"}
        </h2>
        <button aria-label="Cancel" type="button" onClick={onCancel} className="text-faint hover:text-content p-1" title="Cancel">
          <X size={15} />
        </button>
      </div>

      <label className="block">
        <div className="text-xs text-muted mb-1">Provider</div>
        <select
          value={providerId}
          disabled={isEdit}
          onChange={(e) => {
            setProviderId(e.target.value);
            setCreds({});
          }}
          className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 disabled:opacity-60"
        >
          {/* Grouped by kind: an AI key and a tracking account are different
              enough that one flat list of vendor names reads as a jumble. */}
          {Object.entries(
            providers.filter((p) => !serviceKindOnly || p.kind === "service").reduce<Record<string, AiProviderDef[]>>((acc, p) => {
              const k = p.kind ?? "ai-provider";
              (acc[k] ??= []).push(p);
              return acc;
            }, {}),
          ).map(([kind, items]) => (
            <optgroup key={kind} label={CONNECTION_KIND_LABELS[kind]?.title ?? kind}>
              {items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {provider?.blurb && <div className="text-[11px] text-faint mt-1">{provider.blurb}</div>}
      </label>

      {oauth && !isEdit ? (
        <OAuthConnectPanel provider={provider!} start={oauth.start} orgs={orgs} onCancel={onCancel} />
      ) : (
      <>
      <label className="block">
        <div className="text-xs text-muted mb-1">Label (optional)</div>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={isService ? (serviceName ? `e.g. ${serviceName}` : "its own name, once it is read") : labelPlaceholder(provider?.label)}
          className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        />
      </label>

      {provider?.setup && <ProviderSetupSteps setup={provider.setup} />}

      {isService ? (
        <ServiceSetup
          creds={creds}
          onChange={(k, v) => setCreds((m) => ({ ...m, [k]: v }))}
          keyIsSet={isEdit && !!existing?.credential_keys.includes("secret")}
          onRead={(p) => setServiceName(p.name)}
          wantCapability={wantCapability}
        />
      ) : (
      <CredentialFields
        fields={Object.fromEntries(editableFields)}
        creds={creds}
        onChange={(k, v) => setCreds((m) => ({ ...m, [k]: v }))}
        scope={{ kind: "personal" }}
        providerId={providerId}
        selectClassName="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        hintFor={(k, v) => k === "transit" && v.startsWith("bridge") && <PersonalAgentHint />}
        noteFor={(k, d) =>
          isEdit && d.secret && existing?.credential_keys.includes(k) ? "· set (leave blank to keep)" : undefined
        }
        placeholderFor={(k) =>
          isEdit && existing?.credential_keys.includes(k) ? "•••••• (unchanged)" : undefined
        }
      />
      )}
      {credFields.length === 0 && !isService && (
        <div className="text-[11px] text-faint italic">
          This provider needs no credentials - it routes to a device you connect (e.g. the edge bridge).
        </div>
      )}
      {oauth && (
        <div className="text-[11px] text-faint">
          The mailbox address and the grant are read from Google and are not edited here. Disconnect and connect again to change the mailbox.
        </div>
      )}

      <div>
        <div className="text-xs text-muted mb-1">Use this connection in each workspace</div>
        <div className="rounded border border-line dark:border-slate-700 divide-y divide-line dark:divide-slate-700">
          {orgs.length === 0 && <div className="text-[11px] text-faint p-2">No workspaces.</div>}
          {orgSections.map((section) => (
            <div key={section.label}>
              <div className="px-2 pt-2 pb-1 text-[9px] uppercase tracking-widest text-muted dark:text-slate-500">
                {section.label}
              </div>
              {section.items.map((o) => {
            const cur = perWs[o.id]; // undefined = off
            const owns = o.role === "owner";
            const set = (m: ConnRouteMode | null) =>
              setPerWs((prev) => {
                const next = { ...prev };
                if (m === null) delete next[o.id];
                else next[o.id] = m;
                return next;
              });
            return (
              <div key={o.id} className="flex flex-wrap items-center gap-2 p-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-content dark:text-mortar-200 truncate">{o.name}</div>
                  {cur === "workspace-default" && !owns && (
                    <div className="text-[10px] text-amber-600 dark:text-amber-500">
                      Shared - the owner approves before others can use it. Your own calls work right away.
                    </div>
                  )}
                  {cur && incumbentFor(o.id) && (
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                      <span className="text-muted dark:text-slate-400">
                        <span className="font-medium text-content dark:text-mortar-200">
                          {incumbentFor(o.id)!.label || incumbentFor(o.id)!.provider_id}
                        </span>{" "}
                        is already powering this workspace.
                      </span>
                      {/* Which goes first is a pick of two: a radio group with
                          the pick marked, never told by colour alone (#6045). */}
                      <SegmentedChoice
                        label={`Which connection goes first in ${o.name}`}
                        value={takeOver[o.id] ? "this" : "other"}
                        onChange={(v) => setTakeOver((p) => ({ ...p, [o.id]: v === "this" }))}
                        options={[
                          { value: "this", label: "Use this one first" },
                          { value: "other", label: `Keep ${incumbentFor(o.id)!.label || "the other"} first` },
                        ]}
                      />
                    </div>
                  )}
                </div>
                {/* Off / Just me / Share: a radio group named for this
                    workspace, the pick marked with a check as well as its
                    fill, so whether the key is off, yours alone or offered to
                    everyone is never told by colour alone (#6045). */}
                <SegmentedChoice
                  className="shrink-0"
                  label={`How ${o.name} uses this connection`}
                  value={cur ?? "off"}
                  onChange={(v) => {
                    const val = v === "off" ? null : (v as ConnRouteMode);
                    // A mailbox feeds exactly one workspace: a parcel lands once.
                    if (oauth && val) setPerWs({ [o.id]: val });
                    else set(val);
                  }}
                  options={
                    oauth
                      ? [
                          { value: "off", label: "Off" },
                          { value: "workspace-default", label: "Feeds this workspace" },
                        ]
                      : [
                          { value: "off", label: "Off" },
                          { value: "my-calls", label: "Just me" },
                          { value: "workspace-default", label: "Share" },
                        ]
                  }
                />
              </div>
            );
              })}
            </div>
          ))}
        </div>
        {oauth ? (
          <p className="text-[11px] text-faint mt-1">
            A mailbox feeds one workspace, so each order lands once. The workspace owner approves a mailbox that is not their own.
          </p>
        ) : (
          <p className="text-[11px] text-faint mt-1">
            <span className="font-medium">Just me</span> = only your own work here uses it.{" "}
            <span className="font-medium">Share</span> = offer it to everyone in the workspace (the owner approves).
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">
          Cancel
        </button>
        <button
          type="button"
          disabled={!providerId || save.isPending}
          onClick={() => save.mutate(false)}
          className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : isEdit ? "Save changes" : "Save connection"}
        </button>
      </div>
      </>
      )}
    </section>
  );
}

/** Live "is my personal edge agent connected?" line under the bridge-transit
 *  choice — the answer to "will my local URL actually work?". */
function PersonalAgentHint() {
  const agent = useQuery({ queryKey: ["me-edge-agent"], queryFn: api.getMyEdgeAgent, refetchInterval: 5000 });
  const on = agent.data?.connected ?? false;
  return (
    <div className={"flex items-center gap-2 text-[11px] mt-1 rounded border p-1.5 " + (on ? "border-moss-500/40 bg-moss-50 dark:bg-moss-950/30 text-moss-700 dark:text-moss-300" : "border-amber-500/40 bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400")}>
      <span className={"w-1.5 h-1.5 rounded-full shrink-0 " + (on ? "bg-moss-500" : "bg-amber-500 animate-pulse")} />
      {on
        ? "Your personal edge agent is connected. Calls to this endpoint will route through it to your LAN."
        : "No personal edge agent is connected yet. Calls will fail until one dials in. Set it up like the Local-AI edge bridge agent (it serves every bridge-transit connection you add)."}
    </div>
  );
}

/** Compact live status for an edge-bridge connection in the list — same
 *  emerald/slate "online/offline" convention as the workspace device bridges
 *  (BridgePicker), so a personal bridge reads the same as a 3D-printer one. */
function EdgeBridgeStatusRow({ verified }: { verified: boolean }) {
  const qc = useQueryClient();
  const agent = useQuery({ queryKey: ["me-edge-agent"], queryFn: api.getMyEdgeAgent, refetchInterval: 5000 });
  const on = agent.data?.connected ?? false;
  // The server re-tests the connection when its bridge comes back; pick up the
  // verdict while this page is open instead of showing the old one.
  useEffect(() => {
    if (!on || verified) return;
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: aiAvailabilityKeys.connections() }), 5000);
    const stop = setTimeout(() => clearInterval(t), 120_000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [on, verified, qc]);
  return (
    <div className="flex items-center gap-1.5 text-[11px] mt-1">
      <span className={"inline-block w-1.5 h-1.5 rounded-full " + (on ? "bg-emerald-500" : "bg-slate-400/60")} />
      <span className={on ? "text-emerald-600 dark:text-emerald-500" : "text-muted"}>
        Edge bridge {on ? "online" : "offline"}
      </span>
      {!on && <span className="text-faint"> - start your bridge agent to use it</span>}
    </div>
  );
}

/** Where this connection could stand behind another of yours, as one line.
 *  "Choose…" opens the list of workspaces, all ticked. */
function BackupOffersRow({
  offers,
  orgName,
  pending,
  onAdd,
}: {
  offers: BackupOffer[];
  orgName: (id: string) => string;
  pending: boolean;
  onAdd: (picked: BackupOffer[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const summary = backupSummary(offers, orgName);
  if (!summary) return null;
  const picked = offers.filter((o) => !skip.has(o.org_id));
  return (
    <div className="text-[11px] text-muted dark:text-slate-400 mt-1">
      <div className="flex flex-wrap items-center gap-x-2">
        <span title="When it is busy or out of quota, this one answers.">{summary}</span>
        {offers.length === 1 ? (
          <button type="button" disabled={pending} onClick={() => onAdd(offers)} className="text-accent hover:underline disabled:opacity-50">
            Add
          </button>
        ) : (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="text-accent hover:underline">
            {open ? "Close" : "Choose…"}
          </button>
        )}
      </div>
      {open && offers.length > 1 && (
        <div className="mt-1 rounded border border-line dark:border-slate-700 p-2 space-y-1">
          <div className="text-faint">When the AI there is busy or out of quota, this one answers.</div>
          {offers.map((o) => (
            <label key={o.org_id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={!skip.has(o.org_id)}
                onChange={(e) =>
                  setSkip((cur) => {
                    const next = new Set(cur);
                    if (e.target.checked) next.delete(o.org_id);
                    else next.add(o.org_id);
                    return next;
                  })
                }
              />
              <span>
                {orgName(o.org_id)} <span className="text-faint">(behind {o.behind})</span>
              </span>
            </label>
          ))}
          <button
            type="button"
            disabled={pending || picked.length === 0}
            onClick={() => {
              onAdd(picked);
              setOpen(false);
            }}
            className="mt-1 px-2 py-1 rounded border border-line dark:border-slate-700 text-accent hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-50"
          >
            Add to {picked.length} workspace{picked.length === 1 ? "" : "s"}
          </button>
        </div>
      )}
    </div>
  );
}
