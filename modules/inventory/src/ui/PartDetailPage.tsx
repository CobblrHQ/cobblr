// Part detail — fields inline-editable, allocations panel below.
// Stock adjustments are explicit (a button) so accidental qty edits
// don't silently rewrite history.

import { useState, type FocusEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowLeft, Library, Printer, ShieldCheck, Trash2 } from "lucide-react";
import { CustomFieldsPanel, EntityActionsBar, EntityThumb, useConfirm, usePageTitle, useToast } from "@cobblr/platform-web";
import { useInventory } from "./context";
import { useMatchedCatalogEntry } from "./useMatchedCatalogEntry";
import { AllocationsPanel } from "./AllocationsPanel";
import { StockAdjustButton } from "./StockAdjustButton";
import { PartGallery } from "./PartGallery";
import { MaintenancePanel } from "./MaintenancePanel";

export function PartDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { api, orgSlug, getToken } = useInventory();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const part = useQuery({
    queryKey: ["inventory-part", id],
    queryFn: () => api.getPart(id!),
    enabled: !!id,
  });

  const cats = useQuery({ queryKey: ["inventory-categories"], queryFn: () => api.listCategories() });
  const locs = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });
  const matched = useMatchedCatalogEntry(id);

  const toast = useToast();
  const confirm = useConfirm();

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.updatePart(id!, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inventory-part", id] });
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deletePart(id!),
    onSuccess: () => {
      toast.success("Part deleted.");
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
      navigate("/inventory");
    },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  // usePageTitle MUST run on every render — calling a hook after an
  // early return violates the Rules of Hooks. When the part query
  // transitions from isLoading=true to isLoading=false the hook
  // count would change between renders and React silently fails the
  // component (the page renders blank, no error in the console).
  usePageTitle(part.data?.name ?? "Part");
  if (part.isLoading) return <div className="text-sm text-slate-400 dark:text-slate-500">loading…</div>;
  if (part.error) {
    return <div className="text-sm text-ember-500">{(part.error as Error).message}</div>;
  }
  if (!part.data) return null;
  const p = part.data;

  return (
    <div className="space-y-5 max-w-3xl">
      <Link to="/inventory" className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-cobble-600">
        <ArrowLeft size={12} /> back to parts
      </Link>

      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3">
        <div className="flex items-start gap-4">
          <EntityThumb
            src={p.image_path ?? matched.data?.image_path ?? null}
            alt={p.name}
            size={96}
            className="ring-1 ring-slate-200 dark:ring-slate-700"
          />
          <div className="flex flex-col sm:flex-row items-start gap-3 flex-1 min-w-0">
            <div className="flex-1 min-w-0">
              <InlineText
                value={p.name}
                onCommit={(v) => update.mutate({ name: v })}
                className="font-display text-2xl font-bold text-slate-700 dark:text-mortar-100 w-full"
              />
              <div className="flex flex-wrap items-center gap-2 mt-1">
                {p.asset_id != null && (
                  <span className="text-[11px] font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400 bg-mortar-100 dark:bg-slate-800 rounded px-2 py-0.5">
                    #{String(p.asset_id).padStart(3, "0")}
                  </span>
                )}
                {matched.data && (
                  <span
                    className="text-[10px] inline-flex items-center gap-1 text-cobble-700 dark:text-cobble-300 bg-cobble-50 dark:bg-cobble-900/40 border border-cobble-200 dark:border-cobble-800 rounded px-1.5 py-0.5"
                    title={`Matched to ${matched.data.title} in ${matched.data.subtitle ?? "a catalog"}`}
                  >
                    <Library size={10} />
                    matched: {matched.data.title}
                  </span>
                )}
                <PrintQrButton partId={p.id} orgSlug={orgSlug} getToken={getToken} />
                {p.lifetime_warranty && (
                  <span className="text-[10px] inline-flex items-center gap-1 text-moss-600 border border-moss-200 dark:border-moss-800 rounded px-1.5 py-0.5">
                    lifetime warranty
                  </span>
                )}
                {p.insured && (
                  <span className="text-[10px] inline-flex items-center gap-1 text-cobble-600 border border-cobble-200 dark:border-cobble-800 rounded px-1.5 py-0.5">
                    <ShieldCheck size={10} /> insured
                  </span>
                )}
                {p.archived && (
                  <span className="text-[10px] inline-flex items-center gap-1 text-slate-500 border border-slate-300 dark:border-slate-600 rounded px-1.5 py-0.5">
                    <Archive size={10} /> archived
                  </span>
                )}
              </div>
            </div>
            <EntityActionsBar entityKind="inventory:part" entityId={p.id} className="mt-1" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Qty">
            <div className="flex items-center gap-2">
              <span className="font-mono text-lg text-slate-700 dark:text-mortar-100">
                {fmt(p.qty)} {p.unit}
              </span>
              <StockAdjustButton partId={p.id} />
            </div>
          </Field>
          <Field label="Unit">
            <InlineText value={p.unit} onCommit={(v) => update.mutate({ unit: v })} />
          </Field>
          <Field label="Min qty">
            <InlineText
              value={p.min_qty ?? ""}
              placeholder="—"
              onCommit={(v) => update.mutate({ min_qty: v === "" ? null : Number(v) })}
              numeric
            />
          </Field>
          <Field label="Cost">
            <InlineText
              value={p.cost ?? ""}
              placeholder="—"
              onCommit={(v) => update.mutate({ cost: v === "" ? null : Number(v) })}
              numeric
            />
          </Field>
          <Field label="Category">
            <select
              value={p.category_id ?? ""}
              onChange={(e) => update.mutate({ category_id: e.target.value || null })}
              className="input"
            >
              <option value="">— none —</option>
              {cats.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Location">
            <select
              value={p.location_id ?? ""}
              onChange={(e) => update.mutate({ location_id: e.target.value || null })}
              className="input"
            >
              <option value="">— none —</option>
              {locs.data?.items.map((l) => (
                <option key={l.id} value={l.id}>
                  {"  ".repeat(l.depth)}
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Manufacturer">
            <InlineText
              value={p.manufacturer ?? ""}
              placeholder="—"
              onCommit={(v) => update.mutate({ manufacturer: v || null })}
            />
          </Field>
          <Field label="Supplier URL">
            <InlineText
              value={p.supplier_url ?? ""}
              placeholder="—"
              onCommit={(v) => update.mutate({ supplier_url: v || null })}
            />
          </Field>
          <Field label="Serial number">
            <InlineText
              value={p.serial_number ?? ""}
              placeholder="—"
              onCommit={(v) => update.mutate({ serial_number: v || null })}
            />
          </Field>
          <Field label="Model number">
            <InlineText
              value={p.model_number ?? ""}
              placeholder="—"
              onCommit={(v) => update.mutate({ model_number: v || null })}
            />
          </Field>
        </div>
        <Field label="Notes">
          <InlineTextarea
            value={p.notes ?? ""}
            onCommit={(v) => update.mutate({ notes: v || null })}
          />
        </Field>
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3">
        <h3 className="text-[10px] font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400">
          warranty & status
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Warranty expires">
            <InlineText
              value={
                p.warranty_expires
                  ? new Date(p.warranty_expires).toISOString().slice(0, 10)
                  : ""
              }
              placeholder="YYYY-MM-DD"
              onCommit={(v) =>
                update.mutate({ warranty_expires: v.trim() === "" ? null : v.trim() })
              }
            />
          </Field>
          <Field label="Lifetime warranty">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={p.lifetime_warranty}
                onChange={(e) => update.mutate({ lifetime_warranty: e.target.checked })}
                className="accent-cobble-500"
              />
              <span className="text-slate-500 dark:text-slate-400">no expiry</span>
            </label>
          </Field>
        </div>
        <Field label="Warranty details">
          <InlineTextarea
            value={p.warranty_details ?? ""}
            onCommit={(v) => update.mutate({ warranty_details: v || null })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3 pt-2">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={p.insured}
              onChange={(e) => update.mutate({ insured: e.target.checked })}
              className="accent-cobble-500"
            />
            <span className="text-slate-600 dark:text-mortar-200 inline-flex items-center gap-1">
              <ShieldCheck size={12} /> Insured
            </span>
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={p.archived}
              onChange={(e) => update.mutate({ archived: e.target.checked })}
              className="accent-cobble-500"
            />
            <span className="text-slate-600 dark:text-mortar-200 inline-flex items-center gap-1">
              <Archive size={12} /> Archived
              <span className="text-[10px] text-slate-400">(hidden from default list)</span>
            </span>
          </label>
        </div>
      </div>

      <PartGallery
        partId={p.id}
        coverImagePath={p.image_path}
        onSetCover={(imagePath) => update.mutate({ image_path: imagePath })}
      />

      <MaintenancePanel entityModule="inventory" entityType="part" entityId={p.id} />

      <CustomFieldsPanel
        entityKind="inventory:part"
        values={(p.metadata as Record<string, unknown> | null) ?? {}}
        fallbackValues={matched.data?.fields}
        fallbackLabel={matched.data ? `catalog (${matched.data.title})` : undefined}
        onCommit={(name, value) =>
          update.mutate({
            metadata: {
              ...((p.metadata as Record<string, unknown> | null) ?? {}),
              [name]: value,
            },
          })
        }
      />

      <AllocationsPanel partId={p.id} />

      <div className="text-center pt-4">
        <button
          onClick={async () => {
            const ok = await confirm({
              title: `Delete "${p.name}"?`,
              message: "This can't be undone. Allocations to other modules' entities are released.",
              confirmLabel: "Delete part",
              destructive: true,
            });
            if (ok) remove.mutate();
          }}
          className="text-xs text-slate-400 dark:text-slate-500 hover:text-ember-500 inline-flex items-center gap-1.5"
        >
          <Trash2 size={12} /> Delete this part
        </button>
      </div>
    </div>
  );
}

// PrintQrButton — mints a QR token bound to this part (if one doesn't
// already exist) then routes the labels module to print a QR label
// for it. The "moment of magic" parity with HomeBox's per-item label
// button.
function PrintQrButton({
  partId,
  orgSlug,
  getToken,
}: {
  partId: string;
  orgSlug: string;
  getToken: () => string | null;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const auth = (): Record<string, string> => {
    const t = getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  async function printQr() {
    setBusy(true);
    try {
      // 1. Reuse an active navigate-mode token, or mint one.
      const list = await fetch(
        `/api/v1/orgs/${orgSlug}/modules/core-labels-qr/tokens?entity_kind=inventory:part&entity_id=${encodeURIComponent(partId)}`,
        { headers: auth() },
      );
      let tokenSlug: string | null = null;
      let entityName = "";
      if (list.ok) {
        const data = (await list.json()) as {
          items: Array<{ id: string; token: string; revoked_at: string | null }>;
        };
        const active = data.items.find((t) => !t.revoked_at);
        if (active) tokenSlug = active.token;
      }
      if (!tokenSlug) {
        const res = await fetch(
          `/api/v1/orgs/${orgSlug}/modules/core-labels-qr/tokens`,
          {
            method: "POST",
            headers: { ...auth(), "Content-Type": "application/json" },
            body: JSON.stringify({
              entity_kind: "inventory:part",
              entity_id: partId,
              mode: "navigate",
              auth: "session",
            }),
          },
        );
        if (!res.ok) throw new Error(`mint token: ${res.status}`);
        const data = (await res.json()) as { token: string };
        tokenSlug = data.token;
      }
      // Fetch the part name for the label description.
      const partRes = await fetch(
        `/api/v1/orgs/${orgSlug}/modules/inventory/parts/${partId}`,
        { headers: auth() },
      );
      if (partRes.ok) {
        const part = (await partRes.json()) as { name?: string; asset_id?: number };
        entityName =
          part.asset_id != null
            ? `#${String(part.asset_id).padStart(3, "0")} ${part.name ?? ""}`.trim()
            : (part.name ?? "");
      }
      // 2. Queue a label-print job. qr_payload is the unauthenticated
      //    resolver URL — any QR reader pointed at it lands on the
      //    workspace's part detail.
      const qrUrl = `${window.location.origin}/qr/${tokenSlug}`;
      const q = await fetch(
        `/api/v1/orgs/${orgSlug}/modules/labels/queue`,
        {
          method: "POST",
          headers: { ...auth(), "Content-Type": "application/json" },
          body: JSON.stringify({
            module_name: "inventory",
            entity_type: "part",
            entity_id: partId,
            qr_payload: qrUrl,
            description: entityName || "Part",
            qty: 1,
          }),
        },
      );
      if (!q.ok && q.status !== 409) throw new Error(`queue: ${q.status}`);
      toast.success("QR label queued — open Labels → Queue to print.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void printQr()}
      disabled={busy}
      className="text-[11px] font-mono uppercase tracking-widest text-cobble-600 hover:text-cobble-700 inline-flex items-center gap-1 border border-cobble-200 dark:border-cobble-800 rounded px-1.5 py-0.5 disabled:opacity-50"
      title="Mint a QR token and queue a label print"
    >
      <Printer size={11} /> {busy ? "queueing…" : "QR label"}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}

function InlineText({
  value,
  onCommit,
  placeholder,
  numeric,
  className = "input",
}: {
  value: string | number | null;
  onCommit: (v: string) => void;
  placeholder?: string;
  numeric?: boolean;
  className?: string;
}) {
  const initial = value == null ? "" : String(value);
  const [draft, setDraft] = useState(initial);
  function commit(e: FocusEvent<HTMLInputElement>) {
    if (e.target.value !== initial) onCommit(e.target.value);
  }
  return (
    <input
      type={numeric ? "number" : "text"}
      step={numeric ? "any" : undefined}
      defaultValue={initial}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          (e.target as HTMLInputElement).value = initial;
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder={placeholder}
      className={className}
      // suppress 'unused var' linter
      data-draft={draft}
    />
  );
}

function InlineTextarea({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => void;
}) {
  return (
    <textarea
      defaultValue={value}
      onBlur={(e) => {
        if (e.target.value !== value) onCommit(e.target.value);
      }}
      rows={3}
      className="input"
    />
  );
}

function fmt(n: number | string): string {
  const v = typeof n === "string" ? Number(n) : n;
  if (Number.isNaN(v)) return String(n);
  return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(3)));
}
