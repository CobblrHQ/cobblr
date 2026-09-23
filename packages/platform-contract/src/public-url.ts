// This instance's public address, read in one place.
//
// It was read four times, under two names: the kernel's link builder and the
// labels module took `PUBLIC_BASE_URL` or an undocumented `COBBLR_PUBLIC_URL`;
// the phone-pairing door and the outbound User-Agent took only the first. An
// instance configured with the second name got absolute links in its emails
// and a working printed QR, but a phone pairing offer and a User-Agent that
// said it had no public address at all. Nothing set the second name (no
// compose file, no .env example, no deployed box), so it is gone rather than
// taught to the other two readers (#3421, #3499).
//
// Read at call time, not at module load: a test or a setting changed in-process
// is seen by the next call. `lint:public-url-one-reader` holds every other
// reader of the variable in the repo to this function.

/** The configured public origin (e.g. `https://cobblr.example.com`), without a
 *  trailing slash; "" when the instance has none configured. */
export function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
}
