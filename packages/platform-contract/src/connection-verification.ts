// What a saved connection KNOWS about its own key.
//
// A new or replaced key used to be stored and the save said "Connection
// updated"; the first real call then failed. The owner's requirement (the
// 2026-09-13 review, #2895): a key is tested before the connection is
// presented as ready. So a save probes the provider once (the cheapest call it
// has, no workspace data), and what the probe said becomes the connection's
// verification, shown on the row and in the toast, re-checked from a button.
//
// Buildless subpath: no runtime import of a sibling.

export type VerificationState =
  /** The probe reached the provider and the key was accepted. */
  | "verified"
  /** The provider rejected the key (or named a model it does not serve). */
  | "invalid"
  /** The probe could not settle it: the provider was unreachable or refused for a quota. */
  | "unverifiable"
  /** Saved without a passing probe, on the person's say-so. */
  | "unverified";

export interface ConnectionVerification {
  state: VerificationState;
  /** The provider's reason (provider-reason.ts) when the probe did not pass. */
  reason?: "invalid_key" | "quota" | "model_unavailable" | "unreachable" | "unknown";
  /** The sentence a person reads for it. */
  message?: string;
  /** The model the probe confirmed, when the provider named one. */
  model?: string;
  /** When the probe ran, ISO. */
  at: string;
}

/** The verification a probe's verdict becomes. A quota or an unreachable
 *  provider says nothing about the key, so those are "unverifiable", not
 *  "invalid"; a rejected key or a missing model is "invalid". */
export function verificationOf(
  probe: { ok: boolean; reason?: ConnectionVerification["reason"]; error?: string; detail?: string; models?: string[]; note?: string },
  model?: string | null,
  now: Date = new Date(),
): ConnectionVerification {
  const at = now.toISOString();
  if (probe.ok) return { state: "verified", at, ...(model ? { model } : probe.models?.[0] ? { model: probe.models[0] } : {}), ...(probe.note ? { message: probe.note } : {}) };
  const reason = probe.reason ?? "unknown";
  const state: VerificationState = reason === "invalid_key" || reason === "model_unavailable" ? "invalid" : "unverifiable";
  return { state, reason, at, ...(probe.error ? { message: probe.error } : {}) };
}

/** Read a stored value back as a verification, or null for none / garbage. */
export function verificationFrom(value: unknown): ConnectionVerification | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!["verified", "invalid", "unverifiable", "unverified"].includes(String(v.state))) return null;
  if (typeof v.at !== "string") return null;
  return v as unknown as ConnectionVerification;
}

/** The short word a row shows for it. */
export function verificationLabel(v: ConnectionVerification | null | undefined): string {
  switch (v?.state) {
    case "verified":
      return "Verified";
    case "invalid":
      return v.reason === "model_unavailable" ? "Model not available" : "Key not valid";
    case "unverifiable":
      return v.reason === "quota" ? "Could not verify (usage limit)" : "Could not verify";
    case "unverified":
      return "Unverified";
    default:
      return "Not checked yet";
  }
}
