/** Bounded-concurrency map: at most `limit` of `fn` in flight, results in
 *  input order. One copy for every module (four had their own): a fan-out
 *  over a workspace's database never asks more at once than its pool holds,
 *  where the rest would wait on the pool's clock and fail (#7682). */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}
