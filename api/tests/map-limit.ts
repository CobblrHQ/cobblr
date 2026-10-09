/**
 * `f` over `xs`, at most `limit` at once, results in input order. For a sweep of independent reads
 * (every route, every kind): one at a time, a 150-route sweep was most of its file's minute and the
 * file one of the suite's slowest (#5443). Not for reads that must not overlap (a cold-cache probe).
 */
export async function mapLimit<T, R>(xs: readonly T[], limit: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, xs.length) }, async () => {
      while (next < xs.length) {
        const i = next++;
        out[i] = await f(xs[i]!, i);
      }
    }),
  );
  return out;
}
