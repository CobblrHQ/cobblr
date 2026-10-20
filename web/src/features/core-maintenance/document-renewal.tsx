import { renewalDocumentTypes } from "@cobblr/platform-contract/renewal-document-types";
import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoneyInput, runAction, useMoneyCurrency } from "@cobblr/platform-web";
import type { PersonalDocumentRead } from "@cobblr/platform-contract/personal-documents";
import { withArticle } from "@cobblr/platform-contract/plural";
import { dayLabel } from "@cobblr/platform-contract/day";
import { api, type RenewalDocumentCandidate } from "../../lib/api";

const input = "mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-base text-content";
const button = "rounded-md bg-accent px-3 py-2 text-sm text-white disabled:opacity-50";
const labels = { vin: "VIN", plate: "Plate", make: "Make", model: "Model", year: "Year", expires: "New expiry", amount: "Fee", reference: "Confirmation" };
const keyOf = (record: { kind: string; id: string }) => `${record.kind}/${record.id}`;

export function DocumentRenewalCard({ slug, read, file, folder }: { slug: string; read: PersonalDocumentRead; file: File | Blob; folder?: string }) {
  const declaration = renewalDocumentTypes.find(type => type.id === (read.renewalType || "registration"))!;
  const qc = useQueryClient();
  const id = useId();
  const mainCurrency = useMoneyCurrency();
  const [currency, setCurrency] = useState(mainCurrency);
  const [fields, setFields] = useState(read.fields);
  const [selected, setSelected] = useState<string | null>(null);
  const [previous, setPrevious] = useState<string | null>(null);
  const [folderChoice, setFolderChoice] = useState(folder || declaration.folder);
  const [name, setName] = useState(file instanceof File ? file.name : "registration.pdf");
  const [newCar, setNewCar] = useState(false);
  const [collection, setCollection] = useState("");
  const [carName, setCarName] = useState([fields.year, fields.make, fields.model].filter(Boolean).join(" "));
  const [done, setDone] = useState<{ summary: string; undo: Array<{ action_id: string; args: Record<string, unknown> }> } | null>(null);
  const [undone, setUndone] = useState(false);
  const identity = { vin: fields.vin, plate: fields.plate, make: fields.make, model: fields.model, year: fields.year };
  const planKey = ["document-renewal-plan", slug, id];
  const plan = useQuery({ queryKey: [...planKey, identity], queryFn: () => api.planRenewalDocument(slug, declaration.id, identity), enabled: !done });
  const folders = useQuery({ queryKey: ["vault-folders", slug], queryFn: () => api.vaultFolders(slug), enabled: !done });
  useEffect(() => () => { qc.removeQueries({ queryKey: ["document-renewal-plan", slug, id] }); }, [qc, slug, id]);
  const chosen = selected ?? (plan.data?.matched ? keyOf(plan.data.matched) : "");
  const record = plan.data?.records.find(item => keyOf(item) === chosen);
  const previousExpiry = previous ?? record?.expiry ?? "";
  const ownFolders = folders.data?.items.filter(item => item.mine) ?? [];
  const chosenFolder = ownFolders.find(item => item.id === folderChoice || item.name === folderChoice);
  const collectionChoice = collection || (plan.data?.collections.length === 1 ? plan.data.collections[0]!.kind : "");
  const create = useMutation({ mutationFn: async () => {
    const target = plan.data?.collections.find(item => item.kind === collectionChoice);
    if (!target || !carName.trim() || !previousExpiry) throw new Error("Choose the collection, car name and previous expiry.");
    const native: Record<string, unknown> = { [target.titleField]: carName.trim() };
    const metadata: Record<string, unknown> = {};
    for (const [key, mapping] of Object.entries(target.fields)) {
      const value = key === "expires" ? previousExpiry : fields[key as keyof typeof fields];
      if (!value) continue;
      const converted = mapping.type === "number" ? Number(value) : value;
      (mapping.native ? native : metadata)[mapping.name] = converted;
    }
    const added = await api.createKindRecord(slug, target.kind, { ...native, metadata });
    setSelected(keyOf({ kind: target.kind, id: added.id })); setNewCar(false);
    await qc.invalidateQueries({ queryKey: planKey });
  } });
  const confirm = useMutation({ mutationFn: async () => {
    if (!record) throw new Error("Choose the car for this document.");
    // NO-UNDO: This card keeps and shows the returned Undo itself.
    // PRESS-ARGS: The editable confirmation card supplies every required renewal value and its original.
    const outcome = await runAction(api, qc, slug, { actionId: "core-maintenance:renew-document", document: new File([file], name, { type: file.type }), args: {
      document_type: plan.data?.type.id || declaration.id, record_kind: record.kind, record_id: record.id,
      previous_expiry: previousExpiry, new_expiry: fields.expires, ...(fields.amount ? { cost: Number(fields.amount) } : {}), reference: fields.reference || "", folder: folderChoice, currency,
    } });
    const result = outcome.result as { summary?: string };
    setDone({ summary: result.summary || `${declaration.label} renewed. The original is in your Vault.`, undo: outcome.undo as Array<{ action_id: string; args: Record<string, unknown> }> || [] });
  } });
  const undo = useMutation({ mutationFn: async () => {
    // NO-UNDO: This press runs the issued Undo and offers no Undo of its own.
    // PRESS-ARGS: The action door issues the complete Undo arguments for this confirmed renewal.
    for (const step of done?.undo ?? []) await runAction(api, qc, slug, { actionId: step.action_id, args: step.args });
    setUndone(true);
  } });
  const error = confirm.error || create.error || undo.error || plan.error || folders.error;
  if (done) return <div className="space-y-3" data-document-renewal-complete><p role="status">{undone ? "The renewal and Vault filing were undone." : done.summary}</p>{!undone && done.undo.length > 0 && <button type="button" className={button} disabled={undo.isPending} onClick={() => undo.mutate()}>Undo</button>}{error && <p role="alert" className="text-sm text-danger">{error instanceof Error ? error.message : "The change could not be undone."}</p>}</div>;
  function selectRecord(value: string) { setSelected(value); setPrevious(null); }
  function candidateButton(item: RenewalDocumentCandidate) { return <button type="button" key={keyOf(item)} className="w-full rounded-md border border-line px-3 py-2 text-left" aria-pressed={chosen === keyOf(item)} onClick={() => selectRecord(keyOf(item))}>{item.title}{item.values.plate ? ` (${item.values.plate})` : ""}{item.values.vin ? `, VIN ${item.values.vin}` : ""}</button>; }
  return <section className="space-y-4" aria-label={`${declaration.label} renewal`}>
    <p className="text-sm">Check these values before you renew and file the original. {read.message}</p>
    {plan.isLoading && <p role="status" className="text-sm">Finding the {declaration.recordLabel}…</p>}
    {plan.data && <>
      {plan.data.candidates.length > 1 && <div className="space-y-2"><p>Which {declaration.recordLabel} is this for? More than one matches.</p>{plan.data.candidates.map(candidateButton)}</div>}
      {!plan.data.complete && <p className="text-sm">There are more records than could be checked here. Choose the car yourself.</p>}
      <label className="block text-sm">{plan.data.candidates.length ? declaration.recordLabel : `Which ${declaration.recordLabel} is this for?`}<select aria-label={declaration.recordLabel === "car" ? "Car" : "Record"} className={input} value={chosen} onChange={event => selectRecord(event.target.value)}><option value="">Choose {withArticle(declaration.recordLabel)}</option>{plan.data.records.map(item => <option key={keyOf(item)} value={keyOf(item)}>{item.title}{item.values.plate ? ` (${item.values.plate})` : ""}</option>)}</select></label>
      <button type="button" className="text-sm text-accent underline" onClick={() => setNewCar(!newCar)}>Add this {declaration.recordLabel}</button>
    </>}
    {newCar && <div className="space-y-3 rounded-md border border-line p-3"><label className="block text-sm">Collection<select className={input} value={collectionChoice} onChange={event => setCollection(event.target.value)}><option value="">Choose a collection</option>{plan.data?.collections.map(item => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select></label><label className="block text-sm">{declaration.recordLabel === "car" ? "Car name" : "Record name"}<input className={input} value={carName} onChange={event => setCarName(event.target.value)} /></label><p className="text-sm text-muted">The VIN, plate, make, model and year below will fill its fields. Enter its previous expiry too.</p><button type="button" className={button} disabled={create.isPending || !previousExpiry} onClick={() => create.mutate()}>Add {declaration.recordLabel}</button></div>}
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{Object.entries(labels).filter(([key]) => key !== "amount").map(([key, label]) => <label key={key} className="block text-sm">{label}<input className={input} type={key === "expires" ? "date" : "text"} inputMode={key === "amount" ? "decimal" : undefined} value={fields[key as keyof typeof fields] || ""} onChange={event => setFields({ ...fields, [key]: event.target.value })} />{read.sources[key as keyof typeof read.sources] === "local-ai" && <span className="mt-1 block text-xs text-muted">Read by your local AI. Please check.</span>}{read.sources[key as keyof typeof read.sources] === "cloud-ai" && <span className="mt-1 block text-xs text-muted">Read by the cloud AI your workspace owner chose. Please check.</span>}</label>)}</div>
    <div className="text-sm">Fee<MoneyInput storage="amount" value={fields.amount || null} currency={currency} onCurrencyChange={setCurrency} live onCommit={value => setFields({ ...fields, amount: value == null ? "" : String(value) })} ariaLabel="Fee" />{read.sources.amount === "local-ai" && <p className="mt-1 text-xs text-muted">Read by your local AI. Please check.</p>}{read.sources.amount === "cloud-ai" && <p className="mt-1 text-xs text-muted">Read by the cloud AI your workspace owner chose. Please check.</p>}</div>
    <label className="block text-sm">Previous expiry<input type="date" className={input} value={previousExpiry} onChange={event => setPrevious(event.target.value)} /></label>
    <label className="block text-sm">Document name<input className={input} value={name} onChange={event => setName(event.target.value)} /></label>
    <label className="block text-sm">Vault folder<select className={input} value={folderChoice} onChange={event => setFolderChoice(event.target.value)}><option value={declaration.folder}>{declaration.folder}{ownFolders.some(item => item.name === declaration.folder) ? "" : " (new, only you)"}</option>{ownFolders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <p className="text-sm text-muted">Who can see the document: {chosenFolder?.people.length ? `you and ${chosenFolder.people.map(person => person.name).join(", ")}` : "only you"}.</p>
    {record && fields.expires && <p className="rounded-md bg-surface p-3 text-sm">{plan.data?.type.label || "Registration"} renewal for {record.title}{fields.plate ? ` (${fields.plate})` : ""}. New expiry {dayLabel(fields.expires)}{previousExpiry ? ` (was ${dayLabel(previousExpiry)})` : ""}.{fields.amount ? ` Fee ${fields.amount} ${currency}.` : ""}{fields.reference ? ` Confirmation ${fields.reference}.` : ""} File the original in {chosenFolder?.name || declaration.folder}. If this {declaration.recordLabel} has no {declaration.label.toLowerCase()} renewal, this will set one up with its first term.</p>}
    {error && <p role="alert" className="text-sm text-danger">{error instanceof Error ? error.message : "The renewal could not be prepared."}</p>}
    <button type="button" className={button} disabled={!record || !fields.expires || !previousExpiry || !name.trim() || confirm.isPending || folders.isLoading || plan.isLoading} onClick={() => confirm.mutate()}>{confirm.isPending ? "Filing…" : "Confirm"}</button>
  </section>;
}
