import { useEffect, useRef, useState } from "react";
import { isMaskedSecret } from "@cobblr/platform-contract/secret-field";
import { SecretInput } from "./PasswordInput";
import { usePlatformWeb } from "./context";

export function SecretField({ value, field, kind, recordId, onCommit }: {
  value: unknown;
  field: string;
  kind?: string;
  recordId?: string;
  onCommit?: (value: string | null) => void;
}) {
  const { api, orgSlug, role } = usePlatformWeb();
  const generation = useRef(0);
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const masked = isMaskedSecret(value) ? value : null;
  // role-gate: exact: secret access is explicitly limited to owner/admin, creator or the configured field capability.
  const hidden = masked ? masked.can_reveal !== true : !!recordId && role !== "owner" && role !== "admin";
  const hasValue = masked?.has_value ?? (typeof value === "string" && value.length > 0);
  const recordKind = kind ?? masked?.kind;
  const id = recordId ?? masked?.record_id;
  const fieldName = masked?.field ?? field;
  useEffect(() => {
    generation.current++;
    setBusy(false);
    setError(null);
    setShown(null);
    setCopied(false);
    setDraft("");
    setEditing(false);
    return () => { generation.current++; };
  }, [orgSlug, recordKind, id, fieldName, value]);
  useEffect(() => {
    if (shown === null) return;
    const timer = setTimeout(() => setShown(null), 60_000);
    return () => clearTimeout(timer);
  }, [shown]);
  async function read(operation: "reveal" | "copy") {
    if (busy || hidden || !recordKind || !id || !api.revealSecretField) return;
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await api.revealSecretField(orgSlug, recordKind, id, fieldName, operation);
      if (current !== generation.current) return;
      if (operation === "copy") {
        await navigator.clipboard.writeText(result.value);
        if (current === generation.current) setCopied(true);
      } else setShown(result.value);
    } catch {
      if (current !== generation.current) return;
      setError(operation === "copy" ? "Could not copy this value." : "Could not reveal this value.");
    } finally { if (current === generation.current) setBusy(false); }
  }
  if (hidden) return <span data-secret-hidden="">hidden</span>;
  return (
    <div className="space-y-2" data-secret-field="">
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all" data-secret-state={shown === null ? "masked" : "revealed"}>{shown ?? (hasValue ? "••••••" : "Empty")}</span>
        {hasValue && id && recordKind && api.revealSecretField && <>
          <button type="button" className="text-accent" disabled={busy} onClick={() => { if (shown !== null) setShown(null); else void read("reveal"); }}>{shown === null ? "Reveal" : "Hide"}</button>
          <button type="button" className="text-accent" disabled={busy} onClick={() => void read("copy")}>{copied ? "Copied" : "Copy"}</button>
        </>}
        {onCommit && !editing && <button type="button" className="text-accent" onClick={() => setEditing(true)}>{hasValue ? "Change" : "Set value"}</button>}
      </div>
      {editing && onCommit && <div className="flex flex-wrap items-center gap-2">
        <SecretInput secret what="new secret value" className="input text-base" aria-label="New secret value" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button type="button" className="btn" onClick={() => { onCommit(draft || null); setDraft(""); setEditing(false); setShown(null); }}>Save</button>
        <button type="button" className="btn" onClick={() => { setDraft(""); setEditing(false); }}>Cancel</button>
      </div>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
