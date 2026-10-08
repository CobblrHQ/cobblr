import type { WorkspaceSendPreview } from "./SendRecords";

export function SendPreviewCards({items, canConfigure, onDrop, onAdd}: {items: WorkspaceSendPreview["items"]; canConfigure: boolean; onDrop: (label: string) => void; onAdd: (label: string) => void}) {
  return <div className="space-y-3" data-testid="send-preview">{items.map((i) => <section key={i.id} className="rounded border border-line p-3">
    <h3 className="font-medium">{i.name} → {i.collection ?? "Choose a collection"}</h3>
    <p className="text-sm">{i.arrival === "collection" ? `Files into ${i.collection}` : "Waits in the scan inbox"} · {i.files} files</p>
    <ul className="mt-2 space-y-1 text-sm">
      {i.mappings.filter((m) => !i.dropped.includes(m.from)).map((m) => <li key={m.from} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={!m.to ? "text-ember-600 dark:text-ember-400" : undefined}>{m.to ? `${m.from} → ${m.to}` : `${m.from}: no field in ${i.collection ?? "the target collection"}`}</span>
        {!m.to && <><button type="button" className="underline" onClick={() => onDrop(m.from)}>Drop this field</button>{canConfigure && <button type="button" className="underline" onClick={() => onAdd(m.from)}>Add this field there</button>}</>}
      </li>)}
      {i.needs.filter((n) => !i.missing.some((field) => n === `${field} has no field in ${i.collection ?? "the target collection"}`)).map((n) => <li key={n} className="text-ember-600 dark:text-ember-400">{n}</li>)}
      {i.dropped.map((d) => <li key={d}>Not sent: {d}</li>)}
    </ul>
  </section>)}</div>;
}
