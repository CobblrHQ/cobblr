// A numeric setting read from the environment, where "" means unset.
//
// Compose passes a setting it forwards as `${NAME:-}`, which arrives as an EMPTY
// STRING, not as absent. `Number(process.env.NAME ?? 64)` then reads Number("") = 0,
// because `??` only falls back on undefined: the base docker-compose.yml forwarded
// the sandbox tuning keys that way from b11714fb2 (2026-08-13), so any stack run from
// it got a worker pool of 0, a 0 ms deadline and a 0 ms CPU quota, and every module
// call failed. Found by server-setup's satellite check rendering the file (#3734).
// api/src/env.ts drops empty strings for everything in its schema; this is the same
// rule for the readers outside it. `lint:compose-empty-env-reads` holds every
// compose-forwarded key to it.

/** `process.env[name]` as a finite number, or `fallback` when it is unset, empty,
 *  blank or not a number. "0" is a real value and is returned as 0. */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
