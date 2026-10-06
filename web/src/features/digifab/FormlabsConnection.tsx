import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { SecretInput } from "@cobblr/platform-web";
import { useActiveOrg } from "../../auth/ActiveOrgContext";
import { api, ApiError } from "../../lib/api";

export function FormlabsConnection({ onCreated }: { onCreated: (id?: string) => void }) {
  const { activeSlug } = useActiveOrg();
  const [label, setLabel] = useState("Formlabs Dashboard");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const save = useMutation({ mutationFn: () => api.createDigifabConnection(activeSlug, { type: "formlabs_dashboard", label: label.trim(), base_url: "https://api.formlabs.com", username: clientId.trim(), password: secret }), onSuccess: connection => onCreated(connection.id) });
  const input = "w-full rounded border border-line bg-surface px-3 py-2";
  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
    <p>Read printer status and resin estimates from your Formlabs Dashboard account. This connection cannot upload, start, pause or stop prints.</p>
    <p>Create application credentials in <a href="https://dashboard.formlabs.com" target="_blank" rel="noreferrer" className="underline">Dashboard Developer Tools</a>. Printers must be registered to your account and connected to the internet.</p>
    <label className="block">Connection name<input className={input} value={label} onChange={event => setLabel(event.target.value)} /></label>
    <label className="block">Client ID<SecretInput what="Formlabs client ID" className={input} value={clientId} onChange={event => setClientId(event.target.value)} /></label>
    <label className="block">Client secret<SecretInput secret what="Formlabs client secret" className={input} value={secret} onChange={event => setSecret(event.target.value)} /></label>
    {save.error && <p role="alert">{save.error instanceof ApiError ? save.error.message : "The Dashboard connection could not be saved."}</p>}
    <button type="submit" disabled={save.isPending || !label.trim() || !clientId.trim() || !secret} className="min-h-12 rounded bg-cobble-600 px-4 py-3 text-white disabled:opacity-50">{save.isPending ? "Adding…" : "Add Dashboard monitor"}</button>
  </form>;
}
