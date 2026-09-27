// A single-use code, spent once per page load however many times the page mounts.
//
// The landing pages for an emailed or handed-off sign-in (/auth/callback,
// /auth/magic) trade a one-time code for a session in an effect. React runs an
// effect twice in development, and a remount can run it again anywhere: the
// first request spent the code, the second came back "already used", and the
// page showed that error while dropping the session the first one had made.
// Every mount now shares the one request for its code.
const inFlight = new Map<string, Promise<unknown>>();

export function redeemOnce<T>(code: string, redeem: () => Promise<T>): Promise<T> {
  let p = inFlight.get(code) as Promise<T> | undefined;
  if (!p) {
    p = redeem();
    inFlight.set(code, p);
  }
  return p;
}
