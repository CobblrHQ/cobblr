// One line of the api's own memory, on a timer, when COBBLR_MEMORY_LOG_S is set (#6772). The nightly tour's api
// grew to 3.7 GB and was killed by its job's 6.5 GB cgroup three nights running; the sampler outside it saw only
// the resident size, which cannot tell a JavaScript heap that keeps growing from native memory, nor say how many
// tenant pools were open. This says all of it, in the log the digest already carries.

/** The parts of process.memoryUsage() this reads. */
export interface MemoryParts {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

const mb = (n: number) => Math.round(n / 1048576);

/** PURE. The line: every figure in MB, native is what the resident size holds beyond the heap's reservation. */
export function memoryLine(m: MemoryParts, pools: { open: number; total: number }): string {
  const native = Math.max(0, m.rss - m.heapTotal);
  return (
    `[memory] rss=${mb(m.rss)} heap_used=${mb(m.heapUsed)} heap_total=${mb(m.heapTotal)} external=${mb(m.external)} ` +
    `array_buffers=${mb(m.arrayBuffers)} native=${mb(native)} tenant_pools=${pools.open} pool_clients=${pools.total}`
  );
}

/** Start the timer; it never keeps the process alive. Returns its stop. */
export function startMemoryLog(everyS: number, pools: () => { open: number; total: number }, log: (line: string) => void = console.log): () => void {
  // SINGLE-PROCESS-SAFE: each api process logs its own memory; it reads nothing shared and writes only its log.
  const t = setInterval(() => log(memoryLine(process.memoryUsage(), pools())), everyS * 1000);
  t.unref();
  return () => clearInterval(t);
}
