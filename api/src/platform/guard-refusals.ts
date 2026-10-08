// Every request the request guard refused with a 429, counted by rule, for
// /healthz to report and an alert to read.
//
// On 2026-10-07 every visitor to the public deployment reached the api from
// one address (the proxy in front did not pass the client's on), so they all
// shared one bucket per rule, and nothing could say whether anyone had been
// refused: the guard answered 429 silently, with no log line and no number.
// "No 429s" was a guess. Now each refusal is one log line naming the rule and
// what its bucket is keyed on (never the address itself), and a count here.
//
// Process-local, like error-rate.ts: it answers "is this container refusing
// people right now", and a fresh container starts at zero.

export interface Refusal {
  /** The rule that refused: auth, feedback, anon, signup-ip, signup-global, sandbox-ip, sandbox-global, or the overlay's own. */
  rule: string;
  /** What the rule's bucket is keyed on: one address, or everyone at once. */
  key: "address" | "global" | "unknown";
}

const HOUR_MS = 60 * 60_000;
/** Keep the ring bounded: past this the container is refusing a flood. */
const CAP = 20_000;
const recent: { at: number; rule: string }[] = [];
const total = new Map<string, number>();

export function noteRefusal(r: Refusal, now: number = Date.now()): void {
  recent.push({ at: now, rule: r.rule });
  if (recent.length > CAP) recent.splice(0, recent.length - CAP);
  total.set(r.rule, (total.get(r.rule) ?? 0) + 1);
}

/** Refusals in the last hour and since this process started, by rule. */
export function guardRefusals(now: number = Date.now()): {
  last_hour: Record<string, number>;
  since_start: Record<string, number>;
  auth_last_hour: number;
} {
  const cut = now - HOUR_MS;
  while (recent.length > 0 && recent[0]!.at < cut) recent.shift();
  const last: Record<string, number> = {};
  for (const r of recent) last[r.rule] = (last[r.rule] ?? 0) + 1;
  return {
    last_hour: last,
    since_start: Object.fromEntries(total),
    // Credential routes and the account-creation caps: the number an alert reads.
    auth_last_hour: Object.entries(last)
      .filter(([rule]) => rule === "auth" || rule.startsWith("signup") || rule.startsWith("sandbox"))
      .reduce((n, [, c]) => n + c, 0),
  };
}

/** Tests only. */
export function resetGuardRefusals(): void {
  recent.length = 0;
  total.clear();
}
