// A table's "Import from <service>" button (Yarn: Import from Ravelry).
//
// A bundle declares it on a table (`connector_import`, ConnectorImportDecl):
// which sync connector, and which of this workspace's tables each of its
// sections lands in (Ravelry's stash into Yarn, its projects into Patterns).
// It is the same sync connection the Integrations page makes, reached from the
// table itself, because a managed app (Cobblr for Yarn) has no Integrations
// page at all: the old button there called an importer that no longer existed,
// and the connector that replaced it was out of reach.
//
// The first press asks for the service's keys once and makes the connection;
// every press after that imports again, which updates what is already here
// (the import matches on the service's ids) rather than adding it twice. The
// connection keeps syncing on its own afterwards, as any sync connection does.
import { useEffect, useState } from "react";
import type { ConnectorImportDecl } from "@cobblr/platform-contract";
import { Modal } from "./Modal";
import { SecretInput } from "./PasswordInput";

interface ConnectorDef {
  id: string;
  label: string;
  credentials: Record<string, { label: string; secret: boolean }>;
  entityTypes: Array<{ key: string; label: string }>;
}
interface Connection {
  id: string;
  connector_id: string;
  archived_at?: string | null;
}
interface RunResult {
  created: number;
  updated: number;
  linked: number;
  total: number;
}

export interface SectionOutcome {
  section: string;
  table: string;
  ok: boolean;
  result?: RunResult;
  error?: string;
}

/** "Yarn: 12 added, 3 updated. Patterns: 4 added." */
export function importSummary(outcomes: SectionOutcome[], tableLabel: (name: string) => string): string {
  const parts = outcomes.map((o) => {
    if (!o.ok) return `${tableLabel(o.table)}: not imported (${o.error ?? "error"})`;
    const r = o.result ?? { created: 0, updated: 0, linked: 0, total: 0 };
    const bits = [r.created ? `${r.created} added` : "", r.updated + r.linked ? `${r.updated + r.linked} updated` : ""].filter(Boolean);
    return `${tableLabel(o.table)}: ${bits.length ? bits.join(", ") : "nothing new"}`;
  });
  return parts.join(". ") + ".";
}

