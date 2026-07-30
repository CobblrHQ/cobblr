// /configuration/integrations — connector + inbound token editor.
//
// Two halves match the module:
//   - Outbound connectors (Slack/Discord/webhook). User picks a
//     connector from the catalogue, fills in credentials, can hit
//     Test or Send to verify.
//   - Inbound tokens. Each row is a stable webhook URL the user can
//     give to an external service. Per-handler config (HMAC secret,
//     etc.) is configurable.
//
// Each section ships its own modal — no inline forms, per the
// modals-not-pages convention.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Mail,
  Pencil,
  Play,
  Plug,
  Plus,
  Send,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";
import {
  ApiError,
  api,
  type IntegrationConnector,
  type IntegrationConnectorDef,
  type InboundHandlerDef,
  type InboundToken,
} from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { SyncConnectionsSection } from "./SyncConnectionsSection";
import { MigrateInSection } from "../components/MigrateInSection";
import { FEED_SCROLL } from "../lib/feed";
import { SettingsSection } from "../components/SettingsSection";

export function IntegrationsPage() {
  usePageTitle("Integrations");
  const { activeSlug } = useActiveOrg();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<IntegrationConnector | null>(null);
  const [invoking, setInvoking] = useState<IntegrationConnector | null>(null);
  const [addingInbound, setAddingInbound] = useState(false);

  const catalogueQ = useQuery({
    queryKey: ["integrations-catalogue", activeSlug],
    queryFn: () => api.listConnectorCatalogue(activeSlug),
    enabled: !!activeSlug,
  });
  const connectorsQ = useQuery({
    queryKey: ["integrations-connectors", activeSlug],
    queryFn: () => api.listConnectors(activeSlug),
    enabled: !!activeSlug,
  });
  const inboundHandlersQ = useQuery({
    queryKey: ["integrations-inbound-handlers", activeSlug],
    queryFn: () => api.listInboundHandlers(activeSlug),
    enabled: !!activeSlug,
  });
  const inboundTokensQ = useQuery({
    queryKey: ["integrations-inbound-tokens", activeSlug],
    queryFn: () => api.listInboundTokens(activeSlug),
    enabled: !!activeSlug,
  });
  const callsQ = useQuery({
    queryKey: ["integrations-calls", activeSlug],
    queryFn: () => api.listIntegrationCalls(activeSlug, 25),
    enabled: !!activeSlug,
  });

  const cataloguesByDefId = useMemo(() => {
    const m = new Map<string, IntegrationConnectorDef>();
    for (const d of catalogueQ.data?.items ?? []) m.set(d.id, d);
    return m;
  }, [catalogueQ.data]);

  return (
    <div className="space-y-6">
      <EmailInSection />

      <SyncConnectionsSection />

      <MigrateInSection />

      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-content dark:text-mortar-100 flex items-center gap-2">
              <Plug className="h-4 w-4" /> Sending out
            </h2>
            <p className="text-xs text-faint mt-0.5">
              Push what happens here to Slack, Discord, email, or any webhook.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white shrink-0"
          >
            <Plus className="h-4 w-4" /> Add connector
          </button>
        </div>
        <div className="space-y-2">
          {connectorsQ.data?.items.length === 0 && (
            <p className="text-sm text-faint">
              Nothing set up yet. Pick Slack, Discord, or a plain webhook to
              start sending what happens here to another service.
            </p>
          )}
          {connectorsQ.data?.items.map((c) => (
            <ConnectorRow
              key={c.id}
              connector={c}
              def={cataloguesByDefId.get(c.connector_id) ?? null}
              onEdit={() => setEditing(c)}
              onInvoke={() => setInvoking(c)}
            />
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-content dark:text-mortar-100 flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" /> Letting things in
            </h2>
            <p className="text-xs text-faint mt-0.5">
              A stable URL you hand to another service so it can post here.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAddingInbound(true)}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white shrink-0"
          >
            <Plus className="h-4 w-4" /> Add inbound token
          </button>
        </div>
        <div className="space-y-2">
          {inboundTokensQ.data?.items.length === 0 && (
            <p className="text-sm text-faint">
              None yet. Add one to give another service a stable address to
              post to.
            </p>
          )}
          {inboundTokensQ.data?.items.map((t) => (
            <InboundTokenRow key={t.id} token={t} />
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100 mb-2">
          Recent calls
        </h2>
        <div className={"text-xs font-mono space-y-1 overflow-x-auto " + FEED_SCROLL}>
          {callsQ.data?.items.length === 0 && (
            <div className="text-sm text-muted">No calls yet.</div>
          )}
          {callsQ.data?.items.map((c) => (
            <div key={c.id} className="flex gap-3 items-center">
              <span
                className={c.ok ? "text-emerald-600" : "text-red-600"}
              >
                {c.ok ? "ok" : "err"}
              </span>
              <span className="text-muted">{c.direction}</span>
              <span className="font-medium">{c.connector_id}</span>
              <span className="text-muted">{c.action_or_event}</span>
              <span className="text-faint">
                {c.status ?? "—"} · {c.ms ?? "—"}ms
              </span>
              <span className="text-faint">
                {new Date(c.occurred_at).toLocaleString()}
              </span>
              {c.error && (
                <span className="text-red-500 truncate">{c.error}</span>
              )}
            </div>
          ))}
        </div>
      </section>

      {adding && catalogueQ.data && (
        <ConnectorAddModal
          catalogue={catalogueQ.data.items}
          onClose={() => setAdding(false)}
        />
      )}
      {editing && cataloguesByDefId.get(editing.connector_id) && (
        <ConnectorEditModal
          connector={editing}
          def={cataloguesByDefId.get(editing.connector_id)!}
          onClose={() => setEditing(null)}
        />
      )}
      {invoking && cataloguesByDefId.get(invoking.connector_id) && (
        <ConnectorInvokeModal
          connector={invoking}
          def={cataloguesByDefId.get(invoking.connector_id)!}
          onClose={() => setInvoking(null)}
        />
      )}
      {addingInbound && inboundHandlersQ.data && (
        <InboundTokenAddModal
          handlers={inboundHandlersQ.data.items}
          onClose={() => setAddingInbound(false)}
        />
      )}
    </div>
  );
}

// Inbound EMAIL — the friendliest inbound path, and the one people go looking
// for ("how do I email things in?"). Two things live here: a personal
// forward-a-receipt address, and reply-by-email (which needs no setup). Both are
// operator-gated (the inbound Email Worker); when it's off we say so plainly
// instead of showing a dead address. Anchored #email-in for the search hit.
function EmailInSection() {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const addrQ = useQuery({
    queryKey: ["receipt-address", activeSlug],
    queryFn: () => api.getReceiptAddress(activeSlug),
    enabled: !!activeSlug,
  });
  const address = addrQ.data?.configured && addrQ.data.address ? addrQ.data.address : null;

  return (
    <SettingsSection
      id="email-in"
      title="Email in"
      icon={Mail}
      blurb="Send things into this workspace by email, with nothing to install."
    >
      <div className="space-y-4">
        <div>
          <div className="text-sm font-medium mb-1">Forward a receipt by email</div>
          {address ? (
            <>
              <p className="text-sm text-muted mb-2">
                Forward a receipt - PDF, photo, or CSV - to your personal address and its
                line items land in your{" "}
                <Link to="/scan" className="text-accent hover:underline">
                  Scan inbox
                </Link>
                , ready to confirm. Each workspace you're in has its own address.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate text-sm font-mono bg-subtle dark:bg-slate-900 border dark:border-slate-700 rounded px-2 py-1.5">
                  {address}
                </code>
                <button
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(address);
                    toast.success("Address copied.");
                  }}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white shrink-0"
                >
                  <Copy className="h-4 w-4" /> Copy
                </button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted">
              Email-in isn't enabled on this server yet. It needs the operator to set up
              the inbound Email Worker (a one-time step). Until then, upload receipts on the{" "}
              <Link to="/scan" className="text-accent hover:underline">
                Scan
              </Link>{" "}
              page.
            </p>
          )}
        </div>
        <div className="border-t dark:border-slate-800 pt-3">
          <div className="text-sm font-medium mb-1">Reply by email</div>
          <p className="text-sm text-muted">
            When Cobblr emails you (a feedback update, a notification), just hit reply - 
            your message threads back onto the item automatically. Nothing to set up.
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}

function ConnectorRow({
  connector,
  def,
  onEdit,
  onInvoke,
}: {
  connector: IntegrationConnector;
  def: IntegrationConnectorDef | null;
  onEdit: () => void;
  onInvoke: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const testM = useMutation({
    mutationFn: () => api.testConnector(activeSlug, connector.id),
    onSuccess: (r) =>
      r.ok ? toast.success("Test passed.") : toast.error(r.error ?? "Test failed."),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const delM = useMutation({
    mutationFn: () => api.deleteConnector(activeSlug, connector.id),
    onSuccess: () => {
      toast.success("Connector deleted.");
      void qc.invalidateQueries({ queryKey: ["integrations-connectors", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const toggleM = useMutation({
    mutationFn: () =>
      api.updateConnector(activeSlug, connector.id, { enabled: !connector.enabled }),
    onSuccess: () => {
      toast.success(connector.enabled ? "Disabled." : "Enabled.");
      void qc.invalidateQueries({ queryKey: ["integrations-connectors", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <div className="rounded-lg border border-line dark:border-slate-700 p-3">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="font-medium truncate">{connector.label}</div>
          <div className="text-xs text-muted">
            {def?.label ?? connector.connector_id}
            {!connector.enabled && (
              <span className="ml-2 text-amber-600">disabled</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => testM.mutate()}
            disabled={testM.isPending}
            className="p-1.5 text-muted hover:text-content dark:hover:text-slate-200 rounded hover:bg-subtle dark:hover:bg-slate-800"
            title="Test connection"
          >
            <Play className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onInvoke}
            className="p-1.5 text-muted hover:text-content dark:hover:text-slate-200 rounded hover:bg-subtle dark:hover:bg-slate-800"
            title="Send a test action"
          >
            <Send className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="p-1.5 text-muted hover:text-content dark:hover:text-slate-200 rounded hover:bg-subtle dark:hover:bg-slate-800"
            title="Edit"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => toggleM.mutate()}
            disabled={toggleM.isPending}
            className="px-2 py-1 text-xs rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
          >
            {connector.enabled ? "Disable" : "Enable"}
          </button>
          <button
            type="button"
            onClick={async () => {
              const ok = await confirm({
                title: "Delete connector?",
                message: `${connector.label} will be removed. Existing wires that target it will fail until you create a new connector.`,
                confirmLabel: "Delete",
                destructive: true,
              });
              if (ok) delM.mutate();
            }}
            className="p-1.5 text-red-500 hover:text-red-600 rounded hover:bg-red-50 dark:hover:bg-red-900/40"
            title="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function InboundTokenRow({ token }: { token: InboundToken }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const fullUrl = `${window.location.origin}/api/v1/integrations/${token.connector_id}/${token.token}/webhook`;

  const revokeM = useMutation({
    mutationFn: () => api.revokeInboundToken(activeSlug, token.id),
    onSuccess: () => {
      toast.success("Token revoked.");
      void qc.invalidateQueries({ queryKey: ["integrations-inbound-tokens", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const deleteM = useMutation({
    mutationFn: () => api.deleteInboundToken(activeSlug, token.id),
    onSuccess: () => {
      toast.success("Token deleted.");
      void qc.invalidateQueries({ queryKey: ["integrations-inbound-tokens", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <div className="rounded-lg border border-line dark:border-slate-700 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">{token.label}</div>
          <div className="text-xs text-muted">
            {token.connector_id}
            {!token.enabled && <span className="ml-2 text-amber-600">revoked</span>}
            <span className="ml-2">
              hits: {token.hit_count}
              {token.last_hit_at && (
                <span> · last {new Date(token.last_hit_at).toLocaleString()}</span>
              )}
            </span>
          </div>
          <div className="text-xs font-mono mt-1 text-muted break-all">{fullUrl}</div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(fullUrl);
              toast.success("URL copied.");
            }}
            className="p-1.5 text-muted hover:text-content dark:hover:text-slate-200 rounded hover:bg-subtle dark:hover:bg-slate-800"
            title="Copy URL"
          >
            <Copy className="h-4 w-4" />
          </button>
          {token.enabled && (
            <button
              type="button"
              onClick={() => revokeM.mutate()}
              className="px-2 py-1 text-xs rounded text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/40"
            >
              Revoke
            </button>
          )}
          <button
            type="button"
            onClick={async () => {
              const ok = await confirm({
                title: "Delete token?",
                message: "The webhook URL stops working forever.",
                confirmLabel: "Delete",
                destructive: true,
              });
              if (ok) deleteM.mutate();
            }}
            className="p-1.5 text-red-500 hover:text-red-600 rounded hover:bg-red-50 dark:hover:bg-red-900/40"
            title="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectorAddModal({
  catalogue,
  onClose,
}: {
  catalogue: IntegrationConnectorDef[];
  onClose: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [pickedId, setPickedId] = useState<string>(catalogue[0]?.id ?? "");
  const picked = catalogue.find((c) => c.id === pickedId);
  const [label, setLabel] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});

  const createM = useMutation({
    mutationFn: () =>
      api.createConnector(activeSlug, {
        connector_id: pickedId,
        label: label.trim() || picked?.label || pickedId,
        credentials: creds,
      }),
    onSuccess: () => {
      toast.success("Connector added.");
      void qc.invalidateQueries({ queryKey: ["integrations-connectors", activeSlug] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <Modal open onClose={onClose} title="Add connector" size="md">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          createM.mutate();
        }}
      >
        <div>
          <label className="block text-sm font-medium mb-1">Connector type</label>
          <select
            value={pickedId}
            onChange={(e) => {
              setPickedId(e.target.value);
              setCreds({});
            }}
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900"
          >
            {catalogue.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Label (your name for this connection)</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={picked?.label ?? ""}
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900"
          />
        </div>
        {picked &&
          Object.entries(picked.credentials).map(([key, def]) => (
            <div key={key}>
              <label className="block text-sm font-medium mb-1">{def.label}</label>
              <input
                type={def.secret ? "password" : "text"}
                value={creds[key] ?? ""}
                onChange={(e) => setCreds({ ...creds, [key]: e.target.value })}
                className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900 font-mono"
              />
            </div>
          ))}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createM.isPending}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {createM.isPending ? "Saving…" : "Add"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConnectorEditModal({
  connector,
  def,
  onClose,
}: {
  connector: IntegrationConnector;
  def: IntegrationConnectorDef;
  onClose: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [label, setLabel] = useState(connector.label);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [updateCreds, setUpdateCreds] = useState(false);

  const saveM = useMutation({
    mutationFn: () =>
      api.updateConnector(activeSlug, connector.id, {
        label: label.trim() || connector.label,
        credentials: updateCreds ? creds : undefined,
      }),
    onSuccess: () => {
      toast.success("Connector updated.");
      void qc.invalidateQueries({ queryKey: ["integrations-connectors", activeSlug] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <Modal open onClose={onClose} title={`Edit ${connector.label}`} size="md">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          saveM.mutate();
        }}
      >
        <div>
          <label className="block text-sm font-medium mb-1">Label</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={updateCreds}
            onChange={(e) => setUpdateCreds(e.target.checked)}
          />
          Replace credentials
        </label>
        {updateCreds &&
          Object.entries(def.credentials).map(([key, d]) => (
            <div key={key}>
              <label className="block text-sm font-medium mb-1">{d.label}</label>
              <input
                type={d.secret ? "password" : "text"}
                value={creds[key] ?? ""}
                onChange={(e) => setCreds({ ...creds, [key]: e.target.value })}
                className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900 font-mono"
              />
            </div>
          ))}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saveM.isPending}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {saveM.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConnectorInvokeModal({
  connector,
  def,
  onClose,
}: {
  connector: IntegrationConnector;
  def: IntegrationConnectorDef;
  onClose: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [actionId, setActionId] = useState(def.actions[0]?.id ?? "");
  const [args, setArgs] = useState<Record<string, string>>({});
  const [rendered, setRendered] = useState("");
  const [result, setResult] = useState<unknown>(null);

  const action = def.actions.find((a) => a.id === actionId);

  const invokeM = useMutation({
    mutationFn: () =>
      api.invokeConnector(activeSlug, connector.id, {
        action_id: actionId,
        args,
        rendered: rendered || undefined,
      }),
    onSuccess: (r) => {
      setResult(r);
      toast.success(`Invoked in ${r.ms}ms.`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <Modal open onClose={onClose} title={`Send via ${connector.label}`} size="md">
      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium mb-1">Action</label>
          <select
            value={actionId}
            onChange={(e) => setActionId(e.target.value)}
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900"
          >
            {def.actions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          {action?.description && (
            <div className="text-xs text-muted mt-1">{action.description}</div>
          )}
        </div>
        {action?.argsSchema &&
          Object.entries(action.argsSchema).map(([key, d]) => (
            <div key={key}>
              <label className="block text-sm font-medium mb-1">{d.label}</label>
              <input
                type={d.type === "number" ? "number" : "text"}
                value={args[key] ?? ""}
                onChange={(e) => setArgs({ ...args, [key]: e.target.value })}
                className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900"
              />
            </div>
          ))}
        <div>
          <label className="block text-sm font-medium mb-1">Rendered body (optional, wins over args)</label>
          <textarea
            value={rendered}
            onChange={(e) => setRendered(e.target.value)}
            rows={3}
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900 font-mono"
            placeholder="hello world"
          />
        </div>
        {result !== null && (
          <pre className="text-xs bg-subtle dark:bg-slate-900 border dark:border-slate-700 rounded p-2 overflow-auto max-h-40">
            {JSON.stringify(result, null, 2)}
          </pre>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => invokeM.mutate()}
            disabled={invokeM.isPending}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {invokeM.isPending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function InboundTokenAddModal({
  handlers,
  onClose,
}: {
  handlers: InboundHandlerDef[];
  onClose: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [handlerId, setHandlerId] = useState(handlers[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});

  const handler = handlers.find((h) => h.id === handlerId);

  const createM = useMutation({
    mutationFn: () =>
      api.createInboundToken(activeSlug, {
        connector_id: handlerId,
        label: label.trim() || handler?.label || handlerId,
        config,
      }),
    onSuccess: () => {
      toast.success("Inbound token created.");
      void qc.invalidateQueries({ queryKey: ["integrations-inbound-tokens", activeSlug] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <Modal open onClose={onClose} title="Add inbound webhook token" size="md">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          createM.mutate();
        }}
      >
        <div>
          <label className="block text-sm font-medium mb-1">Handler</label>
          <select
            value={handlerId}
            onChange={(e) => {
              setHandlerId(e.target.value);
              setConfig({});
            }}
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900"
          >
            {handlers.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </select>
          {handler && (
            <div className="text-xs text-muted mt-1">
              Emits: {handler.emits.join(", ")}
            </div>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Label</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={handler?.label ?? ""}
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900"
          />
        </div>
        {handler &&
          Object.entries(handler.config).map(([key, d]) => (
            <div key={key}>
              <label className="block text-sm font-medium mb-1">{d.label}</label>
              <input
                type={d.secret ? "password" : "text"}
                value={config[key] ?? ""}
                onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
                className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900 font-mono"
              />
            </div>
          ))}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createM.isPending}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {createM.isPending ? "Saving…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
