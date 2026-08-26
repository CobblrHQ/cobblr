// Operator console — the global vendor scan-URL resolver list. A scanned maker
// URL (e.g. a Polar Filament spool QR) is matched, fetched, and mapped to a
// product by a DATA manifest — no code per vendor. Built-ins ship with Cobblr;
// operators add their own here. Backed by /super-admin/scan-url-resolvers.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, JsonField, useToast, useConfirm } from "@cobblr/platform-web";
import { FlaskConical, Plus, Trash2, Pencil } from "lucide-react";
import { api, type ScanUrlResolverRow, type ScanUrlResolution } from "../lib/api";

const TEMPLATE = `{
  "id": "my-vendor",
  "label": "My Vendor",
  "enabled": true,
  "match": { "pattern": "vendor\\\\.example", "key": "[?&]id=([A-Za-z0-9-]+)" },
  "request": { "method": "GET", "url": "https://vendor.example/api?id={key}" },
  "response": { "require": { "status": "OK" }, "root": "data" },
  "output": {
    "source": "my-vendor", "name": "title", "category": "part", "entityType": "part",
    "fields": { "sku": "sku" }
  }
}`;

export function ScanResolversTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useQuery({ queryKey: ["admin-scan-resolvers"], queryFn: () => api.scanResolvers() });
  const [editing, setEditing] = useState<ScanUrlResolverRow | "new" | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["admin-scan-resolvers"] });

  const toggle = useMutation({
    mutationFn: (r: ScanUrlResolverRow) => api.patchScanResolver(r.resolver_id, { enabled: !r.enabled }),
    onSuccess: refresh,
    onError: () => toast.error("Couldn't update."),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteScanResolver(id),
    onSuccess: () => { toast.success("Removed."); refresh(); },
    onError: () => toast.error("Couldn't remove."),
  });

  const items = list.data?.items ?? [];

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted dark:text-slate-400 max-w-2xl">
            Built-ins ship with Cobblr; add your own as data.
          </p>
        </div>
        <button
          onClick={() => setEditing("new")}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-cobble-600 text-white text-sm font-medium hover:bg-cobble-700 shrink-0"
        >
          <Plus size={14} /> Add vendor
        </button>
      </header>

      <TestBox />

      {list.isLoading ? (
        <p className="text-muted text-sm">Loading…</p>
      ) : (
        <ul className="space-y-2">
          {items.map((r) => {
            const m = (r.manifest ?? {}) as { match?: { pattern?: string } };
            return (
              <li key={r.resolver_id} className="rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-content truncate">{r.label}</span>
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-subtle dark:bg-slate-800 text-muted dark:text-slate-400">
                        {r.builtin ? "built-in" : "custom"}
                      </span>
                      {!r.enabled && (
                        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-subtle dark:bg-slate-800 text-accent">
                          off
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-faint font-mono truncate mt-0.5">
                      {r.resolver_id} · /{m?.match?.pattern ?? "?"}/
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => toggle.mutate(r)}
                      className="px-2 py-1 text-xs rounded border border-line dark:border-slate-600 text-muted dark:text-slate-400 hover:text-content dark:hover:text-mortar-100"
                    >
                      {r.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      onClick={() => setEditing(r)}
                      className="p-1.5 rounded border border-line dark:border-slate-600 text-muted dark:text-slate-400 hover:text-content dark:hover:text-mortar-100"
                      title={r.builtin ? "Override" : "Edit"}
                    >
                      <Pencil size={13} />
                    </button>
                    {!r.builtin && (
                      <button
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `Remove ${r.label}?`,
                              message:
                                "Deletes this custom vendor resolver. A built-in it overrides is restored.",
                              confirmLabel: "Remove",
                              destructive: true,
                            })
                          )
                            remove.mutate(r.resolver_id);
                        }}
                        className="p-1.5 rounded border border-line dark:border-slate-600 text-muted dark:text-slate-400 hover:text-content dark:hover:text-mortar-100"
                        title="Remove"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <EditModal
          row={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function TestBox() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<{ matched: boolean; resolution: ScanUrlResolution | null } | null>(null);
  const run = useMutation({
    mutationFn: () => api.testScanResolver(url.trim()),
    onSuccess: setResult,
  });
  return (
    <div className="rounded-lg border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 p-3">
      <div className="flex items-center gap-2">
        <FlaskConical size={15} className="text-muted shrink-0" />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a scanned URL to test (e.g. https://3dqr.co/?i=52435-20V0)"
          className="flex-1 min-w-0 px-2 py-1.5 rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 text-sm text-content"
        />
        <button
          disabled={!url.trim() || run.isPending}
          onClick={() => run.mutate()}
          className="px-3 py-1.5 rounded-md bg-cobble-600 text-white text-sm font-medium disabled:opacity-50 shrink-0"
        >
          Test
        </button>
      </div>
      {result && (
        <div className="mt-2 text-sm">
          {result.matched && result.resolution ? (
            <div className="text-content">
              <span className="text-accent font-medium">✓ resolved</span> — {result.resolution.name}{" "}
              <span className="text-faint">({result.resolution.source})</span>
              <pre className="mt-1 text-xs bg-surface dark:bg-slate-900 border border-line dark:border-slate-700 rounded p-2 overflow-x-auto">
                {JSON.stringify(result.resolution.fields, null, 2)}
              </pre>
            </div>
          ) : (
            <span className="text-muted">No vendor resolver claimed this URL.</span>
          )}
        </div>
      )}
    </div>
  );
}

function EditModal({
  row,
  onClose,
  onSaved,
}: {
  row: ScanUrlResolverRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [manifest, setManifest] = useState<unknown>(() => (row ? row.manifest : JSON.parse(TEMPLATE)));
  const [valid, setValid] = useState(true);
  const save = useMutation({
    mutationFn: () => api.saveScanResolver(manifest),
    onSuccess: () => {
      toast.success("Saved.");
      onSaved();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save — check the manifest."),
  });
  return (
    <Modal open onClose={onClose} title={row ? `Edit ${row.label}` : "Add a vendor resolver"} size="lg">
      <div className="space-y-3">
        <p className="text-sm text-muted">
          A vendor resolver is a data manifest: match a URL shape, pull a key out, fetch the maker's
          API, and map the JSON response onto a product.{" "}
          <code className="text-xs text-content">{"{key}"}</code> and{" "}
          <code className="text-xs text-content">{"{env:VAR}"}</code> template the request.
        </p>
        <JsonField
          value={manifest}
          onChange={(v, m) => {
            setValid(m.valid);
            if (m.valid) setManifest(v);
          }}
          rows={20}
          hint="The resolver manifest as JSON."
        />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-md border border-line dark:border-slate-600 text-sm text-muted dark:text-slate-400">
            Cancel
          </button>
          <button
            disabled={save.isPending || !valid}
            onClick={() => save.mutate()}
            className="px-3 py-2 rounded-md bg-cobble-600 text-white text-sm font-medium disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
