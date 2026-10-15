// What this box says about itself at GET /healthz: its deploy env, whether
// it has test doors, the build it runs. Public, so it is read with a plain
// fetch, on the sign-in screen too.
//
// Asked once at load by everything that wants it then: the env badge and the
// new-version notice each asked on their own, so a cold load sent it twice
// (#6613). A later look (the notice's poll) asks afresh.

export interface Healthz {
  ok: boolean;
  build_sha?: string | null;
  deploy_env?: string;
  test_doors?: boolean;
}

/** /healthz now. */
export async function readHealthz(): Promise<Healthz> {
  const res = await fetch("/api/v1/healthz", { cache: "no-store" });
  if (!res.ok) return { ok: false };
  return { ...((await res.json()) as Omit<Healthz, "ok">), ok: true };
}

let atLoad: Promise<Healthz> | null = null;

/** /healthz as this page load found it: one request, whoever asks. One that
 *  could not be made is asked again by the next caller. */
export function healthzAtLoad(): Promise<Healthz> {
  return (atLoad ??= readHealthz().catch((e: unknown) => {
    atLoad = null;
    throw e;
  }));
}

/** For a test: forget the load's answer. */
export function resetHealthzAtLoad(): void {
  atLoad = null;
}
