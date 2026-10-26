import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { usePlatformWeb } from "./context";
import { FooterActionPopover } from "./FooterActionPopover";
import { undoStepsOf, useRunAction } from "./run-action";
import { useToast } from "./ToastContext";
import { FieldValueEditor } from "./CustomFieldsPanel";
import { FieldPack } from "./FieldPack";
import { fieldNeed } from "./field-pack";
import { fieldControl } from "./fieldControl";
import type { BulkFieldOption, PlatformFieldDef } from "./types";

import { countOf } from "@cobblr/platform-contract/plural";
interface Ref { kind: string; id: string }
interface Result { ok?: boolean; error?: string; summary?: string; data?: { done: unknown[]; failed: Array<Ref & { title: string; error: string }> } }

export function BulkSetField({ records, onDone }: { records: Ref[]; onDone?: () => void }) {
  const { api, orgSlug, role } = usePlatformWeb();
  const allowed = !!api.listBulkFieldOptions && roleSatisfies(role, ["admin"]);
  const kinds = [...new Set(records.map((r) => r.kind))].sort();
  const options = useQuery({ queryKey: ["bulk-field-options", orgSlug, kinds], queryFn: () => api.listBulkFieldOptions!(orgSlug, kinds), enabled: allowed && records.length > 0 });
  if (!allowed || records.length === 0) return null;
  return (
    <FooterActionPopover label="Set field…" icon={<Pencil size={12} />} title={`Set a field on ${countOf(records.length, "record")}`} width={340} data-testid="bulk-set-field">
      {(close) => options.isLoading ? <p className="p-3 text-sm">Loading fields…</p> : options.isError ? <p role="alert" className="p-3 text-sm">{options.error.message}</p> : (
        <SetFieldForm records={records} fields={options.data?.items ?? []} close={close} onDone={onDone} />
      )}
    </FooterActionPopover>
  );
}

function SetFieldForm({ records, fields, close, onDone }: { records: Ref[]; fields: BulkFieldOption[]; close: () => void; onDone?: () => void }) {
  // PRESS-ARGS: the form chooses a field and value; records are the list's selection and Undo carries the batch's own changes.
  const run = useRunAction();
  const toast = useToast();
  const [name, setName] = useState(fields[0]?.name ?? "");
  const [value, setValue] = useState<unknown>(null);
  const [clear, setClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<NonNullable<Result["data"]>["failed"]>([]);
  const f = fields.find((field) => field.name === name);
  const def: PlatformFieldDef | null = f ? { ...f, id: f.name, entity_kind: records[0]!.kind, position: 0, bundle_id: null } : null;
  return (
    <form className="min-h-0 space-y-3 overflow-y-auto whitespace-normal p-3" onSubmit={async (e) => {
      e.preventDefault();
      if (!f || busy) return;
      if (!clear && value === null) { setError("Enter a value, or choose Clear this field."); return; }
      setBusy(true); setError(null); setFailed([]);
      try {
        const out = await run({ actionId: "platform:set-field-on-records", entityKind: "", entityId: "", args: { records, field: name, value: clear ? null : value } }, { undo: "shown-here" });
        const result = out.result as Result;
        if (!result?.ok) throw new Error(result?.error ?? "That did not go through.");
        const skipped = result.data?.failed ?? [];
        setFailed(skipped);
        const steps = undoStepsOf(out.undo);
        if (steps.length) toast.action(result.summary ?? "Fields changed.", { actionLabel: "Undo", onAction: async () => {
          for (const step of steps) {
            const back = await run({ actionId: step.action_id, entityKind: "", entityId: "", undo_id: step.undo_id, args: step.args ?? {} }, { undo: "is-undo" });
            const restored = back.result as Result;
            if (!restored?.ok) { toast.error(restored?.error ?? "The batch could not be undone."); return; }
            const failures = restored.data?.failed ?? [];
            if (failures.length) toast.error(failures.map((r) => `${r.title}: ${r.error}`).join("\n"));
            else toast.success(restored.summary ?? "Previous values restored.");
          }
        } });
        if (skipped.length === 0) { close(); onDone?.(); }
      } catch (err) { setError((err as Error).message); }
      finally { setBusy(false); }
    }}>
      {fields.length === 0 ? <p className="text-sm">These records have no writable fields in common.</p> : <>
        <label className="block text-sm">Field
          <select aria-label="Field" className="input w-full text-base sm:text-sm" value={name} onChange={(e) => { setName(e.target.value); setValue(null); setClear(false); }} disabled={busy}>
            {fields.map((field) => <option key={field.name} value={field.name}>{field.display_label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={clear} onChange={(e) => setClear(e.target.checked)} disabled={busy} />Clear this field</label>
        {!clear && def && <FieldPack items={[{ need: fieldNeed(def.id, { control: fieldControl(def), label: def.display_label, choices: def.choices }), node: <FieldValueEditor key={def.name} draftOnly def={def} kind={records[0]!.kind} value={value} onCommit={setValue} /> }]} />}
        {error && <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
        {failed.length > 0 && <div role="alert" className="max-h-48 overflow-auto text-sm"><p>These records were skipped:</p><ul>{failed.map((r) => <li key={`${r.kind}:${r.id}`}>{r.title}: {r.error}</li>)}</ul></div>}
        <button type="submit" disabled={busy} className="w-full rounded bg-cobble-600 px-3 py-2 text-sm text-white disabled:opacity-50">{busy ? "Applying…" : `${clear ? "Clear" : "Set"} on ${countOf(records.length, "record")}`}</button>
      </>}
    </form>
  );
}
