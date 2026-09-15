// How many responses this process answered with a 5xx in the last few minutes,
// for /healthz to report.
//
// A canary container served the scan inbox as a 500 for four hours on
// 2026-09-13 while every check it was subject to said healthy: healthz was
// 200, the Caddy in front logs only its own proxy errors, and the api's own
// log left with the container at the next roll (#2944). Nothing that survives
// a roll counted the failures. This does: it is a number on /healthz, read by
// whatever already reads /healthz (the roll's post-check, the box's
// run-or-alert, deploy-gap), and a fresh container starts at zero, which is
// the honest answer for a container that has not failed anything yet.
//
// Process-local and approximate on purpose: it answers "is this container
// failing requests right now", not "how many requests failed today".

const WINDOW_MS = 5 * 60_000;
/** Keep the ring bounded: past this a container is already screaming. */
const CAP = 10_000;
const stamps: number[] = [];

/** Call once per finished response. Health probes never count: a probe that
 *  failed would otherwise feed its own number. Neither does a 501: every 501
 *  this api sends is a declared answer ("this module has no items route",
 *  "this driver cannot pause"), not a failure, and the dashboard's attention
 *  feed asks its own modules over loopback once a minute, three of which
 *  said so, which read as 15 errors in five minutes and tripped the alert
 *  and deploy-gap's health gate on every visit (#3044). */
export function noteResponse(status: number, path: string, now: number = Date.now()): void {
  if (status < 500 || status === 501) return;
  if (path.startsWith("/api/v1/healthz")) return;
  stamps.push(now);
  if (stamps.length > CAP) stamps.splice(0, stamps.length - CAP);
}

/** 5xx responses in the last five minutes. */
export function errors5xxRecent(now: number = Date.now()): number {
  const cut = now - WINDOW_MS;
  while (stamps.length > 0 && stamps[0]! < cut) stamps.shift();
  return stamps.length;
}

/** Tests only. */
export function resetErrorRate(): void {
  stamps.length = 0;
}