export function TableConnectorImport({
  orgSlug,
  getToken,
  decl,
  open,
  onClose,
  onDone,
}: {
  orgSlug: string;
  getToken: () => string | null;
  decl: ConnectorImportDecl;
  open: boolean;
  onClose: () => void;
  /** After an import, so the table refetches. */
  onDone?: () => void;
}) {
  const base = `/api/v1/orgs/${orgSlug}/modules/core-integrations/sync`;
  const [phase, setPhase] = useState<"checking" | "keys" | "importing" | "done" | "error">("checking");
  const [def, setDef] = useState<ConnectorDef | null>(null);
  const [tables, setTables] = useState<Record<string, string>>({});
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [labels, setLabels] = useState<Record<string, string>>({});

  const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const t = getToken();
    const r = await fetch(path, {
      method,
      headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    const data = text ? (JSON.parse(text) as T & { error?: { message?: string } | string }) : ({} as T);
    if (!r.ok) {
      const e = (data as { error?: { message?: string } | string }).error;
      throw new Error(typeof e === "string" ? e : e?.message ?? `the service answered ${r.status}`);
    }
    return data;
  };

  const runImports = async (connectionId: string, sections: Record<string, string>, names: Record<string, string> = labels) => {
    setPhase("importing");
    const outcomes: SectionOutcome[] = [];
    for (const [section, table] of Object.entries(sections)) {
      try {
        const r = await call<{ ok: boolean; result?: RunResult; error?: string }>(
          "POST",
          `${base}/connections/${connectionId}/syncs/${encodeURIComponent(section)}/import`,
        );
        outcomes.push({ section, table, ok: r.ok !== false, result: r.result, error: r.error });
      } catch (e) {
        outcomes.push({ section, table, ok: false, error: (e as Error).message });
      }
    }
    setMessage(importSummary(outcomes, (n) => names[n] ?? n));
    setPhase(outcomes.some((o) => o.ok) ? "done" : "error");
    onDone?.();
  };

  // On open: learn the connector, which of its tables exist here, and whether
  // a connection is already made (then it is one press: import again).
  useEffect(() => {
    if (!open) return;
    let live = true;
    setPhase("checking");
    setMessage("");
    (async () => {
      try {
        const [connectors, connections, instances] = await Promise.all([
          call<{ items: ConnectorDef[] }>("GET", `${base}/connectors`),
          call<{ items: Connection[] }>("GET", `${base}/connections`),
          call<{ items: Array<{ instance_name: string; display_name: string }> }>("GET", `/api/v1/orgs/${orgSlug}/instances`),
        ]);
        if (!live) return;
        const d = connectors.items.find((c) => c.id === decl.connector) ?? null;
        if (!d) throw new Error(`${decl.label ?? "This import"} is not available in this workspace.`);
        const have = new Set(instances.items.map((i) => i.instance_name));
        const sections = Object.fromEntries(Object.entries(decl.sections).filter(([k, t]) => have.has(t) && d.entityTypes.some((e) => e.key === k)));
        const names = Object.fromEntries(instances.items.map((i) => [i.instance_name, i.display_name]));
        setLabels(names);
        setDef(d);
        setTables(sections);
        const existing = connections.items.find((c) => c.connector_id === decl.connector && !c.archived_at);
        if (existing) await runImports(existing.id, sections, names);
        else setPhase("keys");
      } catch (e) {
        if (!live) return;
        setMessage((e as Error).message);
        setPhase("error");
      }
    })();
    return () => {
      live = false;
    };
    // Runs once per opening; the helpers it calls read the latest state.
  }, [open]);

  const connect = async () => {
    if (!def) return;
    try {
      setPhase("importing");
      const conn = await call<{ id: string }>("POST", `${base}/connections`, {
        connector_id: def.id,
        label: def.label,
        credentials: creds,
        target_instances: tables,
      });
      const test = await call<{ ok: boolean; error?: string }>("POST", `${base}/connections/${conn.id}/test`).catch((e: Error) => ({ ok: false, error: e.message }));
      if (!test.ok) {
        // A wrong key must not leave a dead connection behind to be reused.
        await call("DELETE", `${base}/connections/${conn.id}`).catch(() => undefined);
        // The service's own status says which: refused keys, or not reachable.
        const refused = /\b40[13]\b/.test(test.error ?? "");
        setMessage(
          refused
            ? `${def.label} did not accept those keys. Check them and try again.`
            : `${def.label} could not be reached to check those keys${test.error ? ` (${test.error})` : ""}. Try again in a moment.`,
        );
        setPhase("keys");
        return;
      }
      await runImports(conn.id, tables);
    } catch (e) {
      setMessage((e as Error).message);
      setPhase("keys");
    }
  };

  const title = decl.label ?? `Import from ${def?.label ?? "a service"}`;
  const sectionWords = def
    ? Object.keys(tables)
        .map((k) => `your ${(def.entityTypes.find((e) => e.key === k)?.label ?? k).toLowerCase()} into ${labels[tables[k]!] ?? tables[k]}`)
        .join(" and ")
    : "";

  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <div className="space-y-3" data-testid="connector-import">
        {phase === "checking" && <p className="text-sm text-muted">Getting ready…</p>}
        {phase === "importing" && <p className="text-sm text-muted">Importing {sectionWords}…</p>}
        {phase === "keys" && def && (
          <>
            <p className="text-sm text-content dark:text-mortar-200">
              Connect {def.label} once and this brings {sectionWords}. Press it again any time to update them.
            </p>
            {Object.entries(def.credentials).map(([k, c]) => (
              <label key={k} className="block">
                <span className="block text-xs text-muted mb-0.5">{c.label}</span>
                <SecretInput
                  secret={c.secret}
                  what={c.label.toLowerCase()}
                  value={creds[k] ?? ""}
                  onChange={(e) => setCreds((p) => ({ ...p, [k]: e.target.value.trim() }))}
                  autoComplete="off"
                  className="input text-sm"
                />
              </label>
            ))}
            {message && <p className="text-xs text-ember-600 dark:text-ember-400">{message}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-sm text-muted">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void connect()}
                disabled={Object.keys(def.credentials).some((k) => !creds[k])}
                className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3 py-2 disabled:opacity-40"
              >
                Connect and import
              </button>
            </div>
          </>
        )}
        {(phase === "done" || phase === "error") && (
          <>
            <p className={`text-sm ${phase === "error" ? "text-ember-600 dark:text-ember-400" : "text-content dark:text-mortar-200"}`} data-testid="connector-import-summary">
              {message}
            </p>
            {phase === "done" && <p className="text-xs text-muted">Press it again any time: it updates what is already here and adds what is new.</p>}
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3 py-2">
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
