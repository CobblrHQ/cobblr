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
import type { ProviderReason } from "./provider-reason.js";

export interface ConnectionTestOutcome {
  ok: boolean;
  /** A successful probe's limitation, shown in amber instead of as verified. */
  warning?: string;
}

export type VerificationState =
  /** The probe reached the provider and the key was accepted. */
  | "verified"
  /** The connection works, but the probe found a limitation. */
  | "warning"
  /** The provider rejected the key (or named a model it does not serve). */
  | "invalid"
  /** The probe could not settle it: the provider was unreachable or refused for a quota. */
  | "unverifiable"
  /** Saved without a passing probe, on the person's say-so. */
  | "unverified";

export interface ConnectionVerification {
  state: VerificationState;
  /** The provider's reason (provider-reason.ts) when the probe did not pass. */
  reason?: ProviderReason;
  /** The sentence a person reads for it. */
  message?: string;
  /** The model the probe confirmed, when the provider named one. */
  model?: string;
  /** When the probe ran, ISO. */
  at: string;
  /** Whether the connection read a known picture during the probe, for a
   *  provider whose backend may ignore an image (a bridge to an agent). A
   *  connection can answer chat and still not see photos, which is what
   *  decides whether it can stand in for scanning. Absent: not tried. */
  photos?: "read" | "not-read";
  /** What it said about the picture, when it did not name it. */
  photos_said?: string;
  /** How long the whole probe took, in milliseconds, whatever it said. */
  latency_ms?: number;
}

/** The verification a probe's verdict becomes. A quota or an unreachable
 *  provider says nothing about the key, so those are "unverifiable", not
 *  "invalid"; a rejected key or a missing model is "invalid". */
export function verificationOf(
  probe: ConnectionTestOutcome & { reason?: ConnectionVerification["reason"]; error?: string; detail?: string; models?: string[]; note?: string; photos?: { read: boolean; said?: string } },
  model?: string | null,
  now: Date = new Date(),
  latencyMs?: number,
): ConnectionVerification {
  const at = now.toISOString();
  const took = typeof latencyMs === "number" && Number.isFinite(latencyMs) ? { latency_ms: Math.max(0, Math.round(latencyMs)) } : {};
  const photos = probe.photos
    ? { photos: probe.photos.read ? ("read" as const) : ("not-read" as const), ...(!probe.photos.read && probe.photos.said ? { photos_said: probe.photos.said.slice(0, 200) } : {}) }
    : {};
  const warning = probe.warning?.trim();
  if (probe.ok) return { state: warning ? "warning" : "verified", at, ...(model ? { model } : probe.models?.[0] ? { model: probe.models[0] } : {}), ...(warning || probe.note ? { message: warning || probe.note } : {}), ...photos, ...took };
  const reason = probe.reason ?? "unknown";
  const state: VerificationState = reason === "invalid_key" || reason === "model_unavailable" ? "invalid" : "unverifiable";
  return { state, reason, at, ...(probe.error ? { message: probe.error } : {}), ...took };
}

/** Read a stored value back as a verification, or null for none / garbage. */
export function verificationFrom(value: unknown): ConnectionVerification | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!["verified", "warning", "invalid", "unverifiable", "unverified"].includes(String(v.state))) return null;
  if (typeof v.at !== "string") return null;
  return v as unknown as ConnectionVerification;
}

/** The short word a row shows for it. */
export function verificationLabel(v: ConnectionVerification | null | undefined): string {
  switch (v?.state) {
    case "verified":
      return "Verified";
    case "warning":
      return "Works with limitations";
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

export function isWorkingVerification(v: { state?: string } | null | undefined): boolean {
  return v?.state === "verified" || v?.state === "warning";
}

/** The 409 body for a key saved without the person's say-so: one the probe
 *  rejected, or a REPLACEMENT the probe could not settle, because the key it
 *  would displace works (a made-up key replaced a working one while the probe
 *  read "unverifiable", #2895). On create there is nothing to lose. Both doors
 *  that save a key, a personal connection and a workspace AI provider, answer
 *  with this, so the panel reads one refusal (#3499). */
export function unverifiedRefusal(verification: ConnectionVerification): {
  error: { code: "key_invalid" | "key_unverifiable"; message: string };
  verification: ConnectionVerification;
} {
  const invalid = verification.state === "invalid";
  return {
    error: {
      code: invalid ? "key_invalid" : "key_unverifiable",
      message: verification.message ?? (invalid ? "The provider rejected this key." : "The key could not be verified just now."),
    },
    verification,
  };
}
